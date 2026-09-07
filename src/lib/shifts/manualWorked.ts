import { BREAK_INVALID_ERROR, BREAK_TOO_LONG_ERROR } from './punchEdit';

// The client half of the manual-worked creation path (migration 130's
// lensed_create_manual_worked_shift): what the manager sees when the server refuses, and what the
// "Add Worked Time" button prefills the form with.
//
// Pure and dependency-free on purpose — both halves are unit-tested directly, and neither needs a
// browser, a Supabase client, or React to be proved.

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

export function manualWorkedErrorMessage(err: RpcErrorLike): string {
  const msg = err.message ?? '';
  // Token match first: the SQLSTATE is a coarser signal (22023 covers three different refusals)
  // and PostgREST has been known to reshape codes, but the raised token is stable.
  if (msg.includes('WORKED_TIME_OVERLAP')) return WORKED_TIME_OVERLAP_MESSAGE;
  if (msg.includes('BREAK_TOO_LONG')) return BREAK_TOO_LONG_ERROR;
  if (msg.includes('BREAK_INVALID')) return BREAK_INVALID_ERROR;
  if (msg.includes('EMPLOYEE_NOT_FOUND')) return EMPLOYEE_NOT_FOUND_MESSAGE;
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
