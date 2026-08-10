import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { payPeriodStartFor } from '@/lib/employees';
import { laWallTimeToUtc, addDaysISO, laTodayISO } from './timezone';
import { ScheduleError } from './release';
import { planAdminShift, crossesMidnight } from './eligibility';

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
  let employeeRole: string | null = null;
  let storeId: string | null = null;
  if (input.employeeId) {
    const { data: emp, error } = await admin
      .from('employees').select('id, role, store_id').eq('id', input.employeeId).maybeSingle();
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

export interface PendingClaimRow {
  claim_id: string;
  claimer_name: string;
  shift_date: string;
  starts_at: string;
  ends_at: string;
  projected_week_hours: number | null;
  instance_status: string;
}

export async function listPendingClaims(): Promise<PendingClaimRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('shift_claims')
    .select('id, claimed_by, projected_week_hours, shift_instance_id, status')
    .eq('status', 'pending')
    .order('claimed_at', { ascending: true });
  if (error) throw new ScheduleError('READ_FAILED', error.message);
  const claims = data ?? [];
  if (claims.length === 0) return [];

  const instIds = [...new Set(claims.map((c) => c.shift_instance_id))];
  const empIds = [...new Set(claims.map((c) => c.claimed_by))];
  const [insts, emps] = await Promise.all([
    admin.from('shift_instances').select('id, shift_date, starts_at, ends_at, status').in('id', instIds),
    admin.from('employees').select('id, name').in('id', empIds),
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
export async function approveClaim(claimId: string, approverId: string): Promise<void> {
  const admin = createAdminClient();
  const { data: claim, error } = await admin
    .from('shift_claims')
    .select('id, shift_instance_id, claimed_by, status, user_id')
    .eq('id', claimId)
    .maybeSingle();
  if (error) throw new ScheduleError('READ_FAILED', error.message);
  if (!claim) throw new ScheduleError('NOT_FOUND');
  if (claim.status !== 'pending') throw new ScheduleError('NOT_PENDING');

  const { data: won, error: uErr } = await admin
    .from('shift_instances')
    .update({ status: 'claimed', employee_id: claim.claimed_by, source: 'claim' })
    .eq('id', claim.shift_instance_id)
    .eq('status', 'released')
    .select('id, shift_date, user_id')
    .maybeSingle();
  if (uErr) throw new ScheduleError('APPROVE_FAILED', uErr.message);
  if (!won) throw new ScheduleError('SHIFT_UNAVAILABLE', 'That shift is no longer on the board — it was taken or changed.');

  const { error: cErr } = await admin
    .from('shift_claims')
    .update({ status: 'approved', approved_by: approverId, approved_at: new Date().toISOString() })
    .eq('id', claimId);
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

  await notifyClaimer(claim.claimed_by, claim.shift_instance_id, 'approved');
}

// REJECT: mark the claim rejected, leave the instance 'released' so someone else can take it, and
// tell the claimer.
export async function rejectClaim(claimId: string, approverId: string): Promise<void> {
  const admin = createAdminClient();
  const { data: claim, error } = await admin
    .from('shift_claims')
    .select('id, claimed_by, shift_instance_id, status')
    .eq('id', claimId)
    .maybeSingle();
  if (error) throw new ScheduleError('READ_FAILED', error.message);
  if (!claim) throw new ScheduleError('NOT_FOUND');
  if (claim.status !== 'pending') throw new ScheduleError('NOT_PENDING');

  const { error: uErr } = await admin
    .from('shift_claims')
    .update({ status: 'rejected', approved_by: approverId, approved_at: new Date().toISOString() })
    .eq('id', claimId);
  if (uErr) throw new ScheduleError('REJECT_FAILED', uErr.message);
  // Instance intentionally left 'released' — back on the board for someone else.
  await notifyClaimer(claim.claimed_by, claim.shift_instance_id, 'rejected');
}

// Best-effort claimer SMS (log-only until SMS_SEND_ENABLED). Never throws into the admin action.
async function notifyClaimer(employeeId: string, instanceId: string, outcome: 'approved' | 'rejected'): Promise<void> {
  try {
    const admin = createAdminClient();
    const [{ data: emp }, { data: inst }] = await Promise.all([
      admin.from('employees').select('phone').eq('id', employeeId).maybeSingle(),
      admin.from('shift_instances').select('starts_at, ends_at').eq('id', instanceId).maybeSingle(),
    ]);
    if (!emp?.phone || !inst) return;
    const { sendSms, claimApprovedMessage, tokenLink } = await import('./sms');
    const { fmtDateLA, fmtTimeRangeLA } = await import('./format');
    const { data: tok } = await admin
      .from('employee_access_tokens').select('token').eq('employee_id', employeeId).eq('active', true).limit(1).maybeSingle();
    const link = tok?.token ? tokenLink(tok.token) : '';
    const body = outcome === 'approved'
      ? claimApprovedMessage({ starts_at: inst.starts_at, ends_at: inst.ends_at }, link)
      : `Your claim for ${fmtDateLA(inst.starts_at)}, ${fmtTimeRangeLA(inst.starts_at, inst.ends_at)} wasn't approved — it's back on the board. ${link}`;
    await sendSms(emp.phone, body, `claim_${outcome}`);
  } catch (e) {
    console.error(`[schedule] notifyClaimer(${outcome}) failed:`, (e as Error).message);
  }
}
