import { BREAK_INVALID_ERROR, BREAK_TOO_LONG_ERROR } from './punchEdit';
import { laWallTimeToUtc, addDaysISO } from '@/lib/schedule/timezone';

// The client half of the manual-worked creation path (migration 131's
// lensed_create_manual_worked_shift): what the manager sees when the server refuses, and what the
// "Add Worked Time" button prefills the form with.
//
// Pure on purpose — every half is unit-tested directly, and none of it needs a browser, a
// Supabase client, or React to be proved. The only import beyond sibling validators is
// schedule/timezone, which is itself import-free and owns the DST-correct LA conversion; the
// eligibility rule below needs a real instant, and re-deriving that here is how two paths drift.

// ── refusal messages ─────────────────────────────────────────────────────────

// The RPC raises SHORT STABLE TOKENS, never sentences, for the same reason the confirm RPCs do:
// the wording is a product decision that belongs in the client, and a migration is a bad place to
// keep copy. Everything below maps a token to a manager-readable sentence; anything unrecognised
// falls through to a generic line, so a raw Postgres error can never reach the UI.
export const WORKED_TIME_OVERLAP_MESSAGE =
  'Worked time already exists for this employee during that period. Edit the existing shift instead.';
export const OPEN_SHIFT_MESSAGE = 'This person already has an open shift — end it first.';
export const EMPLOYEE_NOT_FOUND_MESSAGE = 'That employee is no longer available.';
export const GENERIC_CREATE_FAILED_MESSAGE = "Couldn't save this worked time. Please try again.";

/** The shape of a supabase-js error, narrowed to what the mapping reads. */
export interface RpcErrorLike {
  code?: string | null;
  message?: string | null;
}

export const OPEN_PUNCH_CONFLICT_MESSAGE =
  'This employee is currently clocked in over these hours. Clock them out with the real time first, then record any correction.';
export const UNRECONCILED_PUNCH_MESSAGE =
  'There is a recorded punch for these hours that has not become a shift yet. It will be paid once it reconciles, so adding worked time here would pay twice.';

export function manualWorkedErrorMessage(err: RpcErrorLike): string {
  const msg = err.message ?? '';
  // Token match first: the SQLSTATE is a coarser signal (22023 covers three different refusals)
  // and PostgREST has been known to reshape codes, but the raised token is stable.
  if (msg.includes('WORKED_TIME_OVERLAP')) return WORKED_TIME_OVERLAP_MESSAGE;
  if (msg.includes('BREAK_TOO_LONG')) return BREAK_TOO_LONG_ERROR;
  if (msg.includes('BREAK_INVALID')) return BREAK_INVALID_ERROR;
  if (msg.includes('EMPLOYEE_NOT_FOUND')) return EMPLOYEE_NOT_FOUND_MESSAGE;
  // Raw-punch conflicts are a DIFFERENT problem from an existing shift overlapping, and the fix
  // is different too, so they get their own sentences. Both name the next action rather than just
  // refusing — the manager has to resolve the punch, not retype the times.
  if (msg.includes('OPEN_PUNCH_CONFLICT')) return OPEN_PUNCH_CONFLICT_MESSAGE;
  if (msg.includes('UNRECONCILED_PUNCH_OVERLAP')) return UNRECONCILED_PUNCH_MESSAGE;
  // The partial unique index idx_shifts_one_open_per_employee (migration 052) still fires on the
  // INSERT inside the RPC — it is a different rule from overlap and keeps its own wording.
  if (err.code === '23505') return OPEN_SHIFT_MESSAGE;
  if (err.code === '23P01') return WORKED_TIME_OVERLAP_MESSAGE;
  return GENERIC_CREATE_FAILED_MESSAGE;
}

// ── prefill ──────────────────────────────────────────────────────────────────

export interface WorkedTimePrefill {
  employeeIds: string[];
  date: string;
  /** 'HH:MM' — the granularity <input type="time"> works at. */
  start: string;
  end: string;
  breakMinutes: number;
}

/** 'HH:MM' from an 'HH:MM' / 'HH:MM:SS' time string. */
function hhmm(t: string): string {
  return t.slice(0, 5);
}

/**
 * What the Worked / Missed Punch form opens at when it is reached from a "Did not clock in" card.
 *
 * These are PREFILLS, not a record of anything: the scheduled span is the best available guess at
 * what the person worked, and the manager is expected to correct it before saving. Break starts at
 * 0 because no break was observed — inventing one would be as much a fabrication as inventing a
 * punch.
 *
 * Returns null when the tile has no scheduled span to copy, which is the same condition
 * canAddWorkedTime() refuses on — so a caller that checked the affordance can never get null, and
 * one that did not gets a safe answer rather than a half-filled form.
 */
export function workedTimePrefill(
  person: { employee_id: string; scheduled: { start_time: string; end_time: string } | null },
  dateISO: string,
): WorkedTimePrefill | null {
  if (!person.scheduled) return null;
  return {
    employeeIds: [person.employee_id],
    date: dateISO,
    start: hhmm(person.scheduled.start_time),
    end: hhmm(person.scheduled.end_time),
    breakMinutes: 0,
  };
}


// ── eligibility: when may a manager add worked time? ─────────────────────────

/**
 * The UTC instant an LA-local scheduled span ENDS.
 *
 * `end_time <= start_time` means the span crosses midnight, so the end lands on the NEXT calendar
 * day — the same wrap rule as shiftHours()/isOvernight()/wallClockSpanMinutes(). Without it a
 * 16:00–02:00 shift would look like it ended at 02:00 on its own start date, i.e. fourteen hours
 * before it began, and every eligibility answer for an overnight shift would be wrong.
 *
 * Times are compared as INSTANTS, not wall clock, and the conversion is pinned to the business
 * timezone rather than the browser's — a manager in another zone must get the same answer.
 */
export function scheduledEndInstant(
  dateISO: string,
  scheduled: { start_time: string; end_time: string },
): Date {
  const start = hhmm(scheduled.start_time);
  const end = hhmm(scheduled.end_time);
  const endDate = end <= start ? addDaysISO(dateISO, 1) : dateISO;
  return laWallTimeToUtc(endDate, end);
}

/**
 * May the manager add worked time to this person-day?
 *
 * TRUE only when all three hold:
 *   • no worked record exists   — `punch` is built from `shifts` rows of ANY source, so a tile
 *                                 that already has manual OR time_clock time is excluded. Offering
 *                                 "add worked time" next to existing worked time is precisely how
 *                                 one shift becomes two payable rows.
 *   • something was scheduled   — the prefill copies the planned span; with no plan there is
 *                                 nothing to copy and the manager should use the Add-shift modal.
 *   • the scheduled period is OVER — a shift that has not finished must never be one click from
 *                                 being paid. Someone may still clock in.
 *
 * WHY THIS NO LONGER READS `state`. DayPersonState is DAY-granular: classify() only reports
 * 'no_show' once the whole calendar day is behind us, so it cannot express "the shift ended two
 * hours ago" and it made a same-day miss wait until midnight to be correctable. Comparing against
 * the real end instant is strictly more precise and subsumes it — a past day's shift ended in the
 * past, so it still qualifies. The states that DO need excluding ('open', 'pending', 'confirmed')
 * all imply a punch, which the first clause already rejects.
 *
 * This is an AFFORDANCE rule, never the boundary. lensed_create_manual_worked_shift (migration
 * 131) independently re-derives the real constraint — no overlapping worked time, including
 * against raw punches that have not become shifts yet — inside one transaction.
 */
export function canAddWorkedTimeAt(
  person: { punch: unknown | null; scheduled: { start_time: string; end_time: string } | null },
  dateISO: string,
  now: Date = new Date(),
): boolean {
  if (person.punch) return false;
  if (!person.scheduled) return false;
  // >= so a shift is eligible the instant it ends, not a minute later.
  return now.getTime() >= scheduledEndInstant(dateISO, person.scheduled).getTime();
}
