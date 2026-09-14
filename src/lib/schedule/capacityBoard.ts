import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { payrollTeamOfRole } from '@/lib/employees';
import type { Employee } from '@/types';
import { addDaysISO, laTodayISO } from './timezone';
import {
  blockInstants, capacityItemId, planShiftRequest, staffingOutlook, teamOfEmployees,
  type BlockStaffing, type CapacityBlock, type CapacitySetting, type CapacityTeam,
  type ShiftRequestRefusal, type StaffedInstance,
} from './capacity';

// EMPLOYEE-FACING capacity availability + the Request Shift write.
//
// SECURITY. This module is only ever reached from a /s/[token] route, i.e. through the
// service-role client, where RLS is NOT the boundary (see tokens.ts). The boundary is that
// `employee` here is the TOKEN-RESOLVED employee and every query below is scoped by
//     owner = employee.user_id     AND     team  = payrollTeamOfRole(employee.role)
// derived server-side from that row. Nothing is ever taken from the request body except the block
// id and the date, and both are re-validated against this owner + team before anything is written.
//
// TEAM ISOLATION IS A QUERY PREDICATE, NOT A CLIENT FILTER. Another team's blocks, capacities,
// staffing counts and request rows are never selected, so they cannot reach the browser to be
// hidden there. A fulfillment employee's payload contains no host numbers at all.

/** How far forward capacity opportunities are published. Matches the forward materializer's horizon. */
export const CAPACITY_HORIZON_DAYS = 28;

/** One capacity opportunity, shaped for the employee portal. */
export interface CapacityOpportunity {
  block_id: string;
  shift_date: string;
  starts_at: string;
  ends_at: string;
  hours: number;
  team: CapacityTeam;
  /** How many shifts remain available in this block. Never a setup count, never the capacity. */
  available: number;
  /** The viewer's own pending request for this block+date, if any. */
  request_id: string | null;
  /** null = the viewer can request it; otherwise why not. */
  refusal: ShiftRequestRefusal | null;
}

export class CapacityError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

type Admin = ReturnType<typeof createAdminClient>;

const BLOCK_COLS = 'id, user_id, team, label, days_of_week, start_time, end_time, capacity, active';
const SETTING_COLS = 'id, team, block_id, date, capacity, closed, note';

function ownerOf(employee: Employee): string {
  const owner = employee.user_id;
  if (!owner) throw new CapacityError('NO_OWNER', 'This employee has no account. Refusing an unscoped query.');
  return owner;
}

/** The employee's capacity team, or null when their role maps to neither staffing team. */
export function capacityTeamOf(employee: Pick<Employee, 'role'>): CapacityTeam | null {
  const t = payrollTeamOfRole(employee.role);
  return t === 'host' || t === 'fulfillment' ? t : null;
}

/**
 * Load everything one owner+team needs to compute staffing across [from, to], in one place so the
 * employee board and the manager outlook cannot diverge on what "staffed" means.
 */
async function loadStaffingInputs(admin: Admin, owner: string, team: CapacityTeam | null, fromISO: string, toISO: string): Promise<{
  blocks: CapacityBlock[];
  settings: CapacitySetting[];
  instances: (StaffedInstance & { employee_id: string | null; shift_date: string })[];
  teamOf: (employeeId: string) => ReturnType<typeof payrollTeamOfRole>;
}> {
  let blockQ = admin.from('shift_capacity_blocks').select(BLOCK_COLS).eq('user_id', owner).eq('active', true);
  if (team) blockQ = blockQ.eq('team', team);
  let settingQ = admin.from('shift_capacity_settings').select(SETTING_COLS).eq('user_id', owner);
  if (team) settingQ = settingQ.eq('team', team);

  // The instant window every block in [from, to] can possibly span: an overnight block starting on
  // `to` ends on `to + 1`, so the window is [from 00:00 LA, to+1 24:00 LA]. Widened by a day on
  // each side and expressed as the SAME half-open overlap predicate the count uses, so it rides
  // idx_shift_instances_owner_span.
  const windowStart = blockInstants({ start_time: '00:00', end_time: '23:59' }, addDaysISO(fromISO, -1)).starts_at;
  const windowEnd = blockInstants({ start_time: '00:00', end_time: '23:59' }, addDaysISO(toISO, 2)).ends_at;

  const [blocks, settings, instances, employees] = await Promise.all([
    blockQ.order('start_time', { ascending: true }),
    settingQ,
    admin.from('shift_instances')
      .select('id, employee_id, shift_date, status, starts_at, ends_at')
      .eq('user_id', owner)
      .in('status', ['scheduled', 'claimed'])
      .not('employee_id', 'is', null)
      .lt('starts_at', windowEnd)
      .gt('ends_at', windowStart),
    // Roles for the team mapping. THE TEAM COMES FROM employees.role, never shift_instances.role:
    // every 'pattern' instance carries role IS NULL because the role is derived from the assignee.
    admin.from('employees').select('id, role').eq('user_id', owner),
  ]);

  if (blocks.error) throw new CapacityError('READ_FAILED', blocks.error.message);
  if (settings.error) throw new CapacityError('READ_FAILED', settings.error.message);
  if (instances.error) throw new CapacityError('READ_FAILED', instances.error.message);
  if (employees.error) throw new CapacityError('READ_FAILED', employees.error.message);

  return {
    blocks: (blocks.data ?? []) as unknown as CapacityBlock[],
    settings: (settings.data ?? []) as unknown as CapacitySetting[],
    instances: (instances.data ?? []) as unknown as (StaffedInstance & { employee_id: string | null; shift_date: string })[],
    teamOf: teamOfEmployees((employees.data ?? []) as { id: string; role: string | null }[]),
  };
}

/**
 * The capacity opportunities THIS employee may see, from today to the horizon.
 *
 * Returns [] — never throws — when the employee's role maps to no staffing team, so an
 * unrecognised role can never be shown another team's board.
 */
export async function getCapacityAvailability(employee: Employee, now: Date = new Date()): Promise<CapacityOpportunity[]> {
  const owner = ownerOf(employee);
  const team = capacityTeamOf(employee);
  if (!team) return [];

  const admin = createAdminClient();
  const todayISO = laTodayISO(now);
  const toISO = addDaysISO(todayISO, CAPACITY_HORIZON_DAYS);

  const [inputs, myRequests] = await Promise.all([
    loadStaffingInputs(admin, owner, team, todayISO, toISO),
    admin.from('shift_requests')
      .select('id, block_id, shift_date, starts_at, ends_at, team')
      .eq('user_id', owner)
      .eq('employee_id', employee.id)
      .eq('status', 'pending')
      .gte('shift_date', todayISO),
  ]);
  if (myRequests.error) throw new CapacityError('READ_FAILED', myRequests.error.message);

  const myRequestRows = (myRequests.data ?? []) as { id: string; block_id: string; shift_date: string; starts_at: string; ends_at: string; team: string }[];
  const requestByKey = new Map(myRequestRows.map((r) => [`${r.block_id}|${r.shift_date}`, r.id]));
  // UNIQUE(employee_id, shift_date): one shift per person per day, so any instance I already hold
  // on a date rules that date out entirely.
  const myDatesInUse = new Set(
    inputs.instances.filter((i) => i.employee_id === employee.id).map((i) => i.shift_date),
  );

  const outlook = staffingOutlook({
    blocks: inputs.blocks,
    fromISO: todayISO,
    toISO,
    instances: inputs.instances,
    teamOf: inputs.teamOf,
    settings: inputs.settings,
    team,
  });

  const nowMs = now.getTime();
  const employeeTeam = payrollTeamOfRole(employee.role);
  const out: CapacityOpportunity[] = [];
  for (const s of outlook) {
    const requestId = requestByKey.get(`${s.block_id}|${s.date}`) ?? null;
    const plan = planShiftRequest({
      staffing: s,
      employeeTeam,
      employeeStatus: employee.status,
      myDatesInUse,
      alreadyRequested: requestId != null,
      nowMs,
      todayISO,
    });
    const code = plan.ok ? null : plan.code;
    // A block with nothing available and no request of mine is not an opportunity — showing "0
    // shifts available" on every block every day would bury the ones that matter. A block the
    // viewer has REQUESTED stays visible, because "Shift Requested" is the state they need to see.
    // Past / started / wrong-team / inactive opportunities are dropped rather than annotated: they
    // are not decisions the employee can act on.
    // AN UNCONFIGURED BLOCK PUBLISHES NOTHING. Not "0 shifts available" — nothing at all. The
    // business has not said how many setups it runs, so there is no shift to offer, and an
    // employee must never see one invented from a default.
    if (!s.configured) continue;
    if (code === 'PAST_DATE' || code === 'ALREADY_STARTED' || code === 'WRONG_TEAM' || code === 'INACTIVE_EMPLOYEE') continue;
    if (!requestId && (code === 'NO_CAPACITY' || code === 'AVAILABILITY_CLOSED' || code === 'CAPACITY_NOT_CONFIGURED')) continue;
    out.push({
      block_id: s.block_id,
      shift_date: s.date,
      starts_at: s.starts_at,
      ends_at: s.ends_at,
      hours: s.hours,
      team: s.team,
      available: s.available,
      request_id: requestId,
      refusal: code,
    });
  }

  // ORPHANED REQUESTS. A manager can pause a block, or take a weekday off it, AFTER someone has
  // asked for a shift in it. The block then produces no occurrence, the request produces no row,
  // and the employee's pending request disappears from their portal with no way to withdraw it —
  // while the manager's queue still shows it. That is the one untruthful state this board can
  // reach, so the request is carried on its own stored span instead. `available: 0` because there
  // is nothing to advertise; `requested` is what the row is for.
  const shown = new Set(out.map((o) => `${o.block_id}|${o.shift_date}`));
  for (const r of myRequestRows) {
    if (shown.has(`${r.block_id}|${r.shift_date}`)) continue;
    out.push({
      block_id: r.block_id,
      shift_date: r.shift_date,
      starts_at: r.starts_at,
      ends_at: r.ends_at,
      hours: Math.round(((Date.parse(r.ends_at) - Date.parse(r.starts_at)) / 3_600_000) * 10) / 10,
      team: r.team === 'fulfillment' ? 'fulfillment' : 'host',
      available: 0,
      request_id: r.id,
      refusal: null,
    });
  }
  return out.sort((a, b) => (a.starts_at < b.starts_at ? -1 : a.starts_at > b.starts_at ? 1 : 0));
}

/**
 * REQUEST SHIFT. Files a pending request; it assigns nobody and consumes no capacity.
 *
 * Everything the client sent is re-derived or re-validated here: the block is looked up by
 * (id, owner) so another tenant's id resolves to nothing, the team is read off the BLOCK and the
 * EMPLOYEE (never the body), and the span is recomputed from the block rather than accepted.
 */
export async function requestShift(input: {
  employee: Employee;
  blockId: string;
  dateISO: string;
  now?: Date;
}): Promise<{ request_id: string }> {
  const { employee, blockId, dateISO } = input;
  const now = input.now ?? new Date();
  const owner = ownerOf(employee);
  const team = capacityTeamOf(employee);
  if (!team) throw new CapacityError('WRONG_TEAM', 'This shift is for a different role.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) throw new CapacityError('BAD_DATE', 'Bad request.');

  const admin = createAdminClient();
  const todayISO = laTodayISO(now);
  if (dateISO < todayISO) throw new CapacityError('PAST_DATE', 'That day has already passed.');
  if (dateISO > addDaysISO(todayISO, CAPACITY_HORIZON_DAYS)) {
    throw new CapacityError('BLOCK_UNAVAILABLE', 'This shift is no longer available.');
  }

  // Re-derive the opportunity server-side for this employee. Reusing the read path means the
  // request can only be filed for something the employee could legitimately see.
  const opportunities = await getCapacityAvailability(employee, now);
  const opp = opportunities.find((o) => o.block_id === blockId && o.shift_date === dateISO);
  if (!opp) throw new CapacityError('BLOCK_UNAVAILABLE', 'This shift is no longer available.');
  if (opp.request_id) throw new CapacityError('ALREADY_REQUESTED', 'You have already requested this shift.');
  if (opp.refusal) {
    throw new CapacityError(opp.refusal, opp.refusal === 'NO_CAPACITY'
      ? 'This shift is fully staffed.'
      : 'This shift is no longer available.');
  }

  const { data, error } = await admin
    .from('shift_requests')
    .insert({
      user_id: owner,
      employee_id: employee.id,
      block_id: blockId,
      shift_date: dateISO,
      starts_at: opp.starts_at,
      ends_at: opp.ends_at,
      team,
      status: 'pending',
    })
    .select('id')
    .single();
  if (error) {
    // idx_shift_requests_one_pending_per_day — the double-tap guard, enforced by the database
    // rather than by the check-then-insert above, which cannot be atomic.
    if (error.code === '23505') throw new CapacityError('ALREADY_REQUESTED', 'You have already requested a shift that day.');
    throw new CapacityError('REQUEST_FAILED', error.message);
  }
  return { request_id: data.id as string };
}

/**
 * MY shift requests, for the portal's Requests tab: everything still pending plus anything decided
 * recently, newest activity first.
 *
 * SCOPED TWICE — owner AND employee. Nobody else's request can be selected, and nothing about the
 * capacity that produced it (the number of setups, the block's configuration, a manager note) is
 * read at all, so it cannot reach the payload by accident. The span comes off the request row,
 * which stores it, so this needs no block lookup.
 */
export async function getMyShiftRequests(employee: Employee, now: Date = new Date()): Promise<{
  id: string; block_id: string; shift_date: string; starts_at: string; ends_at: string;
  hours: number; role: CapacityTeam | null; status: 'pending' | 'approved' | 'declined' | 'withdrawn' | 'superseded';
  requested_at: string; decided_at: string | null;
}[]> {
  const owner = ownerOf(employee);
  const admin = createAdminClient();
  const todayISO = laTodayISO(now);
  const { data, error } = await admin
    .from('shift_requests')
    .select('id, block_id, shift_date, starts_at, ends_at, team, status, created_at, decided_at')
    .eq('user_id', owner)
    .eq('employee_id', employee.id)
    .gte('shift_date', addDaysISO(todayISO, -SHIFT_REQUEST_HISTORY_DAYS))
    .order('shift_date', { ascending: true });
  if (error) throw new CapacityError('READ_FAILED', error.message);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    block_id: r.block_id as string,
    shift_date: r.shift_date as string,
    starts_at: r.starts_at as string,
    ends_at: r.ends_at as string,
    hours: Math.round(((Date.parse(r.ends_at as string) - Date.parse(r.starts_at as string)) / 3_600_000) * 10) / 10,
    role: (r.team === 'fulfillment' ? 'fulfillment' : 'host') as CapacityTeam,
    status: r.status as 'pending' | 'approved' | 'declined' | 'withdrawn' | 'superseded',
    requested_at: r.created_at as string,
    decided_at: (r.decided_at as string | null) ?? null,
  }));
}

/** How far back a decided request keeps showing under Requests. Matches the pickup history window. */
const SHIFT_REQUEST_HISTORY_DAYS = 30;

/** Withdraw my own pending request. Scoped by employee AND owner; decided requests are untouched. */
export async function withdrawShiftRequest(employee: Employee, requestId: string): Promise<void> {
  const owner = ownerOf(employee);
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('shift_requests')
    .update({ status: 'withdrawn', decided_at: new Date().toISOString() })
    .eq('id', requestId)
    .eq('user_id', owner)
    .eq('employee_id', employee.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (error) throw new CapacityError('WITHDRAW_FAILED', error.message);
  if (!data) throw new CapacityError('NOT_PENDING', 'That request has already been decided.');
}

/** Manager-side loader, re-exported so capacityAdmin.ts uses the identical staffing inputs. */
export async function loadOwnerStaffing(owner: string, fromISO: string, toISO: string, team?: CapacityTeam): Promise<{
  blocks: CapacityBlock[];
  settings: CapacitySetting[];
  outlook: BlockStaffing[];
}> {
  if (!owner) throw new CapacityError('OWNER_REQUIRED', 'Owner scope is required.');
  const admin = createAdminClient();
  const inputs = await loadStaffingInputs(admin, owner, team ?? null, fromISO, toISO);
  return {
    blocks: inputs.blocks,
    settings: inputs.settings,
    outlook: staffingOutlook({
      blocks: inputs.blocks,
      fromISO,
      toISO,
      instances: inputs.instances,
      teamOf: inputs.teamOf,
      settings: inputs.settings,
      team,
    }),
  };
}

/** The wire id a capacity opportunity carries in the portal payload. */
export { capacityItemId };
