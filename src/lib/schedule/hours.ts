import { paidShiftHours } from '@/lib/employees';
import { addDaysISO, weekdayOf } from './timezone';

// The FLSA workweek containing `dateISO`, as a Mon→Sun {start,end} window (aligned with the
// biweekly pay period's Mon→Sun halves). Overtime is weekly-40 only (Nevada daily-OT does not
// apply at these rates), so the 40h projection is scoped to this 7-day window.
export function weekBoundsMonSun(dateISO: string): { start: string; end: string } {
  const daysSinceMon = (weekdayOf(dateISO) + 6) % 7; // Sun→6, Mon→0, … Sat→5
  const start = addDaysISO(dateISO, -daysSinceMon);
  return { start, end: addDaysISO(start, 6) };
}

// Hours for one instance from its true UTC span, REUSING paidShiftHours' span logic (the
// clock_in_at/clock_out_at branch). Instances carry no break, so this is just the elapsed span.
export function instanceHours(starts_at: string, ends_at: string): number {
  return paidShiftHours({
    employee_id: '',
    start_time: '00:00',
    end_time: '00:00',
    clock_in_at: starts_at,
    clock_out_at: ends_at,
  });
}
