import { laWallTimeToUtc, laWallClockOf, addDaysISO } from '@/lib/schedule/timezone';
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

// The row as stored, for the fields these decisions need. `source` must come from the ROW (or a
// card faithfully carrying it) — getting the branch wrong in either direction corrupts pay.
export interface EditableShiftRow {
  source: string | null;
  date: string;
  start_time: string;
  end_time: string | null;
  clock_in_at?: string | null;
  clock_out_at?: string | null;
  /** Current unpaid break. Absent/null reads as 0 — the column is NOT NULL DEFAULT 0. */
  break_minutes?: number | null;
}

// 'HH:MM' from an 'HH:MM' / 'HH:MM:SS' time string — the granularity the operator's
// <input type="time"> works at, and therefore the granularity every comparison here uses.
function hhmm(t: string): string {
  return t.slice(0, 5);
}

// A time_clock row's hours come from its instants, so the instants are also what the edit form
// must OPEN AT. Prefilling from start_time/end_time on one of the diverging rows would show the
// stale wall clock and — since a save recomputes instants from the fields — write it straight
// over the good punch. Manual rows have no instants and keep their wall clock.
//
// This is the single definition of "the wall clock this row currently means", used by the modal
// to prefill AND by buildShiftEditPatch to detect change, so prefill and write cannot disagree.
export function shiftEditPrefill(row: EditableShiftRow): { start: string; end: string } {
  if (row.source === 'time_clock' && row.clock_in_at && row.clock_out_at) {
    return {
      start: laWallClockOf(row.clock_in_at).time,
      end: laWallClockOf(row.clock_out_at).time,
    };
  }
  return { start: hhmm(row.start_time), end: row.end_time == null ? '' : hhmm(row.end_time) };
}

export interface ShiftEditPatch {
  start_time?: string;
  end_time?: string | null;
  clock_in_at?: string;
  clock_out_at?: string;
  break_minutes?: number;
}

// Rejected before any write. paidShiftHours() floors at 0, so a break >= the span would not
// error — it would silently pay the person nothing. That is exactly the failure this refuses.
export const BREAK_TOO_LONG_ERROR = 'Break must be shorter than the shift.';
export const BREAK_INVALID_ERROR = 'Break must be a whole number of minutes, 0 or more.';

// The span, in minutes, that PAY will use for this row after the edit — the same branch
// paidShiftHours() takes, so validation cannot accept a break that pay would then floor to zero:
//   * time_clock  → the punch instants (post-edit when the times changed, else the stored pair).
//                   Their span has no 24h ceiling, which is the whole reason pay reads them.
//   * manual/etc. → the wall clock, overnight-wrapped.
// Returns null when no span can be determined (an open shift), which callers treat as "cannot
// validate an upper bound" rather than as zero.
function paySpanMinutes(
  row: EditableShiftRow,
  nextStart: string,
  nextEnd: string | null,
  instants: PunchInstants | null,
): number | null {
  if (nextEnd == null) return null; // open shift — no completed span
  if (row.source === 'time_clock') {
    const inAt = instants ? instants.clock_in_at : row.clock_in_at;
    const outAt = instants ? instants.clock_out_at : row.clock_out_at;
    if (inAt && outAt) {
      const mins = (Date.parse(outAt) - Date.parse(inAt)) / 60_000;
      return Number.isFinite(mins) ? mins : null;
    }
  }
  return wallClockSpanMinutes(nextStart, nextEnd);
}

// The wall-clock span in minutes, overnight-wrapped — the same `end <= start ⇒ next day` rule as
// shiftHours()/isOvernight(). Exported because CREATING a manual worked shift needs the identical
// upper bound for its break, and a second copy of the wrap rule is exactly how two paths drift.
// Returns null for an open shift (no completed span), which callers read as "no upper bound".
export function wallClockSpanMinutes(startTime: string, endTime: string | null): number | null {
  if (endTime == null) return null;
  const toMin = (t: string) => {
    const [h, m] = t.split(':');
    return (Number(h) || 0) * 60 + (Number(m) || 0);
  };
  const startM = toMin(startTime);
  let endM = toMin(endTime);
  if (endM <= startM) endM += 1440; // overnight
  return endM - startM;
}

// THE break invariant, in two halves so each is asserted exactly where the edit path already
// asserts it (shape always; the span bound only once a change is known to be real — a no-op save
// must not start failing because a stored break happens to equal its span).
//
// Shared with the manual-worked CREATION path so the two cannot drift. The RPC re-asserts both
// server-side; these give the manager the message before a round trip.
export function assertBreakShape(next: number): void {
  if (!Number.isFinite(next) || !Number.isInteger(next) || next < 0) {
    throw new Error(BREAK_INVALID_ERROR);
  }
}

export function assertBreakFitsSpan(next: number, spanMinutes: number | null): void {
  // A break equal to the span pays zero; longer pays zero too (paidShiftHours floors). Both are
  // refused so the manager sees why instead of silently wiping the shift's pay.
  if (spanMinutes != null && next >= spanMinutes) throw new Error(BREAK_TOO_LONG_ERROR);
}

// The exact column patch for a start/end-time edit. THE single place that decides which layer a
// correction lands in, shared by useShifts.updateShift and its test so neither reimplements it.
//
//   * time_clock → punch instants (the pay basis) AND the wall clock, kept in sync.
//   * manual → the wall clock only. Instants stay NULL (097's CHECK exempts non-time_clock rows)
//     and paidShiftHours already reads the wall clock for them.
//
// AN UNCHANGED ENDPOINT'S INSTANT IS NEVER REWRITTEN. Change is judged against
// shiftEditPrefill — what the form opened at — at MINUTE granularity, because that is all the
// operator can express. Real punches carry seconds and microseconds (49 of 49 diverging rows
// do), so recomputing an untouched endpoint from its own 'HH:MM' would silently truncate a true
// punch by up to 59s, and on a row whose clock_out_at was hand-corrected it would destroy the
// good value. Nothing changed at minute granularity ⇒ null ⇒ NO WRITE AT ALL, so open-and-save
// is inert. This is the guard that keeps an edit from becoming an implicit backfill.
//
// The out instant is also rewritten when the pair's OVERNIGHT-ness flips (e.g. 22:00→06:00
// edited to 04:00→06:00 stops crossing midnight), because its calendar date depends on the pair,
// not on the end value alone — otherwise the out instant would be left a day late.
export function buildShiftEditPatch(
  row: EditableShiftRow,
  edit: { start_time?: string; end_time?: string | null; break_minutes?: number },
): ShiftEditPatch | null {
  if (edit.start_time === undefined && edit.end_time === undefined && edit.break_minutes === undefined) {
    return null;
  }

  // What the form opened at — the SAME basis the modal prefilled from.
  const current = shiftEditPrefill(row);
  const nextStart = edit.start_time !== undefined ? hhmm(edit.start_time) : current.start;
  const nextEnd = edit.end_time !== undefined ? edit.end_time : current.end;
  const startChanged = nextStart !== current.start;

  // ── the TIME half: exactly the pre-existing rules, untouched ──
  // Computed first because the break's upper bound is the span this edit RESULTS in, not the
  // span it started from — editing 4pm–2am down to 4pm–6pm must invalidate a 3-hour break.
  const timePatch: ShiftEditPatch = {};
  let instants: PunchInstants | null = null;

  if (row.source !== 'time_clock') {
    // Manual rows: wall clock only, unchanged behaviour — but still skip a genuine no-op.
    if (edit.start_time !== undefined && startChanged) timePatch.start_time = edit.start_time;
    if (edit.end_time !== undefined && (edit.end_time === null ? current.end !== '' : hhmm(edit.end_time) !== current.end)) {
      timePatch.end_time = edit.end_time;
    }
  } else {
    // Reopening would null clock_out_at and violate shifts_time_clock_has_instants (097).
    // Only a genuine end-time edit can reopen; a break-only save leaves nextEnd as prefilled.
    if (nextEnd == null) throw new Error(REOPEN_PUNCH_ERROR);
    const endChanged = hhmm(nextEnd) !== current.end;
    const overnightFlipped =
      isOvernight(nextStart, hhmm(nextEnd)) !== isOvernight(current.start, current.end);
    if (startChanged || endChanged || overnightFlipped) {
      instants = punchInstantsForWallClock(row.date, nextStart, hhmm(nextEnd));
      timePatch.start_time = nextStart;
      timePatch.end_time = hhmm(nextEnd);
      if (startChanged) timePatch.clock_in_at = instants.clock_in_at;
      if (endChanged || overnightFlipped) timePatch.clock_out_at = instants.clock_out_at;
    }
  }

  // ── the BREAK half ──
  // Independent of the time half by design: a break-only correction must emit ONLY break_minutes,
  // leaving start_time/end_time/clock_in_at/clock_out_at exactly as stored. Rewriting an untouched
  // endpoint would truncate a real punch to the minute (see the note above), so a manager fixing a
  // forgotten break-return must not silently disturb the punch that was recorded correctly.
  //
  // confirmed_at / confirmed_by are never emitted here on any path — the BEFORE UPDATE guard in
  // migration 070 rejects them outside the confirm RPCs, and confirmation is not a break concern.
  let breakPatch: number | undefined;
  if (edit.break_minutes !== undefined) {
    const next = edit.break_minutes;
    assertBreakShape(next);
    const currentBreak = row.break_minutes ?? 0;
    if (next !== currentBreak) {
      // Validate against the RESULTING pay span, never the stored one.
      assertBreakFitsSpan(next, paySpanMinutes(row, nextStart, nextEnd, instants));
      breakPatch = next;
    }
  }

  const patch: ShiftEditPatch = { ...timePatch };
  if (breakPatch !== undefined) patch.break_minutes = breakPatch;
  return Object.keys(patch).length === 0 ? null : patch;
}
