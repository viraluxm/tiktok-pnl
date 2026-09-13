import { laWallTimeToUtc } from '@/lib/schedule/timezone';
import type { Employee, PayAdjustment, Shift } from '@/types';

// FIXTURES FOR THE PAY DETAIL REVIEW ROUTE. Plain objects, shaped exactly like `shifts` rows —
// no query, no client, nothing that could reach a database.
//
// The shapes are taken from real production rows in the 2026-08-24 → 2026-09-06 period (read-only)
// so the review covers what actually exists rather than a tidy invention: a manual 06:00–14:00
// correction stacked on the punch that already covered the same hours, a 47.75-hour forgotten
// clock-out carrying a 40-hour break, an unconfirmed punch, an open clock-in and a scheduled-only
// day. Names are invented; the numbers are the kinds of numbers the Pay tab really holds.

export const PREVIEW_PERIOD = { start: '2026-08-24', end: '2026-09-06', payday: '2026-09-11' };
export const PREVIEW_GENERATED_AT = '2026-09-08T17:00:00.000Z';

export const PREVIEW_EMPLOYEES: Employee[] = [
  // Carlos is the BONUS review case, and his numbers are exact on purpose: 72.50 payable hours at
  // $22.00 = $1,595.00 of worked pay, plus a $100 and a $50 bonus = $150.00, for $1,745.00 owed.
  // Everything on the screen and on his PDF has to add up to those four figures.
  mkEmployee('e-carlos', 'Carlos Herrera', 'fulfillment', 25),
  mkEmployee('e-juan', 'Juan Reyes', 'fulfillment', 22),
  mkEmployee('e-adriana', 'Adriana Salas', 'host', 25),
  mkEmployee('e-chris', 'Chris Okafor', 'fulfillment', 19.5),
  mkEmployee('e-haley', 'Haley Nguyen', 'host', 30),
  mkEmployee('e-marcus', 'Marcus Bell', 'fulfillment', 18),
  mkEmployee('e-priya', 'Priya Raman', 'host', 26),
  mkEmployee('e-devon', 'Devon Clarke', 'fulfillment', 0),
];

function mkEmployee(id: string, name: string, role: string, hourly_rate: number): Employee {
  return {
    id, user_id: 'preview-owner', name, role, status: 'active', hourly_rate,
    hire_date: null, probation_end_date: null, created_at: '', updated_at: '',
  };
}

let n = 0;
function punch(employee_id: string, date: string, start: string, end: string, over: Partial<Shift> = {}): Shift {
  const outDate = end <= start ? addDays(date, 1) : date;
  return {
    id: `pv-p${++n}`, user_id: 'preview-owner', employee_id, date,
    start_time: `${start}:00`, end_time: `${end}:00`,
    source: 'time_clock', source_rule_id: null,
    confirmed_at: '2026-09-07T00:00:00.000Z', confirmed_by: 'preview-owner', break_minutes: 0,
    clock_in_at: laWallTimeToUtc(date, start).toISOString(),
    clock_out_at: laWallTimeToUtc(outDate, end).toISOString(),
    auto_closed: false, created_at: '', updated_at: '', ...over,
  };
}

function manual(employee_id: string, date: string, start: string, end: string | null, over: Partial<Shift> = {}): Shift {
  return {
    id: `pv-m${++n}`, user_id: 'preview-owner', employee_id, date,
    start_time: `${start}:00`, end_time: end === null ? null : `${end}:00`,
    source: 'manual', source_rule_id: null,
    confirmed_at: null, confirmed_by: null, break_minutes: 0,
    clock_in_at: null, clock_out_at: null,
    auto_closed: false, created_at: '', updated_at: '', ...over,
  };
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const PREVIEW_SHIFTS: Shift[] = [
  // ── Carlos: an ORDINARY two weeks, and ONE Tuesday that carries a split shift ─────────────
  // Deliberately dull apart from Tuesday, because the review is about the day-specific incentive.
  // Week 1 = 40.00, week 2 = 40.00 → 80.00 payable hours; at $25.00 that is exactly $2,000.00.
  punch('e-carlos', '2026-08-24', '08:00', '16:00'),  //  8.00
  punch('e-carlos', '2026-08-25', '08:00', '16:00'),  //  8.00
  punch('e-carlos', '2026-08-26', '08:00', '16:00'),  //  8.00
  punch('e-carlos', '2026-08-27', '08:00', '16:00'),  //  8.00
  punch('e-carlos', '2026-08-28', '08:00', '16:00'),  //  8.00  → week 1 = 40.00
  punch('e-carlos', '2026-08-31', '08:00', '16:00'),  //  8.00
  // TUESDAY Sep 1 — TWO separate shifts, 4.00 each. The day is worth 8.00 payable hours, so the
  // Tuesday incentive must price BOTH of them: 8 x $5.00 = $40.00, not 4 x $5.00.
  punch('e-carlos', '2026-09-01', '06:00', '10:00'),  //  4.00
  punch('e-carlos', '2026-09-01', '14:00', '18:00'),  //  4.00  → Tuesday = 8.00
  punch('e-carlos', '2026-09-02', '08:00', '16:00'),  //  8.00
  punch('e-carlos', '2026-09-03', '08:00', '16:00'),  //  8.00
  punch('e-carlos', '2026-09-04', '08:00', '16:00'),  //  8.00  → week 2 = 40.00
  // ── Juan: the double-pay pattern, a forgotten clock-out, and clean days ───────────────────
  // A 47.75h punch with a 40h break — abnormal span, ordinary paid hours.
  punch('e-juan', '2026-08-24', '05:59', '05:44', {
    clock_out_at: laWallTimeToUtc('2026-08-26', '05:44').toISOString(),
    break_minutes: 2417,
  }),
  manual('e-juan', '2026-08-24', '06:00', '14:00'), // stacked on the punch above
  // THE SPLIT DAY. Two separate clock sessions on one Monday — 4.00 h each, 8.00 h for the day.
  // Before the calendarModel fix the second one existed in the database but never reached the
  // confirm queue, so it could not be paid.
  punch('e-juan', '2026-08-25', '06:00', '10:00'),
  punch('e-juan', '2026-08-25', '14:00', '18:00'),
  punch('e-juan', '2026-08-26', '06:06', '14:01', { break_minutes: 27 }),
  manual('e-juan', '2026-08-26', '06:00', '14:00'), // stacked again
  punch('e-juan', '2026-08-27', '06:04', '14:02', { break_minutes: 62 }),
  punch('e-juan', '2026-08-27', '18:59', '23:30'), // a legitimate split shift, same day
  punch('e-juan', '2026-08-28', '05:48', '13:20'),
  punch('e-juan', '2026-09-01', '06:15', '13:58'),
  punch('e-juan', '2026-09-02', '06:00', '14:00', { confirmed_at: null, confirmed_by: null }),
  manual('e-juan', '2026-09-04', '09:00', '17:00', { source_rule_id: 'pv-rule-1' }), // plan, not pay
  punch('e-juan', '2026-09-05', '06:02', '14:07', { break_minutes: 30 }),

  // ── Adriana: an overnight host shift and one overlap ──────────────────────────────────────
  punch('e-adriana', '2026-08-31', '15:52', '01:44'),
  manual('e-adriana', '2026-08-31', '16:00', '00:00'), // overlaps the punch
  punch('e-adriana', '2026-09-01', '16:34', '23:12'),
  punch('e-adriana', '2026-09-03', '16:02', '22:30', { break_minutes: 30 }),

  // ── Chris: clean, plus an open clock-in that is not being paid ────────────────────────────
  punch('e-chris', '2026-08-25', '06:21', '14:00', { break_minutes: 30 }),
  punch('e-chris', '2026-08-26', '06:15', '14:05', { break_minutes: 30 }),
  punch('e-chris', '2026-09-02', '06:03', '14:11'),
  manual('e-chris', '2026-09-05', '06:00', null), // still on the clock

  // ── Haley: entirely clean — the ordinary case ─────────────────────────────────────────────
  punch('e-haley', '2026-08-25', '16:08', '22:05'),
  punch('e-haley', '2026-08-27', '16:01', '22:12', { break_minutes: 15 }),
  punch('e-haley', '2026-09-01', '16:00', '21:58'),
  punch('e-haley', '2026-09-03', '15:58', '22:03', { break_minutes: 15 }),

  // ── Marcus: nothing but an unconfirmed punch — pays zero until a manager acts ─────────────
  punch('e-marcus', '2026-09-04', '07:00', '15:00', { confirmed_at: null, confirmed_by: null }),

  // ── Priya: a single hand-entered correction ───────────────────────────────────────────────
  manual('e-priya', '2026-08-29', '17:00', '21:30', { break_minutes: 15 }),

  // ── Devon: worked hours at a $0 rate — reported as zero owed, never hidden ────────────────
  punch('e-devon', '2026-09-02', '08:00', '12:00'),
];

// ── Bonus / incentive fixtures (migrations 150 + 151 rows) ──────────────────────────────────
//
// Plain objects shaped exactly like `employee_pay_adjustments` rows. The periods are the real
// canonical windows, because the selector matches on them: PREVIEW_PERIOD is 2026-08-24 →
// 2026-09-06, and the row dated to the PREVIOUS period is here to prove the scoping — it must never
// appear in the period on screen, and the review is worth less without something that is supposed
// to be invisible.
//
// Money is INTEGER CENTS. 10000 = $100.00 flat; 500 = $5.00 PER PAYABLE HOUR ON ONE DAY.
//
// EVERY HOURLY ROW NAMES A DAY. There is no pay-period-wide hourly bonus any more, and the database
// refuses an hourly row without a target_date inside its own period (migration 151).
//
// NOTE WHAT IS *NOT* HERE: no calculated total on any hourly row. Its worth is derived from that
// DAY's payable hours every time a statement is built — which is what the review demonstrates:
// edit one of Carlos's Tuesday shifts and the Tuesday incentive re-prices itself.
//
// Carlos's reviewed figures: 80.00 payable hours at $25.00 = $2,000.00 worked pay; Tuesday Sep 1
// carries 8.00 of those hours (a 4 hr + 4 hr split shift); a $5.00/hr Tuesday incentive is worth
// $40.00 → $2,040.00 owed. His stored hourly_rate stays $25.00 — never $30.00.
// His Saturday line is the ZERO-HOUR case and adds $0.00, so it does not disturb that figure.
export const PREVIEW_ADJUSTMENTS: PayAdjustment[] = [
  // THE HEADLINE CASE — a day-specific hourly incentive on a Tuesday that carries a split shift.
  {
    id: 'pv-b1', user_id: 'preview-owner', employee_id: 'e-carlos',
    period_start: PREVIEW_PERIOD.start, period_end: PREVIEW_PERIOD.end,
    kind: 'bonus', calculation_type: 'hourly', amount_cents: null, rate_cents_per_hour: 500,
    target_date: '2026-09-01', description: 'Tuesday incentive',
    created_at: '2026-09-07T18:00:00.000Z', updated_at: '2026-09-07T18:00:00.000Z',
  },
  // A FLAT bonus — unchanged behaviour, no day, no hours dependency. Deliberately on SOMEONE ELSE
  // so Carlos's headline stays exactly $2,000.00 worked + $40.00 Tuesday = $2,040.00, which is the
  // figure this review is for.
  {
    id: 'pv-b2', user_id: 'preview-owner', employee_id: 'e-juan',
    period_start: PREVIEW_PERIOD.start, period_end: PREVIEW_PERIOD.end,
    kind: 'bonus', calculation_type: 'flat', amount_cents: 10000, rate_cents_per_hour: null,
    target_date: null, description: 'Performance bonus',
    created_at: '2026-09-07T18:05:00.000Z', updated_at: '2026-09-07T18:05:00.000Z',
  },
  // A ZERO-HOUR DAY. Saturday Aug 29 is an Off day for Carlos, so this incentive is worth $0.00
  // today — legal, visible, and it re-prices itself the moment a Saturday shift is confirmed.
  {
    id: 'pv-b3', user_id: 'preview-owner', employee_id: 'e-carlos',
    period_start: PREVIEW_PERIOD.start, period_end: PREVIEW_PERIOD.end,
    kind: 'bonus', calculation_type: 'hourly', amount_cents: null, rate_cents_per_hour: 500,
    target_date: '2026-08-29', description: 'Saturday cover incentive',
    created_at: '2026-09-07T18:10:00.000Z', updated_at: '2026-09-07T18:10:00.000Z',
  },
  // A LIVE HOST on a day-specific incentive, so the review covers the team whose payable hours are
  // the APPROVED duration rather than the punch. Priced off that same figure, for that one day.
  {
    id: 'pv-b4', user_id: 'preview-owner', employee_id: 'e-adriana',
    period_start: PREVIEW_PERIOD.start, period_end: PREVIEW_PERIOD.end,
    kind: 'bonus', calculation_type: 'hourly', amount_cents: null, rate_cents_per_hour: 300,
    target_date: '2026-08-31', description: 'Live show incentive',
    created_at: '2026-09-07T19:00:00.000Z', updated_at: '2026-09-07T19:00:00.000Z',
  },
  // A bonus with no reason given — it has to render as something, and "Bonus" is that something.
  {
    id: 'pv-b5', user_id: 'preview-owner', employee_id: 'e-haley',
    period_start: PREVIEW_PERIOD.start, period_end: PREVIEW_PERIOD.end,
    kind: 'bonus', calculation_type: 'flat', amount_cents: 7500, rate_cents_per_hour: null,
    target_date: null, description: null,
    created_at: '2026-09-07T19:05:00.000Z', updated_at: '2026-09-07T19:05:00.000Z',
  },
  // ANOTHER PERIOD'S BONUS. Same person, $999.00, and it must be nowhere on this screen.
  {
    id: 'pv-b-other-period', user_id: 'preview-owner', employee_id: 'e-carlos',
    period_start: '2026-08-10', period_end: '2026-08-23',
    kind: 'bonus', calculation_type: 'flat', amount_cents: 99900, rate_cents_per_hour: null,
    target_date: null, description: 'Previous period bonus',
    created_at: '2026-08-24T18:00:00.000Z', updated_at: '2026-08-24T18:00:00.000Z',
  },
];
