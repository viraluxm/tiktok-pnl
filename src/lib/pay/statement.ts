import {
  isPayableShift,
  paidShiftHours,
  type ShiftLike,
} from '@/lib/employees';
import { laWallClockOf } from '@/lib/schedule/timezone';
import { MAX_PLAUSIBLE_PUNCH_HOURS } from '@/lib/shipping/pickCostEconomics';
import type { Employee, Shift } from '@/types';

// ONE NORMALIZED PAY STATEMENT. This module is the single place a pay period is turned into
// per-employee rows, hours, money and review warnings. The Pay Detail screen and the PDF both
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

// ── Interval derivation ─────────────────────────────────────────────────────────────────────
//
// The occupancy interval of a worked row, used ONLY for overlap and span warnings — never for
// money. It is a branch-for-branch port of the database's canonical range helper
// `public.lensed_shift_wall_range(source, date, start_time, end_time, clock_in_at, clock_out_at)`
// (migration 131), which is what lensed_create_manual_worked_shift refuses overlapping writes
// against. The UI warning and the DB guard must name the same conflicts, so there is exactly one
// rule and this is a transcription of it:
//
//   * time_clock WITH both instants → the punch instants, read as America/Los_Angeles wall time.
//     Instants have no 24-hour ceiling, which is deliberate (a 26h forgotten clock-out must read
//     as 26h, not wrap to 2h and hide a conflict).
//   * anything else                 → date + start_time … date + end_time, plus a day when
//     end_time <= start_time (ran past midnight).
//   * end_time NULL                 → unbounded upper, matching the DB's `tsrange(lo, null)`.
//
// TESTED FOR THE INSTANTS, NEVER INFERRED FROM `source`. Three shipped kiosk RPCs are written as
// though they could insert a time_clock row with NULL instants; the hosted CHECK constraint
// `shifts_time_clock_has_instants` currently forbids it (verified against the live schema), but
// this code does not depend on that — it takes the wall-clock branch whenever an instant is
// missing, exactly as paidShiftHours does.
//
// Working in WALL space (plain minutes on a civil calendar) rather than absolute instants is not
// a shortcut: it is what the DB does, because tsrange is `timestamp without time zone`. Two rows
// conflict when they occupy the same wall time, which is the question a manager is asking.
//
// KNOWN GRANULARITY: laWallClockOf truncates to the minute (real punches carry seconds), so an
// interval here can differ from the DB's by up to 59s. Minutes are the granularity the editor and
// every other surface work at; a sub-minute touch is not a conflict a manager can act on.

const MINUTES_PER_DAY = 1440;

// Days from 1970-01-01 for a 'YYYY-MM-DD', by pure integer civil-calendar arithmetic. Date is
// avoided on purpose: this must be identical on a UTC server and an LA laptop.
function daysFromEpoch(dateISO: string): number {
  const y = Number(dateISO.slice(0, 4));
  const m = Number(dateISO.slice(5, 7));
  const d = Number(dateISO.slice(8, 10));
  // Howard Hinnant's days_from_civil.
  const yAdj = m <= 2 ? y - 1 : y;
  const era = Math.floor(yAdj / 400);
  const yoe = yAdj - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function minutesOfDay(timeHHMM: string): number {
  return Number(timeHHMM.slice(0, 2)) * 60 + Number(timeHHMM.slice(3, 5));
}

// Absolute minutes on the civil calendar — the comparable coordinate every interval uses.
function wallMinutes(dateISO: string, timeHHMM: string): number {
  return daysFromEpoch(dateISO) * MINUTES_PER_DAY + minutesOfDay(timeHHMM);
}

/** A half-open [lo, hi) occupancy interval in wall minutes. `hi` null = open/unbounded. */
export interface WallInterval {
  lo: number;
  hi: number | null;
}

/** The fields interval derivation needs. Satisfied by a stored `Shift`. */
export type IntervalShift = Pick<Shift, 'date' | 'start_time' | 'end_time'> &
  Partial<Pick<Shift, 'source' | 'clock_in_at' | 'clock_out_at'>>;

export function wallIntervalOf(s: IntervalShift): WallInterval {
  const usesInstants = s.source === 'time_clock' && !!s.clock_in_at && !!s.clock_out_at;
  if (usesInstants) {
    const inAt = laWallClockOf(s.clock_in_at as string);
    const outAt = laWallClockOf(s.clock_out_at as string);
    const a = wallMinutes(inAt.date, inAt.time);
    const b = wallMinutes(outAt.date, outAt.time);
    // LEAST/GREATEST, as the DB helper does — an inverted pair is normalised, not negative.
    return { lo: Math.min(a, b), hi: Math.max(a, b) };
  }
  const lo = wallMinutes(s.date, s.start_time);
  if (s.end_time == null) return { lo, hi: null }; // open shift — unbounded, like tsrange(lo, null)
  const endM = minutesOfDay(s.end_time);
  const startM = minutesOfDay(s.start_time);
  const wrap = endM <= startM ? MINUTES_PER_DAY : 0; // `<=`, matching lensed_shift_wall_range
  return { lo, hi: lo + (endM - startM) + wrap };
}

function intervalsOverlap(a: WallInterval, b: WallInterval): boolean {
  const aHi = a.hi ?? Infinity;
  const bHi = b.hi ?? Infinity;
  return a.lo < bHi && b.lo < aHi; // half-open: touching endpoints do not overlap
}

// ── Warnings ────────────────────────────────────────────────────────────────────────────────

/**
 * How many days BEFORE the pay period the overlap scan must also read.
 *
 * The Pay tab fetches by the `shifts.date` COLUMN, but a time_clock row's real interval comes
 * from its instants and has no 24-hour ceiling — production holds a punch dated 2026-08-24 whose
 * span is 47.75h and therefore occupies 2026-08-26. A row dated just before the period can reach
 * into it, and scanning only the period would miss exactly the conflict the database's own guard
 * exists to catch (commit 717fe22 removed the same date-bounded mistake from that guard).
 *
 * 3 days clears the worst shape on record with a day of slack: measured against live data, the
 * furthest any stored row reaches past its own `date` is 2 days (max span 47.75h). This is a
 * BOUNDED APPROXIMATION of the RPC's deliberately unbounded per-employee scan — a hypothetical
 * 100-hour punch dated 4 days before the period would not be flagged here, though the RPC would
 * still refuse a write against it. Only a per-employee unbounded read is exact.
 */
export const OVERLAP_SCAN_LOOKBACK_DAYS = 3;

/**
 * Gross span, in hours, past which a worked interval is called out for review.
 *
 * Imported rather than redefined: 18 is the number this product already shows managers ("A single
 * punch over 18h is a missed clock-out, not a shift"), and it was tuned against real stored spans
 * — high enough to clear a genuine 16.08h double shift, low enough to catch every observed
 * anomaly. A fourth threshold competing with LONG_SHIFT_HOURS (16, an at-entry editor warning on
 * wall-clock duration) and IMPLAUSIBLE_SPAN_HOURS (14, orphaned) is the last thing payroll needs.
 *
 * Measured on the GROSS span, not on paid hours. The 47.75h row in production carries a 2417-minute
 * break and pays 7.47h; judged on paid hours it looks ordinary, and it is precisely the row a
 * manager must see.
 *
 * (The constant lives in a shipping module, which is poor layering. Left where it is: relocating a
 * shared constant is not this feature's business, and duplicating it would defeat the point.)
 */
export const LONG_SPAN_HOURS = MAX_PLAUSIBLE_PUNCH_HOURS;

export type WarningKind = 'overlap' | 'long_span' | 'manual_entry';

export interface RowWarning {
  kind: WarningKind;
  /** Manager-facing, plain language. No table names, no column names, no RPC names. */
  label: string;
  detail: string;
  /** 'review' needs a decision; 'note' is context, not a problem. */
  tone: 'review' | 'note';
}

/** Why a row inside the period contributed nothing — the reasons isPayableShift encodes. */
export type ExclusionReason = 'open' | 'schedule_plan' | 'awaiting_confirmation';

const EXCLUSION_COPY: Record<ExclusionReason, { label: string; detail: string }> = {
  open: {
    label: 'Open Clock-In',
    detail: 'Still on the clock — no end time recorded, so these hours are not being paid yet.',
  },
  schedule_plan: {
    label: 'Scheduled Only',
    detail: 'This came from the schedule, not from worked time. Scheduled hours are never paid.',
  },
  awaiting_confirmation: {
    label: 'Needs Review',
    detail: 'A time-clock punch waiting on a manager. It stays out of pay until it is confirmed.',
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
  /** Gross occupancy before the break — what the long-span warning judges. */
  spanHours: number;
  rate: number;
  amount: number;
  source: 'time_clock' | 'manual';
  sourceLabel: string;
  warnings: RowWarning[];
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
  reviewCount: number;
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

function isoPlusDays(dateISO: string, n: number): string {
  const days = daysFromEpoch(dateISO) + n;
  // civil_from_days, the inverse of daysFromEpoch above.
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const year = m <= 2 ? y + 1 : y;
  return `${String(year).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export interface BuildStatementInput {
  employee: Employee;
  period: { start: string; end: string; payday: string };
  /**
   * Every `shifts` row for THIS employee in [period.start − OVERLAP_SCAN_LOOKBACK_DAYS, period.end].
   * The wider window feeds the overlap scan only; rows dated before period.start are never paid
   * and never listed. Filtering happens here, on `date`, exactly as the Pay tab's query does.
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

  // Overlap candidates: the database guard's set, with ONE deliberate narrowing.
  //
  // Kept, as the guard keeps them: unconfirmed punches. An unconfirmed punch is real worked time
  // that becomes payable the moment a manager confirms it, which is exactly when a manual row
  // stacked on top of it starts paying twice — so it must raise the flag before that happens.
  //
  // Dropped, where the guard keeps them: OPEN rows. The guard treats an open shift as unbounded
  // because it has to refuse a write that MIGHT collide with wherever that punch eventually ends.
  // A review warning is answering a different question, and inheriting the unbounded reach here
  // makes one forgotten clock-out declare a conflict against every shift that follows it — noise
  // that buries the real overlaps. An open row is not payable (isPayableShift drops it) so it is
  // double-paying nothing, and it is already called out on its own as an Open Clock-In.
  const candidates = mine
    .filter((s) => s.source_rule_id == null)
    .map((s) => ({ shift: s, interval: wallIntervalOf(s) }))
    .filter((c) => c.interval.hi !== null);

  const overlapPartners = new Map<string, Shift[]>();
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];
      if (!intervalsOverlap(a.interval, b.interval)) continue;
      const forA = overlapPartners.get(a.shift.id) ?? [];
      forA.push(b.shift);
      overlapPartners.set(a.shift.id, forA);
      const forB = overlapPartners.get(b.shift.id) ?? [];
      forB.push(a.shift);
      overlapPartners.set(b.shift.id, forB);
    }
  }

  const payable = inPeriod.filter((s) => isPayableShift(s));
  const rows: StatementRow[] = payable
    .map((s) => {
      const span = displaySpan(s);
      const interval = wallIntervalOf(s);
      const spanHours = interval.hi == null ? 0 : (interval.hi - interval.lo) / 60;
      const paidHours = paidShiftHours(s);
      const warnings: RowWarning[] = [];

      const partners = overlapPartners.get(s.id);
      if (partners && partners.length > 0) {
        warnings.push({
          kind: 'overlap',
          label: 'Overlapping Worked Time',
          // Deliberately NOT quantified in hours or dollars. The occupancy interval is gross and
          // does not subtract breaks, so any figure stated here would not be the money at stake.
          // The manager is shown WHICH records conflict and decides; nothing decides for them.
          detail: `Covers the same time as ${partners.length === 1 ? 'another record' : `${partners.length} other records`} for ${employee.name}: ${partners
            .map((p) => {
              const ps = displaySpan(p);
              const end = ps.end ? formatClock12(ps.end) : 'still open';
              return `${formatDayLabel(p.date)} ${formatClock12(ps.start)}–${end} (${
                p.source === 'time_clock' ? 'Time Clock' : 'Manual Entry'
              })`;
            })
            .join('; ')}. Both are being paid. Review which one is right.`,
          tone: 'review',
        });
      }

      if (spanHours > LONG_SPAN_HOURS) {
        warnings.push({
          kind: 'long_span',
          label: 'Unusually Long',
          detail: `Runs ${spanHours.toFixed(1)} hours end to end — longer than a shift usually is, and often a missed clock-out.${
            s.break_minutes > 0
              ? ` A ${formatBreak(s.break_minutes)} break brings the paid time down to ${paidHours.toFixed(2)}.`
              : ''
          } The hours shown are being paid as-is.`,
          tone: 'review',
        });
      }

      if (s.source !== 'time_clock') {
        warnings.push({
          kind: 'manual_entry',
          label: 'Manual Entry',
          detail: 'Entered by hand rather than punched at the clock. Not a problem on its own.',
          tone: 'note',
        });
      }

      return {
        shiftId: s.id,
        dateISO: s.date,
        startLabel: span.start,
        endLabel: span.end,
        endDateISO: span.endDateISO,
        breakMinutes: s.break_minutes ?? 0,
        paidHours,
        spanHours,
        rate,
        amount: paidHours * rate,
        source: s.source === 'time_clock' ? 'time_clock' : 'manual',
        sourceLabel: s.source === 'time_clock' ? 'Time Clock' : 'Manual Entry',
        warnings,
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
  const reviewCount =
    rows.reduce((n, r) => n + r.warnings.filter((w) => w.tone === 'review').length, 0) +
    excluded.filter((e) => e.reason !== 'schedule_plan').length;

  return {
    employee: { id: employee.id, name: employee.name, role: employee.role },
    period,
    rate,
    rows,
    excluded,
    // One line, because one rate is all the product stores. Kept as a list so a real rate history
    // would extend this rather than force a second total somewhere else.
    rateLines: rows.length > 0 ? [{ rate, hours: paidHours, amount: gross }] : [],
    totals: { paidHours, gross, workedDays, rowCount: rows.length, reviewCount },
    generatedAtISO,
  };
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
 *   Lensed-Pay-Statement-Carlos-2026-08-24-to-2026-09-06.pdf
 * Deterministic for a given (employee, period): the same statement downloaded twice overwrites
 * rather than accumulating "(1)" copies.
 */
export function payStatementFilename(s: Pick<PayStatement, 'employee' | 'period'>): string {
  const name = s.employee.name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics — the filename stays ASCII
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const who = name || 'Employee';
  return `Lensed-Pay-Statement-${who}-${s.period.start}-to-${s.period.end}.pdf`;
}
