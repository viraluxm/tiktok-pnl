// Shared window-containment rule for the member binding flow.
//
// /api/member/sessions uses this to decide which of a room's sessions are in-window candidates
// (vs the room-only fallback offered when NONE are), and /api/member/bind uses the SAME rule to
// stamp `out_of_window` into the audit trail. The two MUST NOT drift — if bind computed the window
// differently from what the picker showed, the audit would disagree with what the member saw.

// Grace on BOTH edges. From the window-mismatch distribution a 5-minute pad recovers ~53 rows (vs
// ~13 at 60s) while staying clear of the >30min multi-session tail where grace could surface the
// wrong show. Since the member manually picks, a modest pad only adds true-session options near a
// show's edges — it never auto-binds. Tune here (single source of truth for both routes).
export const GRACE_MS = 5 * 60 * 1000;

export type SessionWindow = {
  started_at: string | null;
  ended_at: string | null;
  created_at: string | null;
};

// True when capture timestamp `t` (ms epoch) falls within the session's window ± GRACE. An
// unparseable start (both started_at and created_at absent) or a null/open end is treated as
// unbounded on that edge. When `t` itself is not finite we cannot window-filter, so every room
// session is a candidate — captured here as `true` (matches the picker's "no timestamp → all").
export function captureInWindow(t: number, s: SessionWindow): boolean {
  if (!Number.isFinite(t)) return true;
  const start = Date.parse(s.started_at ?? s.created_at ?? '');
  const end = Date.parse(s.ended_at ?? '');
  const startOk = !Number.isFinite(start) || t >= start - GRACE_MS;
  const endOk = !Number.isFinite(end) || t <= end + GRACE_MS;
  return startOk && endOk;
}
