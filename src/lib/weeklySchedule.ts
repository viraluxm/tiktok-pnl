// Pure logic for the weekly employee shift calendar (Phase 1).
//
// This module is deliberately React-free and has NO value imports (only a type-only
// import from '@/types', which is erased at compile time) so it can be transpiled and
// unit-tested standalone exactly like src/lib/employees.ts (see employees.weekly.test.mjs).
//
// Design notes:
//   * Weeks are MONDAY→SUNDAY, to line up with the biweekly pay period (Mon→Sun) in
//     employees.ts. All date math is done in UTC-midnight space (Date.UTC + getUTCDay),
//     matching employees.ts, so weekday/step math is free of local-timezone / DST drift.
//   * `durationHours` mirrors `shiftHours` in employees.ts EXACTLY (end<start ⇒ +24h for an
//     overnight shift; a null end ⇒ 0). A parity test asserts the two never diverge.
//   * Hours/pay logic itself is unchanged — this module only shapes existing rows for the
//     weekly grid. Recurring generation + materialization behaviour stay in employees.ts.

import type { Employee } from '@/types';

// ── Date helpers (UTC-midnight space) ────────────────────────────────────────

const DAY_MS = 86_400_000;

// Parse a 'YYYY-MM-DD' string as UTC midnight.
export function parseYMD(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}

export function toYMD(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDaysISO(iso: string, days: number): string {
  return toYMD(new Date(parseYMD(iso).getTime() + days * DAY_MS));
}

// The Monday (ISO) of the week containing `iso`. getUTCDay: 0=Sun … 6=Sat.
export function mondayOfISO(iso: string): string {
  const day = parseYMD(iso).getUTCDay();
  const offset = day === 0 ? -6 : 1 - day; // Sun rolls back to the previous Monday
  return addDaysISO(iso, offset);
}

// The seven ISO dates Mon→Sun for the week whose Monday is `mondayISO`.
export function weekDatesISO(mondayISO: string): string[] {
  const monday = mondayOfISO(mondayISO); // normalise defensively
  return Array.from({ length: 7 }, (_, i) => addDaysISO(monday, i));
}

export interface WeekRange {
  start: string; // Monday
  end: string; // Sunday
  dates: string[]; // 7, Mon→Sun
}

// The Mon→Sun range for the week containing `anchorISO`.
export function weekRangeForAnchor(anchorISO: string): WeekRange {
  const dates = weekDatesISO(anchorISO);
  return { start: dates[0], end: dates[6], dates };
}

// Today as 'YYYY-MM-DD' using the viewer's LOCAL calendar day (the manager's "today"),
// then normalised into UTC-midnight ISO so it composes with the helpers above.
export function localTodayISO(now: Date = new Date()): string {
  return toYMD(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
}

export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

// ── Roles ─────────────────────────────────────────────────────────────────────

export type RoleGroupKey = 'host' | 'fulfillment' | 'other';
export type RoleFilterValue = 'all' | 'host' | 'fulfillment';

// Fixed display order for role groups in the grid.
export const ROLE_GROUP_ORDER: RoleGroupKey[] = ['host', 'fulfillment', 'other'];

export const ROLE_GROUP_LABEL: Record<RoleGroupKey, string> = {
  host: 'Live Hosts',
  fulfillment: 'Fulfillment',
  other: 'Other',
};

// Map a free-text employee.role to a grid group. `host` → Live Hosts, `fulfillment` →
// Fulfillment, everything else (manager/support/other/unknown/empty) → Other. Role is
// stored as free text (migration 044), so this is intentionally forgiving.
export function roleGroupOf(role: string | null | undefined): RoleGroupKey {
  const r = (role || '').trim().toLowerCase();
  if (r === 'host') return 'host';
  if (r === 'fulfillment') return 'fulfillment';
  return 'other';
}

export function isFormer(employee: Pick<Employee, 'status'>): boolean {
  return (employee.status || '').toLowerCase() === 'former';
}

export function isProbation(employee: Pick<Employee, 'status'>): boolean {
  return (employee.status || '').toLowerCase() === 'probation';
}

// Employees that belong in the weekly grid / new-shift entry: FORMER employees are
// excluded entirely (their historical shifts still live in Time Records).
export function schedulableEmployees<T extends Pick<Employee, 'status'>>(employees: T[]): T[] {
  return employees.filter((e) => !isFormer(e));
}

export function matchesRoleFilter(role: string | null | undefined, filter: RoleFilterValue): boolean {
  if (filter === 'all') return true;
  return roleGroupOf(role) === filter;
}

// ── Time / duration ─────────────────────────────────────────────────────────

// Minutes since midnight for an 'HH:MM' / 'HH:MM:SS' string.
export function toMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

// Hours for a shift. Mirrors shiftHours() in employees.ts: a null end (open shift) → 0;
// end < start ⇒ the shift ran past midnight, so add 24h. Parity is asserted by tests.
export function durationHours(startTime: string, endTime: string | null): number {
  if (endTime == null) return 0;
  let mins = toMinutes(endTime) - toMinutes(startTime);
  if (mins < 0) mins += 24 * 60;
  return mins / 60;
}

// True when the shift crosses midnight (end strictly earlier than start). Open shifts
// (null end) are never overnight.
export function isOvernight(startTime: string, endTime: string | null): boolean {
  if (endTime == null) return false;
  return toMinutes(endTime) < toMinutes(startTime);
}

// Unusually long shifts get a non-blocking warning at/above this many hours.
export const LONG_SHIFT_HOURS = 16;

// ── 12-hour display formatting (user-facing only; storage stays 24h 'HH:MM:SS') ──

// Format an 'HH:MM' / 'HH:MM:SS' time as 12-hour AM/PM, no leading zero, minutes shown
// only when non-zero:
//   00:00 → "12 AM", 05:00 → "5 AM", 12:00 → "12 PM", 17:00 → "5 PM",
//   17:30 → "5:30 PM", 00:40 → "12:40 AM".
export function formatTime12(t: string): string {
  const parts = t.split(':');
  const h = Number(parts[0]) || 0;
  const m = Number(parts[1]) || 0;
  const period = h < 12 ? 'AM' : 'PM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hh} ${period}` : `${hh}:${String(m).padStart(2, '0')} ${period}`;
}

// A start–end range in 12-hour format: "5 PM–1 AM". A null end (open shift) → "5 PM–open".
export function formatTimeRange12(startTime: string, endTime: string | null): string {
  const s = formatTime12(startTime);
  return endTime == null ? `${s}–open` : `${s}–${formatTime12(endTime)}`;
}

// Weekday name (e.g. "Tuesday") of the day AFTER dateISO — for overnight "· Ends <day>"
// labels. Uses UTC so the calendar day never drifts by timezone.
export function nextDayWeekday(dateISO: string): string {
  if (!dateISO) return '';
  return parseYMD(addDaysISO(dateISO, 1)).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
}

// ── Shift-card model ──────────────────────────────────────────────────────────

// Minimal shapes of the rows we consume, so the pure logic doesn't couple to exact
// generated types. `ShiftRow` = a row from the `shifts` table (useShifts); `GeneratedRow`
// = a computed recurring instance (generateRecurringShifts).
export interface ShiftRow {
  id: string;
  employee_id: string;
  date: string;
  start_time: string;
  end_time: string | null;
  source_rule_id?: string | null;
}

export interface GeneratedRow {
  id: string;
  rule_id: string;
  employee_id: string;
  date: string;
  start_time: string;
  end_time: string;
  modified: boolean;
  skipped: boolean;
}

export interface WeekShiftCard {
  id: string;
  kind: 'oneoff' | 'recurring';
  employee_id: string;
  date: string;
  start_time: string;
  end_time: string | null;
  isOpen: boolean; // end_time missing → in progress / incomplete
  isOvernight: boolean;
  isFrozen: boolean; // materialized recurring payroll-history row (source_rule_id set) → read-only
  modified: boolean; // recurring instance overridden by a 'modified' exception
  ruleId: string | null;
  hours: number; // 0 for open shifts
  startMin: number;
  endMin: number; // overnight-extended (+1440); for open shifts, equals startMin
}

function cardFromShift(s: ShiftRow): WeekShiftCard {
  const isOpen = s.end_time == null;
  const frozen = s.source_rule_id != null;
  const startMin = toMinutes(s.start_time);
  const overnight = isOvernight(s.start_time, s.end_time);
  const endMin = isOpen ? startMin : toMinutes(s.end_time as string) + (overnight ? 1440 : 0);
  return {
    id: s.id,
    // A materialized recurring row is payroll history — surface it as recurring, never as a
    // deletable one-off (spec + audit finding). Plain one-offs have source_rule_id = null.
    kind: frozen ? 'recurring' : 'oneoff',
    employee_id: s.employee_id,
    date: s.date,
    start_time: s.start_time,
    end_time: s.end_time,
    isOpen,
    isOvernight: overnight,
    isFrozen: frozen,
    modified: false,
    ruleId: s.source_rule_id ?? null,
    hours: durationHours(s.start_time, s.end_time),
    startMin,
    endMin,
  };
}

function cardFromGenerated(g: GeneratedRow): WeekShiftCard {
  const overnight = isOvernight(g.start_time, g.end_time);
  const startMin = toMinutes(g.start_time);
  return {
    id: g.id,
    kind: 'recurring',
    employee_id: g.employee_id,
    date: g.date,
    start_time: g.start_time,
    end_time: g.end_time,
    isOpen: false,
    isOvernight: overnight,
    isFrozen: false,
    modified: g.modified,
    ruleId: g.rule_id,
    hours: durationHours(g.start_time, g.end_time),
    startMin,
    endMin: toMinutes(g.end_time) + (overnight ? 1440 : 0),
  };
}

// Build all cards for the week, keyed `${employee_id}|${date}`. `shifts` are real rows
// (one-off + materialized); `generated` are computed recurring instances. Skipped
// recurring instances are dropped (a skipped day is not coverage).
export function indexWeekCards(
  shifts: ShiftRow[],
  generated: GeneratedRow[],
  weekDateSet: ReadonlySet<string>,
): Map<string, WeekShiftCard[]> {
  const index = new Map<string, WeekShiftCard[]>();
  const push = (card: WeekShiftCard) => {
    if (!weekDateSet.has(card.date)) return;
    const key = `${card.employee_id}|${card.date}`;
    const arr = index.get(key);
    if (arr) arr.push(card);
    else index.set(key, [card]);
  };
  for (const s of shifts) push(cardFromShift(s));
  for (const g of generated) {
    if (g.skipped) continue;
    push(cardFromGenerated(g));
  }
  // Stable per-cell order: earliest start first, then id.
  for (const arr of index.values()) {
    arr.sort((a, b) => a.startMin - b.startMin || a.id.localeCompare(b.id));
  }
  return index;
}

// Do any two COMPLETED cards in the same cell overlap in time? Open shifts (indeterminate
// end) are ignored. Uses overnight-extended minute ranges so a past-midnight shift is
// compared correctly.
export function detectOverlap(cards: WeekShiftCard[]): boolean {
  const ranges = cards
    .filter((c) => !c.isOpen)
    .map((c) => [c.startMin, c.endMin] as const)
    .sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i][0] < ranges[i - 1][1]) return true;
  }
  return false;
}

export interface WeekCell {
  date: string;
  cards: WeekShiftCard[];
  hasOverlap: boolean;
}

export interface WeekEmployeeModel {
  employee: Employee;
  cells: WeekCell[]; // 7, Mon→Sun
  totalHours: number; // completed hours across the week (open shifts contribute 0)
}

export interface WeekGroupModel {
  key: RoleGroupKey;
  label: string;
  employees: WeekEmployeeModel[];
}

// Assemble the full grid model: schedulable employees only (former excluded), filtered by
// role, grouped Live Hosts → Fulfillment → Other, each with a 7-day row of cells and a
// weekly hour total. A single-role filter always returns exactly that one group (possibly
// empty, so the grid can show a focused empty state); 'all' returns only non-empty groups.
export function buildWeekModel(params: {
  employees: Employee[];
  shifts: ShiftRow[];
  generated: GeneratedRow[];
  weekDates: string[]; // 7 ISO, Mon→Sun
  roleFilter: RoleFilterValue;
}): WeekGroupModel[] {
  const { employees, shifts, generated, weekDates, roleFilter } = params;
  const weekDateSet = new Set(weekDates);
  const index = indexWeekCards(shifts, generated, weekDateSet);

  const visible = schedulableEmployees(employees)
    .filter((e) => matchesRoleFilter(e.role, roleFilter))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  const modelFor = (employee: Employee): WeekEmployeeModel => {
    let totalHours = 0;
    const cells = weekDates.map((date) => {
      const cards = index.get(`${employee.id}|${date}`) ?? [];
      for (const c of cards) totalHours += c.hours; // open shifts already contribute 0
      return { date, cards, hasOverlap: detectOverlap(cards) };
    });
    return { employee, cells, totalHours };
  };

  const groupsToShow: RoleGroupKey[] =
    roleFilter === 'all' ? ROLE_GROUP_ORDER : [roleFilter];

  const out: WeekGroupModel[] = [];
  for (const key of groupsToShow) {
    const members = visible.filter((e) => roleGroupOf(e.role) === key);
    // For 'all', hide empty groups; for a single-role filter, keep it (focused empty state).
    if (roleFilter === 'all' && members.length === 0) continue;
    out.push({ key, label: ROLE_GROUP_LABEL[key], employees: members.map(modelFor) });
  }
  return out;
}

// ── Editor helpers ────────────────────────────────────────────────────────────

export interface ShiftPrefill {
  employee_id: string;
  start_time: string;
  end_time: string | null;
}

// Prefill for Duplicate / Copy-to-day: same employee + same hours, destination date chosen
// separately by the user.
export function duplicatePrefill(card: Pick<WeekShiftCard, 'employee_id' | 'start_time' | 'end_time'>): ShiftPrefill {
  return {
    employee_id: card.employee_id,
    start_time: card.start_time,
    end_time: card.end_time,
  };
}

export interface ShiftTimeValidation {
  ok: boolean;
  error: string | null;
  overnight: boolean;
  longWarning: boolean;
  hours: number;
}

// Validate the start/end a user enters in the editor.
//   * open (no end)           → always ok; hours indeterminate (0).
//   * missing start/end       → error.
//   * start === end           → error (a zero-length shift is rejected).
//   * end < start             → OK, flagged overnight (ends next day).
//   * hours ≥ LONG_SHIFT_HOURS → non-blocking warning.
export function validateShiftTimes(
  startTime: string,
  endTime: string | null,
  opts: { open?: boolean } = {},
): ShiftTimeValidation {
  const base = { overnight: false, longWarning: false, hours: 0 };
  if (opts.open) {
    if (!startTime) return { ok: false, error: 'Start time is required.', ...base };
    return { ok: true, error: null, ...base };
  }
  if (!startTime || !endTime) {
    return { ok: false, error: 'Start and end time are required.', ...base };
  }
  if (toMinutes(startTime) === toMinutes(endTime)) {
    return { ok: false, error: 'Start and end time cannot be the same.', ...base };
  }
  const overnight = isOvernight(startTime, endTime);
  const hours = durationHours(startTime, endTime);
  return {
    ok: true,
    error: null,
    overnight,
    longWarning: hours >= LONG_SHIFT_HOURS,
    hours,
  };
}
