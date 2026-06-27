'use client';

import { useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import LiveOverlay from './LiveOverlay';
import { COMMENTS, HOST_NAME, USERNAMES, type LiveComment } from './simulatorData';

type SessionState = 'idle' | 'requesting' | 'running' | 'denied' | 'complete';
type AuctionPhase = 'idle' | 'running' | 'ended';

const SESSION_SECONDS = 20 * 60; // 20-minute practice session
const AUCTION_START_SECONDS = 10;
const AUCTION_BID_RESET_SECONDS = 7;
const AUCTION_MAX_BID = 4;

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Weighted final price so auctions vary: most end at $2-$3, occasionally $4,
// sometimes just $1. The goal is pacing practice, not pricing realism.
function pickAuctionTarget(): number {
  const r = Math.random();
  if (r < 0.2) return 1;
  if (r < 0.5) return 2;
  if (r < 0.8) return 3;
  return AUCTION_MAX_BID;
}

function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function clearIntervalRef(ref: MutableRefObject<ReturnType<typeof setInterval> | null>) {
  if (ref.current !== null) {
    clearInterval(ref.current);
    ref.current = null;
  }
}

function clearTimeoutRef(ref: MutableRefObject<ReturnType<typeof setTimeout> | null>) {
  if (ref.current !== null) {
    clearTimeout(ref.current);
    ref.current = null;
  }
}

export default function LiveSimulator() {
  const [sessionState, setSessionState] = useState<SessionState>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [sessionSeconds, setSessionSeconds] = useState(SESSION_SECONDS);
  const [viewers, setViewers] = useState(0);
  const [comments, setComments] = useState<LiveComment[]>([]);

  const [auctionPhase, setAuctionPhase] = useState<AuctionPhase>('idle');
  const [auctionBid, setAuctionBid] = useState(0);
  const [auctionSeconds, setAuctionSeconds] = useState(AUCTION_START_SECONDS);
  const [auctionWinner, setAuctionWinner] = useState<string | null>(null);
  const [auctionSoldAt, setAuctionSoldAt] = useState<number | null>(null);

  // Media
  const streamRef = useRef<MediaStream | null>(null);

  // Timers
  const sessionTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const viewerTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const commentTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const auctionTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const bidTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endedResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mutable runtime values (kept in refs so timer callbacks never read stale state)
  const sessionSecondsRef = useRef(SESSION_SECONDS);
  const viewersRef = useRef(0);
  const commentIdRef = useRef(0);
  const auctionBidRef = useRef(0);
  const auctionTargetRef = useRef(0);
  const auctionSecondsRef = useRef(AUCTION_START_SECONDS);
  const auctionActiveRef = useRef(false);

  // Attaches the live stream whenever the <video> mounts/remounts.
  function setVideoRef(el: HTMLVideoElement | null) {
    if (el && streamRef.current && el.srcObject !== streamRef.current) {
      el.srcObject = streamRef.current;
      void el.play().catch(() => {});
    }
  }

  function stopSessionTimers() {
    clearIntervalRef(sessionTickRef);
    clearIntervalRef(viewerTickRef);
    clearTimeoutRef(commentTimeoutRef);
  }

  function stopAuctionTimers() {
    clearIntervalRef(auctionTickRef);
    clearTimeoutRef(bidTimeoutRef);
    clearTimeoutRef(endedResetRef);
  }

  function stopStream() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }

  // ---- Comments: roughly 1-2/min with occasional quiet gaps ----
  function addComment() {
    commentIdRef.current += 1;
    const next: LiveComment = {
      id: commentIdRef.current,
      username: pick(USERNAMES),
      text: pick(COMMENTS),
    };
    setComments((prev) => [...prev, next].slice(-4));
  }

  function scheduleComment() {
    clearTimeoutRef(commentTimeoutRef);
    let delay = 18000 + Math.random() * 26000; // 18-44s
    if (Math.random() < 0.25) delay += 12000; // occasional longer quiet gap
    commentTimeoutRef.current = setTimeout(() => {
      addComment();
      scheduleComment();
    }, delay);
  }

  // ---- Viewer ramp: slow trickle, then accelerate, then fluctuate 200-800 ----
  function updateViewers() {
    const elapsed = SESSION_SECONDS - sessionSecondsRef.current;
    let v: number;
    if (elapsed < 120) {
      v = Math.max(1, Math.round(Math.pow(elapsed / 120, 1.6) * 9)); // 1 -> ~9
    } else if (elapsed < 240) {
      const t = (elapsed - 120) / 120;
      v = Math.round(10 + t * t * 250); // ~10 -> ~260 (accelerating)
    } else {
      v = viewersRef.current + Math.round((Math.random() - 0.5) * 110); // wander
    }
    const minV = elapsed < 240 ? 1 : 200;
    v = Math.min(800, Math.max(minV, v));
    viewersRef.current = v;
    setViewers(v);
  }

  // ---- Auction ----
  function scheduleBid() {
    clearTimeoutRef(bidTimeoutRef);
    const delay = 1500 + Math.random() * 2700; // 1.5-4.2s between bid attempts
    bidTimeoutRef.current = setTimeout(() => {
      if (!auctionActiveRef.current) return;
      if (
        auctionBidRef.current < auctionTargetRef.current &&
        auctionBidRef.current < AUCTION_MAX_BID &&
        auctionSecondsRef.current > 0
      ) {
        auctionBidRef.current += 1;
        setAuctionBid(auctionBidRef.current);
        setAuctionWinner(pick(USERNAMES));
        auctionSecondsRef.current = AUCTION_BID_RESET_SECONDS;
        setAuctionSeconds(AUCTION_BID_RESET_SECONDS);
        scheduleBid();
      }
      // else: target reached -> let the countdown run out and sell.
    }, delay);
  }

  function endAuction() {
    auctionActiveRef.current = false;
    clearIntervalRef(auctionTickRef);
    clearTimeoutRef(bidTimeoutRef);
    setAuctionSoldAt(auctionBidRef.current);
    setAuctionPhase('ended');
    // Briefly show the sold state, then reset the card to ready.
    endedResetRef.current = setTimeout(() => {
      setAuctionPhase('idle');
      setAuctionWinner(null);
      setAuctionBid(0);
      setAuctionSoldAt(null);
      setAuctionSeconds(AUCTION_START_SECONDS);
    }, 2800);
  }

  function startAuction() {
    if (auctionActiveRef.current) return;
    stopAuctionTimers();

    auctionTargetRef.current = pickAuctionTarget();
    auctionBidRef.current = 1; // opening bid $1.00
    auctionSecondsRef.current = AUCTION_START_SECONDS; // starts at 10s
    auctionActiveRef.current = true;

    setAuctionBid(1);
    setAuctionWinner(pick(USERNAMES));
    setAuctionSeconds(AUCTION_START_SECONDS);
    setAuctionSoldAt(null);
    setAuctionPhase('running');

    auctionTickRef.current = setInterval(() => {
      auctionSecondsRef.current -= 1;
      setAuctionSeconds(Math.max(0, auctionSecondsRef.current));
      if (auctionSecondsRef.current <= 0) {
        endAuction();
      }
    }, 1000);

    scheduleBid();
  }

  // ---- Session lifecycle ----
  function startRuntime() {
    stopSessionTimers();
    stopAuctionTimers();

    sessionSecondsRef.current = SESSION_SECONDS;
    setSessionSeconds(SESSION_SECONDS);
    viewersRef.current = 0;
    setViewers(0);
    setComments([]);

    auctionActiveRef.current = false;
    setAuctionPhase('idle');
    setAuctionWinner(null);
    setAuctionBid(0);
    setAuctionSoldAt(null);
    setAuctionSeconds(AUCTION_START_SECONDS);

    sessionTickRef.current = setInterval(() => {
      sessionSecondsRef.current -= 1;
      setSessionSeconds(sessionSecondsRef.current);
      if (sessionSecondsRef.current <= 0) {
        completePractice();
      }
    }, 1000);

    viewerTickRef.current = setInterval(updateViewers, 2500);
    updateViewers();
    scheduleComment();
  }

  function completePractice() {
    stopSessionTimers();
    stopAuctionTimers();
    auctionActiveRef.current = false;
    setAuctionPhase('idle');
    setSessionState('complete');
  }

  async function startPractice() {
    setErrorMsg(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setSessionState('denied');
      setErrorMsg('Camera is not supported in this browser.');
      return;
    }
    setSessionState('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: false,
      });
      streamRef.current = stream;
      setSessionState('running');
      startRuntime();
    } catch (err) {
      stopStream();
      const name = err instanceof DOMException ? err.name : '';
      setErrorMsg(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Camera access was blocked. Allow camera access, then try again.'
          : name === 'NotFoundError'
            ? 'No camera was found on this device.'
            : 'Could not start the camera. Please try again.',
      );
      setSessionState('denied');
    }
  }

  function restartPractice() {
    const live =
      !!streamRef.current &&
      streamRef.current.getVideoTracks().some((t) => t.readyState === 'live');
    if (live) {
      setSessionState('running');
      startRuntime();
    } else {
      stopStream();
      void startPractice();
    }
  }

  // Clean up everything on unmount.
  useEffect(() => {
    return () => {
      stopSessionTimers();
      stopAuctionTimers();
      stopStream();
    };
  }, []);

  // ---- Render ----
  if (sessionState === 'idle' || sessionState === 'requesting' || sessionState === 'denied') {
    return (
      <div
        className="fixed inset-0 z-[200] flex flex-col items-center justify-center bg-tt-bg px-6"
        style={{
          paddingTop: 'env(safe-area-inset-top)',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
        {sessionState === 'denied' ? (
          <div className="flex max-w-xs flex-col items-center gap-6 text-center">
            <p className="text-[15px] leading-relaxed text-tt-text">{errorMsg}</p>
            <button
              type="button"
              onClick={() => void startPractice()}
              className="inline-flex min-h-[52px] cursor-pointer items-center justify-center rounded-full bg-[#FE2C55] px-8 text-[17px] font-semibold text-white shadow-lg shadow-[#FE2C55]/30 transition-[filter] duration-200 hover:brightness-110 active:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
            >
              Try again
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void startPractice()}
            disabled={sessionState === 'requesting'}
            className="inline-flex min-h-[54px] cursor-pointer items-center justify-center rounded-full bg-[#FE2C55] px-9 text-[17px] font-semibold text-white shadow-lg shadow-[#FE2C55]/30 transition-[filter,opacity] duration-200 hover:brightness-110 active:brightness-95 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
          >
            {sessionState === 'requesting' ? 'Starting…' : 'Start Practice Live'}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[200] h-[100dvh] overflow-hidden bg-black">
      <video
        ref={setVideoRef}
        muted
        playsInline
        autoPlay
        className="absolute inset-0 h-full w-full -scale-x-100 object-cover"
      />
      {/* Legibility gradients */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-black/55 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-80 bg-gradient-to-t from-black/75 to-transparent" />

      <LiveOverlay
        hostName={HOST_NAME}
        viewers={viewers}
        sessionTimeLabel={formatClock(sessionSeconds)}
        comments={comments}
        auction={{
          phase: auctionPhase,
          bid: auctionBid,
          seconds: auctionSeconds,
          winner: auctionWinner,
          soldAt: auctionSoldAt,
        }}
        onStartAuction={startAuction}
      />

      {sessionState === 'complete' && (
        <div
          className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/70 px-6 text-center backdrop-blur-sm"
          style={{
            paddingTop: 'env(safe-area-inset-top)',
            paddingBottom: 'env(safe-area-inset-bottom)',
          }}
        >
          <h2 className="mb-6 text-2xl font-bold text-white">Practice complete</h2>
          <button
            type="button"
            onClick={restartPractice}
            className="inline-flex min-h-[54px] cursor-pointer items-center justify-center rounded-full bg-[#FE2C55] px-9 text-[17px] font-semibold text-white shadow-lg shadow-[#FE2C55]/30 transition-[filter] duration-200 hover:brightness-110 active:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
          >
            Start Practice Live
          </button>
        </div>
      )}
    </div>
  );
}
