import type { Employee, Shift, ShiftRule, ShiftException } from '@/types';

// Minutes since midnight for an 'HH:MM' / 'HH:MM:SS' time string.
function parseTime(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

// Hours worked for a single shift, derived from its time range. A shift whose end is
// before its start is treated as running past midnight (end rolls into the next day).
export function shiftHours(startTime: string, endTime: string): number {
  let mins = parseTime(endTime) - parseTime(startTime);
  if (mins < 0) mins += 24 * 60;
  return mins / 60;
}

export interface EmployeePay {
  employee: Employee;
  hours: number;
  pay: number; // hours * hourly_rate — derived, never stored
}

// The minimum shape computePay needs from a shift. Both stored one-off `Shift`s and
// computed recurring `GeneratedShift`s satisfy it, so callers can pass them combined.
export type ShiftLike = Pick<Shift, 'employee_id' | 'start_time' | 'end_time'>;

// Per-employee hours + derived pay owed for the given set of shifts (already scoped to
// the pay period by the caller). Accepts one-off shifts and/or generated recurring
// instances — pass them combined so recurring hours count toward pay.
export function computePay(employees: Employee[], shifts: ReadonlyArray<ShiftLike>): EmployeePay[] {
  const hoursByEmployee = new Map<string, number>();
  for (const s of shifts) {
    const prev = hoursByEmployee.get(s.employee_id) || 0;
    hoursByEmployee.set(s.employee_id, prev + shiftHours(s.start_time, s.end_time));
  }
  return employees.map((employee) => {
    const hours = hoursByEmployee.get(employee.id) || 0;
    return { employee, hours, pay: hours * employee.hourly_rate };
  });
}

const DAY_MS = 86_400_000;
const FRIDAY = 5; // getUTCDay(): Sun=0 … Fri=5 … Sat=6

// Parse a 'YYYY-MM-DD' date as UTC midnight. Working purely in UTC-midnight space keeps
// the weekday/step math free of local-timezone and DST drift.
function parseDateUTC(d: string): Date {
  const [y, m, day] = d.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}

function addDaysUTC(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

// The employee's NEXT upcoming biweekly payday relative to `today`, anchored to
// hire_date. Rules: paydays fall on Fridays; the first payday is the SECOND Friday
// after hire_date; then every 14 days. Friday-hire edge case — the hire day itself
// does not count, so the next Friday is the "1st Friday" (handled by taking the first
// Friday STRICTLY after hire_date). Returns a formatted date like "Fri, Jul 17", or
// null when hire_date is missing/unparseable.
export function nextPayday(hireDate: string | null, today: Date = new Date()): string | null {
  if (!hireDate) return null;
  const hire = parseDateUTC(hireDate);
  if (isNaN(hire.getTime())) return null;

  // 1st Friday strictly after hire_date (a Friday hire rolls forward a full week).
  const daysToFirstFriday = ((FRIDAY - hire.getUTCDay() + 7) % 7) || 7;
  const firstFriday = addDaysUTC(hire, daysToFirstFriday);
  // First payday = 2nd Friday = 1st Friday + 7 days.
  const firstPayday = addDaysUTC(firstFriday, 7);

  // Compare at day granularity using the local calendar date the user sees as "today".
  const todayUTC = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));

  // Advance in 14-day steps to the first payday that is today or later.
  let payday = firstPayday;
  if (payday.getTime() < todayUTC.getTime()) {
    const periods = Math.ceil((todayUTC.getTime() - payday.getTime()) / (14 * DAY_MS));
    payday = addDaysUTC(payday, periods * 14);
  }

  return payday.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function toISODateUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// A recurring shift INSTANCE, computed from a rule (minus/adjusted by exceptions).
// Never persisted — regenerated on read. `id` is synthetic (rule + date) so React
// keys and per-instance actions have a stable handle; `modified` marks instances
// whose hours came from a 'modified' exception.
export interface GeneratedShift {
  id: string; // `${rule_id}:${date}`
  rule_id: string;
  employee_id: string;
  date: string; // 'YYYY-MM-DD'
  start_time: string;
  end_time: string;
  modified: boolean; // hours came from a 'modified' exception
  skipped: boolean;  // a 'skip' exception exists — surfaced for "Restore"; excluded from pay
  recurring: true;
}

// Hard cap on days walked per rule, so a pathological range can never loop away
// (~10 years). Real ranges are a pay period, or start_date→today for all-time.
const MAX_GENERATED_DAYS = 3660;

// Generate recurring instances for the given rules + exceptions within a date range.
// For each ACTIVE rule, every matching weekday from start_date forward within range
// emits an instance UNLESS a 'skip' exception exists for that date; a 'modified'
// exception replaces the hours (a null side falls back to the rule's time).
//
// rangeStart null → each rule's own start_date. rangeEnd null (all-time) → capped at
// `today`, so we never emit unbounded future instances. Non-skipped instances count
// toward pay by default (the caller sums them with one-off shifts); 'skip'-exception
// dates are still EMITTED with skipped=true so the UI can offer "Restore", but the
// caller must exclude skipped ones from pay.
export function generateRecurringShifts(
  rules: ShiftRule[],
  exceptions: ShiftException[],
  rangeStart: string | null,
  rangeEnd: string | null,
  today: Date = new Date(),
): GeneratedShift[] {
  // Exception lookup keyed by rule + date.
  const exByKey = new Map<string, ShiftException>();
  for (const ex of exceptions) exByKey.set(`${ex.rule_id}|${ex.date}`, ex);

  const todayISO = toISODateUTC(
    new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())),
  );
  const out: GeneratedShift[] = [];

  for (const rule of rules) {
    if (!rule.active) continue;
    if (!rule.days_of_week || rule.days_of_week.length === 0) continue;

    // Effective window: max(rule.start_date, rangeStart) → (rangeEnd ?? today).
    const startISO =
      rangeStart && rangeStart > rule.start_date ? rangeStart : rule.start_date;
    const endISO = rangeEnd ?? todayISO;
    if (startISO > endISO) continue;

    const days = new Set(rule.days_of_week);
    let cursor = parseDateUTC(startISO);
    const end = parseDateUTC(endISO);

    for (let i = 0; cursor.getTime() <= end.getTime() && i < MAX_GENERATED_DAYS; i++) {
      if (days.has(cursor.getUTCDay())) {
        const iso = toISODateUTC(cursor);
        const ex = exByKey.get(`${rule.id}|${iso}`);
        const skipped = ex?.type === 'skip';
        const modified = ex?.type === 'modified';
        out.push({
          id: `${rule.id}:${iso}`,
          rule_id: rule.id,
          employee_id: rule.employee_id,
          date: iso,
          start_time: modified ? ex!.modified_start ?? rule.start_time : rule.start_time,
          end_time: modified ? ex!.modified_end ?? rule.end_time : rule.end_time,
          modified,
          skipped,
          recurring: true,
        });
      }
      cursor = addDaysUTC(cursor, 1);
    }
  }

  return out;
}
