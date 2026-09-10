// Practice Mode event timeline — pure logic (migration 139).
//
// Dependency-free (no React, no fetch, no browser globals) so the host, the API
// route and plain-Node tests share ONE definition of what an event is and how its
// offset is computed. The clock is injected, so timing behaviour is testable
// without fake timers.

// ─────────────────────────────────────────────────────────────────────────────
// What we record
//
// OUTCOMES, NOT COMMANDS. Deliberately NOT the existing TrainerEvent messages: the
// controller's commands cannot reconstruct the screen. Only the host knows the
// TOTAL a bid reached, who the winner was, and that a blocked user's comment was
// never displayed at all. So the host writes this log and each entry says what the
// screen actually did.
export const PRACTICE_EVENT_KINDS = [
  'session_start',
  'comment',
  'bid',
  'auction_start',
  'auction_end',
  'auction_reset',
  'block',
  'viewers',
  'session_complete',
] as const;

export type PracticeEventKind = (typeof PRACTICE_EVENT_KINDS)[number];

export interface PracticeLogEvent {
  // Milliseconds since session start, from a MONOTONIC clock (performance.now()).
  // Never wall-clock: a practice host is a phone, and a skewed phone clock would
  // desync the entire replay invisibly.
  session_offset_ms: number;
  kind: PracticeEventKind;
  payload: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tuning

// How often the host ships its buffer. Batched because one request per comment
// would mean ~20 hosts each firing a request per keystroke-ish event.
export const PRACTICE_LOG_FLUSH_MS = 2_000;

// Server-side ceiling on one request, so a pathological client cannot post an
// unbounded array.
export const PRACTICE_LOG_MAX_BATCH = 500;

// Client-side buffer ceiling. Only reachable if flushing fails for a long stretch
// (offline). A 30-minute session normally produces a few hundred events, so this
// is ~5x headroom.
export const PRACTICE_LOG_MAX_BUFFER = 2_000;

// Viewer count is sampled every 2.5s by the host's existing ramp, which would be
// ~720 rows per session for a purely cosmetic number. Logged at most this often
// instead; the replay step-holds between samples.
export const PRACTICE_VIEWERS_LOG_MS = 10_000;

// Guards against a paste or a runaway string turning one event into a huge row.
export const PRACTICE_PAYLOAD_MAX_CHARS = 2_000;

export function isPracticeEventKind(value: unknown): value is PracticeEventKind {
  return (
    typeof value === 'string' && (PRACTICE_EVENT_KINDS as readonly string[]).includes(value)
  );
}

// Server-side validation of one event. Returns null when acceptable, or a reason.
// Shared with the client only so the two agree; the ROUTE is the enforcer.
export function validatePracticeEvent(event: unknown): string | null {
  if (typeof event !== 'object' || event === null) return 'event must be an object';
  const e = event as Partial<PracticeLogEvent>;
  if (!isPracticeEventKind(e.kind)) return `unknown kind: ${String(e.kind)}`;
  const off = e.session_offset_ms;
  // A negative offset would sort ahead of session_start and corrupt the replay's
  // opening state, so it is rejected rather than clamped — a client producing one
  // is broken and should be noticed.
  if (typeof off !== 'number' || !Number.isSafeInteger(off) || off < 0) {
    return 'session_offset_ms must be a non-negative integer';
  }
  if (typeof e.payload !== 'object' || e.payload === null || Array.isArray(e.payload)) {
    return 'payload must be a plain object';
  }
  if (JSON.stringify(e.payload).length > PRACTICE_PAYLOAD_MAX_CHARS) return 'payload too large';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The buffer

export interface PracticeLogBuffer {
  // Sets the monotonic epoch every offset is measured from, and clears state.
  start(nowMs: number): void;
  // Records an event. Returns false if it was dropped (buffer full, or a viewers
  // sample arriving inside the throttle window).
  add(kind: PracticeEventKind, payload: Record<string, unknown>, nowMs: number): boolean;
  // Removes and returns up to `max` events, oldest first, for sending.
  take(max: number): PracticeLogEvent[];
  // Returns a failed batch to the FRONT of the queue so a network error does not
  // lose it. Without this, take() + a failed POST would silently drop events.
  requeue(events: PracticeLogEvent[]): void;
  size(): number;
  // Events lost to the buffer ceiling. Exposed so an incomplete timeline can be
  // reported rather than quietly presented as complete.
  dropped(): number;
}

export function createPracticeLogBuffer(): PracticeLogBuffer {
  let epoch: number | null = null;
  let queue: PracticeLogEvent[] = [];
  let lastViewersAt = -Infinity;
  let droppedCount = 0;

  return {
    start(nowMs) {
      epoch = nowMs;
      queue = [];
      lastViewersAt = -Infinity;
      droppedCount = 0;
    },

    add(kind, payload, nowMs) {
      // No epoch means the session has not started; an event now would carry a
      // meaningless offset, so refuse it rather than invent one.
      if (epoch === null) return false;

      if (kind === 'viewers') {
        if (nowMs - lastViewersAt < PRACTICE_VIEWERS_LOG_MS) return false;
        lastViewersAt = nowMs;
      }

      if (queue.length >= PRACTICE_LOG_MAX_BUFFER) {
        // Full. Sacrifice the oldest VIEWERS sample first — it is cosmetic and the
        // replay step-holds across the gap. Only if there is none do we drop a
        // semantic event, and then the OLDEST, so the end of the session (where a
        // reviewer is usually heading) survives.
        const i = queue.findIndex((e) => e.kind === 'viewers');
        queue.splice(i === -1 ? 0 : i, 1);
        droppedCount++;
      }

      queue.push({
        // Math.max guards against a non-monotonic reading; performance.now() should
        // never go backwards, but an offset must never be negative.
        session_offset_ms: Math.max(0, Math.round(nowMs - epoch)),
        kind,
        payload,
      });
      return true;
    },

    take(max) {
      return queue.splice(0, Math.max(0, max));
    },

    requeue(events) {
      if (events.length === 0) return;
      queue = [...events, ...queue];
    },

    size() {
      return queue.length;
    },

    dropped() {
      return droppedCount;
    },
  };
}
