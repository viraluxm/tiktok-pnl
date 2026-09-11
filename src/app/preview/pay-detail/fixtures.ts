import { laWallTimeToUtc } from '@/lib/schedule/timezone';
import type { Employee, Shift } from '@/types';

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
