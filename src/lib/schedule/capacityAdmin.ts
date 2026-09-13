import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { addDaysISO, laTodayISO } from './timezone';
import { CapacityError, loadOwnerStaffing } from './capacityBoard';
import {
  blockInstants, CAPACITY_TEAMS,
  type BlockStaffing, type CapacityBlock, type CapacityTeam, type StaffingOutlookPayload,
} from './capacity';

// MANAGER-SIDE staffing capacity: configure blocks and capacities, read the staffing outlook, and
// decide shift requests.
//
// TENANT BOUNDARY. `ownerId` is ALWAYS the acting manager's auth uid, taken from the session by the
// route and never from client input. createAdminClient() bypasses RLS, so the explicit
// `.eq('user_id', ownerId)` on every statement below IS the boundary — the same discipline
// adminShifts.ts records after the pending-claims leak.

/** How far ahead the manager outlook is computed by default. */
export const OUTLOOK_DAYS = 21;

export type { StaffingOutlookPayload };

export async function getStaffingOutlook(ownerId: string, opts: { from?: string; days?: number } = {}): Promise<StaffingOutlookPayload> {
  if (!ownerId) throw new CapacityError('OWNER_REQUIRED', 'Owner scope is required.');
  const from = opts.from && /^\d{4}-\d{2}-\d{2}$/.test(opts.from) ? opts.from : laTodayISO();
  const to = addDaysISO(from, Math.min(Math.max(opts.days ?? OUTLOOK_DAYS, 1), 60));

  const { blocks, settings, outlook } = await loadOwnerStaffing(ownerId, from, to);

  const byDate = new Map<string, BlockStaffing[]>();
  for (const s of outlook) {
    const list = byDate.get(s.date);
    if (list) list.push(s);
    else byDate.set(s.date, [s]);
  }
  const days: StaffingOutlookPayload['days'] = [];
  for (let d = from; d <= to; d = addDaysISO(d, 1)) days.push({ date: d, blocks: byDate.get(d) ?? [] });

  return {
    from,
    to,
    blocks,
    settings,
    days,
    // `capacity: null` means NOT CONFIGURED, and the panel says so in words. There is no constant
    // standing in for a number the business never told us.
    teamDefaults: CAPACITY_TEAMS.map((team) => {
      const row = settings.find((s) => s.block_id == null && s.team === team) ?? null;
      return { team, capacity: row?.capacity ?? null, closed: Boolean(row?.closed) };
    }),
  };
}

// ── Block CRUD ────────────────────────────────────────────────────────────────────────────────

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export interface BlockInput {
  id?: string;
  team: string;
  label?: string | null;
  days_of_week: number[];
  start_time: string;
  end_time: string;
  capacity?: number | null;
  active?: boolean;
}

function validateBlock(input: BlockInput): { team: CapacityTeam; days: number[]; start: string; end: string; capacity: number | null } {
  if (input.team !== 'host' && input.team !== 'fulfillment') throw new CapacityError('BAD_TEAM', 'Pick a team.');
  if (!TIME_RE.test(input.start_time) || !TIME_RE.test(input.end_time)) {
    throw new CapacityError('BAD_TIME', 'Start and end must be times.');
  }
  const start = input.start_time.slice(0, 5);
  const end = input.end_time.slice(0, 5);
  // A zero-length block would be read as overnight by crossesMidnight()'s <=, which is why the DB
  // carries the same CHECK. Refuse it here so the manager gets a sentence, not a 500.
  if (start === end) throw new CapacityError('BAD_TIME', 'End time must be different from the start time.');
  const days = [...new Set(input.days_of_week.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
  if (days.length === 0) throw new CapacityError('NO_DAYS', 'Pick at least one day.');
  const capacity = input.capacity == null || input.capacity === ('' as unknown as number) ? null : Number(input.capacity);
  if (capacity != null && (!Number.isInteger(capacity) || capacity < 0 || capacity > 999)) {
    throw new CapacityError('BAD_CAPACITY', 'Capacity must be a whole number, 0 or more.');
  }
  return { team: input.team, days, start, end, capacity };
}

export async function upsertCapacityBlock(ownerId: string, input: BlockInput): Promise<CapacityBlock> {
  if (!ownerId) throw new CapacityError('OWNER_REQUIRED', 'Owner scope is required.');
  const v = validateBlock(input);
  const admin = createAdminClient();
  const row = {
    user_id: ownerId,
    team: v.team,
    label: input.label?.trim() ? input.label.trim().slice(0, 60) : null,
    days_of_week: v.days,
    start_time: v.start,
    end_time: v.end,
    capacity: v.capacity,
    active: input.active ?? true,
  };
  const q = input.id
    // `.eq('user_id', ownerId)` on the UPDATE is the ownership proof — a foreign id updates nothing
    // rather than reporting success.
    ? admin.from('shift_capacity_blocks').update(row).eq('id', input.id).eq('user_id', ownerId).select('*').maybeSingle()
    : admin.from('shift_capacity_blocks').insert(row).select('*').single();
  const { data, error } = await q;
  if (error) throw new CapacityError('SAVE_FAILED', error.message);
  if (!data) throw new CapacityError('NOT_FOUND', 'That block no longer exists.');
  return data as unknown as CapacityBlock;
}

/**
 * DEACTIVATE a block. Never a delete: a block with history is what the manager outlook and the
 * request trail refer to, and an inactive block already produces no opportunity on any date.
 * Assigned shifts are untouched — a block is a staffing question, not a schedule.
 */
export async function setCapacityBlockActive(ownerId: string, blockId: string, active: boolean): Promise<void> {
  if (!ownerId) throw new CapacityError('OWNER_REQUIRED', 'Owner scope is required.');
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('shift_capacity_blocks')
    .update({ active })
    .eq('id', blockId)
    .eq('user_id', ownerId)
    .select('id')
    .maybeSingle();
  if (error) throw new CapacityError('SAVE_FAILED', error.message);
  if (!data) throw new CapacityError('NOT_FOUND', 'That block no longer exists.');
}

// ── Capacity settings (team default + per-date override) ──────────────────────────────────────

/** Set or clear the owner's TEAM DEFAULT — "Live Host · 10 live setups". */
export async function setTeamCapacity(ownerId: string, team: string, capacity: number | null, closed = false): Promise<void> {
  if (!ownerId) throw new CapacityError('OWNER_REQUIRED', 'Owner scope is required.');
  if (team !== 'host' && team !== 'fulfillment') throw new CapacityError('BAD_TEAM', 'Pick a team.');
  if (capacity != null && (!Number.isInteger(capacity) || capacity < 0 || capacity > 999)) {
    throw new CapacityError('BAD_CAPACITY', 'Capacity must be a whole number, 0 or more.');
  }
  const admin = createAdminClient();
  const existing = await admin
    .from('shift_capacity_settings')
    .select('id')
    .eq('user_id', ownerId).eq('team', team).is('block_id', null)
    .maybeSingle();
  if (existing.error) throw new CapacityError('READ_FAILED', existing.error.message);

  // A row that names neither a number nor a closure has no meaning (the DB CHECK says so too), so
  // clearing both DELETES the row and the team goes back to NOT CONFIGURED — which advertises
  // nothing, rather than falling back to some number nobody chose.
  if (capacity == null && !closed) {
    if (existing.data) {
      const { error } = await admin.from('shift_capacity_settings').delete().eq('id', existing.data.id).eq('user_id', ownerId);
      if (error) throw new CapacityError('SAVE_FAILED', error.message);
    }
    return;
  }
  const row = { user_id: ownerId, team, block_id: null, date: null, capacity, closed };
  const { error } = existing.data
    ? await admin.from('shift_capacity_settings').update(row).eq('id', existing.data.id).eq('user_id', ownerId)
    : await admin.from('shift_capacity_settings').insert(row);
  if (error) throw new CapacityError('SAVE_FAILED', error.message);
}

/**
 * Set, change or clear the override for ONE block on ONE date.
 *
 * `capacity: null, closed: false` REMOVES the override, restoring automatic capacity.
 *
 * THIS NEVER TOUCHES AN ASSIGNMENT. Lowering capacity below current staffing does not cancel
 * anybody — the outlook simply reports "Over capacity by N" and stops advertising availability
 * until staffing falls back under the number. Closing availability stops NEW requests and nothing
 * else: no shift is dropped, no offer is cancelled, no employee is removed.
 */
export async function setBlockDateCapacity(ownerId: string, input: {
  blockId: string;
  date: string;
  capacity?: number | null;
  closed?: boolean;
  note?: string | null;
}): Promise<void> {
  if (!ownerId) throw new CapacityError('OWNER_REQUIRED', 'Owner scope is required.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new CapacityError('BAD_DATE', 'Bad request.');
  const capacity = input.capacity == null ? null : Number(input.capacity);
  if (capacity != null && (!Number.isInteger(capacity) || capacity < 0 || capacity > 999)) {
    throw new CapacityError('BAD_CAPACITY', 'Capacity must be a whole number, 0 or more.');
  }
  const closed = Boolean(input.closed);

  const admin = createAdminClient();
  // The block must belong to this owner. Resolving it here is what stops a foreign block id from
  // ever reaching an insert — shift_capacity_settings.user_id alone would not prove the chain.
  const block = await admin
    .from('shift_capacity_blocks')
    .select('id, team')
    .eq('id', input.blockId).eq('user_id', ownerId)
    .maybeSingle();
  if (block.error) throw new CapacityError('READ_FAILED', block.error.message);
  if (!block.data) throw new CapacityError('NOT_FOUND', 'That block no longer exists.');

  const existing = await admin
    .from('shift_capacity_settings')
    .select('id')
    .eq('user_id', ownerId).eq('block_id', input.blockId).eq('date', input.date)
    .maybeSingle();
  if (existing.error) throw new CapacityError('READ_FAILED', existing.error.message);

  if (capacity == null && !closed) {                       // restore automatic capacity
    if (existing.data) {
      const { error } = await admin.from('shift_capacity_settings').delete().eq('id', existing.data.id).eq('user_id', ownerId);
      if (error) throw new CapacityError('SAVE_FAILED', error.message);
    }
    return;
  }
  const row = {
    user_id: ownerId,
    team: block.data.team as string,
    block_id: input.blockId,
    date: input.date,
    capacity,
    closed,
    note: input.note?.trim() ? input.note.trim().slice(0, 200) : null,
  };
  const { error } = existing.data
    ? await admin.from('shift_capacity_settings').update(row).eq('id', existing.data.id).eq('user_id', ownerId)
    : await admin.from('shift_capacity_settings').insert(row);
  if (error) throw new CapacityError('SAVE_FAILED', error.message);
}

// ── The request queue ─────────────────────────────────────────────────────────────────────────

export interface ShiftRequestRow {
  request_id: string;
  employee_id: string;
  employee_name: string;
  block_id: string;
  block_label: string | null;
  team: string;
  shift_date: string;
  starts_at: string;
  ends_at: string;
  requested_at: string;
  /** Staffing for that block+date AT READ TIME, so the manager decides against current numbers. */
  staffed: number;
  /** null = no configured capacity for that block; approval will refuse. */
  capacity: number | null;
  available: number;
  closed: boolean;
}

export async function listShiftRequests(ownerId: string): Promise<ShiftRequestRow[]> {
  if (!ownerId) throw new CapacityError('OWNER_REQUIRED', 'Owner scope is required.');
  const admin = createAdminClient();
  const todayISO = laTodayISO();
  const { data, error } = await admin
    .from('shift_requests')
    .select('id, employee_id, block_id, team, shift_date, starts_at, ends_at, created_at')
    .eq('user_id', ownerId)
    .eq('status', 'pending')
    .gte('shift_date', todayISO)
    .order('shift_date', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw new CapacityError('READ_FAILED', error.message);
  const rows = data ?? [];
  if (rows.length === 0) return [];

  const dates = rows.map((r) => r.shift_date as string).sort();
  const [names, staffing] = await Promise.all([
    admin.from('employees').select('id, name').eq('user_id', ownerId)
      .in('id', [...new Set(rows.map((r) => r.employee_id as string))]),
    loadOwnerStaffing(ownerId, dates[0], dates[dates.length - 1]),
  ]);
  const nameById = new Map((names.data ?? []).map((e) => [e.id as string, e.name as string]));
  const labelById = new Map(staffing.blocks.map((b) => [b.id, b.label]));
  const staffingByKey = new Map(staffing.outlook.map((s) => [`${s.block_id}|${s.date}`, s]));

  return rows.map((r) => {
    const s = staffingByKey.get(`${r.block_id as string}|${r.shift_date as string}`) ?? null;
    return {
      request_id: r.id as string,
      employee_id: r.employee_id as string,
      employee_name: nameById.get(r.employee_id as string) ?? 'Unknown',
      block_id: r.block_id as string,
      block_label: labelById.get(r.block_id as string) ?? null,
      team: r.team as string,
      shift_date: r.shift_date as string,
      starts_at: r.starts_at as string,
      ends_at: r.ends_at as string,
      requested_at: r.created_at as string,
      staffed: s?.staffed ?? 0,
      capacity: s?.capacity ?? null,
      available: s?.available ?? 0,
      closed: s?.closed ?? false,
    };
  });
}

const APPROVE_MESSAGES: Record<string, string> = {
  REQUEST_NOT_FOUND: 'That request no longer exists.',
  REQUEST_NOT_PENDING: 'That request has already been decided.',
  ALREADY_APPROVED: 'That request was already approved.',
  BLOCK_NOT_FOUND: 'That shift block no longer exists.',
  BLOCK_INACTIVE: 'That shift block is no longer active.',
  BLOCK_NOT_ON_DATE: 'That block does not run on that day any more.',
  STALE_BLOCK: 'This block’s hours changed after the request — ask them to request it again.',
  AVAILABILITY_CLOSED: 'Availability is closed for that day.',
  PAST_DATE: 'That day has already passed.',
  EMPLOYEE_UNAVAILABLE: 'That employee is no longer active.',
  WRONG_TEAM: 'That employee is not on this block’s team.',
  NO_CAPACITY: 'That block is fully staffed — there is no room for another shift.',
  CAPACITY_NOT_CONFIGURED: 'Set a capacity for this team before approving shift requests.',
  EMPLOYEE_DOUBLE_BOOKED: 'That employee is already scheduled that day.',
};

/**
 * APPROVE a shift request — the only path that creates a capacity-driven shift_instances row.
 *
 * Every precondition is re-checked inside the RPC, under an advisory lock keyed on
 * (owner, team, date), and the staffed count is RECOUNTED there. That is what makes two managers
 * approving the last remaining shift at the same instant produce one assignment and one
 * NO_CAPACITY refusal rather than 11/10 scheduled. Nothing is trusted from this call site except
 * the owner, which is the session uid.
 *
 * The RPC takes NO default-capacity argument: capacity is explicit or it does not exist, and an
 * unconfigured block refuses with CAPACITY_NOT_CONFIGURED rather than inventing a number.
 * rpc-grants: lensed_approve_shift_request
 */
export async function approveShiftRequest(input: { ownerId: string; requestId: string }): Promise<{
  shift_instance_id: string; employee_id: string; superseded: number;
}> {
  if (!input.ownerId) throw new CapacityError('OWNER_REQUIRED', 'Owner scope is required.');
  const admin = createAdminClient();
  const { data, error } = await admin.rpc('lensed_approve_shift_request', {
    p_owner: input.ownerId,
    p_request_id: input.requestId,
  });
  if (error) throw new CapacityError('APPROVE_FAILED', error.message);
  const r = (data ?? {}) as { ok?: boolean; reason?: string; shift_instance_id?: string; employee_id?: string; superseded?: number };
  if (!r.ok) {
    const reason = r.reason ?? 'APPROVE_FAILED';
    throw new CapacityError(reason, APPROVE_MESSAGES[reason] ?? 'That request could not be approved.');
  }
  return {
    shift_instance_id: r.shift_instance_id as string,
    employee_id: r.employee_id as string,
    superseded: r.superseded ?? 0,
  };
}

/** DECLINE one request. Assigns nothing, changes no capacity, and leaves other requests pending. */
export async function declineShiftRequest(input: { ownerId: string; requestId: string; note?: string | null }): Promise<void> {
  if (!input.ownerId) throw new CapacityError('OWNER_REQUIRED', 'Owner scope is required.');
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('shift_requests')
    .update({
      status: 'declined',
      decided_by: input.ownerId,
      decided_at: new Date().toISOString(),
      decision_note: input.note?.trim() ? input.note.trim().slice(0, 200) : null,
    })
    .eq('id', input.requestId)
    .eq('user_id', input.ownerId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (error) throw new CapacityError('DECLINE_FAILED', error.message);
  if (!data) throw new CapacityError('NOT_PENDING', 'That request has already been decided.');
}

export { blockInstants };
