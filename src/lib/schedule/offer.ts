import 'server-only';
import { randomUUID } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { payPeriodStartFor } from '@/lib/employees';
import type { Employee } from '@/types';
import { laTodayISO } from './timezone';
import { ScheduleError } from './release';
import {
  planDrop, planPickup, buildAvailableShifts, DROP_REFUSAL_MESSAGES, PICKUP_REFUSAL_MESSAGES,
  type OfferableInstance, type AvailableShift,
} from './offerPlan';

// Phase 2 offer lifecycle — the DB-bound half of Drop Shift / Available Shifts / Pick Up Shift.
//
// Writes ONLY shift_instances (the offer marker) and shift_claims (the pickup request), plus the
// same attendance_events trail the legacy release path writes so drop counting keeps working.
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

  // Drop counting. The same 'released' event the legacy path writes, so computeDrops() keeps
  // working unchanged and an offer still counts toward the cap the UI warns about. pay_period_start
  // keys on the ACTION time, matching release.ts, so an offer and an offsetting pickup net out in
  // the same period. Best-effort: the offer itself already succeeded and must not be undone by a
  // bookkeeping failure, so this logs loudly rather than throwing.
  const { error: evErr } = await admin.from('attendance_events').insert({
    user_id: employee.user_id,
    employee_id: employee.id,
    shift_instance_id: instanceId,
    shift_date: updated.shift_date,
    event_type: 'released',
    pay_period_start: payPeriodStartFor(laTodayISO(now)),
  });
  if (evErr) {
    console.error(`[schedule] OFFER_EVENT_FAILED instance=${instanceId} employee=${employee.id}: ${evErr.message} (shift IS offered but has no attendance_event)`);
  }

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
