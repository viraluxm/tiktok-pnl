// Per-session distance for the binding picker (O4).
//
// The picker previously exposed only a flat `in_window` boolean, so an operator seeing "no session
// contains this order" next to an apparently-matching session had no way to tell whether the miss
// was six minutes or six hours. This reports HOW FAR outside the order is, and in which direction.
//
// Deliberately SEPARATE from src/lib/member/sessionWindow.ts: that module owns the containment
// PREDICATE (with GRACE_MS) and is shared with the bind audit trail. This one is purely descriptive
// and is measured against the RAW window edges, with no grace applied — so an order 3 minutes
// before start reads "3 min before start" even though GRACE_MS puts it in-window. That is the
// intended reading: the operator is told the true offset, and containment is decided elsewhere.

export type DistanceDirection = 'before_start' | 'after_end' | 'within';

export interface SessionDistance {
  direction: DistanceDirection;
  /** Absolute offset from the nearest raw window edge, in seconds. 0 when `within`. */
  seconds: number;
}

export interface DistanceWindow {
  started_at: string | null;
  ended_at: string | null;
  created_at: string | null;
}

/**
 * Distance from capture timestamp `t` (ms epoch) to the session's raw window.
 * Returns null when it cannot be established (unparseable capture time, or a session with no
 * usable start) — the caller renders nothing rather than a misleading zero.
 * An open-ended session (no ended_at) is never `after_end`.
 */
export function sessionDistance(t: number, s: DistanceWindow): SessionDistance | null {
  if (!Number.isFinite(t)) return null;
  const start = Date.parse(s.started_at ?? s.created_at ?? '');
  if (!Number.isFinite(start)) return null;
  if (t < start) return { direction: 'before_start', seconds: Math.round((start - t) / 1000) };
  const end = Date.parse(s.ended_at ?? '');
  if (Number.isFinite(end) && t > end) return { direction: 'after_end', seconds: Math.round((t - end) / 1000) };
  return { direction: 'within', seconds: 0 };
}
