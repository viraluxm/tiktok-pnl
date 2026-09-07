// Pure scheduling-eligibility kernels — NO imports (server-safe, and unit-testable via the
// runtime-transpile pattern the other schedule tests use). The DB-bound orchestration in board.ts /
// claim.ts / adminShifts.ts calls into these so the two read paths can never disagree on what role
// a shift represents.

// ── The clock-in eligibility boundary ────────────────────────────────────────
// The ONLY statuses of a `shift_instances` row that may back a NEW punch (QR issuance, the kiosk's
// active-schedule window, the worker's clock controls). Derived from the statuses the rest of the
// system already treats as a live assignment — board.ts's FILLING, getMyShifts, mySchedule,
// claim.ts's same-day check, sms.ts's busy check and the /s clock-window predicate all use exactly
// this pair — and from the DB CHECK vocabulary (scheduled, released, claimed, worked, missed,
// cancelled), of which:
//   • scheduled / claimed → a live assignment for a specific person. ELIGIBLE.
//   • released            → no assignee (employee_id NULL); nobody to clock in.
//   • worked / missed     → the day is already resolved; a new punch would contradict it.
//   • cancelled           → the manager removed it from the schedule. NEVER eligible.
// Exported as a shared constant so a future read path cannot drift from this list. NOTE this is
// deliberately NARROWER than resolveScheduledSpan's set, which also accepts 'worked' because it
// answers a different question (what span was this person scheduled for, at confirm time).
export const CLOCK_ELIGIBLE_STATUSES = ['scheduled', 'claimed'] as const;

/** Whether a shift_instances row may back a NEW punch. Released rows are excluded twice over:
 *  by status and by having no assignee. */
export function isClockEligibleStatus(status: string | null | undefined): boolean {
  return status === 'scheduled' || status === 'claimed';
}

// The pay-role a released/open shift represents:
//   • released shift (released_by set) → the RELEASER's role (derived; the row carries no role)
//   • admin one-time open shift (source 'admin_open', no releaser) → the row's OWN `role` (mig 090)
//   • anything else → null (malformed for the board — not claimable)
// `releaserRole` is the looked-up employees.role of released_by (null when there's no releaser or it
// couldn't be resolved).
export function effectiveShiftRole(
  inst: { released_by: string | null; source: string; role?: string | null },
  releaserRole: string | null,
): string | null {
  if (inst.released_by) return releaserRole;
  if (inst.source === 'admin_open') return inst.role ?? null;
  return null;
}

export type AdminShiftPlan =
  | { ok: true; status: 'scheduled' | 'released'; role: string }
  | { ok: false; error: 'ROLE_REQUIRED' };

// Decide status + role for a one-time admin shift.
//   • assigned (employeeRole given) → status 'scheduled' (lands on the person's schedule); role is
//     the employee's own role, so any typed role input is ignored (no mismatch possible).
//   • unassigned → status 'released' (straight to the board); role is REQUIRED here and must be a
//     valid pay-role class, since there's no employee to derive it from (migration 090 header).
export function planAdminShift(input: {
  employeeRole: string | null; // the assigned employee's role, or null when unassigned
  role: string | null; // the typed role field (only consulted when unassigned)
}): AdminShiftPlan {
  if (input.employeeRole) return { ok: true, status: 'scheduled', role: input.employeeRole };
  if (input.role === 'host' || input.role === 'fulfillment') return { ok: true, status: 'released', role: input.role };
  return { ok: false, error: 'ROLE_REQUIRED' };
}

// Does an admin shift's [start,end) cross midnight (end on the NEXT calendar day)? Times are
// 'HH:MM' wall-clock. end <= start means overnight (end rolls to +1 day); end === start is caller-
// rejected as zero-length before this is used.
export function crossesMidnight(startHHMM: string, endHHMM: string): boolean {
  return toMins(endHHMM) <= toMins(startHHMM);
}

function toMins(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

// The /s page shows its empty state ONLY when the employee has nothing in ANY section — it is a
// FALLBACK, not a gate. Crucially it does NOT depend on whether the employee has recurring rules: a
// no-rules employee with a one-time assigned shift, a claimable board shift, or a pending claim must
// still see it. Content decides; rules never do. (The original bug gated the whole page on
// hasActiveRules, hiding one-time shifts and the board from exactly the roster they're meant for.)
export function scheduleIsEmpty(counts: { myShifts: number; board: number; pending: number }): boolean {
  return counts.myShifts === 0 && counts.board === 0 && counts.pending === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// REMOVING a scheduled shift (Remove Shift, MVP).
//
// Scope is deliberately narrow: an UNTOUCHED FUTURE ONE-OFF PLAN and nothing else. The removal
// path hard-deletes a `shift_instances` row, so anything that is not purely a plan — or that a
// payroll record already refers to — must be refused rather than quietly destroyed.
//
// WHY 'admin_open' ONLY. A 'pattern' instance is materialized from an active shift_rule, and the
// forward materializer's regeneration guard reads `attendance_events`, NOT the absence of a row —
// so a hard-deleted pattern instance is re-inserted on the next daily run. Deleting one would look
// like it worked and silently undo itself. 'claim' rows carry a shift_claims record (ON DELETE
// CASCADE) that is an OT approval trail. Neither belongs in this MVP.
//
// WHY THE PAYROLL CHECKS. `shift_instances` never feeds pay, so removing one cannot change what
// anyone is owed. These two checks are not about pay arithmetic — they are about not deleting the
// plan out from under a record that is actively referring to it: an open punch (the QR clock-in
// gate at /s/[token]/clock resolves the instance by id), and a worked `shifts` row on the same
// employee+date (the calendar pairs plan and punch on that key to show the clocked-vs-scheduled
// delta; dropping the plan half rewrites history).
//
// PURE: the caller supplies the facts, this decides. `startsAtMs`/`nowMs` are epoch millis from
// the row's authoritative `starts_at` timestamptz — never a wall-clock date string, so no local /
// UTC calendar-day assumption can creep in.
export type ShiftRemovalRefusal =
  | 'NOT_ONE_OFF'
  | 'NOT_SCHEDULED'
  | 'ALREADY_STARTED'
  | 'WORKED_TIME_EXISTS'
  | 'EMPLOYEE_CLOCKED_IN';

export type ShiftRemovalPlan = { ok: true } | { ok: false; code: ShiftRemovalRefusal };

export function planShiftRemoval(input: {
  source: string;
  status: string;
  startsAtMs: number; // Date.parse(starts_at)
  nowMs: number;
  hasWorkedShift: boolean; // a `shifts` row for the same employee + shift_date
  hasOpenPunch: boolean; // an employee_time_entries row with clocked_out_at IS NULL
}): ShiftRemovalPlan {
  if (input.source !== 'admin_open') return { ok: false, code: 'NOT_ONE_OFF' };
  if (input.status !== 'scheduled') return { ok: false, code: 'NOT_SCHEDULED' };
  // Fail CLOSED on an unparseable instant: refusing to remove is always recoverable, deleting the
  // wrong row is not. `starts_at` is NOT NULL in the schema, so this is a belt-and-braces branch.
  if (!Number.isFinite(input.startsAtMs) || input.startsAtMs <= input.nowMs) {
    return { ok: false, code: 'ALREADY_STARTED' };
  }
  if (input.hasWorkedShift) return { ok: false, code: 'WORKED_TIME_EXISTS' };
  if (input.hasOpenPunch) return { ok: false, code: 'EMPLOYEE_CLOCKED_IN' };
  return { ok: true };
}

// The manager-facing sentence for each refusal. Kept beside the kernel so the server, the tests
// and the UI can never drift into three different vocabularies for the same decision.
export const SHIFT_REMOVAL_MESSAGES: Record<ShiftRemovalRefusal, string> = {
  NOT_ONE_OFF: "This recurring shift can't be removed here.",
  NOT_SCHEDULED: 'This shift is no longer scheduled — it may have been released or claimed.',
  ALREADY_STARTED: "This shift has already started and can't be removed.",
  WORKED_TIME_EXISTS: 'This employee already has worked time for this date.',
  EMPLOYEE_CLOCKED_IN: 'This employee is currently clocked in.',
};
