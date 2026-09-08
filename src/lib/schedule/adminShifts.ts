import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { payPeriodStartFor } from '@/lib/employees';
import { laWallTimeToUtc, addDaysISO, laTodayISO } from './timezone';
import { ScheduleError } from './release';
import { planAdminShift, crossesMidnight, planShiftRemoval, SHIFT_REMOVAL_MESSAGES } from './eligibility';

// Admin one-time shifts (migration 090) + OT-claim approve/reject. Server-side; the routes gate on
// app_metadata.role === 'admin'. Nothing here is payable — shift_instances never feed pay.

export interface PostShiftInput {
  userId: string; // owning account (auth uid of the admin)
  date: string; // 'YYYY-MM-DD' LA-local
  startTime: string; // 'HH:MM'
  endTime: string; // 'HH:MM'
  role: string | null; // required when unassigned; ignored when assigned (derived from employee)
  employeeId: string | null; // null → unassigned (board); set → assigned to that person
  note: string | null;
}

// Create a one-time shift_instance. Assigned → status 'scheduled' (shows on the person's /s under
// Your Shifts; releasable like any shift). Unassigned → status 'released', straight to the board.
// Both source='admin_open', shift_rule_id NULL — the forward materializer never touches them.
export async function postOneTimeShift(input: PostShiftInput): Promise<{ id: string }> {
  const admin = createAdminClient();

  // Assigned → look up the employee (role is authoritative from them; typed role is ignored).
  //
  // OWNER SCOPE. createAdminClient() bypasses RLS, so the `user_id` filter is the only thing
  // binding the employee to the calling admin's account: without it, an admin could post a shift
  // onto another owner's employee (the row would carry OUR user_id but THEIR employee_id, and would
  // surface on that employee's /s page). Matches the bulk route's employees read.
  let employeeRole: string | null = null;
  let storeId: string | null = null;
  if (input.employeeId) {
    const { data: emp, error } = await admin
      .from('employees').select('id, role, store_id')
      .eq('id', input.employeeId)
      .eq('user_id', input.userId)
      .maybeSingle();
    if (error) throw new ScheduleError('READ_FAILED', error.message);
    if (!emp) throw new ScheduleError('EMPLOYEE_NOT_FOUND');
    employeeRole = emp.role;
    storeId = emp.store_id ?? null;
  }

  // Status + role decision (pure kernel — see eligibility.ts). Unassigned with no valid role fails
  // here, which is where migration 090's "unassigned ⇒ role required" invariant is enforced.
  const plan = planAdminShift({ employeeRole, role: input.role });
  if (!plan.ok) {
    throw new ScheduleError('ROLE_REQUIRED', 'An unassigned open shift must specify a role (host or fulfillment).');
  }

  if (input.startTime === input.endTime) throw new ScheduleError('BAD_TIMES', 'Start and end cannot be equal.');
  const endDate = crossesMidnight(input.startTime, input.endTime) ? addDaysISO(input.date, 1) : input.date;

  const { data, error } = await admin
    .from('shift_instances')
    .insert({
      user_id: input.userId,
      employee_id: input.employeeId,
      shift_rule_id: null,
      store_id: storeId,
      shift_date: input.date,
      starts_at: laWallTimeToUtc(input.date, input.startTime).toISOString(),
      ends_at: laWallTimeToUtc(endDate, input.endTime).toISOString(),
      status: plan.status,
      source: 'admin_open',
      released_by: null,
      role: plan.role,
      note: input.note ?? null,
    })
    .select('id')
    .single();
  if (error) throw new ScheduleError('POST_FAILED', error.message);
  return { id: data.id };
}

// REMOVE a one-time admin shift (Remove Shift, MVP). Hard-deletes exactly ONE `shift_instances`
// row and nothing else. It never touches `shifts`, `employee_time_entries`, `attendance_events`,
// `clock_audit` or `shift_claims` — the scheduling/payroll table separation IS the safety boundary
// here, so this function deliberately has no other delete target.
//
// Eligibility is decided by planShiftRemoval() (pure, unit-tested) from facts read here. The button
// in the calendar is not a security boundary: every condition is re-checked server-side, and the
// final DELETE re-asserts the two mutable ones (source, status) as predicates so a row that changed
// between the read and the write is left alone instead of destroyed.
//
// SCOPING: createAdminClient() bypasses RLS, so `user_id` is written into every query explicitly
// rather than relied upon — the same discipline the rest of this module uses.
export async function removeOneTimeShift(input: { userId: string; instanceId: string }): Promise<void> {
  const admin = createAdminClient();

  const { data: inst, error } = await admin
    .from('shift_instances')
    .select('id, employee_id, shift_date, starts_at, status, source')
    .eq('id', input.instanceId)
    .eq('user_id', input.userId)
    .maybeSingle();
  if (error) throw new ScheduleError('READ_FAILED', error.message);
  if (!inst) throw new ScheduleError('NOT_FOUND', 'That shift no longer exists.');

  // Payroll-side facts. An UNASSIGNED admin shift (employee_id NULL) is posted straight to the
  // board as 'released', so it can never reach the 'scheduled' branch below — but guard anyway
  // rather than querying on a null key.
  let hasOpenPunch = false;
  let hasWorkedShift = false;
  if (inst.employee_id) {
    const [openPunch, worked] = await Promise.all([
      admin
        .from('employee_time_entries')
        .select('id')
        .eq('employee_id', inst.employee_id)
        .eq('user_id', input.userId)
        .is('clocked_out_at', null)
        .limit(1)
        .maybeSingle(),
      // `shifts.date` and `shift_instances.shift_date` are both LA-local calendar dates, so this
      // is a direct comparison — the same (employee, date) key the calendar pairs plan to punch on.
      admin
        .from('shifts')
        .select('id')
        .eq('employee_id', inst.employee_id)
        .eq('user_id', input.userId)
        .eq('date', inst.shift_date)
        .limit(1)
        .maybeSingle(),
    ]);
    if (openPunch.error) throw new ScheduleError('READ_FAILED', openPunch.error.message);
    if (worked.error) throw new ScheduleError('READ_FAILED', worked.error.message);
    hasOpenPunch = !!openPunch.data;
    hasWorkedShift = !!worked.data;
  }

  const plan = planShiftRemoval({
    source: inst.source,
    status: inst.status,
    startsAtMs: Date.parse(inst.starts_at),
    nowMs: Date.now(),
    hasWorkedShift,
    hasOpenPunch,
  });
  if (!plan.ok) throw new ScheduleError(plan.code, SHIFT_REMOVAL_MESSAGES[plan.code]);

  // Conditional delete: the predicates repeat the two fields that can change under us. A shift
  // released or claimed between the read and here matches 0 rows and is reported, not deleted.
  const { data: deleted, error: dErr } = await admin
    .from('shift_instances')
    .delete()
    .eq('id', input.instanceId)
    .eq('user_id', input.userId)
    .eq('source', 'admin_open')
    .eq('status', 'scheduled')
    .select('id');
  if (dErr) throw new ScheduleError('REMOVE_FAILED', dErr.message);
  if (!deleted || deleted.length === 0) {
    throw new ScheduleError('SHIFT_UNAVAILABLE', 'This shift is no longer available.');
  }
}

export interface PendingClaimRow {
  claim_id: string;
  claimer_name: string;
  shift_date: string;
  starts_at: string;
  ends_at: string;
  projected_week_hours: number | null;
  instance_status: string;
}

// TENANT BOUNDARY: `ownerId` is the acting manager's auth uid, taken from the session by the route
// and never from client input. createAdminClient() bypasses RLS, so these explicit user_id filters
// ARE the boundary — without them this listed every account's pending claims and rendered other
// businesses' employee names.
export async function listPendingClaims(ownerId: string): Promise<PendingClaimRow[]> {
  if (!ownerId) throw new ScheduleError('OWNER_REQUIRED', 'Owner scope is required.');
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('shift_claims')
    .select('id, claimed_by, projected_week_hours, shift_instance_id, status')
    .eq('user_id', ownerId)
    .eq('status', 'pending')
    .order('claimed_at', { ascending: true });
  if (error) throw new ScheduleError('READ_FAILED', error.message);
  const claims = data ?? [];
  if (claims.length === 0) return [];

  // The two hydration reads are scoped too. shift_claims.user_id is denormalised at insert, so the
  // instance read re-asserts ownership against the authority; a claim whose instance belongs to
  // another owner hydrates to nothing rather than leaking its date, times or the claimer's name.
  const instIds = [...new Set(claims.map((c) => c.shift_instance_id))];
  const empIds = [...new Set(claims.map((c) => c.claimed_by))];
  const [insts, emps] = await Promise.all([
    admin.from('shift_instances').select('id, shift_date, starts_at, ends_at, status').eq('user_id', ownerId).in('id', instIds),
    admin.from('employees').select('id, name').eq('user_id', ownerId).in('id', empIds),
  ]);
  const instById = new Map((insts.data ?? []).map((i) => [i.id, i]));
  const nameById = new Map((emps.data ?? []).map((e) => [e.id, e.name]));
  return claims.map((c) => {
    const i = instById.get(c.shift_instance_id);
    return {
      claim_id: c.id,
      claimer_name: nameById.get(c.claimed_by) ?? 'Unknown',
      shift_date: i?.shift_date ?? '',
      starts_at: i?.starts_at ?? '',
      ends_at: i?.ends_at ?? '',
      projected_week_hours: c.projected_week_hours,
      instance_status: i?.status ?? 'unknown',
    };
  });
}

// APPROVE: assign the instance to the claimer (atomic conditional flip) and write the withheld
// 'claimed' attendance_event. If the instance is no longer 'released' (taken/changed), fail loudly
// and leave the claim pending for the admin to see.
// `approverId` is BOTH the acting manager's auth uid and the owning account — an admin session is
// the account. It is used for scope, not only for the approved_by stamp it previously carried.
export async function approveClaim(claimId: string, approverId: string): Promise<void> {
  if (!approverId) throw new ScheduleError('OWNER_REQUIRED', 'Owner scope is required.');
  const ownerId = approverId;
  const admin = createAdminClient();
  const { data: claim, error } = await admin
    .from('shift_claims')
    .select('id, shift_instance_id, claimed_by, status, user_id')
    .eq('id', claimId)
    .eq('user_id', ownerId)
    .maybeSingle();
  if (error) throw new ScheduleError('READ_FAILED', error.message);
  // A foreign claim is indistinguishable from a missing one — the manager learns nothing about
  // another account's data from the response.
  if (!claim) throw new ScheduleError('NOT_FOUND');
  if (claim.status !== 'pending') throw new ScheduleError('NOT_PENDING');

  // `released_at: null` — see the identical note in claim.ts. Without it the approved claimer can
  // never clock in, because every clock gate rejects a non-null released_at regardless of status.
  // released_by is kept as the audit record of who dropped the shift.
  //
  // `.eq('user_id', ownerId)` proves the OWNERSHIP CHAIN the claim row alone cannot: shift_claim →
  // shift_instance → user_id must equal the acting manager. The claim read above is already scoped,
  // but shift_claims.user_id is denormalised at insert; the instance is the authority, so the flip
  // re-asserts it. A foreign instance matches 0 rows and nothing mutates.
  const { data: won, error: uErr } = await admin
    .from('shift_instances')
    .update({ status: 'claimed', employee_id: claim.claimed_by, source: 'claim', released_at: null })
    .eq('id', claim.shift_instance_id)
    .eq('user_id', ownerId)
    .eq('status', 'released')
    .select('id, shift_date, user_id')
    .maybeSingle();
  if (uErr) throw new ScheduleError('APPROVE_FAILED', uErr.message);
  if (!won) throw new ScheduleError('SHIFT_UNAVAILABLE', 'That shift is no longer on the board — it was taken or changed.');

  const { error: cErr } = await admin
    .from('shift_claims')
    .update({ status: 'approved', approved_by: approverId, approved_at: new Date().toISOString() })
    .eq('id', claimId)
    .eq('user_id', ownerId);
  if (cErr) {
    console.error(`[schedule] APPROVE claim record failed claim=${claimId}: ${cErr.message}`);
    throw new ScheduleError('APPROVE_RECORD_FAILED', cErr.message);
  }

  const { error: evErr } = await admin.from('attendance_events').insert({
    user_id: won.user_id,
    employee_id: claim.claimed_by,
    shift_instance_id: claim.shift_instance_id,
    shift_date: won.shift_date,
    event_type: 'claimed',
    pay_period_start: payPeriodStartFor(laTodayISO()),
  });
  if (evErr) {
    console.error(`[schedule] APPROVE event failed instance=${claim.shift_instance_id}: ${evErr.message} (instance CLAIMED but no offsetting event)`);
    throw new ScheduleError('EVENT_WRITE_FAILED', evErr.message);
  }

  await notifyClaimer(ownerId, claim.claimed_by, claim.shift_instance_id, 'approved');
}

// REJECT: mark the claim rejected, leave the instance 'released' so someone else can take it, and
// tell the claimer.
export async function rejectClaim(claimId: string, approverId: string): Promise<void> {
  if (!approverId) throw new ScheduleError('OWNER_REQUIRED', 'Owner scope is required.');
  const ownerId = approverId;
  const admin = createAdminClient();
  const { data: claim, error } = await admin
    .from('shift_claims')
    .select('id, claimed_by, shift_instance_id, status')
    .eq('id', claimId)
    .eq('user_id', ownerId)
    .maybeSingle();
  if (error) throw new ScheduleError('READ_FAILED', error.message);
  if (!claim) throw new ScheduleError('NOT_FOUND');
  if (claim.status !== 'pending') throw new ScheduleError('NOT_PENDING');

  // Reject writes no instance row, so unlike approve there is no flip to carry the ownership
  // re-assertion. Prove the chain explicitly instead: shift_claim → shift_instance → user_id.
  // shift_claims.user_id is denormalised at insert; the instance is the authority.
  const { data: inst, error: iErr } = await admin
    .from('shift_instances')
    .select('id')
    .eq('id', claim.shift_instance_id)
    .eq('user_id', ownerId)
    .maybeSingle();
  if (iErr) throw new ScheduleError('READ_FAILED', iErr.message);
  if (!inst) throw new ScheduleError('NOT_FOUND');

  const { error: uErr } = await admin
    .from('shift_claims')
    .update({ status: 'rejected', approved_by: approverId, approved_at: new Date().toISOString() })
    .eq('id', claimId)
    .eq('user_id', ownerId);
  if (uErr) throw new ScheduleError('REJECT_FAILED', uErr.message);
  // Instance intentionally left 'released' — back on the board for someone else.
  await notifyClaimer(ownerId, claim.claimed_by, claim.shift_instance_id, 'rejected');
}

// Best-effort claimer SMS (log-only until SMS_SEND_ENABLED). Never throws into the admin action.
// `ownerId` is threaded in so the three reads below are owner-scoped. This helper reads a phone
// number and an ACCESS TOKEN — a bearer credential — so it must never be able to address another
// account's rows, even though its callers only ever pass ids they have already owner-verified.
async function notifyClaimer(ownerId: string, employeeId: string, instanceId: string, outcome: 'approved' | 'rejected'): Promise<void> {
  try {
    const admin = createAdminClient();
    const [{ data: emp }, { data: inst }] = await Promise.all([
      admin.from('employees').select('phone').eq('id', employeeId).eq('user_id', ownerId).maybeSingle(),
      admin.from('shift_instances').select('starts_at, ends_at').eq('id', instanceId).eq('user_id', ownerId).maybeSingle(),
    ]);
    if (!emp?.phone || !inst) return;
    const { sendSms, claimApprovedMessage, tokenLink } = await import('./sms');
    const { fmtDateLA, fmtTimeRangeLA } = await import('./format');
    const { data: tok } = await admin
      .from('employee_access_tokens').select('token').eq('employee_id', employeeId).eq('user_id', ownerId).eq('active', true).limit(1).maybeSingle();
    const link = tok?.token ? tokenLink(tok.token) : '';
    const body = outcome === 'approved'
      ? claimApprovedMessage({ starts_at: inst.starts_at, ends_at: inst.ends_at }, link)
      : `Your claim for ${fmtDateLA(inst.starts_at)}, ${fmtTimeRangeLA(inst.starts_at, inst.ends_at)} wasn't approved — it's back on the board. ${link}`;
    await sendSms(emp.phone, body, `claim_${outcome}`);
  } catch (e) {
    console.error(`[schedule] notifyClaimer(${outcome}) failed:`, (e as Error).message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// PHASE 2 — SHIFT PICKUP REQUESTS (migration 129)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// These are DISTINCT from the legacy OT claim flow above and never share a query with it: every
// statement filters kind='pickup_request'. The two coexist in shift_claims because a manager wants
// one queue, not because they behave alike.

export interface PickupRequestRow {
  claim_id: string;
  shift_instance_id: string;
  offer_id: string;
  shift_date: string;
  starts_at: string;
  ends_at: string;
  /** who dropped it — still the assigned, responsible employee until this is approved */
  offered_by_name: string;
  requester_name: string;
  requested_at: string;
}

/** Pending pickup requests for ONE owner. Owner-scoped in every query, per the #217 discipline. */
export async function listPickupRequests(ownerId: string): Promise<PickupRequestRow[]> {
  const admin = createAdminClient();
  const { data: claims, error } = await admin
    .from('shift_claims')
    .select('id, shift_instance_id, claimed_by, claimed_at, offer_id')
    .eq('user_id', ownerId)
    .eq('kind', 'pickup_request')
    .eq('status', 'pending')
    .order('claimed_at', { ascending: true });
  if (error) throw new ScheduleError('READ_FAILED', error.message);
  const rows = claims ?? [];
  if (rows.length === 0) return [];

  const instIds = [...new Set(rows.map((r) => r.shift_instance_id as string))];
  const { data: insts } = await admin
    .from('shift_instances')
    .select('id, shift_date, starts_at, ends_at, employee_id, offer_id, offer_state')
    .eq('user_id', ownerId)
    .in('id', instIds);
  const instById = new Map((insts ?? []).map((i) => [i.id as string, i]));

  const empIds = [
    ...new Set([
      ...rows.map((r) => r.claimed_by as string),
      ...(insts ?? []).map((i) => i.employee_id as string).filter(Boolean),
    ]),
  ];
  const { data: emps } = await admin
    .from('employees')
    .select('id, name')
    .eq('user_id', ownerId)
    .in('id', empIds);
  const nameById = new Map((emps ?? []).map((e) => [e.id as string, e.name as string]));

  return rows
    .map((r) => {
      const i = instById.get(r.shift_instance_id as string);
      // Drop rows whose offer cycle has moved on — a stale request is not actionable and showing it
      // would invite a manager to approve something the RPC would refuse anyway.
      if (!i || i.offer_state !== 'offered' || i.offer_id !== r.offer_id) return null;
      return {
        claim_id: r.id as string,
        shift_instance_id: i.id as string,
        offer_id: r.offer_id as string,
        shift_date: i.shift_date as string,
        starts_at: i.starts_at as string,
        ends_at: i.ends_at as string,
        offered_by_name: nameById.get(i.employee_id as string) ?? 'Unknown',
        requester_name: nameById.get(r.claimed_by as string) ?? 'Unknown',
        requested_at: r.claimed_at as string,
      };
    })
    .filter((x): x is PickupRequestRow => x !== null);
}

/**
 * APPROVE a pickup — the assignment transfer.
 *
 * Delegates the whole multi-row change to lensed_approve_shift_pickup (migration 129, extended by
 * 130) because it must be atomic: the winning claim, every rival claim, the assignment, the offer's
 * terminal state AND the attendance pair all move together or not at all. Doing it as separate
 * PostgREST writes permits exactly the half-states the product must never show — a claim approved
 * with the assignment unmoved, or an assignment moved with rivals still pending and
 * un-reapprovable because the CAS pre-state is gone.
 *
 * ATTENDANCE (migration 130): the transfer is the ONLY moment drop bookkeeping happens. Offering a
 * shift writes nothing. `pay_period_start` is computed HERE, not in SQL, because the biweekly
 * PAY_ANCHOR arithmetic lives only in src/lib/employees.ts — forking it into PL/pgSQL would let
 * drops silently land in the wrong period. That is why the RPC takes a 5th argument.
 *
 * The RPC returns {ok:false, reason} for a refusal rather than raising, so a stale or already-taken
 * offer reaches the manager as a sentence instead of a 500.
 * rpc-grants: lensed_approve_shift_pickup
 */
const PICKUP_APPROVE_MESSAGES: Record<string, string> = {
  CLAIM_NOT_FOUND: 'That pickup request no longer exists.',
  CLAIM_NOT_PENDING: 'That request is no longer open — someone else was approved, or the employee cancelled the offer.',
  ALREADY_APPROVED: 'That request was already approved.',
  SHIFT_NOT_FOUND: 'That shift no longer exists.',
  OFFER_NOT_OPEN: 'This shift is no longer being offered — it was cancelled or already taken.',
  STALE_OFFER: 'This shift was re-offered — reload the queue.',
  OFFER_CHANGED: 'This shift changed while you were deciding — reload the queue.',
  SHIFT_UNOWNED: 'That shift has no assigned employee.',
  ALREADY_ASSIGNED: 'That employee already has this shift.',
  EMPLOYEE_UNAVAILABLE: 'That employee is no longer active.',
  EMPLOYEE_DOUBLE_BOOKED: 'That employee is already scheduled that day.',
};

export async function approvePickup(input: {
  ownerId: string;
  claimId: string;
  shiftInstanceId: string;
  offerId: string;
}): Promise<{ shift_instance_id: string; employee_id: string; superseded: number; attendance_events: number }> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc('lensed_approve_shift_pickup', {
    p_owner: input.ownerId,
    p_shift_instance_id: input.shiftInstanceId,
    p_claim_id: input.claimId,
    p_offer_id: input.offerId,
    // ACTION time, matching release.ts and claim.ts, so a drop and its offsetting pickup net out
    // in the same period.
    p_pay_period_start: payPeriodStartFor(laTodayISO()),
  });
  if (error) throw new ScheduleError('APPROVE_FAILED', error.message);
  const r = (data ?? {}) as {
    ok?: boolean; reason?: string; employee_id?: string; superseded?: number; attendance_events?: number;
  };
  if (!r.ok) {
    const reason = r.reason ?? 'APPROVE_FAILED';
    throw new ScheduleError(reason, PICKUP_APPROVE_MESSAGES[reason] ?? 'That pickup could not be approved.');
  }
  return {
    shift_instance_id: input.shiftInstanceId,
    employee_id: r.employee_id as string,
    superseded: r.superseded ?? 0,
    attendance_events: r.attendance_events ?? 0,
  };
}

/**
 * DECLINE one pickup request. Assignment is untouched, the offer stays OPEN, and other pending
 * requests are untouched — declining one person is not withdrawing the shift. Only this claim moves
 * pending → rejected, and only if it is still pending and still belongs to this owner.
 */
export async function declinePickup(input: { ownerId: string; claimId: string }): Promise<void> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('shift_claims')
    .update({ status: 'rejected', approved_by: input.ownerId, approved_at: new Date().toISOString() })
    .eq('id', input.claimId)
    .eq('user_id', input.ownerId)
    .eq('kind', 'pickup_request')
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (error) throw new ScheduleError('DECLINE_FAILED', error.message);
  if (!data) throw new ScheduleError('NOT_PENDING', 'That request has already been decided.');
}
