// Reconstructs a practice session's overlay from its event timeline.
//
// This is the half of "replay" that video cannot provide: the overlay was React DOM
// painted over the camera, never part of the recorded track, so playback re-renders
// it from practice_events. Pure and dependency-free — no React, no DOM — so it is
// unit-testable and the player is a thin shell over it.
//
// REPLAYED FROM ZERO ON EVERY SEEK, DELIBERATELY. A 30-minute session produces a
// few hundred events, so folding them all is microseconds; keeping incremental
// state across seeks would mean two code paths (forward playback and jump) that
// could disagree, which is exactly the bug that makes a replay quietly wrong.

import type { PracticeEventKind } from '@/lib/training/practiceLog';

export interface ReplayEvent {
  session_offset_ms: number;
  kind: PracticeEventKind;
  payload: Record<string, unknown>;
}

export interface ReplayComment {
  id: number;
  username: string;
  text: string;
}

export interface ReplayState {
  viewers: number;
  comments: ReplayComment[];
  auction: {
    phase: 'idle' | 'running' | 'ended';
    bid: number;
    seconds: number;
    winner: string | null;
    soldAt: number | null;
  };
  // True once session_complete has passed — the player dims the overlay rather
  // than pretending the session is still live.
  complete: boolean;
}

// The host showed only the last four comments (LiveSimulator slices to -4), so the
// replay must too. Showing more would be a nicer UI and a less honest one.
const VISIBLE_COMMENTS = 4;

// Mirrors the host's auction timings so the countdown reads the same on playback.
const AUCTION_START_SECONDS = 10;
const AUCTION_BID_RESET_SECONDS = 7;
// How long the host held the "sold" card before resetting to idle.
const SOLD_LINGER_MS = 2800;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function emptyReplayState(): ReplayState {
  return {
    viewers: 0,
    comments: [],
    auction: { phase: 'idle', bid: 0, seconds: AUCTION_START_SECONDS, winner: null, soldAt: null },
    complete: false,
  };
}

// The overlay exactly as it stood at `offsetMs` into the session.
//
// `events` MUST be sorted by session_offset_ms (the API returns them that way, and
// the DB index is on that column). Unsorted input would fold in the wrong order and
// produce a state the host never saw.
export function stateAtOffset(events: ReplayEvent[], offsetMs: number): ReplayState {
  const s = emptyReplayState();
  let commentId = 0;
  // When the running auction last had its clock set, so the countdown can be
  // derived rather than stored — the host never logged a per-second tick, and
  // logging one would have tripled the timeline for something computable.
  let auctionClockSetAt = 0;
  let auctionClockFrom = AUCTION_START_SECONDS;
  let endedAt: number | null = null;

  for (const e of events) {
    if (e.session_offset_ms > offsetMs) break;

    switch (e.kind) {
      case 'viewers':
        s.viewers = num(e.payload.count);
        break;

      case 'comment':
        commentId += 1;
        s.comments.push({
          id: commentId,
          username: str(e.payload.username),
          text: str(e.payload.text),
        });
        if (s.comments.length > VISIBLE_COMMENTS) s.comments.shift();
        break;

      case 'block': {
        // The host removed that commenter's visible comments AND suppressed them
        // afterwards. Suppression needs no handling here: a blocked user's later
        // comments were never logged in the first place (the host logs after the
        // block check), so simply dropping the visible ones reproduces the screen.
        const username = str(e.payload.username);
        s.comments = s.comments.filter((c) => c.username !== username);
        break;
      }

      case 'auction_start':
        s.auction = {
          phase: 'running',
          bid: 0,
          seconds: AUCTION_START_SECONDS,
          winner: null,
          soldAt: null,
        };
        auctionClockSetAt = e.session_offset_ms;
        auctionClockFrom = AUCTION_START_SECONDS;
        endedAt = null;
        break;

      case 'bid':
        // `total` is the applied running total the host displayed — not a delta to
        // re-add. This is why the log records outcomes rather than commands.
        s.auction.phase = 'running';
        s.auction.bid = num(e.payload.total);
        s.auction.winner = str(e.payload.username) || null;
        s.auction.soldAt = null;
        auctionClockSetAt = e.session_offset_ms;
        auctionClockFrom = AUCTION_BID_RESET_SECONDS;
        break;

      case 'auction_end':
        s.auction.phase = 'ended';
        s.auction.soldAt = num(e.payload.sold_at);
        s.auction.bid = num(e.payload.sold_at);
        s.auction.winner = (e.payload.winner as string | null) ?? null;
        s.auction.seconds = 0;
        endedAt = e.session_offset_ms;
        break;

      case 'auction_reset':
        s.auction = {
          phase: 'idle',
          bid: 0,
          seconds: AUCTION_START_SECONDS,
          winner: null,
          soldAt: null,
        };
        endedAt = null;
        break;

      case 'session_complete':
        s.complete = true;
        break;

      case 'session_start':
      default:
        break;
    }
  }

  // Derive the live countdown from when the clock was last set.
  if (s.auction.phase === 'running') {
    const elapsed = Math.floor((offsetMs - auctionClockSetAt) / 1000);
    s.auction.seconds = Math.max(0, auctionClockFrom - elapsed);
  }

  // The host reset the sold card to idle after a short linger. Without this the
  // replay would show "sold" frozen on screen for the rest of the session.
  if (endedAt !== null && offsetMs - endedAt > SOLD_LINGER_MS) {
    s.auction = { phase: 'idle', bid: 0, seconds: AUCTION_START_SECONDS, winner: null, soldAt: null };
  }

  return s;
}

// Where each auction sits in the timeline, for the scrub bar's markers. This is the
// thing that makes a 30-minute recording actually reviewable: a manager wants the
// four moments the candidate ran an auction, not to scrub blindly.
export interface ReplayMarker {
  offsetMs: number;
  label: string;
  soldAt: number | null;
}

export function auctionMarkers(events: ReplayEvent[]): ReplayMarker[] {
  const out: ReplayMarker[] = [];
  let n = 0;
  for (const e of events) {
    if (e.kind !== 'auction_start') continue;
    n += 1;
    // Pair it with its outcome, if the session got that far.
    const end = events.find(
      (x) => x.kind === 'auction_end' && x.session_offset_ms > e.session_offset_ms,
    );
    out.push({
      offsetMs: e.session_offset_ms,
      label: `Auction ${n}`,
      soldAt: end ? num(end.payload.sold_at) : null,
    });
  }
  return out;
}

// How far into the SESSION the video starts.
//
// Recording begins after the camera has been acquired and published, so the video
// is missing the first second or two of the session and every event offset must be
// shifted by that much to line up. Both timestamps are written server-side (the
// session's by its first heartbeat, the recording's by the start route), so this
// involves no client clock and cannot be skewed by a phone.
//
// It is an APPROXIMATION, and honest about it: the true zero is when egress attached
// its first frame, which only LiveKit knows and does not report. Expect ±1-2s, which
// is why the player exposes a nudge.
export function replayOffsetMs(
  sessionStartedAt: string | null,
  recordingStartedAt: string | null,
): number {
  if (!sessionStartedAt || !recordingStartedAt) return 0;
  const a = Date.parse(sessionStartedAt);
  const b = Date.parse(recordingStartedAt);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  // Never negative: a recording cannot begin before its session.
  return Math.max(0, b - a);
}
