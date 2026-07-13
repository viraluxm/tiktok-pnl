'use client';

import { useEffect, useRef, useState } from 'react';
import { COMMENTS, type LiveComment } from './simulatorData';
import {
  SESSION_SECONDS,
  SESSION_ENDING_SECONDS,
  formatClock,
  randomUsername,
  type TrainerEvent,
} from './trainerEvents';
import { useSessionChannel } from '@/lib/training/useSessionChannel';
import { shortTrainingSessionLabel } from '@/lib/training/session';
import TrainerVideoView from './TrainerVideoView';

// ---- Auto-bid tuning (module-level: stable identity, no per-render churn) ----
// Auto-bidding sends realistic +$1 bids (like a real TikTok auction) and stops
// once the bid reaches the cap. Randomness comes from timing, skipped attempts,
// and random usernames — NOT from the bid amount.
const AUTO_BID_MAX = 20; // stop auto-bidding once the current bid reaches $20
const AUTO_BID_SKIP_CHANCE = 0.3; // ~30% of attempts send no bid (bursts & pauses)

function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

// Randomized inter-attempt delay (ms) so the cadence never feels robotic.
function randomAutoBidDelay(): number {
  return randInt(800, 4500);
}

export default function ControlClient({ sessionId }: { sessionId: string }) {
  const [customText, setCustomText] = useState('');
  const [previewPhase, setPreviewPhase] = useState<'idle' | 'running' | 'ended'>('idle');
  const [currentBid, setCurrentBid] = useState(0);
  const [currentWinner, setCurrentWinner] = useState<string | null>(null);
  const [previewSeconds, setPreviewSeconds] = useState(0);
  const [previewSoldAt, setPreviewSoldAt] = useState<number | null>(null);
  const [previewComments, setPreviewComments] = useState<LiveComment[]>([]);

  // Session mirror (host -> controller via `sessionState` broadcast). No local
  // timer here: values update each time the host's existing session tick fires.
  const [sessionSecondsLeft, setSessionSecondsLeft] = useState<number | null>(null);
  const [sessionViewers, setSessionViewers] = useState(0);
  const [sessionPhase, setSessionPhase] = useState<'idle' | 'running' | 'complete'>('idle');

  // Auto-bidding is admin-controlled; Manual (false) is the default. The host
  // stays the authority that actually applies bids.
  const [autoBid, setAutoBid] = useState(false);

  const secondsRef = useRef(0);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const endedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commentIdRef = useRef(0);
  // Live bid mirror in a ref so the auto-bidder can hard-stop at the cap without
  // taking currentBid as an effect dependency (which would restart it each +$1).
  const currentBidRef = useRef(0);

  const auctionRunning = previewPhase === 'running';

  function stopCountdown() {
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
  }

  function startCountdown(secs: number) {
    stopCountdown();
    secondsRef.current = secs;
    setPreviewSeconds(secs);
    countdownRef.current = setInterval(() => {
      secondsRef.current -= 1;
      setPreviewSeconds(Math.max(0, secondsRef.current));
      if (secondsRef.current <= 0) stopCountdown();
    }, 1000);
  }

  function clearEndedTimer() {
    if (endedTimerRef.current) {
      clearTimeout(endedTimerRef.current);
      endedTimerRef.current = null;
    }
  }

  // Mirror the host auction state for the read-only video overlay. Derived
  // entirely from the existing auctionState broadcasts (no realtime changes):
  // a local countdown approximates the host timer; bid 0 => start (10s),
  // bid > 0 => a bid landed (7s); !running with bid > 0 => sold, else idle.
  const { status, peerPresent, send } = useSessionChannel(sessionId, 'controller', (event: TrainerEvent) => {
    if (event.action === 'sessionState') {
      setSessionSecondsLeft(event.secondsLeft);
      setSessionViewers(event.viewers);
      setSessionPhase(event.phase);
      return;
    }
    if (event.action !== 'auctionState') return;
    if (event.running) {
      clearEndedTimer();
      setPreviewPhase('running');
      setCurrentBid(event.bid);
      setCurrentWinner(event.winner);
      setPreviewSoldAt(null);
      startCountdown(event.bid > 0 ? 7 : 10);
    } else {
      stopCountdown();
      if (event.bid > 0) {
        setPreviewPhase('ended');
        setCurrentBid(event.bid);
        setPreviewSoldAt(event.bid);
        clearEndedTimer();
        endedTimerRef.current = setTimeout(() => {
          setPreviewPhase('idle');
          setCurrentBid(0);
          setCurrentWinner(null);
          setPreviewSoldAt(null);
        }, 2800);
      } else {
        setPreviewPhase('idle');
        setCurrentBid(0);
        setCurrentWinner(null);
        setPreviewSoldAt(null);
      }
    }
  });

  const connected = status === 'connected';

  // Session mirror, derived from the host broadcast. Elapsed counts UP from 0.
  const showSessionStats = peerPresent && sessionPhase !== 'idle' && sessionSecondsLeft !== null;
  const elapsedSeconds =
    sessionSecondsLeft === null ? 0 : Math.max(0, SESSION_SECONDS - sessionSecondsLeft);
  const endingInSeconds =
    peerPresent &&
    sessionPhase === 'running' &&
    sessionSecondsLeft !== null &&
    sessionSecondsLeft > 0 &&
    sessionSecondsLeft <= SESSION_ENDING_SECONDS
      ? sessionSecondsLeft
      : null;

  // Auto-bidding may ACTIVELY fire only while every safety condition holds. Any
  // stop condition — manual mode, auction not running, session complete, host
  // gone, channel down, OR the $20 cap reached — flips this false and tears the
  // loop down (effect below). currentBid crossing the cap flips it exactly once
  // (values 0–19 all keep it true, so the loop is NOT restarted on every +$1).
  const autoBidActive =
    autoBid &&
    connected &&
    peerPresent &&
    sessionPhase === 'running' &&
    previewPhase === 'running' &&
    currentBid < AUTO_BID_MAX;
  // Auto is on and an auction is running, but the $20 cap has been reached.
  const autoBidCapped = autoBid && previewPhase === 'running' && currentBid >= AUTO_BID_MAX;

  // Stop the local timers on unmount (refs only — no reactive deps).
  useEffect(() => {
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
      if (endedTimerRef.current) clearTimeout(endedTimerRef.current);
    };
  }, []);

  // Keep the bid ref in sync so the auto-bid loop reads the live value without
  // taking currentBid as an effect dependency (which would restart it each bid).
  useEffect(() => {
    currentBidRef.current = currentBid;
  }, [currentBid]);

  // Auto-bidder: a single self-rescheduling timeout, gated entirely by
  // `autoBidActive`. When it becomes true the loop starts; when any stop
  // condition flips it false (or the component unmounts) this effect's cleanup
  // clears the pending timer. So there is never more than one loop — even under
  // StrictMode's setup→cleanup→setup — and no bid can fire after teardown.
  useEffect(() => {
    if (!autoBidActive) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (cancelled) return;
      // Hard cap guard: never bid at/above $20, even in the brief window before
      // the cap flips autoBidActive. Stop the loop (don't reschedule).
      if (currentBidRef.current >= AUTO_BID_MAX) return;
      // Realistic: mostly +$1 bids with occasional skipped attempts. Omitting
      // `amount` makes the host apply its standard +$1 — identical to a manual bid.
      if (Math.random() >= AUTO_BID_SKIP_CHANCE) {
        send({ action: 'placeBid', username: randomUsername() });
      }
      timer = setTimeout(tick, randomAutoBidDelay()); // reschedule with a fresh delay
    };
    timer = setTimeout(tick, randomAutoBidDelay()); // first attempt after a random delay
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [autoBidActive, send]);

  function sendComment(text: string) {
    const trimmed = text.trim();
    if (!trimmed || !connected) return;
    const username = randomUsername();
    send({ action: 'comment', username, text: trimmed });
    // Mirror the sent comment into the read-only preview feed (last few).
    commentIdRef.current += 1;
    setPreviewComments((prev) =>
      [...prev, { id: commentIdRef.current, username, text: trimmed }].slice(-4),
    );
  }

  function handleCustomSend() {
    sendComment(customText);
    setCustomText('');
  }

  // Connection indicator
  let connLabel = 'Connecting…';
  let connColor = 'text-tt-yellow';
  if (status === 'error') {
    connLabel = 'Connection error';
    connColor = 'text-tt-red';
  } else if (connected) {
    connLabel = peerPresent ? 'Host connected' : 'Waiting for host…';
    connColor = peerPresent ? 'text-tt-green' : 'text-tt-muted';
  }

  return (
    <div className="min-h-[100dvh] bg-tt-bg px-4 py-6 text-tt-text">
      {/* Final-seconds ending countdown warning (mirrors the host) */}
      {endingInSeconds != null && (
        <div className="pointer-events-none fixed inset-x-0 top-4 z-50 flex justify-center px-4">
          <div
            role="status"
            aria-live="assertive"
            className="rounded-2xl bg-[#FE2C55] px-5 py-3 text-[16px] font-bold text-white shadow-xl shadow-black/40 motion-safe:animate-pulse"
          >
            Practice live ending in {endingInSeconds}…
          </div>
        </div>
      )}
      <div className="mx-auto w-full max-w-md lg:max-w-4xl">
        <header className="flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <h1 className="text-lg font-bold">Practice Controller</h1>
            <span className="text-[12px] font-medium tabular-nums text-tt-muted">
              Session: {shortTrainingSessionLabel(sessionId)}
            </span>
          </div>
          <span className={`flex items-center gap-1.5 text-[13px] font-medium ${connColor}`}>
            <span className="h-2 w-2 rounded-full bg-current" />
            {connLabel}
          </span>
        </header>

        {/* Live session mirror: elapsed time (counting up) + viewer count */}
        {showSessionStats && (
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-xl border border-tt-border bg-tt-card px-4 py-2.5 text-[13px] backdrop-blur-xl">
            <span className="flex items-center gap-1.5 text-tt-muted">
              Elapsed
              <span className="font-semibold tabular-nums text-tt-text">
                {formatClock(elapsedSeconds)}
              </span>
            </span>
            <span className="flex items-center gap-1.5 text-tt-muted">
              Viewers
              <span className="font-semibold tabular-nums text-tt-text">{sessionViewers}</span>
            </span>
            {sessionPhase === 'complete' && (
              <span className="font-medium text-tt-muted">· Practice ended</span>
            )}
          </div>
        )}

        <div className="mt-4 grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)] lg:items-start">
          {/* Live host camera preview */}
          <div className="mx-auto w-full max-w-[260px] lg:mx-0 lg:max-w-none">
            <TrainerVideoView
              sessionId={sessionId}
              comments={previewComments}
              auction={{
                phase: previewPhase,
                bid: currentBid,
                seconds: previewSeconds,
                winner: currentWinner,
                soldAt: previewSoldAt,
              }}
            />
          </div>

          {/* Controls */}
          <div className="space-y-4">
            {/* Auction controls */}
        <section className="space-y-3 rounded-2xl border border-tt-border bg-tt-card p-4 backdrop-blur-xl">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">Auction</span>
            <span className="text-[13px] text-tt-muted">
              {auctionRunning
                ? `Running · $${currentBid.toFixed(2)}${currentWinner ? ` · ${currentWinner}` : ''}`
                : 'Idle'}
            </span>
          </div>

          {/* Manual / Auto bidding mode */}
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] font-medium text-tt-muted">Bidding mode</span>
            <div className="inline-flex rounded-lg border border-tt-border bg-tt-input-bg p-0.5">
              <button
                type="button"
                onClick={() => setAutoBid(false)}
                aria-pressed={!autoBid}
                className={`min-h-[36px] cursor-pointer rounded-md px-3.5 text-[13px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/40 ${!autoBid ? 'bg-tt-card text-tt-text shadow-sm' : 'text-tt-muted hover:text-tt-text'}`}
              >
                Manual
              </button>
              <button
                type="button"
                onClick={() => setAutoBid(true)}
                aria-pressed={autoBid}
                className={`min-h-[36px] cursor-pointer rounded-md px-3.5 text-[13px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40 ${autoBid ? 'bg-[#FE2C55] text-white' : 'text-tt-muted hover:text-tt-text'}`}
              >
                Auto
              </button>
            </div>
          </div>

          {autoBid && (
            <div className="flex items-center gap-2 text-[12px]">
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${autoBidActive ? 'bg-[#00B66C] motion-safe:animate-pulse' : 'bg-tt-yellow'}`}
              />
              <span className="text-tt-muted">
                {autoBidActive
                  ? 'Auto bidding on · +$1 bids · max $20'
                  : autoBidCapped
                    ? 'Auto bidding paused · max $20 reached'
                    : 'Auto bidding armed — start an auction to begin'}
              </span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => send({ action: 'startAuction' })}
              disabled={!connected || auctionRunning}
              className="flex min-h-[44px] cursor-pointer items-center justify-center rounded-xl bg-[#00B66C] px-4 text-[15px] font-semibold text-white transition-[filter] duration-200 hover:brightness-110 active:brightness-95 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
            >
              Start auction
            </button>
            <button
              type="button"
              onClick={() => send({ action: 'resetAuction' })}
              disabled={!connected}
              className="flex min-h-[44px] cursor-pointer items-center justify-center rounded-xl border border-tt-border bg-tt-input-bg px-4 text-[15px] font-medium text-tt-text transition-colors duration-200 hover:bg-tt-card-hover disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/40"
            >
              Reset auction
            </button>
          </div>

          <button
            type="button"
            onClick={() => send({ action: 'placeBid', username: randomUsername() })}
            disabled={!connected || !auctionRunning}
            className="flex min-h-[48px] w-full cursor-pointer items-center justify-center rounded-xl bg-[#FE2C55] text-[16px] font-bold text-white transition-[filter] duration-200 hover:brightness-110 active:brightness-95 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          >
            Place bid (+$1)
          </button>
          {!auctionRunning && (
            <p className="text-[12px] text-tt-muted">Start an auction to place bids.</p>
          )}
        </section>

        {/* Comments */}
        <section className="space-y-3 rounded-2xl border border-tt-border bg-tt-card p-4 backdrop-blur-xl">
          <span className="text-sm font-semibold">Comments</span>

          <div className="flex gap-2">
            <input
              type="text"
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCustomSend();
              }}
              aria-label="Custom comment"
              placeholder="Custom comment…"
              className="min-w-0 flex-1 rounded-lg border border-tt-input-border bg-tt-input-bg px-3 py-2.5 text-sm text-tt-text transition-colors focus:border-tt-cyan focus:outline-none"
            />
            <button
              type="button"
              onClick={handleCustomSend}
              disabled={!connected || !customText.trim()}
              className="flex min-h-[44px] shrink-0 cursor-pointer items-center justify-center rounded-lg bg-gradient-to-r from-tt-cyan to-[#4db8c0] px-5 text-sm font-semibold text-black transition-opacity duration-200 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/50"
            >
              Send
            </button>
          </div>

          <div className="flex flex-wrap gap-2">
            {COMMENTS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => sendComment(c)}
                disabled={!connected}
                className="cursor-pointer rounded-full border border-tt-border bg-tt-input-bg px-3 py-2 text-[12px] text-tt-text transition-colors duration-200 hover:bg-tt-card-hover disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/40"
              >
                {c}
              </button>
            ))}
          </div>
        </section>
          </div>
        </div>
      </div>
    </div>
  );
}
