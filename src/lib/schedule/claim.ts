import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { payPeriodStartFor } from '@/lib/employees';
import type { Employee } from '@/types';
import { laTodayISO } from './timezone';
import { NOTICE_MS } from './board';
import { weekBoundsMonSun, instanceHours } from './hours';
import { ScheduleError } from './release';
import { claimAutoApproves, OT_THRESHOLD_HOURS } from './otGate';

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

  // OWNER SCOPE. This runs service-role (RLS bypassed) from a PUBLIC tokenized route, and
  // instanceId is client-supplied — so the owner filter is the only thing binding the instance to
  // the caller's account. Without it a token holder who learned another owner's instance UUID
  // could claim it. release.ts gets this for free via `.eq('employee_id', employee.id)` (you can
  // only release your own); a claimer does not own the row yet, so it must be explicit here.
  const { data: inst, error } = await admin
    .from('shift_instances')
    .select('id, status, starts_at, ends_at, shift_date, user_id, released_by')
    .eq('id', instanceId)
    .eq('user_id', employee.user_id)
    .maybeSingle();
  if (error) throw new ScheduleError('READ_FAILED', error.message);
  if (!inst) throw new ScheduleError('NOT_FOUND');
  if (inst.status !== 'released') throw new ScheduleError('ALREADY_CLAIMED');
  if (!inst.released_by) throw new ScheduleError('NOT_FOUND'); // released row must carry its releaser

  // Eligibility re-verify. Role now comes from the RELEASER's employees.role (no template, 086).
  if (inst.released_by === employee.id) throw new ScheduleError('OWN_RELEASE');
  const { data: releaser, error: relErr } = await admin
    .from('employees')
    .select('role')
    .eq('id', inst.released_by)
    .eq('user_id', employee.user_id)   // same owner scope as the instance read above
    .maybeSingle();
  if (relErr) throw new ScheduleError('READ_FAILED', relErr.message);
  if (!releaser || releaser.role !== employee.role) throw new ScheduleError('WRONG_ROLE');
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
    // THE RACE GUARD. `.eq('status','released')` lives HERE, in the UPDATE's WHERE, evaluated
    // atomically by Postgres — the status check at the top of this function is a fast-path for
    // messaging ONLY and must never be treated as the guard. Exactly one concurrent claimer
    // matches while the row is still 'released'; every loser matches 0 rows.
    //   • .is('employee_id', null) — second guard. release.ts nulls employee_id when it releases,
    //     so a genuinely-released row always has NULL here; this catches any future path that
    //     flips status without clearing the owner.
    //   • .eq('user_id', …) — owner scope, mirroring the read above.
    //   • .select() is REQUIRED: without it there is no row count, so the loser is undetectable.
    //   • .maybeSingle(), never .single() — single() throws on 0 rows, turning a clean
    //     ALREADY_CLAIMED (409) into an opaque 500.
    //   • Chained .eq()/.is() ONLY. NEVER .or() on an update: PostgREST rejects it (42703/400)
    //     and the thrown error gets swallowed as a false "lost race" — the same failure mode that
    //     silently killed TikTok token refresh for three weeks.
    const { data: won, error: uErr } = await admin
      .from('shift_instances')
      .update({ status: 'claimed', employee_id: employee.id, source: 'claim' })
      .eq('id', instanceId)
      .eq('user_id', employee.user_id)
      .eq('status', 'released')
      .is('employee_id', null)
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
  // DUPLICATE-PENDING GUARD. shift_claims has NO unique constraint (085 defines only a status
  // CHECK and a partial index), and this insert is unconditional, so a double-tap or a second
  // device files two identical 'pending' rows and a manager sees the same request twice.
  //
  // Keyed on (instance, claimer) — NOT on the instance alone. Two DIFFERENT employees each filing
  // a pending OT claim on the same released shift is legitimate; the manager picks between them.
  //
  // Honest limit: check-then-insert is NOT atomic. It closes the realistic case (a repeat tap, a
  // revisit, a second tab) but two truly simultaneous submits can still both pass.
  // TODO: the correct fix is a partial unique index on shift_claims —
  //   `unique (shift_instance_id, claimed_by) where status = 'pending'`
  // Add it the next time that schema is touched; this read then becomes belt-and-braces.
  const { data: dupe, error: dErr } = await admin
    .from('shift_claims')
    .select('id')
    .eq('user_id', inst.user_id)
    .eq('shift_instance_id', instanceId)
    .eq('claimed_by', employee.id)
    .eq('status', 'pending')
    .limit(1);
  if (dErr) throw new ScheduleError('READ_FAILED', dErr.message);
  if ((dupe ?? []).length > 0) {
    // Idempotent: this claimer's request is already queued. Return the SAME shape rather than an
    // error — nothing changed, and the UI should show the same "not yours yet" message.
    return { result: 'pending_approval', projected_week_hours: projected };
  }

  const { error: pErr } = await admin.from('shift_claims').insert({
    user_id: inst.user_id,
    shift_instance_id: instanceId,
    claimed_by: employee.id,
    status: 'pending',
    projected_week_hours: projected,
  });
  if (pErr) throw new ScheduleError('CLAIM_RECORD_FAILED', pErr.message);

  return { result: 'pending_approval', projected_week_hours: projected };
}
