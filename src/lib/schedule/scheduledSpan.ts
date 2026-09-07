import { generateRecurringShifts, shiftHours } from '@/lib/employees';
import type { ShiftRule, ShiftException, ShiftInstance } from '@/types';
import { instanceHours } from './hours';
import { ruleDatesOwnedByInstances } from './calendarModel';

// Scheduled-span resolution for a given (employee_id, date) — used to VALIDATE a punch at confirm
// time (display/review only; never pay). Precedence:
//   1. A shift_instances row for that employee+date (authoritative — knows about CLAIMS: a claimed
//      shift has a real scheduled span even though no rule projects it for the claimer).
//   2. Otherwise the recurring-rule projection for that weekday.
//   3. Otherwise none — the employee worked a day they weren't scheduled (its own signal, Step B).

export type ScheduledSource = 'instance' | 'rule';
export interface ScheduledSpan {
  hours: number;
  source: ScheduledSource;
}

const FILLING = new Set(['scheduled', 'claimed', 'worked']); // a real assignment (released/missed/cancelled are not)

export function resolveScheduledSpan(args: {
  employeeId: string;
  date: string; // 'YYYY-MM-DD' (LA-local)
  instances: Pick<ShiftInstance, 'employee_id' | 'shift_date' | 'starts_at' | 'ends_at' | 'status' | 'shift_rule_id'>[];
  rules: ShiftRule[];
  exceptions: ShiftException[];
}): ScheduledSpan | null {
  // 1. Instance for this employee+date (claims included; span from the true starts/ends instants).
  const inst = args.instances.find(
    (i) => i.employee_id === args.employeeId && i.shift_date === args.date && FILLING.has(i.status),
  );
  if (inst) return { hours: instanceHours(inst.starts_at, inst.ends_at), source: 'instance' };

  // 2. Rule projection for that single day (generateRecurringShifts honours active/start_date/skip/modified).
  //
  // Suppressed for any date a stored rule-backed instance already owns. Without this, an occurrence
  // the manager CANCELLED (or the worker RELEASED) fails the FILLING test above and then reappears
  // here as a phantom rule span — which is what a punch gets scored against at confirm time, so the
  // clocked-vs-scheduled delta would be measured against a shift nobody was expected to work.
  // A date with NO stored instance is unaffected: the normal rule fallback still runs.
  const empRules = args.rules.filter((r) => r.employee_id === args.employeeId);
  const projected = generateRecurringShifts(
    empRules,
    args.exceptions,
    args.date,
    args.date,
    ruleDatesOwnedByInstances(args.instances),
  ).find((g) => !g.skipped);
  if (projected) return { hours: shiftHours(projected.start_time, projected.end_time), source: 'rule' };

  // 3. No scheduled span.
  return null;
}

// Does this employee have ANY active recurring rule? Drives the unscheduled-day split (Step B):
// a shift outside an employee's rules is flagged; an employee with NO rules at all is not flagged
// per-shift (surfaced once as a data-completeness item instead).
export function employeeHasActiveRules(employeeId: string, rules: ShiftRule[]): boolean {
  return rules.some((r) => r.employee_id === employeeId && r.active);
}

// The employee's earliest active-rule start_date ('YYYY-MM-DD'), or null if they have no active
// rule. Used to gate schedule-relative confirm flags: a punch dated before this is pre-schedule
// (not an anomaly), so over/under/unscheduled flags are suppressed for it.
export function earliestActiveRuleStart(employeeId: string, rules: ShiftRule[]): string | null {
  const starts = rules.filter((r) => r.employee_id === employeeId && r.active).map((r) => r.start_date);
  return starts.length ? starts.reduce((min, d) => (d < min ? d : min)) : null;
}

// Does the schedule apply to this date for this employee? True when they have an active rule whose
// start_date is on/before the date (or, trivially, when a resolved span exists). Pre-schedule dates
// return false → schedule-relative flags are suppressed.
export function scheduleAppliesToDate(employeeId: string, date: string, rules: ShiftRule[]): boolean {
  const earliest = earliestActiveRuleStart(employeeId, rules);
  return earliest != null && date >= earliest;
}
