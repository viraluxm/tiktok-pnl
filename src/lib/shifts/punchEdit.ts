import { laWallTimeToUtc, addDaysISO } from '@/lib/schedule/timezone';
import { isOvernight } from '@/lib/weeklySchedule';

// PUNCH INSTANTS ARE THE SINGLE SOURCE OF TRUTH FOR PAID HOURS.
//
// paidShiftHours (employees.ts:62-69) derives a time_clock shift's hours from
// clock_out_at − clock_in_at, and migration 097's CHECK constraint
// (shifts_time_clock_has_instants) guarantees every time_clock row carries both — so for a
// punch shift the start_time/end_time branch is statically unreachable. An edit that writes
// only the wall clock therefore changes nothing about pay. Editing a punch shift must edit
// the instants; this module does that conversion and nothing else.
//
// There is no adjustment layer and no coalesce: the instants ARE the corrected value.
// employee_time_entries is the raw badge log — never read by payroll, never written here.
//
// WHY THE TWO ENDPOINTS ARE CONVERTED SEPARATELY (this is the DST-safety argument):
// each of clock_in_at / clock_out_at is resolved from its OWN calendar date + time-of-day
// through laWallTimeToUtc, which pins America/Los_Angeles via the Intl database and does a
// two-pass offset correction. We never compute the out instant by adding a duration to the in
// instant — adding milliseconds assumes a 24-hour civil day and is wrong on both transitions.
//
// Concretely, the overnight shift dated 2026-10-31 (22:00→06:00) crosses the fall-back at
// 02:00 on Nov 1: in = Oct 31 22:00 PDT (UTC-7) = Nov 1 05:00Z, out = Nov 1 06:00 PST (UTC-8)
// = Nov 1 14:00Z ⇒ 9h elapsed for an 8h nominal span, which is the truth on a 25-hour day.
// Adding 8h of milliseconds to the in instant would have said 8h. Spring-forward is the mirror
// image: 2026-03-07 22:00→06:00 elapses 7h. Note the transition fires at 02:00 on the
// transition DATE, so a shift starting that same evening (e.g. dated Nov 1) is already on the
// post-transition offset at both ends and correctly measures a plain 8h.
// (laWallTimeToUtc's own DST proof lives in src/lib/schedule/timezone.test.mjs; the composed
// behaviour here is pinned in punchEdit.test.mjs §4.)

export interface PunchInstants {
  clock_in_at: string; // ISO-8601 UTC
  clock_out_at: string; // ISO-8601 UTC
}

// The punch instants for a corrected wall-clock span on a shift whose business date is
// `dateISO` ('YYYY-MM-DD', the Pacific calendar date the shift books to).
//
// The overnight rule is NOT re-derived here: isOvernight() is the predicate form of the same
// "end < start ⇒ the shift ran past midnight" rule that shiftHours()/durationHours() encode
// (weeklySchedule.ts:52-55, parity-asserted against employees.ts). When it holds, the OUT
// instant resolves against the NEXT calendar day.
export function punchInstantsForWallClock(
  dateISO: string,
  startTime: string,
  endTime: string,
): PunchInstants {
  const outDateISO = isOvernight(startTime, endTime) ? addDaysISO(dateISO, 1) : dateISO;
  return {
    clock_in_at: laWallTimeToUtc(dateISO, startTime).toISOString(),
    clock_out_at: laWallTimeToUtc(outDateISO, endTime).toISOString(),
  };
}

// Thrown when an edit would reopen a time_clock shift (end_time → null). That would null
// clock_out_at and violate migration 097's CHECK constraint, so it is refused here with a
// readable message rather than surfacing a raw 23514 from Postgres. In practice unreachable:
// lensed_clock_out is the only creator of time_clock rows and always sets an end (verified
// against live: 0 time_clock rows with a null end_time).
export const REOPEN_PUNCH_ERROR =
  "This is a time-clock shift — it can't be reopened. Correct its start and end times instead, " +
  'or unconfirm it if it should not be paid.';

// The row as stored, for the fields this decision needs. `source` and `date` must come from the
// ROW, never from a caller's card model (which carries no source and can be stale) — getting
// this branch wrong in either direction corrupts pay.
export interface EditableShiftRow {
  source: string | null;
  date: string;
  start_time: string;
  end_time: string | null;
}

export interface ShiftEditPatch {
  start_time?: string;
  end_time?: string | null;
  clock_in_at?: string;
  clock_out_at?: string;
}

// The exact column patch for a start/end-time edit. THE single place that decides which layer a
// correction lands in, shared by useShifts.updateShift and its test so neither reimplements it.
//
//   * time_clock → punch instants (the pay basis) AND the wall clock, kept in sync. Both
//     instants are recomputed whenever EITHER side changes, because the out instant's calendar
//     date depends on the start/end pair via the overnight rule — a start-only edit can move it.
//   * manual → the wall clock only. Instants stay NULL (097's CHECK exempts non-time_clock rows)
//     and paidShiftHours already reads the wall clock for them.
//
// Returns null when there is nothing to change. That case must NOT fall through to a write:
// recomputing instants from the stored wall clock on a row nobody edited would overwrite a real
// punch with a derived value — which for the 44 known diverging rows would be a silent backfill.
export function buildShiftEditPatch(
  row: EditableShiftRow,
  edit: { start_time?: string; end_time?: string | null },
): ShiftEditPatch | null {
  if (edit.start_time === undefined && edit.end_time === undefined) return null;

  const patch: ShiftEditPatch = {};
  if (edit.start_time !== undefined) patch.start_time = edit.start_time;
  if (edit.end_time !== undefined) patch.end_time = edit.end_time;
  if (row.source !== 'time_clock') return patch;

  // Effective span after this edit: the new value where supplied, else what is stored.
  const nextStart = edit.start_time !== undefined ? edit.start_time : row.start_time;
  const nextEnd = edit.end_time !== undefined ? edit.end_time : row.end_time;
  if (nextEnd == null) throw new Error(REOPEN_PUNCH_ERROR);
  return { ...patch, ...punchInstantsForWallClock(row.date, nextStart, nextEnd) };
}
