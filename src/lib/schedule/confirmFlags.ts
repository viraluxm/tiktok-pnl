import type { ScheduledSpan } from './scheduledSpan';

// Confirm-time validation FLAGS for a time-clock shift. Display/acknowledge only — these never
// block confirmation or affect pay (the manager confirms through the existing window.confirm
// acknowledgement). Each flag states the comparison so it's actionable at a glance.

export type ConfirmFlagKind = 'over_span' | 'under_span' | 'long_break' | 'unscheduled_day' | 'implausible_span';
export interface ConfirmFlag {
  kind: ConfirmFlagKind;
  severity: 'warn' | 'note'; // 'warn' = likely wrong; 'note' = worth a look, lower weight
  message: string;
}

const round1 = (h: number) => Math.round(h * 10) / 10;
export const LONG_BREAK_MIN = 90;
// Absolute upper bound above ANY legitimate shift here (10h host, 8h fulfillment, + real overrun)
// and well below the 23–34h forgotten-clock-outs. Schedule-INDEPENDENT: works retroactively and on
// employees with no schedule at all.
export const IMPLAUSIBLE_SPAN_HOURS = 14;

export function computeConfirmFlags(args: {
  clockedHours: number; // paidShiftHours(shift) — the worked span
  breakMinutes: number;
  scheduled: ScheduledSpan | null; // resolveScheduledSpan(...)
  employeeHasRules: boolean; // employeeHasActiveRules(...) — for the unscheduled-day split
  // FALSE when the shift date precedes the employee's earliest active-rule start_date. Schedule-
  // relative flags (over/under/unscheduled) are suppressed then — a pre-schedule punch isn't an
  // anomaly. Schedule-INDEPENDENT flags (implausible span, long break) still fire.
  scheduleAppliesToDate: boolean;
}): ConfirmFlag[] {
  const flags: ConfirmFlag[] = [];
  const c = round1(args.clockedHours);

  // Implausible span — schedule-independent; fires on any shift, any era, scheduled or not.
  if (args.clockedHours > IMPLAUSIBLE_SPAN_HOURS) {
    flags.push({ kind: 'implausible_span', severity: 'warn', message: `clocked ${c}h — implausibly long (>${IMPLAUSIBLE_SPAN_HOURS}h; forgotten clock-out?)` });
  }

  // Schedule-relative flags — only when the schedule applies to this date.
  if (args.scheduleAppliesToDate) {
    if (args.scheduled) {
      const s = round1(args.scheduled.hours);
      // Over-span: clocked exceeds scheduled by >50% OR by >3h (either trips it).
      if (args.clockedHours > args.scheduled.hours * 1.5 || args.clockedHours > args.scheduled.hours + 3) {
        flags.push({ kind: 'over_span', severity: 'warn', message: `clocked ${c}h, scheduled ${s}h — over by >50% or >3h (forgotten clock-out?)` });
      } else if (args.clockedHours < args.scheduled.hours * 0.5) {
        // Under-span: surfaced with LOWER weight — could be a legit short day or a missing punch.
        flags.push({ kind: 'under_span', severity: 'note', message: `clocked ${c}h, scheduled ${s}h — short day or a missing punch?` });
      }
    } else if (args.employeeHasRules) {
      // No scheduled span, but this employee DOES have rules and the date is IN their schedule era →
      // they worked a day outside their schedule. (No-rule employees are surfaced separately.)
      flags.push({ kind: 'unscheduled_day', severity: 'warn', message: `clocked ${c}h on a day not in this employee's schedule` });
    }
  }

  if (args.breakMinutes > LONG_BREAK_MIN) {
    flags.push({ kind: 'long_break', severity: 'note', message: `break ${args.breakMinutes} min (over ${LONG_BREAK_MIN})` });
  }

  return flags;
}
