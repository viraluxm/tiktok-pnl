// Shared window-containment rule for the member binding flow.
//
// /api/member/sessions uses this to decide which of a room's sessions are in-window candidates
// (vs the room-only fallback offered when NONE are), and /api/member/bind uses the SAME rule to
// stamp `out_of_window` into the audit trail. The two MUST NOT drift — if bind computed the window
// differently from what the picker showed, the audit would disagree with what the member saw.
// These two are the ONLY consumers; nothing else imports from this module.

// The grace is ASYMMETRIC, because the two edges fail for different reasons.
//
// START — 10 minutes. A live_sessions row is created by the FIRST capture_event, so `started_at`
// is when the extension attached and authenticated, not when the host began selling. Lots sold
// before the extension is up therefore fall outside the window, and they are systematically the
// first lots of the night. Across all 143 post-fix `live_ended` sessions (2026-07-22 → 08-15)
// there are exactly 9 such orders, every one before-start, spread 303s–441s early. The old 300s
// symmetric pad missed them by as little as 3s and as much as 141s. 600s clears the worst observed
// lead (441s) with 159s (~2.6 min) of margin.
export const START_GRACE_MS = 10 * 60 * 1000;

// END — 300 seconds, deliberately UNCHANGED from the previous symmetric grace.
// The end edge is not broken: across the same 143 sessions there are ZERO after-end containment
// failures, and the worst capture landing after a session's ended_at is 44.4s (p99 43.5s, 3 rows
// out of ~49,500). Widening this side would buy nothing and would start absorbing the NEXT show's
// orders in a room hosting back-to-back sessions, so it stays where it is.
export const END_GRACE_MS = 5 * 60 * 1000;

export type SessionWindow = {
  started_at: string | null;
  ended_at: string | null;
  created_at: string | null;
};

// True when capture timestamp `t` (ms epoch) falls within the session's window, padded by
// START_GRACE_MS before the start and END_GRACE_MS after the end. An unparseable start (both
// started_at and created_at absent) or a null/open end is treated as unbounded on that edge. When
// `t` itself is not finite we cannot window-filter, so every room session is a candidate —
// captured here as `true` (matches the picker's "no timestamp → all").
export function captureInWindow(t: number, s: SessionWindow): boolean {
  if (!Number.isFinite(t)) return true;
  const start = Date.parse(s.started_at ?? s.created_at ?? '');
  const end = Date.parse(s.ended_at ?? '');
  const startOk = !Number.isFinite(start) || t >= start - START_GRACE_MS;
  const endOk = !Number.isFinite(end) || t <= end + END_GRACE_MS;
  return startOk && endOk;
}
