// STAFFING CAPACITY — the pure kernel behind "2 shifts available".
//
// NO value imports except the import-free helper modules (./timezone, ./eligibility) and
// '@/lib/employees' (itself dependency-free apart from a type import), so this file transpiles
// standalone for the runtime-transpile .test.mjs pattern the rest of src/lib/schedule uses, and is
// safe to import from a client component. Everything DB-bound lives in capacityBoard.ts /
// capacityAdmin.ts.
//
// ── THE MODEL ─────────────────────────────────────────────────────────────────────────────────
// A STAFFING BLOCK is a (team, weekdays, start_time, end_time) slot that exists independently of
// any employee — the thing shift_rules cannot express, because a rule is one PERSON's recurring
// schedule (its employee_id is NOT NULL). See migration 156's header.
//
// A CAPACITY VACANCY IS DERIVED, NEVER STORED. There is no employee-less shift_instances row
// anywhere in this feature. For a block on a date:
//
//     effective_capacity = override.capacity ?? block.capacity ?? teamDefault.capacity
//     available          = effective_capacity == null ? 0            // NOT CONFIGURED
//                        : closed ? 0
//                        : max(0, effective_capacity - staffed)
//
// ── CAPACITY IS EXPLICIT, NEVER IMPLIED ───────────────────────────────────────────────────────
// There is deliberately NO final fallback constant. An account that has not told Lensed how many
// Live Host setups it runs advertises NOTHING: publishing shifts off an invisible global default
// would have every new tenant offering ten setups it may not own, and the first anyone hears of it
// is an employee asking for a shift that does not exist. "Not configured" is a real state the
// manager can see and fix, not a number quietly standing in for one.
//
// ── WHY OVERLAP, NOT EXACT (start,end) GROUPING ───────────────────────────────────────────────
// Capacity means SIMULTANEOUS setups, and every scheduling input in the app is a free `<input
// type="time">` — there is no preset-block picker, and production holds a dozen distinct (start,
// end) pairs. Grouping by exact equality under-counts: on a real upcoming Tuesday the largest
// identical group was 5 while seven hosts were actually live at 19:00, which against a cap of 10
// would advertise 5 available when only 3 were. So `staffed` counts every assigned shift whose
// span OVERLAPS the block window.
//
// Half-open [start, end): touching endpoints do NOT overlap. 06:00–10:00 followed by 10:00–14:00
// is a legitimate split shift, which is the same rule migration 131's overlap guard states.
//
// ── WHY AN OFFERED SHIFT STILL COUNTS ─────────────────────────────────────────────────────────
// There is deliberately NO offer_state clause below. When Carlos drops his shift he REMAINS
// responsible for it until a manager approves someone else — migration 129's
// shift_instances_offered_is_owned CHECK makes that a database guarantee. Excluding offered shifts
// here would advertise an 11th spot on a 10-setup floor while Carlos still holds the 10th.

import { payrollTeamOfRole, type PayrollTeam } from '@/lib/employees';
import { addDaysISO, laWallTimeToUtc, weekdayOf } from './timezone';
import { crossesMidnight } from './eligibility';

/** The teams a staffing block can be configured for. `payrollTeamOfRole`'s 'other' is never one. */
export type CapacityTeam = 'host' | 'fulfillment';

export const CAPACITY_TEAMS: readonly CapacityTeam[] = ['host', 'fulfillment'] as const;

/**
 * THE EDITOR'S PREFILL, AND NOTHING ELSE.
 *
 * This number is what the "Set capacity" field starts at so a manager is not typing into a blank
 * box. It is NOT part of resolveCapacity, it is NOT passed to any RPC, and it can never make a
 * block advertise a shift: until someone opens that field and SAVES, the team has no capacity and
 * publishes nothing. Renamed from DEFAULT_TEAM_CAPACITY precisely so it cannot drift back into the
 * resolution chain — grep it and every hit should be a form default.
 */
export const SUGGESTED_TEAM_CAPACITY: Record<CapacityTeam, number> = {
  host: 10,
  fulfillment: 4,
};

/** The SQL role→team mapping in migration 156, restated. Pinned equal by capacity.test.mjs. */
export const SQL_TEAM_OF_ROLE_PREDICATE =
  "lower(btrim(coalesce(e.role, ''))) in ('host', 'live host')";

export interface CapacityBlock {
  id: string;
  user_id: string;
  team: CapacityTeam;
  label: string | null;
  /** getUTCDay() numbers, 0=Sun … 6=Sat — the same convention as shift_rules.days_of_week. */
  days_of_week: number[];
  /** LA wall clock 'HH:MM' or 'HH:MM:SS'. */
  start_time: string;
  end_time: string;
  /** null = inherit the team default. If that is unset too, the block is NOT CONFIGURED. */
  capacity: number | null;
  active: boolean;
}

/** One row of shift_capacity_settings: a TEAM DEFAULT (no block/date) or a DATE OVERRIDE. */
export interface CapacitySetting {
  id: string;
  team: CapacityTeam;
  block_id: string | null;
  date: string | null;
  capacity: number | null;
  closed: boolean;
  note: string | null;
}

/** The subset of a shift_instances row the staffed count reasons about. */
export interface StaffedInstance {
  id: string;
  employee_id: string | null;
  status: string;
  starts_at: string;
  ends_at: string;
}

/** The statuses that mean "a real person is on the floor for this span". */
const STAFFING_STATUSES = new Set(['scheduled', 'claimed']);

// ── Time ──────────────────────────────────────────────────────────────────────────────────────

/** Does this block occur on `dateISO`? Inactive blocks occur on no date at all. */
export function blockOccursOn(block: Pick<CapacityBlock, 'days_of_week' | 'active'>, dateISO: string): boolean {
  if (!block.active) return false;
  return block.days_of_week.includes(weekdayOf(dateISO));
}

/**
 * The UTC instants of a block's window on `dateISO`. An end at/before the start rolls to the next
 * calendar day — identical to instantsFor() in schedulePlan.ts, so a block's bounds and a shift's
 * bounds are commensurable instants across DST.
 */
export function blockInstants(
  block: Pick<CapacityBlock, 'start_time' | 'end_time'>,
  dateISO: string,
): { starts_at: string; ends_at: string } {
  const start = block.start_time.slice(0, 5);
  const end = block.end_time.slice(0, 5);
  const endDate = crossesMidnight(start, end) ? addDaysISO(dateISO, 1) : dateISO;
  return {
    starts_at: laWallTimeToUtc(dateISO, start).toISOString(),
    ends_at: laWallTimeToUtc(endDate, end).toISOString(),
  };
}

/** Half-open [start, end) overlap. Touching endpoints do NOT overlap. */
export function spansOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return Date.parse(aStart) < Date.parse(bEnd) && Date.parse(aEnd) > Date.parse(bStart);
}

// ── Capacity resolution ───────────────────────────────────────────────────────────────────────

export interface ResolvedCapacity {
  /** null = nobody has configured a number for this block. It advertises nothing. */
  capacity: number | null;
  closed: boolean;
  /**
   * true when THIS block or THIS date names its own number — i.e. the manager deliberately set
   * something other than the team-wide figure.
   *
   * Deliberately NOT "an explicit number exists anywhere in the chain": the team default is itself
   * an explicit number (a manager types "10 live setups"), so that reading would stamp "Custom
   * capacity" on every row in the outlook and the word would mean nothing.
   */
  custom: boolean;
}

/**
 * Resolve the effective capacity for a block on a date.
 *
 * Precedence: date override → block → owner's team default → NOT CONFIGURED.
 * The chain ends in null, never in a constant. See the header: an unconfigured team advertises
 * nothing rather than guessing a number on the business's behalf.
 *
 * `closed` is the OR of the date override and the team default: closing a team closes it, closing
 * one date closes that date, and neither can silently re-open the other.
 */
export function resolveCapacity(input: {
  block: Pick<CapacityBlock, 'team' | 'capacity'>;
  override?: Pick<CapacitySetting, 'capacity' | 'closed'> | null;
  teamDefault?: Pick<CapacitySetting, 'capacity' | 'closed'> | null;
}): ResolvedCapacity {
  const o = input.override ?? null;
  const t = input.teamDefault ?? null;
  const local = o?.capacity ?? input.block.capacity ?? null;      // set on this date or this block
  return {
    capacity: local ?? t?.capacity ?? null,
    closed: Boolean(o?.closed) || Boolean(t?.closed),
    custom: local != null,
  };
}

// ── Staffed count ─────────────────────────────────────────────────────────────────────────────

/**
 * How many people of `team` are already on the floor across this block's window.
 *
 * `teamOf` maps an employee id to their payroll team. It is supplied by the caller because the
 * team MUST come from employees.role, never from shift_instances.role — every 'pattern' instance in
 * production carries role IS NULL (the role is derived from the assignee), so reading it off the
 * instance would count nobody.
 */
export function countStaffed(input: {
  instances: StaffedInstance[];
  teamOf: (employeeId: string) => PayrollTeam;
  team: CapacityTeam;
  blockStart: string;
  blockEnd: string;
}): number {
  let n = 0;
  for (const si of input.instances) {
    if (!si.employee_id) continue;                       // legacy released row — nobody responsible
    if (!STAFFING_STATUSES.has(si.status)) continue;      // cancelled / missed / worked
    if (input.teamOf(si.employee_id) !== input.team) continue;
    if (!spansOverlap(si.starts_at, si.ends_at, input.blockStart, input.blockEnd)) continue;
    n += 1;
  }
  return n;
}

/** teamOf from a role lookup — the one place employees.role becomes a team. */
export function teamOfEmployees(employees: { id: string; role: string | null }[]): (id: string) => PayrollTeam {
  const byId = new Map(employees.map((e) => [e.id, payrollTeamOfRole(e.role)]));
  return (id: string) => byId.get(id) ?? 'other';
}

// ── The block's staffing on one date ──────────────────────────────────────────────────────────

export interface BlockStaffing {
  block_id: string;
  team: CapacityTeam;
  label: string | null;
  date: string;
  starts_at: string;
  ends_at: string;
  /** planned span in hours, to one decimal — never a pay figure. */
  hours: number;
  /** null = NOT CONFIGURED. The block exists and can be staffed; it just advertises nothing. */
  capacity: number | null;
  /** false when nobody has set a number for this block. Drives the manager's "Not configured". */
  configured: boolean;
  staffed: number;
  /** max(0, capacity - staffed). NEVER negative — an over-staffed block advertises nothing. */
  available: number;
  /** staffed - capacity when positive. Surfaced to the MANAGER only, as "Over capacity by N". */
  over: number;
  closed: boolean;
  custom: boolean;
}

/**
 * Staffing for ONE block on ONE date. Returns null when the block does not occur that day — an
 * inactive block or a weekday it is not configured for produces no opportunity at all.
 */
export function blockStaffingOn(input: {
  block: CapacityBlock;
  date: string;
  instances: StaffedInstance[];
  teamOf: (employeeId: string) => PayrollTeam;
  settings?: CapacitySetting[];
}): BlockStaffing | null {
  const { block, date } = input;
  if (!blockOccursOn(block, date)) return null;

  const settings = input.settings ?? [];
  const override = settings.find((s) => s.block_id === block.id && s.date === date) ?? null;
  const teamDefault = settings.find((s) => s.block_id == null && s.team === block.team) ?? null;

  const { starts_at, ends_at } = blockInstants(block, date);
  const { capacity, closed, custom } = resolveCapacity({ block, override, teamDefault });
  const staffed = countStaffed({
    instances: input.instances,
    teamOf: input.teamOf,
    team: block.team,
    blockStart: starts_at,
    blockEnd: ends_at,
  });

  return {
    block_id: block.id,
    team: block.team,
    label: block.label,
    date,
    starts_at,
    ends_at,
    hours: Math.round(((Date.parse(ends_at) - Date.parse(starts_at)) / 3_600_000) * 10) / 10,
    capacity,
    configured: capacity != null,
    staffed,
    // NOT CONFIGURED ADVERTISES NOTHING. The staffed count is still real and still shown to the
    // manager — knowing three people are on Wednesday night is useful before you set a number.
    // CLAMPED AT ZERO otherwise: reducing capacity below current staffing must never surface as a
    // negative number of shifts, and must never remove anybody (see `over`).
    available: capacity == null || closed ? 0 : Math.max(0, capacity - staffed),
    over: capacity == null ? 0 : Math.max(0, staffed - capacity),
    closed,
    custom,
  };
}

/** Every block's staffing across a date range, ordered by date then start. */
export function staffingOutlook(input: {
  blocks: CapacityBlock[];
  fromISO: string;
  toISO: string;
  instances: StaffedInstance[];
  teamOf: (employeeId: string) => PayrollTeam;
  settings?: CapacitySetting[];
  team?: CapacityTeam;
}): BlockStaffing[] {
  const out: BlockStaffing[] = [];
  const blocks = input.team ? input.blocks.filter((b) => b.team === input.team) : input.blocks;
  for (let d = input.fromISO; d <= input.toISO; d = addDaysISO(d, 1)) {
    for (const block of blocks) {
      const s = blockStaffingOn({ block, date: d, instances: input.instances, teamOf: input.teamOf, settings: input.settings });
      if (s) out.push(s);
    }
  }
  return out.sort((a, b) => (a.starts_at < b.starts_at ? -1 : a.starts_at > b.starts_at ? 1 : 0));
}

/**
 * The manager's staffing payload — blocks, capacity settings, the day-by-day outlook and the
 * resolved team defaults. Declared HERE rather than in capacityAdmin.ts so the client hook and the
 * preview can import it without reaching a module that carries 'server-only'.
 */
export interface StaffingOutlookPayload {
  from: string;
  to: string;
  blocks: CapacityBlock[];
  settings: CapacitySetting[];
  days: { date: string; blocks: BlockStaffing[] }[];
  /** `capacity: null` = this team has no configured capacity and advertises nothing. */
  teamDefaults: { team: CapacityTeam; capacity: number | null; closed: boolean }[];
}

// ── Employee-facing copy ──────────────────────────────────────────────────────────────────────

/**
 * "2 shifts available" / "1 shift available". The ONLY capacity number an employee ever sees —
 * never the setup count, never the manager's configured capacity, never how many people are on.
 */
export function shiftsAvailableLabel(available: number): string {
  return `${available} shift${available === 1 ? '' : 's'} available`;
}

/** The manager's one-line staffing summary for a block. Employees never see this string. */
export function staffingLabel(s: Pick<BlockStaffing, 'staffed' | 'capacity' | 'available' | 'over' | 'closed'>): string {
  // First, because it is the reason every other line would be meaningless.
  if (s.capacity == null) return 'Capacity not configured';
  if (s.over > 0) return `Over capacity by ${s.over}`;
  if (s.closed) return 'Availability closed';
  if (s.available === 0) return 'Fully staffed';
  return shiftsAvailableLabel(s.available);
}

/** The manager's "x / y scheduled" figure, with an honest dash when y does not exist yet. */
export function staffedOfLabel(s: Pick<BlockStaffing, 'staffed' | 'capacity'>): string {
  return s.capacity == null ? `${s.staffed} scheduled` : `${s.staffed} / ${s.capacity} scheduled`;
}

// ── Request Shift: the employee-side decision kernel ──────────────────────────────────────────

export type ShiftRequestRefusal =
  | 'INACTIVE_EMPLOYEE'
  | 'WRONG_TEAM'
  | 'PAST_DATE'
  | 'ALREADY_STARTED'
  | 'BLOCK_UNAVAILABLE'
  | 'AVAILABILITY_CLOSED'
  | 'CAPACITY_NOT_CONFIGURED'
  | 'NO_CAPACITY'
  | 'ALREADY_SCHEDULED_THAT_DAY'
  | 'ALREADY_REQUESTED';

/**
 * Employee-facing sentence for each refusal. Kept beside the kernel so the server, the tests and
 * the UI can never drift into three vocabularies for one decision.
 *
 * VOCABULARY RULE: shift language only. Never "seat", "slot", "vacancy" or "capacity opening" —
 * those words exist in the schema and in this file's internals, and nowhere an employee can read.
 */
export const SHIFT_REQUEST_REFUSAL_MESSAGES: Record<ShiftRequestRefusal, string> = {
  INACTIVE_EMPLOYEE: 'Your account is not active.',
  WRONG_TEAM: 'This shift is for a different role.',
  PAST_DATE: 'That day has already passed.',
  ALREADY_STARTED: 'That shift has already started.',
  BLOCK_UNAVAILABLE: 'This shift is no longer available.',
  AVAILABILITY_CLOSED: 'No more shifts are being taken for this day.',
  // Unreachable from the portal (an unconfigured block publishes no opportunity at all), and kept
  // as the server-side refusal so a hand-built request cannot slip past the read path.
  CAPACITY_NOT_CONFIGURED: 'This shift is not available.',
  // Employee vocabulary, not the manager's "Fully staffed" — this map is read by the portal.
  NO_CAPACITY: 'No shifts available.',
  ALREADY_SCHEDULED_THAT_DAY: "You're already scheduled that day.",
  ALREADY_REQUESTED: 'Shift Requested',
};

export type ShiftRequestPlan = { ok: true } | { ok: false; code: ShiftRequestRefusal };

/**
 * May this employee request a shift in this block on this date?
 *
 * PURE — the caller supplies the facts, this decides. Run on the server before every write; the
 * client only uses it to decide whether to draw an enabled button.
 *
 * A PENDING REQUEST DOES NOT CONSUME CAPACITY. `staffing.available` counts assigned shifts only, so
 * five people may each truthfully see "2 shifts available" until managers approve. What stops one
 * employee double-filing is `alreadyRequested`, and what stops oversubscription is the recount
 * inside lensed_approve_shift_request — not a pessimistic hold here.
 */
export function planShiftRequest(input: {
  staffing: BlockStaffing;
  employeeTeam: PayrollTeam;
  employeeStatus: string;
  /** Dates the employee already holds a shift_instances row for. UNIQUE(employee_id, shift_date). */
  myDatesInUse: ReadonlySet<string>;
  alreadyRequested: boolean;
  nowMs: number;
  todayISO: string;
}): ShiftRequestPlan {
  const s = input.staffing;
  if (input.employeeStatus !== 'active') return { ok: false, code: 'INACTIVE_EMPLOYEE' };
  if (input.employeeTeam !== s.team) return { ok: false, code: 'WRONG_TEAM' };
  if (s.date < input.todayISO) return { ok: false, code: 'PAST_DATE' };
  const startsMs = Date.parse(s.starts_at);
  if (!Number.isFinite(startsMs) || startsMs <= input.nowMs) return { ok: false, code: 'ALREADY_STARTED' };
  if (input.alreadyRequested) return { ok: false, code: 'ALREADY_REQUESTED' };
  if (input.myDatesInUse.has(s.date)) return { ok: false, code: 'ALREADY_SCHEDULED_THAT_DAY' };
  if (s.capacity == null) return { ok: false, code: 'CAPACITY_NOT_CONFIGURED' };
  if (s.closed) return { ok: false, code: 'AVAILABILITY_CLOSED' };
  if (s.available <= 0) return { ok: false, code: 'NO_CAPACITY' };
  return { ok: true };
}

/** The stable id a capacity opportunity carries on the wire. */
export function capacityItemId(blockId: string, dateISO: string): string {
  // NAMESPACED on purpose: the portal keys `availableById` on shift_instances ids, and a bare uuid
  // here would collide with a coworker's instance row and mislabel it on the Team tab.
  return `cap:${blockId}:${dateISO}`;
}
