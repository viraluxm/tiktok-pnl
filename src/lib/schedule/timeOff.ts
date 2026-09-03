/**
 * Time-off request rules — pure, dependency-free (transpile-testable, see timeOff.test.mjs).
 *
 * The deadline is anchored to the PAY PERIOD, not to a rolling N-days-ahead window. The schedule
 * is built every other weekend for the whole upcoming period, so the only question that matters
 * is "has the period this date falls in already been built?" A rolling window drifts against
 * that: the same "14 days ahead" is comfortably early at one point in the cycle and already too
 * late at another, and it gives staff no fixed date to work to.
 *
 * One rule covers every case:
 *
 *     a date is requestable  ⟺  the start of its pay period is strictly after (today + leadDays)
 *
 *   • a date in the CURRENT period  → its period started in the past      → refused
 *   • next period, asked early      → that period starts after the cutoff → allowed
 *   • next period, asked 1 day out  → the schedule is already built       → refused
 *   • a far-future period           → allowed
 *
 * `periodStartOf` is INJECTED rather than imported so this file keeps no value imports (the test
 * transpiles it alone). Callers pass `payPeriodStartFor` from '@/lib/employees'.
 */

// Days of notice before a period begins, after which that period is closed to new requests.
// The schedule is built the weekend before a Monday period start, so a Friday cutoff (3 days)
// lands just before that. One constant — tune it here if the build day moves.
export const TIME_OFF_LEAD_DAYS = 3;

// Biweekly cycle length. Used ONLY to step to the next period boundary when reporting the
// earliest requestable date; the payroll anchor itself lives in '@/lib/employees'.
export const PAY_PERIOD_DAYS = 14;

// A single request may not exceed one pay period. Longer absences are a conversation, not a form.
export const TIME_OFF_MAX_DAYS = 14;

export type TimeOffRejectReason =
  | 'ok'
  | 'range_inverted'   // end before start
  | 'range_too_long'   // more than TIME_OFF_MAX_DAYS
  | 'period_closed';   // the period is built (or building) — too late to ask

export interface TimeOffWindowCheck {
  allowed: boolean;
  reason: TimeOffRejectReason;
  /** First date any request may cover right now — drives the date input's `min`. */
  earliestRequestable: string;
}

/** Add whole days to 'YYYY-MM-DD'. Date-only arithmetic, so DST cannot shift it. */
export function addDaysISO(dateISO: string, days: number): string {
  const [y, m, d] = dateISO.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Whole days from `a` to `b`, inclusive of both endpoints (a single day counts as 1). */
export function inclusiveDays(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000) + 1;
}

/**
 * The first date a request may cover: the start of the earliest pay period beginning strictly
 * after (today + leadDays). Exported so the UI and the server agree on the input's lower bound
 * without either re-deriving it.
 */
export function earliestRequestableDate(
  todayISO: string,
  periodStartOf: (dateISO: string) => string,
  leadDays: number = TIME_OFF_LEAD_DAYS,
): string {
  const cutoff = addDaysISO(todayISO, leadDays);
  const start = periodStartOf(cutoff);
  // periodStartOf(cutoff) is the period CONTAINING the cutoff, so it never starts after it;
  // step one period forward to get the first boundary strictly beyond.
  return start > cutoff ? start : addDaysISO(start, PAY_PERIOD_DAYS);
}

/**
 * Validate one request. Checking only `startDate` against the deadline is sufficient: pay periods
 * are contiguous and ordered, so if the start's period is open, every later date's period is too.
 */
export function checkTimeOffWindow(args: {
  startDate: string;
  endDate: string;
  todayISO: string;
  periodStartOf: (dateISO: string) => string;
  leadDays?: number;
  maxDays?: number;
}): TimeOffWindowCheck {
  const leadDays = args.leadDays ?? TIME_OFF_LEAD_DAYS;
  const maxDays = args.maxDays ?? TIME_OFF_MAX_DAYS;
  const earliest = earliestRequestableDate(args.todayISO, args.periodStartOf, leadDays);
  const fail = (reason: TimeOffRejectReason): TimeOffWindowCheck =>
    ({ allowed: false, reason, earliestRequestable: earliest });

  if (args.endDate < args.startDate) return fail('range_inverted');
  if (inclusiveDays(args.startDate, args.endDate) > maxDays) return fail('range_too_long');
  if (args.startDate < earliest) return fail('period_closed');
  return { allowed: true, reason: 'ok', earliestRequestable: earliest };
}

/** Manager-facing copy for a refusal. Kept next to the rule so the two cannot drift. */
export function timeOffRejectMessage(reason: TimeOffRejectReason, earliest: string): string {
  switch (reason) {
    case 'range_inverted': return 'The last day cannot be before the first day.';
    case 'range_too_long': return `A request can cover at most ${TIME_OFF_MAX_DAYS} days.`;
    case 'period_closed': return `That schedule is already being built. The earliest day you can request is ${earliest}.`;
    default: return '';
  }
}
