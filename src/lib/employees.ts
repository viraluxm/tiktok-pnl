import type { Employee, Shift, ShiftRule, ShiftException } from '@/types';

// Minutes since midnight for an 'HH:MM' / 'HH:MM:SS' time string.
function parseTime(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

// Hours worked for a single shift, derived from its time range. A shift whose end is
// before its start is treated as running past midnight (end rolls into the next day).
// An OPEN shift (null end_time) has no completed duration → returns 0; callers that
// sum hours should exclude open shifts entirely (see computePay + isOpenShift).
export function shiftHours(startTime: string, endTime: string | null): number {
  if (endTime == null) return 0;
  let mins = parseTime(endTime) - parseTime(startTime);
  if (mins < 0) mins += 24 * 60;
  return mins / 60;
}

// An open shift is in progress (no end recorded yet). Its hours are indeterminate, so
// it is excluded from pay/hours totals rather than summed as 0.
export function isOpenShift(s: { end_time: string | null }): boolean {
  return s.end_time == null;
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
    if (isOpenShift(s)) continue; // open shift → indeterminate hours, excluded from pay
    const prev = hoursByEmployee.get(s.employee_id) || 0;
    hoursByEmployee.set(s.employee_id, prev + shiftHours(s.start_time, s.end_time));
  }
  return employees.map((employee) => {
    const hours = hoursByEmployee.get(employee.id) || 0;
    return { employee, hours, pay: hours * employee.hourly_rate };
  });
}

const DAY_MS = 86_400_000;

// ONE global biweekly pay cycle for the whole team (replaced the old per-employee,
// hire-date-anchored paydays). PAY_ANCHOR is a KNOWN payday Friday; every payday is
// PAY_ANCHOR ± N×14 days. Change this one constant to shift the entire cycle.
export const PAY_ANCHOR = '2026-07-17'; // Friday

// Parse a 'YYYY-MM-DD' date as UTC midnight. Working purely in UTC-midnight space keeps
// the weekday/step math free of local-timezone and DST drift.
function parseDateUTC(d: string): Date {
  const [y, m, day] = d.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}

function addDaysUTC(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

function toISODateUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// A discrete pay period: an inclusive 'YYYY-MM-DD' window [start, end] (Mon → Sun).
export interface PayPeriod {
  start: string; // Monday
  end: string;   // Sunday
}

// The next GLOBAL payday on-or-after `today`, as 'YYYY-MM-DD'. Same for everyone —
// PAY_ANCHOR ± N×14 days. Steps backward too (past today just yields fewer steps).
export function nextPayday(today: Date = new Date()): string {
  const anchor = parseDateUTC(PAY_ANCHOR);
  const todayUTC = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  // Whole 14-day steps from the anchor to reach the first payday >= today (ceil so a day
  // strictly before the anchor rounds toward 0/negative and lands on the anchor itself).
  const steps = Math.ceil((todayUTC.getTime() - anchor.getTime()) / (14 * DAY_MS));
  return toISODateUTC(addDaysUTC(anchor, steps * 14));
}

// The payday `offset` cycles away from the current one (0 = current, -1 = previous,
// +1 = next), as 'YYYY-MM-DD'. For the prev/next period navigation.
export function paydayAtOffset(offset: number, today: Date = new Date()): string {
  return toISODateUTC(addDaysUTC(parseDateUTC(nextPayday(today)), offset * 14));
}

// The 2-week period a payday PAYS FOR. Lag: the period CLOSES the Sunday BEFORE payday.
//   end   = payday − 5 days  (the Sunday before a Friday payday)
//   start = end − 13 days    (14-day inclusive Mon→Sun window)
// e.g. payPeriodFor('2026-07-17') → { start: '2026-06-29', end: '2026-07-12' }.
export function payPeriodFor(paydayISO: string): PayPeriod {
  const payday = parseDateUTC(paydayISO);
  const end = addDaysUTC(payday, -5);
  const start = addDaysUTC(end, -13);
  return { start: toISODateUTC(start), end: toISODateUTC(end) };
}

// Display helpers (UTC so the calendar date never drifts by timezone).
// fmtPayDate('2026-07-17') → 'Fri, Jul 17';  fmtMonthDay('2026-06-29') → 'Jun 29'.
export function fmtPayDate(iso: string): string {
  return parseDateUTC(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
export function fmtMonthDay(iso: string): string {
  return parseDateUTC(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
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
  // ANTI-DOUBLE-COUNT: `${rule_id}|${date}` pairs that already have a materialized real
  // `shifts` row. The generator must NOT also project these — the real row is the single
  // source of truth for that day, so computePay counts it exactly once. See materialize.
  materialized: ReadonlySet<string> = new Set(),
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
        // Guard the PUSH (not `continue` — the cursor increment lives below the `if`, so a
        // `continue` would loop forever). If a real row already covers (rule, date), skip
        // projecting it: exactly-once is enforced by row EXISTENCE, not a date comparison.
        if (!materialized.has(`${rule.id}|${iso}`)) {
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
      }
      cursor = addDaysUTC(cursor, 1);
    }
  }

  return out;
}

// A past recurring day to freeze into a real `shifts` row. Derived from the SAME
// generator so hours (incl. 'modified' exceptions) match exactly what pay showed.
export interface MaterializableInstance {
  employee_id: string;
  rule_id: string;
  date: string;       // 'YYYY-MM-DD'
  start_time: string;
  end_time: string;   // always concrete (rule/modified) — never an open shift
}

// The set of PAST (date < today), non-skipped recurring instances that should be
// materialized as real rows. "Past" is strict: today's in-progress day is left to the
// live projection (owned by the generator until it becomes past). Skipped days are NOT
// materialized (the person didn't work them). `materialized` excludes days already
// frozen, so this is idempotent to compute. Callers persist the result (see materialize).
export function pastInstancesToMaterialize(
  rules: ShiftRule[],
  exceptions: ShiftException[],
  materialized: ReadonlySet<string> = new Set(),
  today: Date = new Date(),
): MaterializableInstance[] {
  const todayISO = toISODateUTC(
    new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())),
  );
  // Generate the full history up to (and incl.) today, then keep strictly-past,
  // non-skipped, not-already-materialized instances. rangeEnd null → capped at today.
  return generateRecurringShifts(rules, exceptions, null, null, materialized, today)
    .filter((g) => !g.skipped && g.date < todayISO)
    .map((g) => ({
      employee_id: g.employee_id,
      rule_id: g.rule_id,
      date: g.date,
      start_time: g.start_time,
      end_time: g.end_time,
    }));
}
