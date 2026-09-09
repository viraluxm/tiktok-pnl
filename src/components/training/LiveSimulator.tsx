'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import LiveOverlay from './LiveOverlay';
import { HOST_NAME, type LiveComment } from './simulatorData';
import {
  SESSION_SECONDS,
  SESSION_ENDING_SECONDS,
  formatClock,
  type TrainerEvent,
} from './trainerEvents';
import { PRACTICE_VIDEO_CAPTURE } from '@/lib/training/media';
import { useSessionChannel } from '@/lib/training/useSessionChannel';
import { useVideoPublish } from '@/lib/training/useVideoPublish';
import { usePracticeHeartbeat } from '@/lib/training/usePracticeHeartbeat';
import { usePracticeLog } from '@/lib/training/usePracticeLog';
import { usePracticeRecording } from '@/lib/training/usePracticeRecording';
import { shortTrainingSessionLabel } from '@/lib/training/session';
import { practiceEndpoints, type PracticeTransport } from '@/lib/training/transport';

type SessionState = 'idle' | 'requesting' | 'running' | 'denied' | 'complete';
type AuctionPhase = 'idle' | 'running' | 'ended';

const AUCTION_START_SECONDS = 10;
const AUCTION_BID_RESET_SECONDS = 7;

function jitter(magnitude: number): number {
  return Math.round((Math.random() - 0.5) * magnitude);
}

// Resolve the dollar increment for a bid. Manual bids carry no amount → +$1
// (unchanged). Auto bids carry an integer amount; sanitize defensively (finite,
// >= 1) and clamp to a safe max so a malformed value can never corrupt the total.
function bidIncrement(amount: number | undefined): number {
  if (amount === undefined) return 1;
  if (!Number.isFinite(amount)) return 1;
  return Math.min(40, Math.max(1, Math.round(amount)));
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

// `transport` decides which API surface this host talks to and which Realtime
// client it builds. 'admin' is the signed-in staff path; 'token' is an audition
// candidate on their own phone with no Lensed account, holding only an opaque
// per-session token. The mode is threaded through rather than sniffed, so there is
// never any doubt at a call site about which credentials are in play.
export default function LiveSimulator({
  sessionId,
  transport = { mode: 'admin', sessionId },
}: {
  sessionId: string;
  transport?: PracticeTransport;
}) {
  // Memoised on the two values it derives from, so the endpoint object is stable
  // and the hooks below do not re-subscribe on every render.
  const endpoints = useMemo(
    () => practiceEndpoints(transport),
    [transport.mode, transport.token], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // A tokenised page must never construct the cookie-managing Supabase client.
  const sessionless = transport.mode === 'token';
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
  const [showBidBump, setShowBidBump] = useState(false); // brief +7s indicator when a bid resets the timer
  // TRUE when the running session has no microphone track. Practice ran silently
  // for a long time (an app-wide `microphone=()` header denied every request while
  // startPractice's catch quietly re-requested video-only), and nothing on either
  // screen said so. The header is fixed, but a denied prompt or a mic-less device
  // still lands in the same fallback — so the condition is surfaced rather than
  // swallowed. It is also a hard precondition for recording: a track-composite
  // egress needs an audio track to name.
  const [micMissing, setMicMissing] = useState(false);

  // Media
  const streamRef = useRef<MediaStream | null>(null);
  // Tracks whether the host component is still mounted, so an in-flight
  // getUserMedia that resolves after unmount can't start the camera/LiveKit.
  const mountedRef = useRef(true);

  // Timers
  const sessionTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const viewerTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const auctionTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const endedResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mutable runtime values (kept in refs so timer/channel callbacks never read stale state)
  const sessionSecondsRef = useRef(SESSION_SECONDS);
  const viewersRef = useRef(0);
  const commentIdRef = useRef(0);
  const auctionBidRef = useRef(0);
  const auctionSecondsRef = useRef(AUCTION_START_SECONDS);
  const auctionActiveRef = useRef(false);
  // endAuction fires from the auction tick's closure, so the winner must come from
  // a ref — reading auctionWinner state there would log a stale (or null) winner.
  const auctionWinnerRef = useRef<string | null>(null);
  // Mirrors micMissing for broadcastSessionState, which runs inside the session
  // tick's closure and would otherwise read a stale value.
  const micMissingRef = useRef(false);

  // Moderation (block/remove) — session-only, in-memory
  const blockedRef = useRef<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const toastRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bidBumpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Realtime: receive trainer commands. Comments/bids are driven by the
  // controller (no automation). Declared early so channelSend is available to
  // the handlers below; handleEvent is hoisted.
  const { send: channelSend, status: channelStatus } = useSessionChannel(
    sessionId,
    'host',
    handleEvent,
    sessionless,
  );

  // Best-effort: publish the existing camera track to LiveKit for the trainer preview.
  const { publish: publishVideo, stop: stopVideo } = useVideoPublish(sessionId, endpoints);

  // Reports liveness to the shared session registry so every admin's launcher can
  // see which sessions are actually running. Self-throttling, so it rides the
  // per-second session tick below rather than adding a timer of its own.
  const {
    beat: registryBeat,
    end: registryEnd,
    unregistered: sessionUnregistered,
  } = usePracticeHeartbeat(sessionId, endpoints);

  // Records what this screen actually DID, so a replay can re-render the overlay
  // over the footage (the overlay is DOM, not part of the video track). The host is
  // the only party that knows the applied bid total, the winner, and which comments
  // were suppressed — so the emit points below sit where each outcome is decided,
  // never where a command arrives.
  const practiceLog = usePracticeLog(sessionId, endpoints);

  // Server-side recording (LiveKit Cloud track-composite egress). Additive: a
  // failure never stops the practice, but it IS shown — see the indicator below.
  const recording = usePracticeRecording(sessionId, endpoints);

  function handleEvent(event: TrainerEvent) {
    switch (event.action) {
      case 'comment':
        addComment(event.username, event.text);
        break;
      case 'placeBid':
        placeBid(event.username, event.amount);
        break;
      case 'startAuction':
        startAuction();
        break;
      case 'resetAuction':
        resetAuction();
        break;
      default:
        // 'auctionState' is host->controller only; ignored here.
        break;
    }
  }

  function broadcastAuctionState(running: boolean, bid: number, winner: string | null) {
    channelSend({ action: 'auctionState', running, bid, winner });
  }

  // The host owns the authoritative session clock + viewer count; mirror both to
  // the controller (elapsed timer, viewer count, ending countdown). Emitted on
  // the EXISTING per-second session tick — no extra timer.
  function broadcastSessionState(phase: 'running' | 'complete') {
    channelSend({
      action: 'sessionState',
      secondsLeft: Math.max(0, sessionSecondsRef.current),
      viewers: viewersRef.current,
      phase,
      // Mirrored so the controller can warn management that this session has no
      // audio BEFORE they spend 30 minutes on a silent audition. Read from a ref
      // because this runs inside the session tick's closure.
      micMissing: micMissingRef.current,
    });
  }

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
  }

  function stopAuctionTimers() {
    clearIntervalRef(auctionTickRef);
    clearTimeoutRef(endedResetRef);
  }

  function stopStream() {
    // Tear down the LiveKit publish BEFORE stopping the local tracks so the
    // trainer doesn't see a frozen last frame.
    void stopVideo();
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }

  // ---- Comments: driven by the trainer controller ----
  function addComment(username: string, text: string) {
    if (blockedRef.current.has(username)) return; // blocked user suppressed
    // Logged AFTER the suppression check, so the timeline holds only comments the
    // host really showed. Logging the incoming command instead would make a replay
    // display a comment that never appeared on screen.
    practiceLog.event('comment', { username, text });
    commentIdRef.current += 1;
    const next: LiveComment = { id: commentIdRef.current, username, text };
    setComments((prev) => [...prev, next].slice(-4));
  }

  function showToast(message: string) {
    clearTimeoutRef(toastRef);
    setToast(message);
    toastRef.current = setTimeout(() => setToast(null), 1800);
  }

  // Block/remove a commenter: drop their visible comments and silence them for
  // the rest of this practice session (reset on restart / reload).
  function blockUser(comment: LiveComment) {
    blockedRef.current.add(comment.username);
    practiceLog.event('block', { username: comment.username });
    setComments((prev) => prev.filter((c) => c.username !== comment.username));
    showToast('User blocked');
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
      v = viewersRef.current + jitter(110); // wander
    }
    const minV = elapsed < 240 ? 1 : 200;
    v = Math.min(800, Math.max(minV, v));
    viewersRef.current = v;
    // Throttled inside the buffer to PRACTICE_VIEWERS_LOG_MS: the ramp samples every
    // 2.5s, which would be ~720 rows a session for a cosmetic number the replay
    // step-holds anyway.
    practiceLog.event('viewers', { count: v });
    setViewers(v);
  }

  // ---- Auction (rules live here; the controller sends commands) ----
  function startAuction() {
    if (auctionActiveRef.current) return;
    stopAuctionTimers();

    auctionBidRef.current = 0; // no bids yet at start
    auctionSecondsRef.current = AUCTION_START_SECONDS; // starts at 10s
    auctionActiveRef.current = true;

    setAuctionBid(0);
    setAuctionWinner(null);
    setAuctionSeconds(AUCTION_START_SECONDS);
    setAuctionSoldAt(null);
    setAuctionPhase('running');
    auctionWinnerRef.current = null;
    practiceLog.event('auction_start', {});

    auctionTickRef.current = setInterval(() => {
      auctionSecondsRef.current -= 1;
      setAuctionSeconds(Math.max(0, auctionSecondsRef.current));
      if (auctionSecondsRef.current <= 0) {
        endAuction();
      }
    }, 1000);

    broadcastAuctionState(true, 0, null);
  }

  // A fake bid from the controller. Manual bids carry no amount → +$1 (unchanged);
  // auto bids carry a sanitized integer amount (1–40). New winner, reset to 7s.
  // Defense in depth: bids are ignored unless an auction is actively running.
  function placeBid(username: string, amount?: number) {
    if (!auctionActiveRef.current) return;
    if (auctionSecondsRef.current <= 0) return;

    const increment = bidIncrement(amount);
    auctionBidRef.current += increment;
    // The outcome, not the command: the resulting TOTAL is what the screen showed,
    // and is the thing the controller's placeBid message cannot know.
    practiceLog.event('bid', { username, increment, total: auctionBidRef.current });
    setAuctionBid(auctionBidRef.current);
    setAuctionWinner(username);
    auctionWinnerRef.current = username;
    auctionSecondsRef.current = AUCTION_BID_RESET_SECONDS;
    setAuctionSeconds(AUCTION_BID_RESET_SECONDS);

    // Trigger the brief +7s indicator on the host.
    setShowBidBump(true);
    clearTimeoutRef(bidBumpTimerRef);
    bidBumpTimerRef.current = setTimeout(() => setShowBidBump(false), 1000);

    broadcastAuctionState(true, auctionBidRef.current, username);
  }

  function endAuction() {
    auctionActiveRef.current = false;
    clearIntervalRef(auctionTickRef);
    setAuctionSoldAt(auctionBidRef.current);
    setAuctionPhase('ended');
    practiceLog.event('auction_end', {
      sold_at: auctionBidRef.current,
      winner: auctionWinnerRef.current,
    });
    broadcastAuctionState(false, auctionBidRef.current, null);
    // Briefly show the sold state, then reset the card to ready.
    clearTimeoutRef(endedResetRef);
    endedResetRef.current = setTimeout(() => {
      setAuctionPhase('idle');
      setAuctionWinner(null);
      setAuctionBid(0);
      setAuctionSoldAt(null);
      setAuctionSeconds(AUCTION_START_SECONDS);
    }, 2800);
  }

  // Manual reset from the controller: clear the auction back to ready immediately.
  function resetAuction() {
    auctionActiveRef.current = false;
    practiceLog.event('auction_reset', {});
    stopAuctionTimers();
    auctionBidRef.current = 0;
    auctionSecondsRef.current = AUCTION_START_SECONDS;
    setAuctionPhase('idle');
    setAuctionBid(0);
    setAuctionWinner(null);
    auctionWinnerRef.current = null;
    setAuctionSoldAt(null);
    setAuctionSeconds(AUCTION_START_SECONDS);
    broadcastAuctionState(false, 0, null);
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
    blockedRef.current = new Set();
    clearTimeoutRef(toastRef);
    setToast(null);

    auctionActiveRef.current = false;
    auctionBidRef.current = 0;
    setAuctionPhase('idle');
    setAuctionWinner(null);
    setAuctionBid(0);
    setAuctionSoldAt(null);
    setAuctionSeconds(AUCTION_START_SECONDS);
    auctionWinnerRef.current = null;

    // Sets the monotonic epoch EVERY offset is measured from, so it must run before
    // any other emit below (updateViewers fires immediately after this).
    practiceLog.start();

    sessionTickRef.current = setInterval(() => {
      sessionSecondsRef.current -= 1;
      setSessionSeconds(sessionSecondsRef.current);
      if (sessionSecondsRef.current <= 0) {
        completePractice();
      } else {
        broadcastSessionState('running');
        // Registry heartbeat. Called every second but self-throttled to one
        // request per PRACTICE_HEARTBEAT_MS, so this adds no timer and stops
        // automatically whenever the session clock stops.
        registryBeat();
      }
    }, 1000);

    viewerTickRef.current = setInterval(updateViewers, 2500);
    updateViewers();
    // Beat once up front so the launcher shows the session as live immediately
    // rather than up to one heartbeat interval later.
    registryBeat();
    // Initial mirror so the controller isn't blank for up to a second.
    broadcastSessionState('running');
  }

  function completePractice() {
    stopSessionTimers();
    stopAuctionTimers();
    auctionActiveRef.current = false;
    setAuctionPhase('idle');
    setSessionState('complete');
    // Tell the controller the live has ended (stops its elapsed timer + countdown,
    // and is the clean stop-signal a future auto-bidder will hook into).
    broadcastSessionState('complete');
    // Release the camera + microphone and tear down the LiveKit publish via the
    // SAME canonical path used on unmount. Without this a finished session kept
    // capturing and uploading until its tab was closed — with ~20 tabs that is a
    // large amount of pointless Wi-Fi traffic and a camera light left on. Ordered
    // after the broadcast so the 'complete' message is queued first. stopStream()
    // is idempotent (roomRef/streamRef are nulled), so the unmount cleanup and
    // restartPractice() can both call it again safely.
    stopStream();
    // Close the timeline and ship what is left immediately, rather than waiting up
    // to one flush interval while the session is already over.
    practiceLog.finish();
    // Ask egress to stop. Only the fast path — LiveKit finalises by itself when the
    // room empties, so a host that closes the tab still gets a file.
    recording.stop();
    // Record the clean finish in the registry. Best-effort: an un-ended session
    // decays from 'live' to 'Disconnected' on its own once heartbeats stop, so a
    // failure here costs a label, not correctness.
    registryEnd();
  }

  async function startPractice() {
    setErrorMsg(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setSessionState('denied');
      setErrorMsg('Camera is not supported in this browser.');
      return;
    }
    setSessionState('requesting');

    // Prefer camera + microphone (so the trainer can hear the host); fall back
    // to video-only if the mic is denied/unavailable so the simulator still works.
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: PRACTICE_VIDEO_CAPTURE,
        audio: true,
      });
    } catch {
      // Bail if the host navigated away during the first permission prompt —
      // don't re-acquire the camera on an unmounted component.
      if (!mountedRef.current) return;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: PRACTICE_VIDEO_CAPTURE,
          audio: false,
        });
      } catch (err) {
        stopStream();
        if (!mountedRef.current) return; // no setState after unmount
        const name = err instanceof DOMException ? err.name : '';
        setErrorMsg(
          name === 'NotAllowedError' || name === 'SecurityError'
            ? 'Camera access was blocked. Allow camera access, then try again.'
            : name === 'NotFoundError'
              ? 'No camera was found on this device.'
              : 'Could not start the camera. Please try again.',
        );
        setSessionState('denied');
        return;
      }
    }

    // If the component unmounted while the permission prompt was open, the
    // promise can resolve after cleanup — stop the orphaned tracks and bail
    // (no streamRef assignment, no LiveKit publish, no state update).
    if (!mountedRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    streamRef.current = stream;
    // One check for both acquisition paths: the audio:false fallback above, and a
    // first-call success that returned no audio track anyway.
    const noMic = stream.getAudioTracks().length === 0;
    micMissingRef.current = noMic;
    setMicMissing(noMic);
    setSessionState('running');
    startRuntime();
    // Publish, then start recording with the SIDs it returns. Sequenced (not
    // parallel) because a track-composite egress is defined BY those SIDs, so it
    // cannot be requested until the tracks actually exist in the room.
    void publishVideo(stream).then((published) => {
      if (!mountedRef.current) return;
      void recording.start(published);
    });
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
    mountedRef.current = true; // re-arm on (re)mount, incl. StrictMode setup->cleanup->setup
    return () => {
      mountedRef.current = false;
      stopSessionTimers();
      stopAuctionTimers();
      clearTimeoutRef(toastRef);
      clearTimeoutRef(bidBumpTimerRef);
      stopStream(); // also tears down the LiveKit publish (calls stopVideo)
    };
    // unmount-only teardown; stopStream is intentionally not a dependency
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        onBlockUser={blockUser}
        toast={toast}
        showBidBump={showBidBump}
        endingInSeconds={
          sessionSeconds > 0 && sessionSeconds <= SESSION_ENDING_SECONDS ? sessionSeconds : null
        }
      />

      {/* Session label: unobtrusive, so a trainer can confirm host↔controller pairing. */}
      <div
        className="pointer-events-none absolute left-3 z-30 rounded-md bg-black/40 px-2 py-1 text-[10px] font-medium tabular-nums text-white/70 backdrop-blur-sm"
        style={{ top: 'calc(env(safe-area-inset-top) + 0.75rem)' }}
      >
        Session: {shortTrainingSessionLabel(sessionId)}
      </div>

      {/* No-microphone warning. pointer-events-none so it can never swallow a tap
          on the overlay beneath it; not dismissible, because a silent session is a
          real defect for the whole run rather than a transient notice. */}
      {micMissing && (
        <div
          role="status"
          className="pointer-events-none absolute left-3 z-30 max-w-[70%] rounded-md bg-tt-yellow/90 px-2 py-1 text-[10px] font-semibold leading-snug text-black"
          style={{ top: 'calc(env(safe-area-inset-top) + 2.5rem)' }}
        >
          No microphone — this session has no audio. Allow mic access and restart.
        </div>
      )}

      {/* This session id is not in the shared registry, so it is invisible in every
          manager's launcher (a hand-typed or stale link). The practice itself still
          works, which is exactly why it needs saying. */}
      {sessionUnregistered && (
        <div
          role="status"
          className="pointer-events-none absolute left-3 z-30 max-w-[70%] rounded-md bg-black/60 px-2 py-1 text-[10px] font-semibold leading-snug text-white/90 backdrop-blur-sm"
          style={{ top: `calc(env(safe-area-inset-top) + ${micMissing ? '4.6rem' : '2.5rem'})` }}
        >
          Not in the session list — created outside Practice Mode.
        </div>
      )}

      {/* Recording state. Unlike the live preview, a recording failure must be
          visible on the host's own screen — a silently unrecorded audition cannot
          be redone. 'dry-run' appears while PRACTICE_RECORDING_WRITE_ENABLED is
          unset, so a test run is never mistaken for a real recording. */}
      {recording.state.kind !== 'idle' && (
        <div
          role="status"
          className="pointer-events-none absolute right-3 z-30 max-w-[62%] rounded-md px-2 py-1 text-[10px] font-semibold leading-snug backdrop-blur-sm"
          style={{
            top: 'calc(env(safe-area-inset-top) + 2.75rem)',
            background:
              recording.state.kind === 'failed'
                ? 'rgba(254,44,85,0.92)'
                : recording.state.kind === 'dry-run'
                  ? 'rgba(0,0,0,0.6)'
                  : 'rgba(0,0,0,0.55)',
            color: '#fff',
          }}
        >
          {recording.state.kind === 'recording'
            ? '● Recording'
            : recording.state.kind === 'dry-run'
              ? 'Recording OFF (dry run) — nothing is being saved'
              : `Not recording — ${recording.state.reason}`}
        </div>
      )}

      {/* Realtime is how comments and bids arrive. If the channel is down the host
          sees a working camera and an inexplicably silent audience, so say so. This
          matters most on the tokenised page, whose session-less anon client is a
          different Realtime path from the signed-in one. */}
      {channelStatus === 'error' && (
        <div
          role="status"
          className="pointer-events-none absolute left-3 right-3 z-30 rounded-md bg-tt-yellow/90 px-2 py-1 text-center text-[10px] font-semibold leading-snug text-black"
          style={{ top: 'calc(env(safe-area-inset-top) + 5.2rem)' }}
        >
          Trainer channel unavailable — comments and bids will not appear.
        </div>
      )}

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
