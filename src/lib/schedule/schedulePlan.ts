// Pure scheduling kernels for the employee Schedule Builder and the bulk write path.
//
// NO value imports beyond the two import-free helper modules (timezone, weeklySchedule,
// eligibility), so this transpiles standalone for the runtime-transpile tests the rest of
// src/lib/schedule uses. Everything DB-bound lives in bulkSchedule.ts and calls in here.
//
// THE MODEL, in the manager's words: a schedule is a set of real dated `shift_instances`.
// "Working" on a date = one row (scheduled/claimed). "Off" = no row (or a cancelled one).
// Nothing here knows about rules, materializers or payroll — the planner only ever produces
// shift_instances writes, and never a row for `shifts`.

import { laWallTimeToUtc, laWallClockOf, addDaysISO } from './timezone';
import { mondayOfISO, weekDatesISO } from '@/lib/weeklySchedule';
import { crossesMidnight } from './eligibility';

// ── Wire types ──────────────────────────────────────────────────────────────────

/** One intended day for one employee. `off` removes the plan for that date if one exists. */
export type ScheduleEntry =
  | { employeeId: string; date: string; off: true }
  | { employeeId: string; date: string; startTime: string; endTime: string; off?: false };

/** The subset of a shift_instances row the planner reasons about. */
export interface ExistingInstance {
  id: string;
  employee_id: string | null;
  shift_date: string;
  starts_at: string;
  ends_at: string;
  status: string;
  source: string;
  shift_rule_id: string | null;
  store_id: string | null;
  role: string | null;
}

export interface PlanEmployee {
  id: string;
  role: string | null;
  status: string;
  store_id: string | null;
}

/** A full row for one PostgREST bulk upsert on (employee_id, shift_date). Uniform keys. */
export interface UpsertRow {
  user_id: string;
  employee_id: string;
  shift_date: string;
  starts_at: string;
  ends_at: string;
  status: 'scheduled' | 'claimed';
  source: string;
  shift_rule_id: string | null;
  store_id: string | null;
  role: string | null;
}

export type ScheduleRefusalCode =
  | 'BAD_ENTRY'
  | 'DUPLICATE_ENTRY'
  | 'EMPLOYEE_NOT_FOUND'
  | 'EMPLOYEE_FORMER'
  | 'PAST_DATE'
  | 'BAD_TIMES'
  | 'SHIFT_FINAL'
  | 'ALREADY_STARTED'
  | 'WORKED_TIME_EXISTS'
  | 'EMPLOYEE_CLOCKED_IN';

export interface ScheduleRefusal {
  employeeId: string;
  date: string;
  code: ScheduleRefusalCode;
  message: string;
}

// Manager-facing sentence per refusal — one vocabulary for server, tests and UI.
export const SCHEDULE_REFUSAL_MESSAGES: Record<ScheduleRefusalCode, string> = {
  BAD_ENTRY: 'That day is missing a date or time.',
  DUPLICATE_ENTRY: 'The same day was listed twice.',
  EMPLOYEE_NOT_FOUND: 'That employee could not be found.',
  EMPLOYEE_FORMER: 'Former employees cannot be scheduled.',
  PAST_DATE: 'Past days cannot be scheduled.',
  BAD_TIMES: 'Start and end cannot be the same time.',
  SHIFT_FINAL: 'That shift has already been recorded and cannot be changed here.',
  ALREADY_STARTED: 'That shift has already started and cannot be removed.',
  WORKED_TIME_EXISTS: 'This employee already has worked time on that date.',
  EMPLOYEE_CLOCKED_IN: 'This employee is currently clocked in.',
};

export interface ScheduleCounts {
  created: number;
  updated: number;
  removed: number;
  unchanged: number;
}

export interface SchedulePlan {
  upserts: UpsertRow[];
  /** admin_open + scheduled rows → hard delete (the existing Remove Shift semantics). */
  deleteIds: string[];
  /** every other removable row (pattern / claimed) → status 'cancelled'. Keeps the (employee,
   *  date) slot occupied so a dormant materializer can never regenerate it, and hides it from
   *  every schedule read (they all filter status IN scheduled/claimed). */
  cancelIds: string[];
  counts: ScheduleCounts;
  refusals: ScheduleRefusal[];
}

// ── Validation ──────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_RE = /^\d{2}:\d{2}$/;

export function isValidDateISO(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isValidHHMM(s: unknown): s is string {
  if (typeof s !== 'string' || !HHMM_RE.test(s)) return false;
  const [h, m] = s.split(':').map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

/** Hard cap on one request. 8 weeks × 7 days × a large crew is well inside this. */
export const MAX_SCHEDULE_ENTRIES = 500;

/** Parse an untrusted request body into entries, or a list of shape errors. Never throws. */
export function parseScheduleEntries(raw: unknown): { entries: ScheduleEntry[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'entries must be an array' };
  if (raw.length === 0) return { error: 'entries is empty' };
  if (raw.length > MAX_SCHEDULE_ENTRIES) return { error: `Too many days in one request (max ${MAX_SCHEDULE_ENTRIES})` };
  const out: ScheduleEntry[] = [];
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i] as Record<string, unknown> | null;
    if (!e || typeof e !== 'object') return { error: `entries[${i}] is not an object` };
    const employeeId = typeof e.employeeId === 'string' ? e.employeeId.trim() : '';
    if (!employeeId) return { error: `entries[${i}].employeeId is required` };
    if (!isValidDateISO(e.date)) return { error: `entries[${i}].date must be YYYY-MM-DD` };
    if (e.off === true) {
      out.push({ employeeId, date: e.date, off: true });
      continue;
    }
    if (!isValidHHMM(e.startTime) || !isValidHHMM(e.endTime)) {
      return { error: `entries[${i}] needs startTime and endTime as HH:MM` };
    }
    out.push({ employeeId, date: e.date, startTime: e.startTime, endTime: e.endTime });
  }
  return { entries: out };
}

// ── Instants ────────────────────────────────────────────────────────────────────

/** UTC instants for an LA wall-clock shift on `date`; an end at/before the start rolls to +1 day. */
export function instantsFor(date: string, startTime: string, endTime: string): { starts_at: string; ends_at: string } {
  const endDate = crossesMidnight(startTime, endTime) ? addDaysISO(date, 1) : date;
  return {
    starts_at: laWallTimeToUtc(date, startTime).toISOString(),
    ends_at: laWallTimeToUtc(endDate, endTime).toISOString(),
  };
}

function sameInstant(a: string, b: string): boolean {
  return Date.parse(a) === Date.parse(b);
}

// ── Week state (what the builder edits) ─────────────────────────────────────────

export interface DayState {
  working: boolean;
  start: string; // 'HH:MM' — kept even when off so toggling back restores it
  end: string;
}

export type WeekState = Record<string, DayState>; // keyed by 'YYYY-MM-DD'

export const EMPTY_DAY: DayState = { working: false, start: '', end: '' };

/** The Monday-anchored week containing `dateISO`, Mon→Sun. */
export function weekDatesFor(dateISO: string): string[] {
  return weekDatesISO(mondayOfISO(dateISO));
}

/** True when an instance row represents "working" to the schedule (released rows have no
 *  employee and cancelled/missed rows are not coverage). */
export function isWorkingInstance(i: Pick<ExistingInstance, 'status' | 'employee_id'>): boolean {
  return !!i.employee_id && (i.status === 'scheduled' || i.status === 'claimed');
}

/** Build the builder's editable week from the employee's real instances for those dates. */
export function weekStateFromInstances(instances: ExistingInstance[], weekDates: string[]): WeekState {
  const byDate = new Map<string, ExistingInstance>();
  for (const i of instances) if (isWorkingInstance(i)) byDate.set(i.shift_date, i);
  const state: WeekState = {};
  for (const d of weekDates) {
    const i = byDate.get(d);
    state[d] = i
      ? { working: true, start: laWallClockOf(i.starts_at).time, end: laWallClockOf(i.ends_at).time }
      : { ...EMPTY_DAY };
  }
  return state;
}

/** Copy last week's day-of-week pattern onto the target week. Times only — never ids. */
export function copyWeekPattern(
  prevInstances: ExistingInstance[],
  prevWeekDates: string[],
  targetWeekDates: string[],
): WeekState {
  const prev = weekStateFromInstances(prevInstances, prevWeekDates);
  const state: WeekState = {};
  for (let k = 0; k < targetWeekDates.length; k++) {
    const src = prev[prevWeekDates[k]] ?? EMPTY_DAY;
    state[targetWeekDates[k]] = { ...src };
  }
  return state;
}

export function weekStateIsEmpty(state: WeekState): boolean {
  return Object.values(state).every((d) => !d.working);
}

// ── Repeat ──────────────────────────────────────────────────────────────────────

/** Mondays for `count` consecutive weeks starting at the week containing `weekStartISO`. */
export function repeatWeekStarts(weekStartISO: string, count: number): string[] {
  const monday = mondayOfISO(weekStartISO);
  const n = Math.max(1, Math.floor(count));
  return Array.from({ length: n }, (_, i) => addDaysISO(monday, 7 * i));
}

/** How many weekly repeats fit up to and including the week containing `endDateISO` (min 1). */
export function repeatCountUntil(weekStartISO: string, endDateISO: string): number {
  const a = Date.parse(mondayOfISO(weekStartISO));
  const b = Date.parse(mondayOfISO(endDateISO));
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 1;
  return Math.floor((b - a) / (7 * 86_400_000)) + 1;
}

/**
 * Expand one edited week into dated entries for `weekCount` weeks.
 *
 * Week 1 (the one the manager is looking at) is sent in FULL — every day, working or off — so the
 * server sees explicit intent for each date they edited. Later weeks send WORKING days only: the
 * manager never saw those weeks, so an "off" there must not silently remove a shift that already
 * exists. That asymmetry is the whole point; do not "simplify" it.
 */
export function expandRepeat(
  employeeId: string,
  weekStartISO: string,
  state: WeekState,
  weekCount: number,
  // Days before `todayISO` are never sent at all: the past is shown read-only in the builder, and
  // a working entry there would (correctly) be refused as PAST_DATE. Omit to send every day.
  todayISO?: string,
): ScheduleEntry[] {
  const firstWeek = weekDatesFor(weekStartISO);
  const out: ScheduleEntry[] = [];
  const starts = repeatWeekStarts(weekStartISO, weekCount);
  for (let w = 0; w < starts.length; w++) {
    const dates = weekDatesISO(starts[w]);
    for (let k = 0; k < 7; k++) {
      const day = state[firstWeek[k]] ?? EMPTY_DAY;
      const date = dates[k];
      if (todayISO && date < todayISO) continue;
      if (day.working) {
        if (!day.start || !day.end) continue; // incomplete row → nothing to send for that day
        out.push({ employeeId, date, startTime: day.start, endTime: day.end });
      } else if (w === 0) {
        out.push({ employeeId, date, off: true });
      }
    }
  }
  return out;
}

// ── The planner ─────────────────────────────────────────────────────────────────

export interface PlanInput {
  userId: string;
  entries: ScheduleEntry[];
  employees: PlanEmployee[];
  existing: ExistingInstance[];
  /** `${employee_id}|${date}` pairs that already have a payable `shifts` row. */
  workedKeys: ReadonlySet<string>;
  /** employee ids with an open punch right now. */
  clockedInEmployees: ReadonlySet<string>;
  todayISO: string; // LA calendar date
  nowMs: number;
}

const ROLE_OK = new Set(['host', 'fulfillment']);

/**
 * Decide every write before any write happens. Refusals are collected, not thrown — the caller
 * decides whether a partial save is acceptable (the bulk route says no: any refusal = 409 and
 * nothing is written, so the manager fixes the day and saves again).
 */
export function planScheduleBatch(input: PlanInput): SchedulePlan {
  const refusals: ScheduleRefusal[] = [];
  const refuse = (employeeId: string, date: string, code: ScheduleRefusalCode) =>
    refusals.push({ employeeId, date, code, message: SCHEDULE_REFUSAL_MESSAGES[code] });

  const empById = new Map(input.employees.map((e) => [e.id, e]));
  const existingByKey = new Map<string, ExistingInstance>();
  for (const i of input.existing) {
    if (i.employee_id) existingByKey.set(`${i.employee_id}|${i.shift_date}`, i);
  }

  const upserts: UpsertRow[] = [];
  const deleteIds: string[] = [];
  const cancelIds: string[] = [];
  const counts: ScheduleCounts = { created: 0, updated: 0, removed: 0, unchanged: 0 };
  const seen = new Set<string>();

  for (const e of input.entries) {
    const key = `${e.employeeId}|${e.date}`;
    if (seen.has(key)) { refuse(e.employeeId, e.date, 'DUPLICATE_ENTRY'); continue; }
    seen.add(key);

    const emp = empById.get(e.employeeId);
    if (!emp) { refuse(e.employeeId, e.date, 'EMPLOYEE_NOT_FOUND'); continue; }
    const cur = existingByKey.get(key);

    if (e.off) {
      // Off on a day with nothing planned, or already cancelled → nothing to do. Off on a past day
      // is also a no-op: the builder sends the whole week and the past is not ours to edit.
      if (!cur || cur.status === 'cancelled' || e.date < input.todayISO) { counts.unchanged++; continue; }
      if (cur.status !== 'scheduled' && cur.status !== 'claimed') { refuse(e.employeeId, e.date, 'SHIFT_FINAL'); continue; }
      const startsMs = Date.parse(cur.starts_at);
      if (!Number.isFinite(startsMs) || startsMs <= input.nowMs) { refuse(e.employeeId, e.date, 'ALREADY_STARTED'); continue; }
      if (input.workedKeys.has(key)) { refuse(e.employeeId, e.date, 'WORKED_TIME_EXISTS'); continue; }
      if (input.clockedInEmployees.has(e.employeeId)) { refuse(e.employeeId, e.date, 'EMPLOYEE_CLOCKED_IN'); continue; }
      if (cur.source === 'admin_open' && cur.status === 'scheduled') deleteIds.push(cur.id);
      else cancelIds.push(cur.id);
      counts.removed++;
      continue;
    }

    // Working.
    if (emp.status === 'former') { refuse(e.employeeId, e.date, 'EMPLOYEE_FORMER'); continue; }
    if (e.date < input.todayISO) { refuse(e.employeeId, e.date, 'PAST_DATE'); continue; }
    if (e.startTime === e.endTime) { refuse(e.employeeId, e.date, 'BAD_TIMES'); continue; }
    const { starts_at, ends_at } = instantsFor(e.date, e.startTime, e.endTime);

    if (!cur) {
      upserts.push({
        user_id: input.userId,
        employee_id: emp.id,
        shift_date: e.date,
        starts_at,
        ends_at,
        status: 'scheduled',
        source: 'admin_open',
        shift_rule_id: null,
        store_id: emp.store_id ?? null,
        role: emp.role && ROLE_OK.has(emp.role) ? emp.role : null,
      });
      counts.created++;
      continue;
    }

    if (cur.status === 'worked' || cur.status === 'missed') { refuse(e.employeeId, e.date, 'SHIFT_FINAL'); continue; }
    const revive = cur.status === 'cancelled';
    if (!revive && sameInstant(cur.starts_at, starts_at) && sameInstant(cur.ends_at, ends_at)) {
      counts.unchanged++;
      continue;
    }
    // Update in place. Source / rule link / store / role are preserved — editing the time of a
    // shift does not reclassify where it came from. A cancelled row is revived as 'scheduled'.
    upserts.push({
      user_id: input.userId,
      employee_id: emp.id,
      shift_date: e.date,
      starts_at,
      ends_at,
      status: cur.status === 'claimed' ? 'claimed' : 'scheduled',
      source: cur.source,
      shift_rule_id: cur.shift_rule_id,
      store_id: cur.store_id,
      role: cur.role,
    });
    counts.updated++;
  }

  return { upserts, deleteIds, cancelIds, counts, refusals };
}

/** Date span the planner needs existing rows for. */
export function entryDateRange(entries: ScheduleEntry[]): { from: string; to: string } {
  let from = entries[0].date;
  let to = entries[0].date;
  for (const e of entries) {
    if (e.date < from) from = e.date;
    if (e.date > to) to = e.date;
  }
  return { from, to };
}

export function uniqueEmployeeIds(entries: ScheduleEntry[]): string[] {
  return [...new Set(entries.map((e) => e.employeeId))];
}
