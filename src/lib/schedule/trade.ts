import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { payPeriodStartFor } from '@/lib/employees';
import type { Employee } from '@/types';
import { laTodayISO } from './timezone';
import { instanceHours } from './hours';
import { ScheduleError } from './release';
import {
  planTradeRequest, buildTradeOptions, planCoworkerResponse, planCancel, otherDates,
  TRADE_REFUSAL_MESSAGES, RESPOND_REFUSAL_MESSAGES, CANCEL_REFUSAL_MESSAGES, TRADE_APPROVE_MESSAGES,
  type TradeableInstance, type TradeParty,
} from './tradePlan';
import type { TradeOptionsPayload, TradeShiftFacts, TradeStatus, TradeView } from './portalTypes';

// Shift trades — the DB-bound half. Employee routes call the first group (token-resolved employee,
// NEVER a client-supplied one); the admin route calls the second (owner = the manager's session uid).
//
// NOTHING HERE MOVES A SHIFT. The employee paths INSERT a proposal or flip its status with a
// compare-and-swap. The only writer of shift_instances is lensed_approve_shift_trade (migration
// 136), reached through approveTrade(), which re-validates both shifts under row locks and swaps
// atomically. See tradePlan.ts for the pre-check kernel these functions feed.
//
// SCOPING. Service-role client; every query carries `user_id = owner`. Employee identity comes from
// the token; a foreign instance or trade id is simply "not found".

const INSTANCE_COLS = 'id, user_id, employee_id, shift_date, starts_at, ends_at, status, released_at, role, offer_state';
const TRADE_COLS =
  'id, user_id, requester_employee_id, requester_shift_instance_id, target_employee_id, target_shift_instance_id, ' +
  'status, coworker_response, coworker_responded_at, decided_by, decided_at, decision_note, cancelled_at, created_at';
const LIVE = ['pending_coworker', 'pending_manager'];
const HISTORY_DAYS = 90;

interface TradeRow {
  id: string;
  user_id: string;
  requester_employee_id: string;
  requester_shift_instance_id: string;
  target_employee_id: string;
  target_shift_instance_id: string;
  status: TradeStatus;
  coworker_response: 'accepted' | 'declined' | null;
  coworker_responded_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  cancelled_at: string | null;
  created_at: string;
}

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Migration 136 may not be applied yet (this DB has no ledger and migrations ship by hand). Until it
 * is, the portal must still work: every READ of shift_trades degrades to "no trades" on the
 * table-missing error, and the offer guard lets a drop through. Writes still fail loudly.
 */
export function isMissingTradesTable(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === 'PGRST205' || error.code === '42P01') return /shift_trades/.test(error.message ?? '') || true;
  return /shift_trades/.test(error.message ?? '') && /schema cache|does not exist/i.test(error.message ?? '');
}

function facts(i: { id: string; shift_date: string; starts_at: string; ends_at: string }): TradeShiftFacts {
  return { instance_id: i.id, shift_date: i.shift_date, starts_at: i.starts_at, ends_at: i.ends_at, hours: instanceHours(i.starts_at, i.ends_at) };
}

async function readInstance(admin: Admin, ownerId: string, id: string): Promise<TradeableInstance | null> {
  const { data, error } = await admin.from('shift_instances').select(INSTANCE_COLS).eq('id', id).eq('user_id', ownerId).maybeSingle();
  if (error) throw new ScheduleError('READ_FAILED', error.message);
  return (data as TradeableInstance | null) ?? null;
}

async function readParty(admin: Admin, ownerId: string, employeeId: string): Promise<(TradeParty & { name: string }) | null> {
  // Explicit allow-list: never `*` on employees from an employee-facing path (pin hashes, rate, phone).
  const { data, error } = await admin.from('employees').select('id, role, status, name').eq('id', employeeId).eq('user_id', ownerId).maybeSingle();
  if (error) throw new ScheduleError('READ_FAILED', error.message);
  return (data as (TradeParty & { name: string }) | null) ?? null;
}

/** Dates this employee already works (scheduled/claimed) from today on. */
async function datesInUse(admin: Admin, ownerId: string, employeeId: string, todayISO: string): Promise<Set<string>> {
  const { data, error } = await admin
    .from('shift_instances').select('shift_date')
    .eq('user_id', ownerId).eq('employee_id', employeeId).in('status', ['scheduled', 'claimed']).gte('shift_date', todayISO);
  if (error) throw new ScheduleError('READ_FAILED', error.message);
  return new Set((data ?? []).map((r) => r.shift_date as string));
}

/** Instance ids that are part of a LIVE trade for this owner (either side). */
async function liveTradeInstanceIds(admin: Admin, ownerId: string, excludeTradeId?: string): Promise<Set<string>> {
  let q = admin.from('shift_trades').select('id, requester_shift_instance_id, target_shift_instance_id').eq('user_id', ownerId).in('status', LIVE);
  if (excludeTradeId) q = q.neq('id', excludeTradeId);
  const { data, error } = await q;
  if (error) {
    if (isMissingTradesTable(error)) return new Set<string>();
    throw new ScheduleError('READ_FAILED', error.message);
  }
  const s = new Set<string>();
  for (const r of data ?? []) { s.add(r.requester_shift_instance_id as string); s.add(r.target_shift_instance_id as string); }
  return s;
}

// ── Employee: options ─────────────────────────────────────────────────────────────────────────

/** Step 2/3 of Request Trade: coworkers in my role and the shifts of theirs I could swap `mine` for. */
export async function getTradeOptions(employee: Employee, instanceId: string, now: Date = new Date()): Promise<TradeOptionsPayload> {
  const admin = createAdminClient();
  const owner = employee.user_id;
  const todayISO = laTodayISO(now);
  const me: TradeParty = { id: employee.id, role: employee.role ?? null, status: employee.status };

  const mine = await readInstance(admin, owner, instanceId);
  if (!mine || mine.employee_id !== employee.id) throw new ScheduleError('NOT_YOUR_SHIFT', TRADE_REFUSAL_MESSAGES.NOT_YOUR_SHIFT);

  const [{ data: coworkers, error: cErr }, myDates, activeIds] = await Promise.all([
    admin.from('employees').select('id, name, role, status')
      .eq('user_id', owner).eq('status', 'active').neq('id', employee.id).eq('role', employee.role),
    datesInUse(admin, owner, employee.id, todayISO),
    liveTradeInstanceIds(admin, owner),
  ]);
  if (cErr) throw new ScheduleError('READ_FAILED', cErr.message);
  const ids = (coworkers ?? []).map((c) => c.id as string);
  if (ids.length === 0) return { my_shift: facts(mine), coworkers: [] };

  const { data: theirs, error: tErr } = await admin
    .from('shift_instances').select(INSTANCE_COLS)
    .eq('user_id', owner).in('employee_id', ids).in('status', ['scheduled', 'claimed']).gte('shift_date', todayISO)
    .order('starts_at', { ascending: true });
  if (tErr) throw new ScheduleError('READ_FAILED', tErr.message);

  const byEmp = new Map<string, TradeableInstance[]>();
  for (const r of (theirs ?? []) as TradeableInstance[]) {
    const arr = byEmp.get(r.employee_id as string);
    if (arr) arr.push(r); else byEmp.set(r.employee_id as string, [r]);
  }
  const options = buildTradeOptions({
    mine, me, myDates, activeTradeInstanceIds: activeIds, nowMs: now.getTime(),
    candidates: (coworkers ?? []).map((c) => ({
      employee: { id: c.id as string, role: (c.role as string) ?? null, status: c.status as string, name: c.name as string },
      instances: byEmp.get(c.id as string) ?? [],
    })),
  });
  return {
    my_shift: facts(mine),
    coworkers: options.map((o) => ({
      employee_id: o.employee_id, name: o.name, role: o.role,
      shifts: o.shifts.map((s) => ({ instance_id: s.instance_id, shift_date: s.shift_date, starts_at: s.starts_at, ends_at: s.ends_at, hours: instanceHours(s.starts_at, s.ends_at) })),
    })),
  };
}

// ── Employee: propose ─────────────────────────────────────────────────────────────────────────

async function validateProposal(admin: Admin, employee: Employee, mineId: string, theirsId: string, now: Date, excludeTradeId?: string) {
  const owner = employee.user_id;
  const todayISO = laTodayISO(now);
  const [mine, theirs] = await Promise.all([readInstance(admin, owner, mineId), readInstance(admin, owner, theirsId)]);
  if (!mine) throw new ScheduleError('NOT_FOUND', 'That shift no longer exists.');
  if (!theirs || !theirs.employee_id) throw new ScheduleError('TARGET_NOT_OWNED', TRADE_REFUSAL_MESSAGES.TARGET_NOT_OWNED);
  const them = await readParty(admin, owner, theirs.employee_id);
  if (!them) throw new ScheduleError('TARGET_NOT_OWNED', TRADE_REFUSAL_MESSAGES.TARGET_NOT_OWNED);
  const [myDates, theirDates, activeIds] = await Promise.all([
    datesInUse(admin, owner, employee.id, todayISO),
    datesInUse(admin, owner, them.id, todayISO),
    liveTradeInstanceIds(admin, owner, excludeTradeId),
  ]);
  const plan = planTradeRequest({
    mine, theirs,
    me: { id: employee.id, role: employee.role ?? null, status: employee.status },
    them,
    myOtherDates: otherDates(myDates, mine.shift_date),
    theirOtherDates: otherDates(theirDates, theirs.shift_date),
    activeTradeInstanceIds: activeIds,
    nowMs: now.getTime(),
  });
  if (!plan.ok) throw new ScheduleError(plan.code, TRADE_REFUSAL_MESSAGES[plan.code]);
  return { mine, theirs, them };
}

export async function requestTrade(employee: Employee, mineId: string, theirsId: string, now: Date = new Date()): Promise<TradeView> {
  const admin = createAdminClient();
  const { mine, theirs, them } = await validateProposal(admin, employee, mineId, theirsId, now);

  const { data, error } = await admin
    .from('shift_trades')
    .insert({
      user_id: employee.user_id,
      requester_employee_id: employee.id,
      requester_shift_instance_id: mine.id,
      target_employee_id: them.id,
      target_shift_instance_id: theirs.id,
      status: 'pending_coworker',
    })
    .select(TRADE_COLS)
    .single();
  if (error) {
    // The partial unique indexes (136) are the real double-submit guard; the read above only saved a trip.
    if (error.code === '23505') throw new ScheduleError('IN_ACTIVE_TRADE', TRADE_REFUSAL_MESSAGES.IN_ACTIVE_TRADE);
    if (isMissingTradesTable(error)) throw new ScheduleError('TRADES_UNAVAILABLE', 'Shift trades are not available yet.');
    throw new ScheduleError('TRADE_FAILED', error.message);
  }
  return toView(data as unknown as TradeRow, employee.id, { [mine.id]: facts(mine), [theirs.id]: facts(theirs) }, { [them.id]: them.name });
}

// ── Employee: respond / cancel ────────────────────────────────────────────────────────────────

async function readTrade(admin: Admin, ownerId: string, tradeId: string): Promise<TradeRow | null> {
  const { data, error } = await admin.from('shift_trades').select(TRADE_COLS).eq('id', tradeId).eq('user_id', ownerId).maybeSingle();
  if (error) throw new ScheduleError('READ_FAILED', error.message);
  return (data as unknown as TradeRow | null) ?? null;
}

export async function respondToTrade(employee: Employee, tradeId: string, response: 'accept' | 'decline', now: Date = new Date()): Promise<{ status: TradeStatus }> {
  const admin = createAdminClient();
  const t = await readTrade(admin, employee.user_id, tradeId);
  if (!t) throw new ScheduleError('NOT_FOUND', 'That trade no longer exists.');
  const plan = planCoworkerResponse(t, employee.id);
  if (!plan.ok) throw new ScheduleError(plan.code, RESPOND_REFUSAL_MESSAGES[plan.code]);

  if (response === 'accept') {
    // Re-check the swap from the COWORKER's side with fresh rows, so nobody accepts a trade the
    // manager is bound to refuse (their shift got reassigned, the requester's got offered, …).
    // The requester's identity for the kernel is the row's requester, read owner-scoped.
    const requester = await readParty(admin, employee.user_id, t.requester_employee_id);
    if (!requester) throw new ScheduleError('INACTIVE_EMPLOYEE', TRADE_REFUSAL_MESSAGES.INACTIVE_EMPLOYEE);
    await validateProposal(
      admin,
      { ...employee, id: requester.id, role: requester.role ?? '', status: requester.status as Employee['status'] },
      t.requester_shift_instance_id,
      t.target_shift_instance_id,
      now,
      t.id,
    );
  }

  const next = response === 'accept'
    ? { status: 'pending_manager', coworker_response: 'accepted', coworker_responded_at: now.toISOString() }
    : { status: 'declined', coworker_response: 'declined', coworker_responded_at: now.toISOString() };
  const { data, error } = await admin
    .from('shift_trades')
    .update(next)
    .eq('id', tradeId)
    .eq('user_id', employee.user_id)
    .eq('target_employee_id', employee.id)   // re-asserted: the CAS is the authority, not the read above
    .eq('status', 'pending_coworker')
    .select('id, status')
    .maybeSingle();
  if (error) throw new ScheduleError('RESPOND_FAILED', error.message);
  if (!data) throw new ScheduleError('TRADE_CHANGED', TRADE_APPROVE_MESSAGES.TRADE_CHANGED);
  return { status: data.status as TradeStatus };
}

export async function cancelTrade(employee: Employee, tradeId: string, now: Date = new Date()): Promise<{ status: 'cancelled' }> {
  const admin = createAdminClient();
  const t = await readTrade(admin, employee.user_id, tradeId);
  if (!t) throw new ScheduleError('NOT_FOUND', 'That trade no longer exists.');
  const plan = planCancel(t, employee.id);
  if (!plan.ok) throw new ScheduleError(plan.code, CANCEL_REFUSAL_MESSAGES[plan.code]);
  const { data, error } = await admin
    .from('shift_trades')
    .update({ status: 'cancelled', cancelled_at: now.toISOString() })
    .eq('id', tradeId)
    .eq('user_id', employee.user_id)
    .eq('requester_employee_id', employee.id)
    .in('status', LIVE)
    .select('id')
    .maybeSingle();
  if (error) throw new ScheduleError('CANCEL_FAILED', error.message);
  if (!data) throw new ScheduleError('TRADE_CHANGED', TRADE_APPROVE_MESSAGES.TRADE_CHANGED);
  return { status: 'cancelled' };
}

// ── Employee: my trades (for the snapshot) ────────────────────────────────────────────────────

function toView(t: TradeRow, meId: string, factsById: Record<string, TradeShiftFacts | undefined>, nameById: Record<string, string | undefined>): TradeView {
  const iAmRequester = t.requester_employee_id === meId;
  const myInst = iAmRequester ? t.requester_shift_instance_id : t.target_shift_instance_id;
  const theirInst = iAmRequester ? t.target_shift_instance_id : t.requester_shift_instance_id;
  const otherId = iAmRequester ? t.target_employee_id : t.requester_employee_id;
  const missing = (id: string): TradeShiftFacts => ({ instance_id: id, shift_date: '', starts_at: '', ends_at: '', hours: 0 });
  return {
    id: t.id,
    status: t.status,
    direction: iAmRequester ? 'outgoing' : 'incoming',
    other_name: nameById[otherId] ?? 'A coworker',
    my_shift: factsById[myInst] ?? missing(myInst),
    their_shift: factsById[theirInst] ?? missing(theirInst),
    created_at: t.created_at,
    coworker_response: t.coworker_response,
    coworker_responded_at: t.coworker_responded_at,
    decided_at: t.decided_at,
    decision_note: t.decision_note,
    cancelled_at: t.cancelled_at,
  };
}

async function hydrate(admin: Admin, ownerId: string, rows: TradeRow[]) {
  const instIds = [...new Set(rows.flatMap((r) => [r.requester_shift_instance_id, r.target_shift_instance_id]))];
  const empIds = [...new Set(rows.flatMap((r) => [r.requester_employee_id, r.target_employee_id]))];
  const [{ data: insts }, { data: emps }] = await Promise.all([
    instIds.length ? admin.from('shift_instances').select('id, shift_date, starts_at, ends_at').eq('user_id', ownerId).in('id', instIds) : Promise.resolve({ data: [] as unknown[] }),
    empIds.length ? admin.from('employees').select('id, name').eq('user_id', ownerId).in('id', empIds) : Promise.resolve({ data: [] as unknown[] }),
  ]);
  const factsById: Record<string, TradeShiftFacts> = {};
  for (const i of (insts ?? []) as { id: string; shift_date: string; starts_at: string; ends_at: string }[]) factsById[i.id] = facts(i);
  const nameById: Record<string, string> = {};
  for (const e of (emps ?? []) as { id: string; name: string }[]) nameById[e.id] = e.name;
  return { factsById, nameById };
}

/** Every live trade involving me, plus decided ones from the last 90 days. */
export async function listMyTrades(employee: Employee, now: Date = new Date()): Promise<TradeView[]> {
  const admin = createAdminClient();
  const since = new Date(now.getTime() - HISTORY_DAYS * 86_400_000).toISOString();
  const { data, error } = await admin
    .from('shift_trades')
    .select(TRADE_COLS)
    .eq('user_id', employee.user_id)
    .or(`requester_employee_id.eq.${employee.id},target_employee_id.eq.${employee.id}`)
    .or(`status.in.(pending_coworker,pending_manager),created_at.gte.${since}`)
    .order('created_at', { ascending: false });
  if (error) {
    if (isMissingTradesTable(error)) return [];
    throw new ScheduleError('READ_FAILED', error.message);
  }
  const rows = (data ?? []) as unknown as TradeRow[];
  if (rows.length === 0) return [];
  const { factsById, nameById } = await hydrate(admin, employee.user_id, rows);
  return rows.map((r) => toView(r, employee.id, factsById, nameById));
}

// ── Manager ───────────────────────────────────────────────────────────────────────────────────

export interface PendingTradeRow {
  trade_id: string;
  requester_name: string;
  target_name: string;
  requester_shift: TradeShiftFacts;
  target_shift: TradeShiftFacts;
  coworker_responded_at: string | null;
  created_at: string;
}

/** Trades the coworker has accepted and a manager must decide. Owner-scoped in every query. */
export async function listPendingTrades(ownerId: string): Promise<PendingTradeRow[]> {
  if (!ownerId) throw new ScheduleError('OWNER_REQUIRED', 'Owner scope is required.');
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('shift_trades').select(TRADE_COLS)
    .eq('user_id', ownerId).eq('status', 'pending_manager')
    .order('coworker_responded_at', { ascending: true });
  if (error) {
    if (isMissingTradesTable(error)) return [];
    throw new ScheduleError('READ_FAILED', error.message);
  }
  const rows = (data ?? []) as unknown as TradeRow[];
  if (rows.length === 0) return [];
  const { factsById, nameById } = await hydrate(admin, ownerId, rows);
  return rows
    .filter((r) => factsById[r.requester_shift_instance_id] && factsById[r.target_shift_instance_id])
    .map((r) => ({
      trade_id: r.id,
      requester_name: nameById[r.requester_employee_id] ?? 'Unknown',
      target_name: nameById[r.target_employee_id] ?? 'Unknown',
      requester_shift: factsById[r.requester_shift_instance_id],
      target_shift: factsById[r.target_shift_instance_id],
      coworker_responded_at: r.coworker_responded_at,
      created_at: r.created_at,
    }));
}

/**
 * APPROVE — the atomic swap. Delegates entirely to lensed_approve_shift_trade (136): both shifts
 * are re-read under FOR UPDATE, every precondition is re-checked, the three-step swap runs inside
 * one exception block, and the four attendance rows land in the same transaction. The RPC returns
 * {ok:false, reason} for a refusal so a stale queue reaches the manager as a sentence.
 * rpc-grants: lensed_approve_shift_trade
 */
export async function approveTrade(input: { ownerId: string; tradeId: string }): Promise<{ trade_id: string }> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc('lensed_approve_shift_trade', {
    p_owner: input.ownerId,
    p_trade_id: input.tradeId,
    // ACTION time, matching pickup approval, so both sides' release/claim pairs net in one period.
    p_pay_period_start: payPeriodStartFor(laTodayISO()),
  });
  if (error) throw new ScheduleError('APPROVE_FAILED', error.message);
  const r = (data ?? {}) as { ok?: boolean; reason?: string };
  if (!r.ok) {
    const reason = r.reason ?? 'APPROVE_FAILED';
    throw new ScheduleError(reason, TRADE_APPROVE_MESSAGES[reason] ?? 'That trade could not be approved.');
  }
  return { trade_id: input.tradeId };
}

/** DECLINE — records the decision; both shifts stay exactly where they are. */
export async function declineTrade(input: { ownerId: string; tradeId: string; note?: string | null }): Promise<void> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('shift_trades')
    .update({ status: 'declined', decided_by: input.ownerId, decided_at: new Date().toISOString(), decision_note: input.note?.trim().slice(0, 300) || null })
    .eq('id', input.tradeId)
    .eq('user_id', input.ownerId)
    .eq('status', 'pending_manager')
    .select('id')
    .maybeSingle();
  if (error) throw new ScheduleError('DECLINE_FAILED', error.message);
  if (!data) throw new ScheduleError('TRADE_NOT_PENDING', TRADE_APPROVE_MESSAGES.TRADE_NOT_PENDING);
}
