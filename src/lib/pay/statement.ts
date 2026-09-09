import {
  isPayableShift,
  paidShiftHours,
  type ShiftLike,
} from '@/lib/employees';
import { laWallClockOf } from '@/lib/schedule/timezone';
import type { Employee, Shift } from '@/types';

// ONE NORMALIZED PAY STATEMENT. This module is the single place a pay period is turned into
// per-employee rows, hours and money. The Pay Detail screen and the PDF both
// render the object this builds and neither does arithmetic of its own — that is the whole
// point. Two renderers over one model cannot disagree; two calculators always eventually do.
//
// IT DOES NOT REDEFINE PAYROLL. Payable-or-not is isPayableShift() and paid hours are
// paidShiftHours(), both imported from lib/employees — the exact functions computePay() calls
// for the Pay tab's tiles. buildPayStatement sums the same numbers over the same rows, so the
// detail total is the tile total by construction, not by coincidence (proven in statement.test.mjs).
//
// Pure: no React, no Supabase, no clock. `generatedAtISO` is passed in so a statement is a
// deterministic function of its inputs and can be tested without freezing time.

// ── Calendar arithmetic ─────────────────────────────────────────────────────────────────────
//
// Pure integer civil-calendar maths. Date is avoided on purpose: a statement must come out
// identical on a UTC server and an LA laptop.
//
// (An earlier pass also carried a port of the database's `lensed_shift_wall_range` helper here, to
// drive overlap and long-span warnings on the Pay screen. Those warnings were removed — a manager
// reads the records and judges them — so the port went with them rather than sitting unused and
// costing an O(n^2) scan on every statement build. The database keeps its own guard on writes;
// nothing here needed to duplicate it.)

// Days from 1970-01-01 for a 'YYYY-MM-DD' — Howard Hinnant's days_from_civil.
function daysFromEpoch(dateISO: string): number {
  const y = Number(dateISO.slice(0, 4));
  const m = Number(dateISO.slice(5, 7));
  const d = Number(dateISO.slice(8, 10));
  const yAdj = m <= 2 ? y - 1 : y;
  const era = Math.floor(yAdj / 400);
  const yoe = yAdj - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

// The inverse — civil_from_days — so a date can be stepped without touching Date.
function isoPlusDays(dateISO: string, n: number): string {
  const z = daysFromEpoch(dateISO) + n + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const year = m <= 2 ? y + 1 : y;
  return `${String(year).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function minutesOfDay(timeHHMM: string): number {
  return Number(timeHHMM.slice(0, 2)) * 60 + Number(timeHHMM.slice(3, 5));
}

// ── Rows that sit in the period without being paid ──────────────────────────────────────────

/** Why a row inside the period contributed nothing — the reasons isPayableShift encodes. */
export type ExclusionReason = 'open' | 'schedule_plan' | 'awaiting_confirmation';

// Plain statements of fact about why a record carries no money — not verdicts on it. These sit in
// a quiet list under the worked time so a light total is explainable, and nothing here tells the
// manager that something is wrong.
const EXCLUSION_COPY: Record<ExclusionReason, { label: string; detail: string }> = {
  open: {
    label: 'Open clock-in',
    detail: 'No end time recorded yet.',
  },
  schedule_plan: {
    label: 'Scheduled only',
    detail: 'From the schedule, not worked time.',
  },
  awaiting_confirmation: {
    label: 'Unconfirmed punch',
    detail: 'Stays out of pay until it is confirmed.',
  },
};

// The reason a row failed isPayableShift, in that function's own order of precedence. Returns
// null for a payable row. Deliberately derived from the SAME predicate rather than a parallel
// one — a second copy of the payable rule is how a detail view starts disagreeing with its total.
export function exclusionReasonOf(s: ShiftLike): ExclusionReason | null {
  if (isPayableShift(s)) return null;
  if (s.end_time == null) return 'open';
  if (s.source_rule_id != null) return 'schedule_plan';
  return 'awaiting_confirmation';
}

// ── The statement model ─────────────────────────────────────────────────────────────────────

export interface StatementRow {
  shiftId: string;
  /** Business date, 'YYYY-MM-DD'. */
  dateISO: string;
  /** Start as Pacific wall clock 'HH:MM' — from the SAME basis the paid hours come from. */
  startLabel: string;
  endLabel: string;
  /** Set only when the end lands on a different calendar day, so '05:59–05:44' is never a lie. */
  endDateISO: string | null;
  breakMinutes: number;
  /** === paidShiftHours(shift). Never recomputed downstream. */
  paidHours: number;
  rate: number;
  amount: number;
  source: 'time_clock' | 'manual';
  /** Neutral context only: 'Time Clock' or 'Manual Entry'. */
  sourceLabel: string;
}

export interface ExcludedRow {
  shiftId: string;
  dateISO: string;
  startLabel: string;
  endLabel: string | null;
  reason: ExclusionReason;
  label: string;
  detail: string;
}

/**
 * One line per distinct rate in the period.
 *
 * Today Lensed stores exactly one rate per person — `employees.hourly_rate`, a single scalar. It
 * was verified against the live schema that no rate-history table, per-shift rate column or
 * override mechanism exists anywhere in the database, so a statement has exactly one line here.
 * It is modelled as a list anyway because that is the honest shape of "rate breakdown", and
 * because a future rate history would otherwise force the total to be recomputed somewhere else.
 * Nothing here invents a rate the product does not have.
 */
export interface RateLine {
  rate: number;
  hours: number;
  amount: number;
}

export interface StatementTotals {
  paidHours: number;
  gross: number;
  /** Distinct calendar dates with at least one payable row. */
  workedDays: number;
  rowCount: number;
}

export interface PayStatement {
  employee: { id: string; name: string; role: string };
  period: { start: string; end: string; payday: string };
  rate: number;
  rows: StatementRow[];
  excluded: ExcludedRow[];
  rateLines: RateLine[];
  totals: StatementTotals;
  /** Passed in by the caller — this module never reads a clock. */
  generatedAtISO: string;
}

function hhmm(t: string): string {
  return t.slice(0, 5);
}

// The wall clock a row MEANS, on the same basis its paid hours come from. A time_clock row's
// start_time/end_time are only a copy of its instants and can be stale on a historically edited
// row; showing them next to hours derived from the instants is exactly the class of bug this
// feature exists to make impossible. Mirrors shiftEditPrefill (lib/shifts/punchEdit.ts), which is
// what the edit modal opens at — so the row a manager reads and the form they edit agree.
function displaySpan(s: Shift): { start: string; end: string; endDateISO: string | null } {
  if (s.source === 'time_clock' && s.clock_in_at && s.clock_out_at) {
    const a = laWallClockOf(s.clock_in_at);
    const b = laWallClockOf(s.clock_out_at);
    return { start: a.time, end: b.time, endDateISO: b.date === a.date ? null : b.date };
  }
  const start = hhmm(s.start_time);
  const end = s.end_time == null ? '' : hhmm(s.end_time);
  const wraps = s.end_time != null && minutesOfDay(s.end_time) <= minutesOfDay(s.start_time);
  return {
    start,
    end,
    endDateISO: wraps ? isoPlusDays(s.date, 1) : null,
  };
}


export interface BuildStatementInput {
  employee: Employee;
  period: { start: string; end: string; payday: string };
  /**
   * `shifts` rows for THIS employee. Anything outside [period.start, period.end] is ignored —
   * filtering happens here, on `date`, exactly as the Pay tab's own query does, so a caller may
   * safely pass a wider fetch.
   */
  shifts: Shift[];
  generatedAtISO: string;
}

export function buildPayStatement(input: BuildStatementInput): PayStatement {
  const { employee, period, shifts, generatedAtISO } = input;
  const rate = employee.hourly_rate;

  const mine = shifts.filter((s) => s.employee_id === employee.id);
  // In-period rows, by the same `date` predicate useShifts uses. An overnight row belongs to the
  // period its own `date` falls in, which is the existing rule and is deliberately not changed.
  const inPeriod = mine.filter((s) => s.date >= period.start && s.date <= period.end);

  const payable = inPeriod.filter((s) => isPayableShift(s));
  const rows: StatementRow[] = payable
    .map((s) => {
      const span = displaySpan(s);
      const paidHours = paidShiftHours(s);
      return {
        shiftId: s.id,
        dateISO: s.date,
        startLabel: span.start,
        endLabel: span.end,
        endDateISO: span.endDateISO,
        breakMinutes: s.break_minutes ?? 0,
        paidHours,
        rate,
        amount: paidHours * rate,
        source: s.source === 'time_clock' ? 'time_clock' : 'manual',
        sourceLabel: s.source === 'time_clock' ? 'Time Clock' : 'Manual Entry',
      } satisfies StatementRow;
    })
    .sort((a, b) => a.dateISO.localeCompare(b.dateISO) || a.startLabel.localeCompare(b.startLabel));

  const excluded: ExcludedRow[] = inPeriod
    .map((s) => ({ s, reason: exclusionReasonOf(s) }))
    .filter((x): x is { s: Shift; reason: ExclusionReason } => x.reason !== null)
    .map(({ s, reason }) => {
      const span = displaySpan(s);
      return {
        shiftId: s.id,
        dateISO: s.date,
        startLabel: span.start,
        endLabel: span.end || null,
        reason,
        ...EXCLUSION_COPY[reason],
      };
    })
    .sort((a, b) => a.dateISO.localeCompare(b.dateISO) || a.startLabel.localeCompare(b.startLabel));

  // TOTAL HOURS ARE SUMMED THE WAY computePay SUMS THEM — same predicate, same per-row function,
  // same accumulation order over the same rows — so the detail total and the Pay tile are the
  // same number, not two numbers that agree. Gross is `hours * rate`, character for character
  // the expression computePay uses, rather than a sum of per-row amounts, so no rounding can
  // creep between the tile and the statement.
  let paidHours = 0;
  for (const r of rows) paidHours += r.paidHours;
  const gross = paidHours * rate;

  const workedDays = new Set(rows.map((r) => r.dateISO)).size;

  return {
    employee: { id: employee.id, name: employee.name, role: employee.role },
    period,
    rate,
    rows,
    excluded,
    // One line, because one rate is all the product stores. Kept as a list so a real rate history
    // would extend this rather than force a second total somewhere else.
    rateLines: rows.length > 0 ? [{ rate, hours: paidHours, amount: gross }] : [],
    totals: { paidHours, gross, workedDays, rowCount: rows.length },
    generatedAtISO,
  };
}

// ── Grouping: the same arrangement on screen and on paper ───────────────────────────────────
//
// These only ARRANGE `statement.rows` — every hour they report is a sum of numbers buildPayStatement
// already computed, so there is still exactly one payroll calculation. Both the Pay Details panel
// and the PDF read these, which is what keeps a day's total on screen equal to the same day's total
// on paper.
//
// MULTIPLE RECORDS ON ONE DAY STAY SEPARATE. A split shift, or a hand-entered correction sitting
// beside a punch, are different records that a manager may need to edit one at a time; merging them
// into a day total would take that away and hide what actually happened.

export interface DayGroup {
  dateISO: string;
  /** 'Monday'. */
  dayName: string;
  /** Every payable record on this date, earliest first. Empty on a day nobody worked. */
  rows: StatementRow[];
  /** Sum of this day's rows. 0 on a day with no payable record. */
  hours: number;
  amount: number;
}

export interface PeriodWeek {
  /** 1 or 2 for a normal biweekly period. */
  index: number;
  start: string;
  end: string;
  /** Every calendar day in the week, worked or not. */
  days: DayGroup[];
  hours: number;
  amount: number;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function weekdayIndex(dateISO: string): number {
  return ((daysFromEpoch(dateISO) % 7) + 11) % 7; // 1970-01-01 was a Thursday
}

function dayGroupFor(dateISO: string, rows: StatementRow[]): DayGroup {
  let hours = 0;
  let amount = 0;
  for (const r of rows) {
    hours += r.paidHours;
    amount += r.amount;
  }
  return { dateISO, dayName: DAY_NAMES[weekdayIndex(dateISO)], rows, hours, amount };
}

/** The days that actually have payable records, in date order. What the Pay Details panel lists. */
export function workedDayGroups(statement: PayStatement): DayGroup[] {
  const byDate = new Map<string, StatementRow[]>();
  for (const r of statement.rows) {
    const arr = byDate.get(r.dateISO);
    if (arr) arr.push(r);
    else byDate.set(r.dateISO, [r]);
  }
  return [...byDate.keys()].sort().map((d) => dayGroupFor(d, byDate.get(d) as StatementRow[]));
}

/**
 * The WHOLE pay period as consecutive 7-day weeks, every calendar day present whether or not it
 * was worked — the shape the printed statement is read in, where an empty Tuesday is information.
 *
 * Weeks are chunked from the period's own span rather than assuming 14 days, so a period of any
 * length still comes out whole (the last chunk is simply short). For the biweekly period this
 * product actually issues, that is exactly Week 1 and Week 2.
 */
export function payPeriodWeeks(statement: PayStatement): PeriodWeek[] {
  const byDate = new Map<string, StatementRow[]>();
  for (const r of statement.rows) {
    const arr = byDate.get(r.dateISO);
    if (arr) arr.push(r);
    else byDate.set(r.dateISO, [r]);
  }

  const first = daysFromEpoch(statement.period.start);
  const last = daysFromEpoch(statement.period.end);
  const weeks: PeriodWeek[] = [];
  for (let offset = 0; first + offset <= last; offset += 7) {
    const days: DayGroup[] = [];
    let hours = 0;
    let amount = 0;
    for (let d = 0; d < 7 && first + offset + d <= last; d++) {
      const iso = isoPlusDays(statement.period.start, offset + d);
      const group = dayGroupFor(iso, byDate.get(iso) ?? []);
      hours += group.hours;
      amount += group.amount;
      days.push(group);
    }
    weeks.push({
      index: weeks.length + 1,
      start: days[0].dateISO,
      end: days[days.length - 1].dateISO,
      days,
      hours,
      amount,
    });
  }
  return weeks;
}

// ── Presentation helpers shared by the screen and the PDF ───────────────────────────────────

/** '05:59' → '5:59 AM'. */
export function formatClock12(t: string): string {
  if (!t) return '—';
  const h = Number(t.slice(0, 2));
  const m = t.slice(3, 5);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m} ${suffix}`;
}

/** '2026-08-24' → 'Mon Aug 24'. UTC-pinned so the label never drifts by host timezone. */
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function formatDayLabel(dateISO: string): string {
  const dow = ((daysFromEpoch(dateISO) % 7) + 11) % 7; // 1970-01-01 was a Thursday
  return `${WEEKDAY[dow]} ${MONTH[Number(dateISO.slice(5, 7)) - 1]} ${Number(dateISO.slice(8, 10))}`;
}

export function formatBreak(minutes: number): string {
  if (minutes <= 0) return '—';
  // Past an hour, minutes stop being readable — a real row carries a 2417-minute break, which
  // nobody parses as "just over forty hours" at a glance.
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** '$1,234.56'. Same shape as lib/calculations fmt, duplicated-free by being the only formatter
 *  the statement + PDF use; the screen keeps using fmt so the tile and the drawer read alike. */
export function formatMoney(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * A stable, filesystem-safe document name:
 *   Viralux-Payroll-Hours-Statement-Carlos-2026-08-24-to-2026-09-06.pdf
 * Named for what the document IS and who issues it — the employee-facing statement is Viralux
 * Media paperwork, not Lensed's. Deterministic for a given (employee, period): the same statement
 * downloaded twice overwrites rather than accumulating "(1)" copies.
 */
export function payStatementFilename(s: Pick<PayStatement, 'employee' | 'period'>): string {
  const name = s.employee.name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics — the filename stays ASCII
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const who = name || 'Employee';
  return `Viralux-Payroll-Hours-Statement-${who}-${s.period.start}-to-${s.period.end}.pdf`;
}
