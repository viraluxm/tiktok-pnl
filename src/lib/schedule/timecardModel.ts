import { isPayableShift, paidShiftHours } from '@/lib/employees';
import { shiftBusinessDate } from '@/lib/labor';
import { laWallTimeToUtc, addDaysISO } from './timezone';
import type { TimecardDay, TimecardEntry, TimecardEntryState, TimecardOpenPunch, TimecardPayload, TimecardWindow } from './portalTypes';

// The employee's READ-ONLY timecard, derived from real `shifts` rows the same way payroll reads
// them. The hours/payability logic is isPayableShift + paidShiftHours reused VERBATIM — this module
// never subtracts timestamps of its own, so what the employee sees is what pay computes.
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

  const payable = isPayableShift({
    employee_id: s.employee_id,
    start_time: s.start_time,
    end_time: s.end_time,
    source: s.source as 'manual' | 'time_clock',
    source_rule_id: s.source_rule_id,
    confirmed_at: s.confirmed_at,
    break_minutes: s.break_minutes ?? 0,
    clock_in_at: s.clock_in_at,
    clock_out_at: s.clock_out_at,
  });
  const hours = clock_out == null ? 0 : paidShiftHours({
    employee_id: s.employee_id,
    start_time: s.start_time,
    end_time: s.end_time,
    break_minutes: s.break_minutes ?? 0,
    clock_in_at: s.clock_in_at,
    clock_out_at: s.clock_out_at,
  });

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
    open,
  };
}

/** The date range a single `shifts` read must cover to build both windows (±1 day for overnights). */
export function timecardReadRange(week: { start: string; end: string }, period: { start: string; end: string }): { from: string; to: string } {
  const from = week.start < period.start ? week.start : period.start;
  const to = week.end > period.end ? week.end : period.end;
  return { from: addDaysISO(from, -1), to: addDaysISO(to, 1) };
}
