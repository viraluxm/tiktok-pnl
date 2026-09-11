import { clockedShiftHours, isPayableShift, paidShiftHours, payPeriodContaining, paydayForPeriod } from '@/lib/employees';
import { shiftBusinessDate } from '@/lib/labor';
import { laWallTimeToUtc, addDaysISO } from './timezone';
import type { PayPeriodSummary, TimecardDay, TimecardEntry, TimecardEntryState, TimecardOpenPunch, TimecardPayload, TimecardPeriodPayload, TimecardWindow } from './portalTypes';

// The employee's READ-ONLY timecard, derived from real `shifts` rows the same way payroll reads
// them. The hours/payability logic is isPayableShift + paidShiftHours + clockedShiftHours reused
// VERBATIM — this module never subtracts timestamps of its own, so what the employee sees is what
// pay computes.
//
// Every entry carries BOTH durations, because after migration 137 they are different questions:
//   clocked_hours    what the punch spans (attendance)
//   hours            what payroll pays  (the manager-approved minutes when they exist)
// A live host normally sees the second smaller than the first — that is the verified live time,
// not a lost punch, and the screen says so.
//
// What is and is not a "worked" entry:
//   • source_rule_id != null  → a materialized PLAN row (frozen schedule). Not worked time. Skipped.
//   • time_clock, confirmed   → payable punch.
//   • time_clock, unconfirmed → the punch landed but a manager has not confirmed it. Shown, and
//                               counted separately as `pendingHours` — never inside workedHours —
//                               so a recent day does not read as if the punch vanished.
//   • manual (no instants)    → a manager-entered correction. Payable; its instants are derived
//                               from date + wall clock through the DST-safe converter.
//   • auto_closed             → the reconciler closed a forgotten punch; flagged for the employee.
//
// Business date = the clock-in's LA calendar date (labor.ts shiftBusinessDate), so an overnight
// punch books to the evening it started and renders "Tue 6:02 PM → Wed 2:07 AM".

/** The columns the timecard reads from `shifts`. NO hourly_rate, ever. */
export interface TimecardShiftRow {
  id: string;
  employee_id: string;
  date: string;
  start_time: string;
  end_time: string | null;
  source: 'manual' | 'time_clock' | string;
  source_rule_id: string | null;
  confirmed_at: string | null;
  break_minutes: number | null;
  clock_in_at: string | null;
  clock_out_at: string | null;
  auto_closed: boolean | null;
  /** migration 137 — the manager-approved payable minutes, or null. */
  approved_minutes?: number | null;
}

export interface OpenEntryRow {
  clocked_in_at: string;
  on_break: boolean;
  needs_manual_close: boolean;
}

function wallToInstant(dateISO: string, hhmm: string): string {
  return laWallTimeToUtc(dateISO, hhmm).toISOString();
}

/** end <= start on the wall clock ⇒ the shift ran past midnight (same rule as shiftHours). */
function wallCrossesMidnight(start: string, end: string): boolean {
  const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  return toMin(end) <= toMin(start);
}

export function toTimecardEntry(s: TimecardShiftRow): TimecardEntry | null {
  if (s.source_rule_id != null) return null; // plan, never worked time
  const hasInstants = !!(s.clock_in_at && s.clock_out_at);
  const clock_in = s.clock_in_at ?? wallToInstant(s.date, s.start_time);
  let clock_out: string | null;
  if (hasInstants) clock_out = s.clock_out_at as string;
  else if (s.end_time == null) clock_out = null;
  else clock_out = wallToInstant(wallCrossesMidnight(s.start_time, s.end_time) ? addDaysISO(s.date, 1) : s.date, s.end_time);

  // ONE input shape for both canonical calls, so the payable figure and the clocked figure can
  // never be computed from different facts.
  const asShift = {
    employee_id: s.employee_id,
    start_time: s.start_time,
    end_time: s.end_time,
    source: s.source as 'manual' | 'time_clock',
    source_rule_id: s.source_rule_id,
    confirmed_at: s.confirmed_at,
    break_minutes: s.break_minutes ?? 0,
    clock_in_at: s.clock_in_at,
    clock_out_at: s.clock_out_at,
    approved_minutes: s.approved_minutes ?? null,
  };
  const payable = isPayableShift(asShift);
  // APPROVED (payable) vs CLOCKED (attendance) — the whole point of migration 137. paidShiftHours
  // returns the approved minutes when a manager set them; clockedShiftHours always describes the
  // punch. An open punch has no completed duration, so both read 0 and the UI says "in progress".
  const hours = clock_out == null ? 0 : paidShiftHours(asShift);
  const clockedHours = clock_out == null ? 0 : clockedShiftHours(asShift);

  let state: TimecardEntryState;
  if (clock_out == null) state = 'in_progress';
  else if (s.auto_closed) state = 'auto_closed';
  else if (s.source === 'time_clock' && s.confirmed_at == null) state = 'awaiting_confirmation';
  else state = 'complete';

  return {
    id: s.id,
    date: shiftBusinessDate({ employee_id: s.employee_id, date: s.date, start_time: s.start_time, end_time: s.end_time, clock_in_at: s.clock_in_at }),
    clock_in,
    clock_out,
    hours,
    clocked_hours: clockedHours,
    approved_minutes: s.approved_minutes ?? null,
    break_minutes: s.break_minutes ?? 0,
    payable,
    state,
    source: s.source === 'time_clock' ? 'time_clock' : 'manual',
  };
}

/** Hours that count toward `pendingHours`: a completed punch a manager has not confirmed. */
function isPendingConfirmation(e: TimecardEntry): boolean {
  return !e.payable && e.state === 'awaiting_confirmation';
}

export function buildWindow(entries: readonly TimecardEntry[], start: string, end: string): TimecardWindow {
  const inWin = entries.filter((e) => e.date >= start && e.date <= end);
  const byDate = new Map<string, TimecardEntry[]>();
  for (const e of inWin) {
    const arr = byDate.get(e.date);
    if (arr) arr.push(e); else byDate.set(e.date, [e]);
  }
  const days: TimecardDay[] = [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0)) // newest day first
    .map(([date, list]) => ({
      date,
      entries: [...list].sort((a, b) => Date.parse(a.clock_in) - Date.parse(b.clock_in)),
      hours: round2(list.filter((e) => e.payable).reduce((s, e) => s + e.hours, 0)),
    }));
  return {
    start,
    end,
    workedHours: round2(inWin.filter((e) => e.payable).reduce((s, e) => s + e.hours, 0)),
    pendingHours: round2(inWin.filter(isPendingConfirmation).reduce((s, e) => s + e.hours, 0)),
    days,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function buildTimecard(input: {
  shifts: readonly TimecardShiftRow[];
  open: OpenEntryRow | null;
  todayISO: string;
  week: { start: string; end: string };
  period: { start: string; end: string };
}): TimecardPayload {
  const entries = input.shifts.map(toTimecardEntry).filter((e): e is TimecardEntry => e !== null);
  const open: TimecardOpenPunch | null = input.open
    ? { clockedInAt: input.open.clocked_in_at, onBreak: input.open.on_break, needsManualClose: input.open.needs_manual_close }
    : null;
  return {
    todayISO: input.todayISO,
    week: buildWindow(entries, input.week.start, input.week.end),
    period: buildWindow(entries, input.period.start, input.period.end),
    payday: paydayForPeriod({ start: input.period.start, end: input.period.end }),
    open,
  };
}

// ── Pay periods ───────────────────────────────────────────────────────────────────────────────

/** How many CLOSED pay periods the employee's history shows. Six ≈ three months of biweekly pay. */
export const PAY_PERIOD_HISTORY = 6;

/**
 * The `count` pay periods immediately BEFORE `currentStart`, newest first.
 *
 * COMPOSED, never re-derived: the period before one that starts on M is simply the period
 * containing the day before M, so the whole walk is payPeriodContaining() applied repeatedly. If
 * the biweekly cycle ever moves (PAY_ANCHOR), this walk moves with it for free.
 */
export function previousPayPeriods(currentStart: string, count: number = PAY_PERIOD_HISTORY): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  let cursor = currentStart;
  for (let i = 0; i < count; i++) {
    const prev = payPeriodContaining(addDaysISO(cursor, -1));
    out.push(prev);
    cursor = prev.start;
  }
  return out;
}

/** Totals for one period, over entries already built. The hour figures come from buildWindow. */
export function payPeriodSummary(entries: readonly TimecardEntry[], period: { start: string; end: string }): PayPeriodSummary {
  const w = buildWindow(entries, period.start, period.end);
  return {
    start: w.start,
    end: w.end,
    payday: paydayForPeriod({ start: w.start, end: w.end }),
    workedHours: w.workedHours,
    pendingHours: w.pendingHours,
  };
}

/**
 * Turn an untrusted `?period=` string into a real pay-period window, or null.
 *
 * The parameter names a WINDOW, never a person — identity stays with the token — so the only job
 * here is to refuse anything that is not one of this employer's actual periods. Three gates:
 * a literal YYYY-MM-DD, a date that is genuinely a period START under the canonical cycle (so an
 * arbitrary Monday cannot conjure a 14-day window of its own), and not a period in the future.
 */
export function resolvePeriodStart(raw: string | null | undefined, todayISO: string): { start: string; end: string } | null {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const period = payPeriodContaining(raw);
  if (period.start !== raw) return null;                                  // not a period boundary
  if (period.start > payPeriodContaining(todayISO).start) return null;    // not yet begun
  return period;
}

/** The history list: one summary per closed period, newest first. */
export function buildPayPeriods(input: {
  shifts: readonly TimecardShiftRow[];
  periods: readonly { start: string; end: string }[];
}): PayPeriodSummary[] {
  const entries = input.shifts.map(toTimecardEntry).filter((e): e is TimecardEntry => e !== null);
  return input.periods.map((p) => payPeriodSummary(entries, p));
}

/** One past period in full — the same day-by-day window the current period renders. */
export function buildTimecardPeriod(input: {
  shifts: readonly TimecardShiftRow[];
  todayISO: string;
  period: { start: string; end: string };
}): TimecardPeriodPayload {
  const entries = input.shifts.map(toTimecardEntry).filter((e): e is TimecardEntry => e !== null);
  return {
    todayISO: input.todayISO,
    summary: payPeriodSummary(entries, input.period),
    period: buildWindow(entries, input.period.start, input.period.end),
  };
}

/** The date range a single `shifts` read must cover to build both windows (±1 day for overnights). */
export function timecardReadRange(week: { start: string; end: string }, period: { start: string; end: string }): { from: string; to: string } {
  const from = week.start < period.start ? week.start : period.start;
  const to = week.end > period.end ? week.end : period.end;
  return { from: addDaysISO(from, -1), to: addDaysISO(to, 1) };
}

/** The same ±1-day padding over an arbitrary set of windows (the history sweep reads one range). */
export function spanReadRange(windows: readonly { start: string; end: string }[]): { from: string; to: string } {
  const from = windows.reduce((a, w) => (w.start < a ? w.start : a), windows[0].start);
  const to = windows.reduce((a, w) => (w.end > a ? w.end : a), windows[0].end);
  return { from: addDaysISO(from, -1), to: addDaysISO(to, 1) };
}
