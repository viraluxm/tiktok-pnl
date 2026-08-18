import type { Employee, Shift } from '@/types';
import { isOpenShift, isPayableShift, paidShiftHours } from '@/lib/employees';

// Punch-derived labor per business date per role. The ONLY hours/payability logic is
// paidShiftHours + isPayableShift reused VERBATIM from employees.ts — this module never
// reimplements either, so labor and payroll can never drift (see labor.test.mjs 2a).
//
// Basis: clock-in/out INSTANTS (never scheduled hours). isPayableShift already drops
// materialized-plan rows (source_rule_id) and unconfirmed time-clock punches. Manual edits
// to punch times flow through automatically because we read the punch every call and cache
// no derived figure.

const TZ = 'America/Los_Angeles';
// Session-fallback guards (mirror the intent of labor/route.ts's 10min–11h bounds).
const MIN_SESSION_HOURS = 10 / 60;
const MAX_SESSION_HOURS = 11;

// The shift shape the labor calc needs: payroll's fields PLUS `date` (the bucket fallback
// for manual shifts with a null clock_in_at). Everything here comes straight off a shifts row.
export type LaborShift = Pick<Shift, 'employee_id' | 'date' | 'start_time' | 'end_time'> &
  Partial<Pick<Shift, 'source' | 'source_rule_id' | 'confirmed_at' | 'break_minutes' | 'clock_in_at' | 'clock_out_at'>>;

// Minimal live_sessions shape for the HOST fallback.
export interface SessionLike {
  host_id: string | null;
  started_at: string;
  ended_at: string | null;
}

export type LaborBasis = 'punch' | 'session_fallback' | 'mixed';
export type LaborRole = 'host' | 'fulfillment';

// One (employee, date) unit of labor — the grain reconciliation and double-count tests read.
export interface LaborContribution {
  employee_id: string;
  date: string; // Pacific business date, YYYY-MM-DD
  role: string; // employees.role (typed string in the schema; 'host'/'fulfillment' aggregate into cells)
  basis: 'punch' | 'session_fallback';
  hours: number;
  cents: number;
  zero_rate_flag: boolean; // fallback host whose rate is 0/null — hours emitted, cost flagged not silently $0
}

// One (date, role) aggregate — the dashboard row.
export interface LaborCell {
  date: string;
  role: LaborRole;
  hours: number;
  cents: number;
  labor_basis: LaborBasis; // 'mixed' when a date's hosts are part punch, part session-fallback
  unconfirmed_hours_excluded: number; // payable-but-for-confirmation punch hours held back (pending labor)
  zero_rate_flag: boolean; // any contributing host was rate-flagged
}

export interface LaborResult {
  cells: LaborCell[];
  contributions: LaborContribution[];
}

type EmpLike = Pick<Employee, 'id' | 'role' | 'hourly_rate'>;

// Pacific calendar date (YYYY-MM-DD) for an instant, via the NAMED zone — DST-safe. This is
// exactly what the hardcoded '-07:00' at labor/route.ts:46-47 gets wrong after 2026-11-01.
export function pacificDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
}

// The business date a shift books to: its clock-in Pacific date, or shifts.date when there is
// no punch (manual shift, null clock_in_at). No midnight prorate — the whole shift lands here.
export function shiftBusinessDate(s: LaborShift): string {
  return s.clock_in_at ? pacificDate(s.clock_in_at) : s.date;
}

export function computeLaborByDateRole(
  employees: ReadonlyArray<EmpLike>,
  shifts: ReadonlyArray<LaborShift>,
  sessions: ReadonlyArray<SessionLike>,
): LaborResult {
  const byId = new Map<string, EmpLike>(employees.map((e) => [e.id, e]));
  const contributions: LaborContribution[] = [];
  const punchedKey = new Set<string>(); // `${employee_id}|${date}` with a payable punch → fallback skips it
  const unconfirmed = new Map<string, number>(); // `${date}|${role}` → held-back hours

  // ── PUNCH PASS — payable punches are truth; punches-awaiting-confirmation are surfaced ──
  for (const s of shifts) {
    const emp = byId.get(s.employee_id);
    if (!emp) continue; // orphan (verified 0 in window); skip defensively
    const bd = shiftBusinessDate(s);

    if (isPayableShift(s)) {
      const hours = paidShiftHours(s);
      const rate = Number(emp.hourly_rate) || 0;
      contributions.push({
        employee_id: s.employee_id, date: bd, role: emp.role, basis: 'punch',
        hours, cents: Math.round(hours * rate * 100), zero_rate_flag: false,
      });
      punchedKey.add(`${s.employee_id}|${bd}`); // a payable punch here blocks any session fallback
    } else if (
      !isOpenShift(s) && s.source_rule_id == null &&
      s.source === 'time_clock' && s.confirmed_at == null
    ) {
      // Would be payable but for manager confirmation — NOT counted, surfaced separately so a
      // recent day doesn't read artificially cheap and then quietly climb as punches confirm.
      if (emp.role === 'host' || emp.role === 'fulfillment') {
        const k = `${bd}|${emp.role}`;
        unconfirmed.set(k, (unconfirmed.get(k) ?? 0) + paidShiftHours(s));
      }
    }
  }

  // ── HOST SESSION-FALLBACK PASS — only where NO payable punch exists; punch always wins ──
  const fallback = new Map<string, { host: string; date: string; hours: number }>();
  for (const ses of sessions) {
    if (!ses.host_id || !ses.ended_at) continue; // exclude unmapped host / null ended_at
    const emp = byId.get(ses.host_id);
    if (!emp || emp.role !== 'host') continue; // fallback is host-only
    const dur = (new Date(ses.ended_at).getTime() - new Date(ses.started_at).getTime()) / 3_600_000;
    if (!(dur >= MIN_SESSION_HOURS && dur <= MAX_SESSION_HOURS)) continue; // <10min / >11h orphan guards
    const date = pacificDate(ses.started_at);
    if (punchedKey.has(`${ses.host_id}|${date}`)) continue; // PUNCH WINS — never both
    const k = `${ses.host_id}|${date}`;
    const cur = fallback.get(k) ?? { host: ses.host_id, date, hours: 0 };
    cur.hours += dur;
    fallback.set(k, cur);
  }
  for (const { host, date, hours } of fallback.values()) {
    const rate = Number(byId.get(host)!.hourly_rate) || 0;
    contributions.push({
      employee_id: host, date, role: 'host', basis: 'session_fallback',
      hours, cents: Math.round(hours * rate * 100),
      zero_rate_flag: rate <= 0, // emit the hours, flag the date — never silently $0
    });
  }

  // ── AGGREGATE per (date, role) — host + fulfillment only (the two the dashboard shows) ──
  const cells = new Map<string, LaborCell>();
  const bases = new Map<string, Set<'punch' | 'session_fallback'>>(); // basis set per (date|role)
  const cellFor = (date: string, role: LaborRole): LaborCell => {
    const k = `${date}|${role}`;
    let cell = cells.get(k);
    if (!cell) {
      cell = { date, role, hours: 0, cents: 0, labor_basis: 'punch', unconfirmed_hours_excluded: 0, zero_rate_flag: false };
      cells.set(k, cell);
    }
    return cell;
  };
  for (const c of contributions) {
    if (c.role !== 'host' && c.role !== 'fulfillment') continue;
    const cell = cellFor(c.date, c.role);
    cell.hours += c.hours;
    cell.cents += c.cents;
    cell.zero_rate_flag = cell.zero_rate_flag || c.zero_rate_flag;
    const k = `${c.date}|${c.role}`;
    (bases.get(k) ?? bases.set(k, new Set()).get(k)!).add(c.basis);
  }
  for (const [k, cell] of cells) {
    const set = bases.get(k);
    cell.labor_basis = !set || set.size === 0 ? 'punch' // unconfirmed-only cell (no contributions)
      : set.size > 1 ? 'mixed'
      : set.has('session_fallback') ? 'session_fallback' : 'punch';
  }
  for (const [k, h] of unconfirmed) {
    const [date, role] = k.split('|') as [string, LaborRole];
    cellFor(date, role).unconfirmed_hours_excluded += h;
  }

  return {
    cells: [...cells.values()].sort((a, b) => a.date.localeCompare(b.date) || a.role.localeCompare(b.role)),
    contributions,
  };
}
