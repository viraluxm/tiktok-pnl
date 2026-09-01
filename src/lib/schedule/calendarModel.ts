/**
 * Shifts-calendar day model — pure, dependency-free assembly of ONE day cell.
 *
 * Keep this file free of value imports from '@/…' or npm so the repo's transpile-at-runtime
 * .test.mjs pattern can load it alone (see calendarModel.test.mjs). Callers do the fetching,
 * recurring generation and timezone flattening; this file only assembles + classifies.
 *
 * THE RULE THIS ENCODES: a punch is the truth. A scheduled span is context shown NEXT TO the
 * punch, never instead of it, and never summed into anything payable. That mirrors the pay path
 * (isPayableShift / computePay read real `shifts` rows only) so the calendar can never imply a
 * number payroll would not pay.
 */

// ── inputs ───────────────────────────────────────────────────────────────────

export interface CalEmployee {
  id: string;
  name: string;
  role: string | null;
}

/**
 * A worked record — a payable `shifts` row. Usually a time-clock punch; a MANUAL row is a
 * hand-entered correction and is equally payable, so it belongs here too.
 */
export interface CalPunch {
  id: string;
  employee_id: string;
  /** 'time_clock' | 'manual'. Only a time_clock row is gated on manager confirmation. */
  source: string | null;
  date: string;            // 'YYYY-MM-DD' (LA-local)
  start_time: string;      // 'HH:MM[:SS]' wall clock
  end_time: string | null; // null = still on the clock
  clock_in_at: string | null;  // authoritative instants (migration 072)
  clock_out_at: string | null;
  break_minutes: number;
  confirmed_at: string | null;
  auto_closed?: boolean;
}

/**
 * A scheduled span, already flattened to LA-local wall clock by the caller.
 * `origin` follows resolveScheduledSpan's precedence: an 'instance' outranks a 'rule'.
 */
export interface CalScheduled {
  id: string;
  employee_id: string;
  date: string;
  start_time: string;
  end_time: string;
  origin: 'instance' | 'rule';
}

export type CalendarView = 'scheduled' | 'clocked' | 'all';

// ── outputs ──────────────────────────────────────────────────────────────────

/**
 * How one person's day reads at a glance:
 *   pending   — punched, awaiting manager confirmation (held out of pay) → the yellow state
 *   open      — still on the clock (no clock-out yet)
 *   confirmed — punched and confirmed
 *   no_show   — scheduled, the day has passed, no punch ever landed
 *   scheduled — scheduled, not yet worked (today or future)
 */
export type DayPersonState = 'pending' | 'open' | 'confirmed' | 'no_show' | 'scheduled';

export interface DayPunch {
  id: string;
  start_time: string;
  end_time: string | null;
  hours: number;
  breakMinutes: number;
  /** True when nothing is holding this row out of pay. A manual row is never gated. */
  confirmed: boolean;
  /** Only a time_clock row can be confirmed/unconfirmed — drives whether the button shows. */
  confirmable: boolean;
  autoClosed: boolean;
  isOpen: boolean;
}

export interface DayScheduled {
  id: string;
  start_time: string;
  end_time: string;
  hours: number;
  origin: 'instance' | 'rule';
}

export interface DayPerson {
  employee_id: string;
  name: string;
  role: string | null;
  scheduled: DayScheduled | null;
  /**
   * Whether a schedule existed AT ALL for this person-day. Distinct from `scheduled`, which the
   * Clock-ins view deliberately nulls out — a card still needs to say "Not scheduled" truthfully
   * in that view without showing the plan's numbers.
   */
  wasScheduled: boolean;
  punch: DayPunch | null;
  /** punch.hours − scheduled.hours; null unless BOTH exist. Positive = worked over. */
  deltaHours: number | null;
  state: DayPersonState;
}

export interface CalendarDay {
  date: string;
  people: DayPerson[];
  headcount: number;      // people rendered in this cell (drives the avatar stack + density)
  pendingCount: number;   // → the yellow badge
  openCount: number;
  scheduledCount: number;
  clockedCount: number;
}

// ── time helpers (inlined to keep this file import-free) ──────────────────────

/** 'HH:MM[:SS]' → minutes past local midnight. Malformed → 0. */
export function toMinutes(t: string): number {
  if (!t) return 0;
  const [h, m] = t.split(':');
  const hh = Number(h);
  const mm = Number(m);
  return (Number.isFinite(hh) ? hh : 0) * 60 + (Number.isFinite(mm) ? mm : 0);
}

/** Wall-clock duration in hours, treating end <= start as crossing midnight. */
export function wallHours(startTime: string, endTime: string | null): number {
  if (!endTime) return 0;
  const s = toMinutes(startTime);
  let e = toMinutes(endTime);
  if (e <= s) e += 1440; // overnight
  return (e - s) / 60;
}

/** Round to 2dp so float noise never shows up as "8.000000001h". */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Paid hours for a punch. Prefers the real instants (they have no 24h ceiling — a forgotten
 * clock-out spanning 26h must read as 26h, not a wrapped 2h), else the wall clock. Break is
 * subtracted either way. Mirrors paidShiftHours in src/lib/employees.ts.
 */
export function punchHours(p: CalPunch): number {
  const breakHours = (p.break_minutes ?? 0) / 60;
  if (p.clock_in_at && p.clock_out_at) {
    const span = (Date.parse(p.clock_out_at) - Date.parse(p.clock_in_at)) / 3_600_000;
    if (Number.isFinite(span)) return round2(Math.max(0, span - breakHours));
  }
  return round2(Math.max(0, wallHours(p.start_time, p.end_time) - breakHours));
}

// ── assembly ─────────────────────────────────────────────────────────────────

/** Scheduled precedence: an 'instance' beats a 'rule' for the same employee+date. */
function pickScheduled(rows: CalScheduled[]): CalScheduled | null {
  if (rows.length === 0) return null;
  return rows.find((r) => r.origin === 'instance') ?? rows[0];
}

/** The punch that counts for a day: an open one wins (it's live), else the earliest. */
function pickPunch(rows: CalPunch[]): CalPunch | null {
  if (rows.length === 0) return null;
  const open = rows.find((r) => r.end_time == null);
  if (open) return open;
  return [...rows].sort((a, b) => toMinutes(a.start_time) - toMinutes(b.start_time))[0];
}

function classify(
  punch: DayPunch | null,
  hasScheduled: boolean,
  isPast: boolean,
  view: CalendarView,
): DayPersonState {
  // The PLAN view answers "who is supposed to come in", so it must not carry payroll states.
  // 'pending' is a pay concept (a punch waiting on a manager) and showing it here paints the
  // schedule yellow for a reason that has nothing to do with the schedule. Showed up / didn't /
  // not yet is the whole vocabulary this view needs.
  if (view === 'scheduled') {
    if (punch) return 'confirmed'; // showed up — neutral, regardless of confirmation
    return hasScheduled && isPast ? 'no_show' : 'scheduled';
  }
  if (punch) {
    if (punch.isOpen) return 'open';
    return punch.confirmed ? 'confirmed' : 'pending';
  }
  // No punch. Only a PAST scheduled day is a no-show; today/future is simply upcoming.
  if (hasScheduled && isPast) return 'no_show';
  return 'scheduled';
}

/**
 * Assemble every day cell for the grid.
 *
 * `view` filters which people surface:
 *   'clocked'   — only people with a punch (the pay-truth view)
 *   'scheduled' — only people with a scheduled span (the plan view)
 *   'all'       — the union; a punch and its schedule collapse into ONE row so a person
 *                 scheduled 5a–1p who punched 5:04a–1:12p appears once, not twice.
 *
 * `todayISO` splits past from future so an unworked past shift reads as a no-show while an
 * unworked future shift stays neutral.
 */
export function buildCalendarDays(args: {
  employees: CalEmployee[];
  punches: CalPunch[];
  scheduled: CalScheduled[];
  days: string[];
  view: CalendarView;
  todayISO: string;
  roleFilter?: 'all' | 'host' | 'fulfillment';
}): Map<string, CalendarDay> {
  const { employees, punches, scheduled, days, view, todayISO } = args;
  const roleFilter = args.roleFilter ?? 'all';

  const empById = new Map(employees.map((e) => [e.id, e]));
  const dayset = new Set(days);

  const matchesRole = (role: string | null): boolean => {
    if (roleFilter === 'all') return true;
    const r = (role ?? '').trim().toLowerCase();
    return r === roleFilter;
  };

  // Bucket both inputs by `${employee_id}|${date}` so the two sides can be joined per person-day.
  const punchBy = new Map<string, CalPunch[]>();
  for (const p of punches) {
    if (!dayset.has(p.date) || !empById.has(p.employee_id)) continue;
    const k = `${p.employee_id}|${p.date}`;
    const arr = punchBy.get(k);
    if (arr) arr.push(p); else punchBy.set(k, [p]);
  }
  const schedBy = new Map<string, CalScheduled[]>();
  for (const s of scheduled) {
    if (!dayset.has(s.date) || !empById.has(s.employee_id)) continue;
    const k = `${s.employee_id}|${s.date}`;
    const arr = schedBy.get(k);
    if (arr) arr.push(s); else schedBy.set(k, [s]);
  }

  const keys = new Set<string>([...punchBy.keys(), ...schedBy.keys()]);
  const byDate = new Map<string, CalendarDay>();
  for (const d of days) {
    byDate.set(d, { date: d, people: [], headcount: 0, pendingCount: 0, openCount: 0, scheduledCount: 0, clockedCount: 0 });
  }

  for (const key of keys) {
    const sep = key.lastIndexOf('|');
    const employeeId = key.slice(0, sep);
    const date = key.slice(sep + 1);
    const emp = empById.get(employeeId);
    const cell = byDate.get(date);
    if (!emp || !cell) continue;
    if (!matchesRole(emp.role)) continue;

    const rawPunch = pickPunch(punchBy.get(key) ?? []);
    const rawSched = pickScheduled(schedBy.get(key) ?? []);

    // View filter: decided on the RAW pair, before either side is dropped.
    if (view === 'clocked' && !rawPunch) continue;
    if (view === 'scheduled' && !rawSched) continue;

    // Confirmation gates ONLY time-clock rows (isPayableShift ignores confirmed_at for manual
    // rows). Treating a manual row as unconfirmed would paint it yellow and offer a Confirm
    // button the RPC would refuse — so a manual row reads as already-confirmed and un-confirmable.
    const isTimeClock = rawPunch?.source === 'time_clock';
    const punch: DayPunch | null = rawPunch
      ? {
          id: rawPunch.id,
          start_time: rawPunch.start_time,
          end_time: rawPunch.end_time,
          hours: punchHours(rawPunch),
          breakMinutes: rawPunch.break_minutes ?? 0,
          confirmed: isTimeClock ? rawPunch.confirmed_at != null : true,
          confirmable: isTimeClock,
          autoClosed: rawPunch.auto_closed === true,
          isOpen: rawPunch.end_time == null,
        }
      : null;

    const sched: DayScheduled | null = rawSched
      ? {
          id: rawSched.id,
          start_time: rawSched.start_time,
          end_time: rawSched.end_time,
          hours: round2(wallHours(rawSched.start_time, rawSched.end_time)),
          origin: rawSched.origin,
        }
      : null;

    // In the 'clocked' view the schedule is deliberately hidden — that view answers
    // "what are we paying", and a plan number sitting beside it invites reading the wrong one.
    const shownSched = view === 'clocked' ? null : sched;

    // Delta always compares the real pair, even when the schedule is hidden from the cell.
    const deltaHours = punch && !punch.isOpen && sched ? round2(punch.hours - sched.hours) : null;

    cell.people.push({
      employee_id: employeeId,
      name: emp.name,
      role: emp.role,
      scheduled: shownSched,
      wasScheduled: sched != null,
      punch,
      deltaHours,
      state: classify(punch, sched != null, date < todayISO, view),
    });
  }

  for (const cell of byDate.values()) {
    // Busiest signal first inside a day: still-open, then pending, then by start time, then name.
    cell.people.sort((a, b) => {
      const rank = (p: DayPerson) => (p.state === 'open' ? 0 : p.state === 'pending' ? 1 : 2);
      const r = rank(a) - rank(b);
      if (r !== 0) return r;
      const at = a.punch?.start_time ?? a.scheduled?.start_time ?? '';
      const bt = b.punch?.start_time ?? b.scheduled?.start_time ?? '';
      const t = toMinutes(at) - toMinutes(bt);
      if (t !== 0) return t;
      return a.name.localeCompare(b.name);
    });
    cell.headcount = cell.people.length;
    cell.pendingCount = cell.people.filter((p) => p.state === 'pending').length;
    cell.openCount = cell.people.filter((p) => p.state === 'open').length;
    cell.clockedCount = cell.people.filter((p) => p.punch != null).length;
    cell.scheduledCount = cell.people.filter((p) => p.scheduled != null).length;
  }

  return byDate;
}

// ── presentation helpers (pure) ──────────────────────────────────────────────

/**
 * Density bucket 0–4 for the cell tint. Relative to the busiest day in view, so a quiet
 * week and a peak week both use the full ramp instead of every cell looking identical.
 */
export function densityLevel(headcount: number, maxHeadcount: number): 0 | 1 | 2 | 3 | 4 {
  if (headcount <= 0) return 0;
  if (maxHeadcount <= 0) return 0;
  const ratio = headcount / maxHeadcount;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

/** Largest headcount across the grid — the density ramp's upper bound. */
export function maxHeadcount(days: Map<string, CalendarDay>): number {
  let max = 0;
  for (const d of days.values()) if (d.headcount > max) max = d.headcount;
  return max;
}

const DAY_MS = 86_400_000;

/**
 * Is `dateISO` a payday? Paydays are PAY_ANCHOR ± N×14 days (one global biweekly cycle —
 * see PAY_ANCHOR in src/lib/employees.ts, which the caller passes in so this stays import-free).
 */
export function isPaydayISO(dateISO: string, anchorISO: string): boolean {
  const d = Date.parse(dateISO + 'T00:00:00Z');
  const a = Date.parse(anchorISO + 'T00:00:00Z');
  if (!Number.isFinite(d) || !Number.isFinite(a)) return false;
  const diffDays = Math.round((d - a) / DAY_MS);
  return diffDays % 14 === 0;
}

/** Signed delta for display: '+1.2h' / '−0.5h' / 'on time'. Uses a real minus sign. */
export function formatDelta(deltaHours: number | null): string {
  if (deltaHours == null) return '';
  const rounded = Math.round(deltaHours * 10) / 10;
  if (rounded === 0) return 'on time';
  return rounded > 0 ? `+${rounded}h` : `−${Math.abs(rounded)}h`;
}

/** Deterministic avatar hue from a name — same formula as the printed badge monogram. */
export function avatarHue(name: string): number {
  let h = 0;
  for (const c of name || '') h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

/** Initials for the avatar — same rule as src/lib/kiosk/monogram.ts so badge and calendar agree. */
export function initialsOf(name: string): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
