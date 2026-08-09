import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { payPeriodStartFor } from '@/lib/employees';
import type { Employee } from '@/types';
import { laTodayISO } from './timezone';
import { NOTICE_MS } from './board';

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
// The 24h guard is enforced server-side regardless of what the UI showed. Drop-cap is NOT blocked
// here — blocking a release produces a no-show, which is worse; the UI warns on the confirm step.
export async function releaseShift(employee: Employee, instanceId: string): Promise<ReleaseResult> {
  const admin = createAdminClient();

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
    pay_period_start: payPeriodStartFor(laTodayISO()),
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
