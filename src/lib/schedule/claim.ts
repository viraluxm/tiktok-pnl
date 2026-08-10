import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { payPeriodStartFor } from '@/lib/employees';
import type { Employee } from '@/types';
import { laTodayISO } from './timezone';
import { NOTICE_MS } from './board';
import { weekBoundsMonSun, instanceHours } from './hours';
import { ScheduleError } from './release';
import { claimAutoApproves, OT_THRESHOLD_HOURS } from './otGate';
import { effectiveShiftRole } from './eligibility';

export { OT_THRESHOLD_HOURS };

export interface ClaimResult {
  result: 'claimed' | 'pending_approval';
  projected_week_hours: number;
}

// CLAIM a released shift (Part 4).
//
// CONCURRENCY (no-migration constraint): a fully-transactional SELECT … FOR UPDATE version would
// require a Postgres function = a migration, which is out of scope this deploy. Instead the claim
// is decided by an ATOMIC conditional UPDATE — `… WHERE id = $1 AND status = 'released'`. Exactly
// one concurrent claimer matches the row while it is still 'released'; the loser matches 0 rows
// and gets a clean "already claimed". This is NOT read-then-write: the status guard lives in the
// UPDATE's WHERE, evaluated atomically by Postgres. The follow-on shift_claims / attendance_events
// inserts happen AFTER the winning flip (a small non-atomic tail; acceptable for v1, and it would
// collapse into one transaction if/when the RPC is added).
//
// Overtime (projected week > 40h) is the ONLY human-approval path. Role and same-day conflict are
// re-verified here (defense-in-depth over the server-side board filter).
export async function claimShift(employee: Employee, instanceId: string): Promise<ClaimResult> {
  const admin = createAdminClient();

  const { data: inst, error } = await admin
    .from('shift_instances')
    .select('id, status, starts_at, ends_at, shift_date, user_id, released_by, source, role')
    .eq('id', instanceId)
    .maybeSingle();
  if (error) throw new ScheduleError('READ_FAILED', error.message);
  if (!inst) throw new ScheduleError('NOT_FOUND');
  if (inst.status !== 'released') throw new ScheduleError('ALREADY_CLAIMED');

  // Eligibility re-verify. Role comes from the RELEASER's employees.role for a released shift; for
  // an admin-posted open shift (released_by NULL, source 'admin_open') it comes from the row's own
  // `role` column (migration 090) — there's no releaser to derive it from.
  if (inst.released_by === employee.id) throw new ScheduleError('OWN_RELEASE');
  let releaserRole: string | null = null;
  if (inst.released_by) {
    const { data: releaser, error: relErr } = await admin
      .from('employees').select('role').eq('id', inst.released_by).maybeSingle();
    if (relErr) throw new ScheduleError('READ_FAILED', relErr.message);
    releaserRole = releaser?.role ?? null;
  }
  // Same role kernel the board uses (eligibility.ts): released → releaser's role; admin_open → the
  // row's own role; anything else → null (malformed released row, reject).
  const shiftRole = effectiveShiftRole(inst, releaserRole);
  if (shiftRole === null) throw new ScheduleError('NOT_FOUND');
  if (shiftRole !== employee.role) throw new ScheduleError('WRONG_ROLE');
  if (new Date(inst.starts_at).getTime() <= Date.now() + NOTICE_MS) {
    throw new ScheduleError('TOO_LATE', 'This shift starts within 24 hours — contact a manager directly.');
  }
  // No double-booking: the claimer must have no active instance that day.
  const { data: sameDay, error: sdErr } = await admin
    .from('shift_instances')
    .select('id')
    .eq('employee_id', employee.id)
    .eq('shift_date', inst.shift_date)
    .in('status', ['scheduled', 'claimed'])
    .limit(1);
  if (sdErr) throw new ScheduleError('READ_FAILED', sdErr.message);
  if ((sameDay ?? []).length > 0) throw new ScheduleError('ALREADY_WORKING_THAT_DAY');

  // Projected hours for the FLSA week containing this shift: the claimer's scheduled+claimed
  // instances in that Mon–Sun window, plus the shift being claimed.
  const week = weekBoundsMonSun(inst.shift_date);
  const { data: weekRows, error: wErr } = await admin
    .from('shift_instances')
    .select('starts_at, ends_at')
    .eq('employee_id', employee.id)
    .in('status', ['scheduled', 'claimed'])
    .gte('shift_date', week.start)
    .lte('shift_date', week.end);
  if (wErr) throw new ScheduleError('READ_FAILED', wErr.message);
  const existingHours = (weekRows ?? []).reduce((sum, r) => sum + instanceHours(r.starts_at, r.ends_at), 0);
  const claimHours = instanceHours(inst.starts_at, inst.ends_at);
  const projected = existingHours + claimHours;

  if (claimAutoApproves(projected)) {
    // AUTO-APPROVE: projected week <= 40h (40 is straight time, not OT). Atomic claim.
    const { data: won, error: uErr } = await admin
      .from('shift_instances')
      .update({ status: 'claimed', employee_id: employee.id, source: 'claim' })
      .eq('id', instanceId)
      .eq('status', 'released')
      .select('id, shift_date, user_id')
      .maybeSingle();
    if (uErr) throw new ScheduleError('CLAIM_FAILED', uErr.message);
    if (!won) throw new ScheduleError('ALREADY_CLAIMED'); // lost the race

    // BOOKKEEPING (post-flip, non-atomic tail). If either insert fails the instance is ALREADY
    // claimed, so log LOUDLY with the instance id — this is the money-adjacent silent-failure risk
    // (claimed shift with no offsetting event). The daily cron reconciliation (reconcile.ts) also
    // sweeps for exactly this drift, so a failure here is visible in two places.
    const { error: cErr } = await admin.from('shift_claims').insert({
      user_id: won.user_id,
      shift_instance_id: instanceId,
      claimed_by: employee.id,
      status: 'auto_approved',
      projected_week_hours: projected,
    });
    if (cErr) {
      console.error(`[schedule] CLAIM_RECORD_FAILED instance=${instanceId} employee=${employee.id}: ${cErr.message}`);
      throw new ScheduleError('CLAIM_RECORD_FAILED', cErr.message);
    }

    const { error: evErr } = await admin.from('attendance_events').insert({
      user_id: won.user_id,
      employee_id: employee.id,
      shift_instance_id: instanceId,
      shift_date: won.shift_date,
      event_type: 'claimed',
      pay_period_start: payPeriodStartFor(laTodayISO()),
    });
    if (evErr) {
      console.error(`[schedule] EVENT_WRITE_FAILED instance=${instanceId} employee=${employee.id}: ${evErr.message} (instance is CLAIMED but has no offsetting attendance_event)`);
      throw new ScheduleError('EVENT_WRITE_FAILED', evErr.message);
    }

    return { result: 'claimed', projected_week_hours: projected };
  }

  // OT PATH: record a PENDING claim for manager approval; the instance STAYS 'released' (still on
  // the board for others) and NO 'claimed' attendance_event is written yet — the claim isn't
  // effective, so it must not offset a drop. The claimed event + the instance flip happen on
  // approval (Part 7). This is a deliberate departure from the literal spec pseudocode, which
  // wrote the claimed event in both branches; writing it for an unapproved claim would corrupt
  // drop netting. Flagged in the Deploy B summary.
  const { error: pErr } = await admin.from('shift_claims').insert({
    user_id: inst.user_id,
    shift_instance_id: instanceId,
    claimed_by: employee.id,
    status: 'pending',
    projected_week_hours: projected,
  });
  if (pErr) throw new ScheduleError('CLAIM_RECORD_FAILED', pErr.message);

  // Alert the manager that an OT claim needs a decision — the queue is otherwise invisible.
  // Best-effort: never fail the claim on SMS trouble.
  try {
    await alertPendingClaim({ claimerName: employee.name, rate: employee.hourly_rate, projected, starts_at: inst.starts_at, ends_at: inst.ends_at, shift_date: inst.shift_date });
  } catch (e) {
    console.error('[schedule] pending-claim alert failed (claim still filed):', (e as Error).message);
  }

  return { result: 'pending_approval', projected_week_hours: projected };
}

// Manager SMS when an OT claim files as pending. Reuses the capture-health Twilio sender
// (src/lib/live/alertSms.ts). Goes to the manager (ALERT_SMS_TO), NOT employees — independent of
// employee phone numbers. Gated behind SMS_SEND_ENABLED (log-only until on), per the scheduling
// SMS convention. OT cost ≈ excess-over-40 × rate × 0.5 (base hours are already paid).
async function alertPendingClaim(a: {
  claimerName: string; rate: number; projected: number; starts_at: string; ends_at: string; shift_date: string;
}): Promise<void> {
  const { sendAlertSms } = await import('@/lib/live/alertSms');
  const { fmtDateLA, fmtTimeRangeLA } = await import('./format');
  const otHours = Math.max(0, a.projected - OT_THRESHOLD_HOURS);
  const otCost = otHours * a.rate * 0.5;
  const body =
    `OT claim needs approval: ${a.claimerName} — ${fmtDateLA(a.starts_at)}, ${fmtTimeRangeLA(a.starts_at, a.ends_at)}. ` +
    `Projected ${Math.round(a.projected * 10) / 10}h this week; ~$${otCost.toFixed(2)} OT premium. Approve/reject in the team tab.`;
  const recipient = process.env.ALERT_SMS_TO?.trim() || '';
  if (process.env.SMS_SEND_ENABLED === 'true' && recipient) {
    await sendAlertSms(recipient, body, 'pending_claim');
  } else {
    console.log(`[schedule] pending-claim alert LOG_ONLY to=${recipient || '(ALERT_SMS_TO unset)'} body=${JSON.stringify(body)}`);
  }
}
