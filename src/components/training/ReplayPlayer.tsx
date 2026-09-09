'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import LiveOverlay from './LiveOverlay';
import { HOST_NAME } from './simulatorData';
import { formatClock, SESSION_SECONDS } from './trainerEvents';
import {
  auctionMarkers,
  emptyReplayState,
  replayOffsetMs,
  stateAtOffset,
  type ReplayEvent,
} from '@/lib/training/replay';

interface ReplayRecording {
  id: string;
  status: 'recording' | 'complete' | 'failed';
  storage_path: string | null;
  duration_ms: number | null;
  size_bytes: number | null;
  error: string | null;
  started_at: string;
  url: string | null;
}

export interface ReplayData {
  session: {
    id: string;
    trainee_name: string | null;
    created_at: string;
    started_at: string | null;
    ended_at: string | null;
  };
  recordings: ReplayRecording[];
  events: ReplayEvent[];
  events_truncated: boolean;
}

// How far the nudge moves the overlay per press. The video/session offset is derived
// from two server timestamps and is accurate to a second or two (the true zero is
// when egress attached its first frame, which LiveKit does not report), so a
// reviewer occasionally needs to correct it by eye.
const NUDGE_MS = 500;

export default function ReplayPlayer({ data }: { data: ReplayData }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [recordingIndex, setRecordingIndex] = useState(0);
  const [videoMs, setVideoMs] = useState(0);
  const [nudgeMs, setNudgeMs] = useState(0);
  const [playing, setPlaying] = useState(false);

  const recording = data.recordings[recordingIndex] ?? null;

  // How far into the SESSION this video begins. Both timestamps are server-written,
  // so no phone clock is involved.
  const baseOffset = useMemo(
    () => replayOffsetMs(data.session.started_at, recording?.started_at ?? null),
    [data.session.started_at, recording?.started_at],
  );
  const overlayOffsetMs = videoMs + baseOffset + nudgeMs;

  // Folded from zero on every frame. A few hundred events makes this far cheaper
  // than the render it feeds, and it means a seek and normal playback go through
  // exactly the same code — so they cannot disagree.
  const state = useMemo(
    () => (data.events.length ? stateAtOffset(data.events, overlayOffsetMs) : emptyReplayState()),
    [data.events, overlayOffsetMs],
  );

  const markers = useMemo(() => auctionMarkers(data.events), [data.events]);
  const durationMs = recording?.duration_ms ?? 0;

  // Drive the overlay from the video's own clock via rAF rather than timeupdate,
  // which only fires ~4x/second and would make the auction countdown visibly lag.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) setVideoMs(v.currentTime * 1000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Jump to a moment in the SESSION (what a marker means), converting back into
  // video time.
  const seekToSessionMs = useCallback(
    (sessionMs: number) => {
      const v = videoRef.current;
      if (!v) return;
      // Land a beat BEFORE the auction starts, so a reviewer sees the run-up rather
      // than arriving mid-sentence.
      const target = Math.max(0, sessionMs - baseOffset - nudgeMs - 3000);
      v.currentTime = target / 1000;
      void v.play().catch(() => {});
    },
    [baseOffset, nudgeMs],
  );

  if (!recording) {
    return (
      <p className="text-[13px] text-tt-muted">
        No recording for this session. The timeline was captured
        {data.events.length > 0 ? ` (${data.events.length} moments)` : ''}, but no footage exists —
        recording may have been off when it ran.
      </p>
    );
  }
  if (recording.status !== 'complete' || !recording.url) {
    // Say WHY there is nothing to play. An empty video element with no explanation
    // is the failure this whole feature was built to avoid.
    return (
      <div className="rounded-xl border border-tt-border bg-tt-card p-4">
        <p className="text-[13px] font-semibold text-tt-red">
          {recording.status === 'failed' ? 'This recording failed' : 'This recording is still in progress'}
        </p>
        {recording.error && <p className="mt-1 text-[12px] text-tt-muted">{recording.error}</p>}
        {data.events.length > 0 && (
          <p className="mt-2 text-[12px] text-tt-muted">
            The timeline is intact ({data.events.length} moments), so what happened is still
            reviewable even though the footage is not.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      {/* The phone-shaped stage: real footage with the overlay re-rendered on top. */}
      <div className="relative mx-auto aspect-[9/16] w-full max-w-[360px] shrink-0 overflow-hidden rounded-2xl border border-tt-border bg-black">
        <video
          ref={videoRef}
          src={recording.url}
          className="absolute inset-0 h-full w-full object-cover"
          playsInline
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          controls={false}
        />
        {/* Same legibility gradients the host had, so the overlay reads the same. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-black/55 to-transparent" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-64 bg-gradient-to-t from-black/75 to-transparent" />

        <LiveOverlay
          readOnly
          hostName={data.session.trainee_name || HOST_NAME}
          viewers={state.viewers}
          sessionTimeLabel={formatClock(Math.max(0, SESSION_SECONDS - Math.floor(overlayOffsetMs / 1000)))}
          comments={state.comments}
          auction={state.auction}
          onStartAuction={() => {}}
          onBlockUser={() => {}}
          toast={null}
          showBidBump={false}
          endingInSeconds={null}
        />

        {state.complete && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-[13px] font-semibold text-white backdrop-blur-sm">
            Session ended
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="min-w-0 flex-1 space-y-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => {
              const v = videoRef.current;
              if (!v) return;
              if (v.paused) void v.play().catch(() => {});
              else v.pause();
            }}
            className="flex min-h-[44px] min-w-[100px] cursor-pointer items-center justify-center rounded-xl bg-[#FE2C55] px-5 text-[15px] font-semibold text-white transition-[filter] hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          >
            {playing ? 'Pause' : 'Play'}
          </button>
          <span className="text-[13px] tabular-nums text-tt-muted">
            {formatClock(Math.floor(videoMs / 1000))}
            {durationMs > 0 && ` / ${formatClock(Math.floor(durationMs / 1000))}`}
          </span>
        </div>

        {/* Scrub bar */}
        <input
          type="range"
          min={0}
          max={Math.max(1, durationMs)}
          value={Math.min(videoMs, Math.max(1, durationMs))}
          onChange={(e) => {
            const v = videoRef.current;
            if (v) v.currentTime = Number(e.target.value) / 1000;
          }}
          aria-label="Scrub the recording"
          className="w-full cursor-pointer accent-[#FE2C55]"
        />

        {/* Auction markers — the reason a 30-minute file is reviewable at all. A
            manager wants the moments the candidate ran an auction, not to scrub
            blindly through half an hour. */}
        <div>
          <div className="text-[12px] font-semibold text-tt-text">Jump to</div>
          {markers.length === 0 ? (
            <p className="mt-1 text-[12px] text-tt-muted">No auctions were run in this session.</p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              {markers.map((m) => (
                <button
                  key={m.offsetMs}
                  type="button"
                  onClick={() => seekToSessionMs(m.offsetMs)}
                  className="cursor-pointer rounded-full border border-tt-border bg-tt-input-bg px-3 py-1.5 text-[12px] text-tt-text transition-colors hover:bg-tt-card-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/40"
                >
                  {m.label}
                  {m.soldAt !== null && (
                    <span className="ml-1.5 tabular-nums text-tt-muted">${m.soldAt}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Sync nudge. The offset comes from two server timestamps and is accurate
            to a second or two; the true zero is when egress attached its first
            frame, which LiveKit never reports. Rather than pretend to precision,
            let the reviewer correct it by eye. */}
        <div className="flex items-center gap-2 text-[12px] text-tt-muted">
          <span>Overlay sync</span>
          <button
            type="button"
            onClick={() => setNudgeMs((n) => n - NUDGE_MS)}
            className="cursor-pointer rounded-md border border-tt-border bg-tt-input-bg px-2 py-1 tabular-nums text-tt-text hover:bg-tt-card-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/40"
            aria-label="Shift the overlay earlier"
          >
            −0.5s
          </button>
          <span className="w-16 text-center tabular-nums text-tt-text">
            {(nudgeMs / 1000).toFixed(1)}s
          </span>
          <button
            type="button"
            onClick={() => setNudgeMs((n) => n + NUDGE_MS)}
            className="cursor-pointer rounded-md border border-tt-border bg-tt-input-bg px-2 py-1 tabular-nums text-tt-text hover:bg-tt-card-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/40"
            aria-label="Shift the overlay later"
          >
            +0.5s
          </button>
        </div>

        {/* More than one recording happens when a host restarted mid-session. */}
        {data.recordings.length > 1 && (
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <span className="text-tt-muted">Take</span>
            {data.recordings.map((r, i) => (
              <button
                key={r.id}
                type="button"
                onClick={() => {
                  setRecordingIndex(i);
                  setNudgeMs(0);
                }}
                className={`cursor-pointer rounded-md px-2 py-1 tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/40 ${
                  i === recordingIndex
                    ? 'bg-tt-card text-tt-text'
                    : 'border border-tt-border bg-tt-input-bg text-tt-muted hover:text-tt-text'
                }`}
              >
                {i + 1}
                {r.status !== 'complete' && ' ⚠'}
              </button>
            ))}
          </div>
        )}

        {data.events_truncated && (
          <p className="text-[12px] text-tt-yellow">
            This timeline hit the read limit, so the overlay may stop updating before the video
            ends.
          </p>
        )}
        {data.events.length === 0 && (
          <p className="text-[12px] text-tt-muted">
            No timeline was recorded for this session, so the footage plays without an overlay.
          </p>
        )}
      </div>
    </div>
  );
}
