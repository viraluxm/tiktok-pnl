import 'server-only';
import { randomUUID } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import type { Employee } from '@/types';
import { laTodayISO } from './timezone';
import { ScheduleError } from './release';
import {
  planDrop, planPickup, buildAvailableShifts, DROP_REFUSAL_MESSAGES, PICKUP_REFUSAL_MESSAGES,
  type OfferableInstance, type AvailableShift,
} from './offerPlan';

// Phase 2 offer lifecycle — the DB-bound half of Drop Shift / Available Shifts / Pick Up Shift.
//
// Writes ONLY shift_instances (the offer marker) and shift_claims (the pickup request). It writes
// NO attendance_events: offering is not dropping, so nothing is charged until a manager actually
// approves a transfer (that pair is written by lensed_approve_shift_pickup — migration 130).
// It never writes `shifts` and never touches employee_time_entries — scheduling is not payroll.
//
// SCOPING: these run service-role from PUBLIC token routes, so RLS is not the boundary. The
// employee comes from the token (never from the request body) and every query carries an explicit
// user_id filter. That discipline is the security model here, exactly as in board.ts post-hotfix.

const INSTANCE_COLS =
  'id, user_id, employee_id, shift_date, starts_at, ends_at, status, released_at, released_by, role, source, offer_state, offer_id, offered_at';

// ── Drop Shift ────────────────────────────────────────────────────────────────────────────────

export interface DropResult {
  status: 'offered';
  offer_id: string;
  shift_date: string;
  starts_at: string;
  ends_at: string;
}

/**
 * OFFER a shift to coworkers while KEEPING it assigned to its owner.
 *
 * This is deliberately NOT release.ts. The legacy path sets status='released', released_at and
 * employee_id=NULL in one statement, which strips responsibility and clock-eligibility the instant
 * it runs — the exact inverse of the Phase 2 rule. Here the assignment fields are untouched and
 * only the orthogonal offer axis moves, so the owner keeps the shift, keeps seeing it, and keeps
 * being able to clock into it (migration 129's shift_instances_offered_is_owned CHECK pins this).
 */
export async function offerShift(employee: Employee, instanceId: string): Promise<DropResult> {
  const admin = createAdminClient();
  const now = new Date();

  const { data: inst, error } = await admin
    .from('shift_instances')
    .select(INSTANCE_COLS)
    .eq('id', instanceId)
    .eq('user_id', employee.user_id)
    .maybeSingle();
  if (error) throw new ScheduleError('READ_FAILED', error.message);
  if (!inst) throw new ScheduleError('NOT_FOUND', 'That shift no longer exists.');

  const plan = planDrop({
    inst: inst as OfferableInstance,
    employeeId: employee.id,
    nowMs: now.getTime(),
    todayISO: laTodayISO(now),
  });
  if (!plan.ok) throw new ScheduleError(plan.code, DROP_REFUSAL_MESSAGES[plan.code]);

  // A shift in a PENDING TRADE (either side) may not also be offered: the two transfer mechanisms
  // would otherwise race for the same shift and the trade RPC would refuse at approval time with
  // a reason the coworker never saw coming. Refuse up front instead. Owner-scoped like every read.
  const { data: liveTrades, error: tErr } = await admin
    .from('shift_trades')
    .select('id')
    .eq('user_id', employee.user_id)
    .in('status', ['pending_coworker', 'pending_manager'])
    .or(`requester_shift_instance_id.eq.${instanceId},target_shift_instance_id.eq.${instanceId}`)
    .limit(1);
  // Until migration 136 is applied the table does not exist; there can be no trade to collide with.
  if (tErr && !(tErr.code === 'PGRST205' || tErr.code === '42P01')) throw new ScheduleError('READ_FAILED', tErr.message);
  if ((liveTrades ?? []).length > 0) throw new ScheduleError('IN_ACTIVE_TRADE', DROP_REFUSAL_MESSAGES.IN_ACTIVE_TRADE);

  // A FRESH generation id every time. Re-offering a shift invalidates every request and approval
  // from the previous cycle by construction — nothing has to remember to clean them up.
  const offerId = randomUUID();
  const nowISO = now.toISOString();

  // Conditional UPDATE: the predicates repeat every mutable precondition, so a shift that was
  // cancelled, reassigned or offered between the read and here matches 0 rows and is reported
  // rather than overwritten.
  const { data: updated, error: uErr } = await admin
    .from('shift_instances')
    .update({ offer_state: 'offered', offer_id: offerId, offered_at: nowISO })
    .eq('id', instanceId)
    .eq('user_id', employee.user_id)
    .eq('employee_id', employee.id)
    .in('status', ['scheduled', 'claimed'])
    .is('released_at', null)
    .or('offer_state.is.null,offer_state.eq.closed')
    .select('id, shift_date, starts_at, ends_at')
    .maybeSingle();
  if (uErr) throw new ScheduleError('OFFER_FAILED', uErr.message);
  if (!updated) throw new ScheduleError('ALREADY_OFFERED', DROP_REFUSAL_MESSAGES.ALREADY_OFFERED);

  // NO ATTENDANCE EVENT HERE — deliberately, and this is the whole point of the offer lifecycle.
  //
  // An earlier draft wrote the legacy 'released' event right here so computeDrops() would keep
  // working unchanged. That charged the offerer a drop for merely OFFERING, while they were still
  // fully responsible for the shift and still clock-eligible for it — and if nobody picked it up,
  // the drop stood anyway. Offering is not dropping.
  //
  // The bookkeeping now happens at TRANSFER time, inside lensed_approve_shift_pickup (migration
  // 130), which writes the 'released'/'claimed' pair atomically with the assignment change. See
  // that migration's header for why those are the correct two rows and whose ledger each hits.
  return {
    status: 'offered',
    offer_id: offerId,
    shift_date: updated.shift_date,
    starts_at: updated.starts_at,
    ends_at: updated.ends_at,
  };
}

// ── Available Shifts ──────────────────────────────────────────────────────────────────────────

/** Live offers this viewer could work, annotated with why not where they cannot. */
export async function getAvailableShifts(employee: Employee, now = new Date()): Promise<AvailableShift[]> {
  const admin = createAdminClient();
  const todayISO = laTodayISO(now);

  const { data: offers, error } = await admin
    .from('shift_instances')
    .select(INSTANCE_COLS)
    .eq('user_id', employee.user_id)          // OWNER SCOPE — service-role bypasses RLS
    .eq('offer_state', 'offered')
    .gte('shift_date', todayISO)
    .order('starts_at', { ascending: true });
  if (error) throw new ScheduleError('READ_FAILED', error.message);
  const rows = (offers ?? []) as OfferableInstance[];
  if (rows.length === 0) return [];

  const assigneeIds = [...new Set(rows.map((r) => r.employee_id).filter(Boolean) as string[])];
  const [{ data: assignees }, { data: mine }, { data: requested }] = await Promise.all([
    admin.from('employees').select('id, name, role').eq('user_id', employee.user_id).in('id', assigneeIds),
    admin
      .from('shift_instances')
      .select('shift_date')
      .eq('user_id', employee.user_id)
      .eq('employee_id', employee.id)
      .in('status', ['scheduled', 'claimed'])
      .gte('shift_date', todayISO),
    admin
      .from('shift_claims')
      .select('shift_instance_id')
      .eq('user_id', employee.user_id)
      .eq('claimed_by', employee.id)
      .eq('kind', 'pickup_request')
      .eq('status', 'pending'),
  ]);

  return buildAvailableShifts({
    offers: rows,
    assigneeRoleById: new Map((assignees ?? []).map((a) => [a.id as string, (a.role as string) ?? null])),
    assigneeNameById: new Map((assignees ?? []).map((a) => [a.id as string, (a.name as string) ?? null])),
    employeeId: employee.id,
    employeeRole: employee.role ?? null,
    employeeStatus: employee.status,
    myDatesInUse: new Set((mine ?? []).map((r) => r.shift_date as string)),
    requestedInstanceIds: new Set((requested ?? []).map((r) => r.shift_instance_id as string)),
    nowMs: now.getTime(),
    todayISO,
  });
}

// ── Pick Up Shift ─────────────────────────────────────────────────────────────────────────────

export interface PickupResult {
  status: 'pending';
  claim_id: string;
  shift_date: string;
  starts_at: string;
  ends_at: string;
}

/**
 * Request to pick up an offered shift. ALWAYS lands as status='pending' — Phase 2 has no
 * auto-approval, and migration 129's shift_claims_pickup_never_auto CHECK makes that a database
 * guarantee rather than a code convention. Nothing about shift_instances changes here: the
 * requester does not become assigned and does not become clock-eligible. A manager decides.
 */
export async function requestPickup(
  employee: Employee,
  instanceId: string,
  expectedOfferId?: string | null,
): Promise<PickupResult> {
  const admin = createAdminClient();
  const now = new Date();
  const todayISO = laTodayISO(now);

  const { data: inst, error } = await admin
    .from('shift_instances')
    .select(INSTANCE_COLS)
    .eq('id', instanceId)
    .eq('user_id', employee.user_id)          // OWNER SCOPE: a foreign shift is simply not found
    .maybeSingle();
  if (error) throw new ScheduleError('READ_FAILED', error.message);
  if (!inst) throw new ScheduleError('NOT_FOUND', PICKUP_REFUSAL_MESSAGES.NOT_OFFERED);

  const [{ data: mine }, { data: existing }] = await Promise.all([
    admin
      .from('shift_instances')
      .select('shift_date')
      .eq('user_id', employee.user_id)
      .eq('employee_id', employee.id)
      .in('status', ['scheduled', 'claimed'])
      .eq('shift_date', (inst as OfferableInstance).shift_date),
    admin
      .from('shift_claims')
      .select('id')
      .eq('user_id', employee.user_id)
      .eq('shift_instance_id', instanceId)
      .eq('claimed_by', employee.id)
      .eq('kind', 'pickup_request')
      .eq('status', 'pending')
      .limit(1),
  ]);

  const plan = planPickup({
    inst: inst as OfferableInstance,
    employeeId: employee.id,
    employeeRole: employee.role ?? null,
    employeeStatus: employee.status,
    expectedOfferId,
    myDatesInUse: new Set((mine ?? []).map((r) => r.shift_date as string)),
    alreadyRequested: (existing ?? []).length > 0,
    nowMs: now.getTime(),
    todayISO,
  });
  if (!plan.ok) throw new ScheduleError(plan.code, PICKUP_REFUSAL_MESSAGES[plan.code]);

  const { data: claim, error: cErr } = await admin
    .from('shift_claims')
    .insert({
      user_id: employee.user_id,
      shift_instance_id: instanceId,
      claimed_by: employee.id,
      status: 'pending',
      kind: 'pickup_request',
      offer_id: (inst as OfferableInstance).offer_id,
      projected_week_hours: null,
    })
    .select('id')
    .single();
  if (cErr) {
    // The partial unique index (migration 129) is the real guard against a double-tap; the
    // application check above only saves a round trip. Report it as the same friendly state.
    if (cErr.code === '23505') throw new ScheduleError('ALREADY_REQUESTED', PICKUP_REFUSAL_MESSAGES.ALREADY_REQUESTED);
    throw new ScheduleError('PICKUP_FAILED', cErr.message);
  }

  const i = inst as OfferableInstance;
  return { status: 'pending', claim_id: claim.id, shift_date: i.shift_date, starts_at: i.starts_at, ends_at: i.ends_at };
}

/** This viewer's live pickup requests, for the "Waiting for manager approval" state. */
export async function getMyPickupRequests(employee: Employee): Promise<
  { claim_id: string; shift_instance_id: string; shift_date: string; starts_at: string; ends_at: string }[]
> {
  const admin = createAdminClient();
  const { data: claims, error } = await admin
    .from('shift_claims')
    .select('id, shift_instance_id')
    .eq('user_id', employee.user_id)
    .eq('claimed_by', employee.id)
    .eq('kind', 'pickup_request')
    .eq('status', 'pending');
  if (error) throw new ScheduleError('READ_FAILED', error.message);
  const rows = claims ?? [];
  if (rows.length === 0) return [];

  const { data: insts } = await admin
    .from('shift_instances')
    .select('id, shift_date, starts_at, ends_at')
    .eq('user_id', employee.user_id)
    .in('id', rows.map((r) => r.shift_instance_id as string));
  const byId = new Map((insts ?? []).map((i) => [i.id as string, i]));
  return rows
    .map((r) => {
      const i = byId.get(r.shift_instance_id as string);
      return i
        ? { claim_id: r.id as string, shift_instance_id: i.id as string, shift_date: i.shift_date as string, starts_at: i.starts_at as string, ends_at: i.ends_at as string }
        : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

// ── Cancel Offer ──────────────────────────────────────────────────────────────────────────────

export const CANCEL_OFFER_MESSAGES: Record<string, string> = {
  SHIFT_NOT_FOUND: 'That shift no longer exists.',
  NOT_YOUR_SHIFT: 'That shift is not yours to cancel.',
  OFFER_NOT_OPEN: 'That shift is not currently offered.',
  ALREADY_TRANSFERRED: 'A manager already approved someone for this shift.',
  STALE_OFFER: 'This shift was re-offered — reload and try again.',
  OFFER_CHANGED: 'That offer changed while you were deciding — reload and try again.',
  CANCEL_FAILED: 'That offer could not be cancelled.',
};

export interface CancelOfferResult {
  status: 'cancelled';
  offer_id: string;
  /** pending pickup requests from this cycle that were closed. */
  superseded: number;
}

/**
 * CANCEL an offer the employee themselves opened — "actually, I'll keep it".
 *
 * The shift never stopped being theirs, so cancelling restores nothing: employee_id, status and
 * released_at are already correct and the RPC leaves all three untouched. What it does do is close
 * the cycle and supersede that cycle's pending requests, which must happen together — a closed
 * offer with live requests would keep the manager queue actionable for a shift nobody is offering,
 * and would leave the requester permanently unable to ask again after a re-offer (the pending
 * uniqueness index is keyed on the SHIFT, not the cycle).
 *
 * NO attendance event and NO payroll row: cancelling is the opposite of dropping.
 *
 * SECURITY: `employee` is resolved from the permanent token by the route — never from the request
 * body — and the RPC re-asserts it against the row's current owner, so a worker with a valid token
 * of their own still cannot cancel somebody else's offer.
 *
 * rpc-grants: lensed_cancel_shift_offer
 */
export async function cancelOffer(
  employee: Employee,
  instanceId: string,
  offerId: string,
): Promise<CancelOfferResult> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc('lensed_cancel_shift_offer', {
    p_owner: employee.user_id,
    p_employee_id: employee.id,
    p_shift_instance_id: instanceId,
    p_offer_id: offerId,
  });
  if (error) throw new ScheduleError('CANCEL_FAILED', error.message);

  const r = (data ?? {}) as { ok?: boolean; reason?: string; offer_state?: string; superseded?: number };
  if (!r.ok) {
    // An offer that is already 'transferred' is not a generic "not open" — the worker needs to know
    // the shift is gone, not that their tap missed.
    const reason =
      r.reason === 'OFFER_NOT_OPEN' && r.offer_state === 'transferred' ? 'ALREADY_TRANSFERRED' : (r.reason ?? 'CANCEL_FAILED');
    throw new ScheduleError(reason, CANCEL_OFFER_MESSAGES[reason] ?? CANCEL_OFFER_MESSAGES.CANCEL_FAILED);
  }
  return { status: 'cancelled', offer_id: offerId, superseded: r.superseded ?? 0 };
}
