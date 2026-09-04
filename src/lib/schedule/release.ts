import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { payPeriodStartFor } from '@/lib/employees';
import type { Employee } from '@/types';
import { laTodayISO } from './timezone';
import { NOTICE_MS } from './board';
import { computeDrops, DROP_CAP } from './drops';

export class ScheduleError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

export interface ReleaseResult {
  status: 'released';
  shift_date: string;
  starts_at: string;
  ends_at: string;
  store_id: string | null;
}

// RELEASE a scheduled shift the employee can't work (Part 3). The status flip is an ATOMIC
// conditional UPDATE guarded on (employee_id = caller AND status = 'scheduled'): only the owner
// can release, and a double-submit / already-released row matches 0 rows and is reported cleanly.
// (A fully-transactional FOR UPDATE version would need a Postgres RPC = a migration, which is out
// of scope this deploy — see the note in claim.ts. The conditional UPDATE is the atomic equivalent
// for the state flip; the follow-on attendance_events insert is best-effort after it.)
//
// Both guards are enforced server-side regardless of what the UI showed.
//
// DROP CAP. This previously did NOT block, on the reasoning that refusing a release just produces
// a no-show, which is worse. That reasoning holds against a HARD block — so this is not one. Past
// the cap the release is REFUSED TO A HUMAN, exactly like the 24h rule: the worker is told to
// contact a manager, who can release it for them or mark it excused (an excused release leaves the
// drop count entirely — see drops.ts). Nobody is left with no route, and the cap stops being a
// number that only ever printed a warning while the release went through anyway.
//
// REASON. Required, and stored on the attendance event. It is the record a write-up would rest on,
// and being asked to type one is most of the friction that makes a drop deliberate.
export async function releaseShift(
  employee: Employee,
  instanceId: string,
  reason: string,
): Promise<ReleaseResult> {
  const admin = createAdminClient();

  const trimmedReason = reason.trim();
  if (!trimmedReason) {
    throw new ScheduleError('REASON_REQUIRED', 'Tell us why you cannot work this shift.');
  }

  // Read to validate ownership + timing and to carry shift facts into the event + broadcast.
  const { data: inst, error } = await admin
    .from('shift_instances')
    .select('id, employee_id, status, starts_at, ends_at, shift_date, store_id, user_id')
    .eq('id', instanceId)
    .maybeSingle();
  if (error) throw new ScheduleError('READ_FAILED', error.message);
  if (!inst || inst.employee_id !== employee.id) throw new ScheduleError('NOT_YOUR_SHIFT');
  if (inst.status !== 'scheduled') throw new ScheduleError('NOT_RELEASABLE');
  if (new Date(inst.starts_at).getTime() <= Date.now() + NOTICE_MS) {
    throw new ScheduleError('TOO_LATE', 'This shift starts within 24 hours — contact a manager directly.');
  }

  // Drop position for THIS pay period, derived from the append-only trail (never a stored count),
  // read AFTER the cheap ownership/timing checks so a doomed release does not pay for the query.
  const periodStart = payPeriodStartFor(laTodayISO());
  const { data: events, error: evReadErr } = await admin
    .from('attendance_events')
    .select('event_type, shift_date')
    .eq('employee_id', employee.id)
    .eq('pay_period_start', periodStart);
  if (evReadErr) throw new ScheduleError('READ_FAILED', evReadErr.message);
  const drops = computeDrops(events ?? []);
  if (drops.drops >= DROP_CAP) {
    throw new ScheduleError(
      'DROP_CAP_REACHED',
      `You have used ${drops.drops} of ${DROP_CAP} drops this pay period — contact a manager to release this shift.`,
    );
  }

  const nowISO = new Date().toISOString();
  const { data: updated, error: uErr } = await admin
    .from('shift_instances')
    .update({ status: 'released', released_at: nowISO, released_by: employee.id, employee_id: null })
    .eq('id', instanceId)
    .eq('employee_id', employee.id)
    .eq('status', 'scheduled')
    .select('id, shift_date')
    .maybeSingle();
  if (uErr) throw new ScheduleError('RELEASE_FAILED', uErr.message);
  if (!updated) throw new ScheduleError('NOT_RELEASABLE'); // lost a race / already released

  // Append the release to the attendance trail. pay_period_start keys on the ACTION time (now),
  // not the shift date — so a release and an offsetting claim land in the same period (the netting
  // decision). shift_date is denormalized (durable after instance deletion); the guard keys on
  // (employee_id, shift_date).
  const { error: evErr } = await admin.from('attendance_events').insert({
    user_id: inst.user_id,
    employee_id: employee.id,
    shift_instance_id: instanceId,
    shift_date: inst.shift_date,
    event_type: 'released',
    pay_period_start: periodStart,
    note: trimmedReason,
  });
  if (evErr) throw new ScheduleError('EVENT_WRITE_FAILED', evErr.message);

  return {
    status: 'released',
    shift_date: inst.shift_date,
    starts_at: inst.starts_at,
    ends_at: inst.ends_at,
    store_id: inst.store_id ?? null,
  };
}
