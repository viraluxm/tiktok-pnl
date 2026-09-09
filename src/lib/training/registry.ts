// Practice Mode session registry — pure, shared logic.
//
// Deliberately dependency-free (no React, no Supabase, no browser globals) so the
// API routes, the launcher and plain-Node tests all import the SAME derivation.
// The status of a practice session is the one thing both server and client must
// agree on, so it is computed in exactly one place.

// How often a running host reports that it is still alive. Ridden off the host's
// EXISTING per-second session tick rather than a new timer, so this is a throttle
// interval, not a polling loop.
export const PRACTICE_HEARTBEAT_MS = 15_000;

// How stale last_seen_at may be before a session stops counting as live. Three
// missed heartbeats: long enough that a slow request or a brief network blip does
// not make the launcher flap between live and stale, short enough that a phone
// that died is not still advertised as live a minute later.
export const PRACTICE_LIVE_WINDOW_MS = 45_000;

// One recording attached to a session (migration 143), as the list read returns it.
export interface PracticeRecordingRow {
  id: string;
  status: 'recording' | 'complete' | 'failed';
  duration_ms: number | null;
  size_bytes: number | null;
  error: string | null;
}

// A registry row as the API returns it. Timestamps are ISO strings (what
// PostgREST emits) rather than Date objects, so this type survives JSON.
export interface PracticeSessionRow {
  id: string;
  trainee_name: string | null;
  purpose: 'training' | 'audition';
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  last_seen_at: string | null;
  // How many timeline events this session recorded (migration 142). Present on the
  // list read so History can say what there is to replay; 0 for a session that
  // never ran.
  event_count: number;
  // This session's recordings, newest first. Empty when nothing was recorded.
  recordings: PracticeRecordingRow[];
  // The opaque token behind the public /p/<token> host link. Null for sessions
  // created before tokenised access existed — those still work via the admin host
  // route, they just cannot be handed to someone without a login.
  host_token: string | null;
}

// Human summary of a session's footage, for the History row.
//
// A session can have several recordings (restartPractice reuses the id), so this
// reports the whole set rather than assuming one. A FAILED recording is called out
// explicitly and in preference to a byte count: "there is footage" and "one of
// these did not record" are different facts, and the second is the one someone
// needs to act on.
export function describeRecordings(recordings: PracticeRecordingRow[]): {
  label: string;
  tone: 'none' | 'pending' | 'ok' | 'error';
  detail: string | null;
} {
  if (recordings.length === 0) return { label: 'No recording', tone: 'none', detail: null };

  const failed = recordings.filter((r) => r.status === 'failed');
  const running = recordings.filter((r) => r.status === 'recording');
  const done = recordings.filter((r) => r.status === 'complete');

  if (failed.length > 0) {
    return {
      label: done.length > 0 ? `${done.length} recorded · ${failed.length} failed` : 'Recording failed',
      tone: 'error',
      detail: failed[0].error,
    };
  }
  if (running.length > 0 && done.length === 0) {
    return { label: 'Recording…', tone: 'pending', detail: null };
  }

  const totalMs = done.reduce((n, r) => n + (r.duration_ms ?? 0), 0);
  const totalBytes = done.reduce((n, r) => n + (r.size_bytes ?? 0), 0);
  const mins = Math.round(totalMs / 60000);
  const mb = totalBytes > 0 ? `${(totalBytes / 1048576).toFixed(0)} MB` : null;
  const parts = [
    done.length > 1 ? `${done.length} recordings` : 'Recorded',
    totalMs > 0 ? (mins >= 1 ? `${mins}m` : `${Math.round(totalMs / 1000)}s`) : null,
    mb,
  ].filter(Boolean);
  return { label: parts.join(' · '), tone: 'ok', detail: null };
}

// Where a session is in its life:
//   created — the link exists but no host has ever started it (an audition no-show
//             is permanently in this state, which is exactly what we want to see)
//   live    — a host heartbeat landed within the live window
//   stale   — it started, then the heartbeats stopped without a clean finish
//             (tab closed, phone slept, browser killed). NOT the same as ended.
//   ended   — finished cleanly, or removed by an admin
export type PracticeStatus = 'created' | 'live' | 'stale' | 'ended';

// Parse an ISO timestamp to epoch ms, or null if absent/unparseable. Never throws:
// a malformed timestamp degrades to "no timestamp" instead of taking down a list
// render for every other session.
function epoch(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

// THE single definition of a practice session's status.
//
// Order matters. `ended_at` wins outright — a cleanly finished session must never
// read as live just because its final heartbeat is still inside the window (the
// two writes land within milliseconds of each other at the end of a session).
export function derivePracticeStatus(
  row: Pick<PracticeSessionRow, 'ended_at' | 'last_seen_at'>,
  nowMs: number = Date.now(),
): PracticeStatus {
  if (epoch(row.ended_at) !== null) return 'ended';
  const seen = epoch(row.last_seen_at);
  if (seen === null) return 'created';
  // A clock skewed into the future must not read as stale, so compare on the
  // absolute gap rather than assuming now >= seen.
  return Math.abs(nowMs - seen) <= PRACTICE_LIVE_WINDOW_MS ? 'live' : 'stale';
}

// True while a session is worth showing as active in the launcher's live count.
export function isPracticeLive(
  row: Pick<PracticeSessionRow, 'ended_at' | 'last_seen_at'>,
  nowMs: number = Date.now(),
): boolean {
  return derivePracticeStatus(row, nowMs) === 'live';
}

// Human labels for the launcher. Kept next to the type so adding a status forces
// a label (an exhaustive Record, not a lookup with a fallback).
export const PRACTICE_STATUS_LABEL: Record<PracticeStatus, string> = {
  created: 'Not started',
  live: 'Live',
  stale: 'Disconnected',
  ended: 'Ended',
};

// How long a session actually ran, for the History list.
//
// Measured started_at -> ended_at, NOT created_at -> ended_at: creating a link and
// starting a session are different moments (a link can sit unused for hours), so
// using created_at would report wall-clock idle time as practice time.
//
// A session with no started_at never ran at all — that is a real and meaningful
// outcome for an audition (a no-show), so it is labelled rather than shown as 0m.
export function formatPracticeRunLength(
  row: Pick<PracticeSessionRow, 'started_at' | 'ended_at'>,
  nowMs: number = Date.now(),
): string {
  const started = epoch(row.started_at);
  if (started === null) return 'Never started';
  // An un-ended row is still running: measure to now so History stays correct even
  // if a row lands here while a final write is in flight.
  const finished = epoch(row.ended_at) ?? nowMs;
  const secs = Math.max(0, Math.round((finished - started) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

// The two purposes a session can serve. NOT SURFACED IN THE UI: the
// training/audition distinction turned out not to matter operationally, so the
// launcher does not ask and the column simply takes its 'training' default. The
// constant and validator are kept because the CHECK constraint in migration 136 is
// still there — if a caller ever sends a purpose again, it must be a legal one.
export const PRACTICE_PURPOSES = ['training', 'audition'] as const;
export type PracticePurpose = (typeof PRACTICE_PURPOSES)[number];

export function isPracticePurpose(value: unknown): value is PracticePurpose {
  return typeof value === 'string' && (PRACTICE_PURPOSES as readonly string[]).includes(value);
}

// Trainee/candidate names are operator-typed free text. Trim, collapse to null when
// empty, and cap the length so a paste accident cannot write an unbounded string.
export const PRACTICE_TRAINEE_NAME_MAX = 80;

export function normalizeTraineeName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, PRACTICE_TRAINEE_NAME_MAX);
}
