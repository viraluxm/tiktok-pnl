import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { laTodayISO } from './timezone';
import {
  planScheduleBatch, entryDateRange, uniqueEmployeeIds,
  type ScheduleEntry, type ExistingInstance, type PlanEmployee, type ScheduleCounts, type ScheduleRefusal,
} from './schedulePlan';

// THE bulk scheduling write path. Every new scheduling surface (the employee Schedule Builder,
// the day/crew modal, anything later) funnels through applyScheduleBatch so there is exactly one
// place that decides what a "working" or "off" day means in the database.
//
// Only `shift_instances` is ever written. `shifts` and `employee_time_entries` are READ for the
// removal guards and nothing else — this function has no code path that can create payable time,
// which is the property the tests pin.
//
// ATOMICITY (honest statement): PostgREST gives us ONE atomic multi-row upsert statement, but the
// removals are separate statements and there is no transaction RPC in the schema. So the plan is
// computed completely before any write (any refusal → nothing is written), and writes run in the
// order upsert → delete → cancel. A failure between them can leave a requested-off day still
// scheduled (visible, re-saveable) but can never lose a requested-working day. A DB function would
// make this a single transaction; that is a later migration, deliberately not part of this change.

export interface ApplyScheduleResult {
  ok: true;
  dryRun: boolean;
  counts: ScheduleCounts;
  /** Dates whose times this operation replaces / removes — for the repeat confirmation. */
  updatedDates: string[];
  removedDates: string[];
}

export interface ApplyScheduleRefused {
  ok: false;
  refusals: ScheduleRefusal[];
}

export class ScheduleBatchError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

export async function applyScheduleBatch(input: {
  userId: string;
  entries: ScheduleEntry[];
  dryRun?: boolean;
  now?: Date;
}): Promise<ApplyScheduleResult | ApplyScheduleRefused> {
  const admin = createAdminClient();
  const now = input.now ?? new Date();
  const employeeIds = uniqueEmployeeIds(input.entries);
  const { from, to } = entryDateRange(input.entries);

  // SCOPING: createAdminClient() bypasses RLS, so `user_id` is written into every query explicitly.
  const [emps, existing, worked, open] = await Promise.all([
    admin
      .from('employees')
      .select('id, role, status, store_id')
      .eq('user_id', input.userId)
      .in('id', employeeIds),
    admin
      .from('shift_instances')
      .select('id, employee_id, shift_date, starts_at, ends_at, status, source, shift_rule_id, store_id, role')
      .eq('user_id', input.userId)
      .in('employee_id', employeeIds)
      .gte('shift_date', from)
      .lte('shift_date', to),
    // Removal guard facts. `shifts.date` and `shift_instances.shift_date` are both LA calendar
    // dates, so (employee, date) is a direct key.
    admin
      .from('shifts')
      .select('employee_id, date')
      .eq('user_id', input.userId)
      .in('employee_id', employeeIds)
      .gte('date', from)
      .lte('date', to),
    admin
      .from('employee_time_entries')
      .select('employee_id')
      .eq('user_id', input.userId)
      .in('employee_id', employeeIds)
      .is('clocked_out_at', null),
  ]);
  if (emps.error) throw new ScheduleBatchError('READ_FAILED', emps.error.message);
  if (existing.error) throw new ScheduleBatchError('READ_FAILED', existing.error.message);
  if (worked.error) throw new ScheduleBatchError('READ_FAILED', worked.error.message);
  if (open.error) throw new ScheduleBatchError('READ_FAILED', open.error.message);

  const plan = planScheduleBatch({
    userId: input.userId,
    entries: input.entries,
    employees: (emps.data ?? []) as PlanEmployee[],
    existing: (existing.data ?? []) as ExistingInstance[],
    workedKeys: new Set((worked.data ?? []).map((r) => `${r.employee_id}|${r.date}`)),
    clockedInEmployees: new Set((open.data ?? []).map((r) => r.employee_id as string)),
    todayISO: laTodayISO(now),
    nowMs: now.getTime(),
  });

  if (plan.refusals.length > 0) return { ok: false, refusals: plan.refusals };
  const dates = { updatedDates: plan.updatedDates, removedDates: plan.removedDates };
  if (input.dryRun) return { ok: true, dryRun: true, counts: plan.counts, ...dates };

  // 1. Upsert (one statement). ON CONFLICT (employee_id, shift_date) DO UPDATE — the unique
  //    constraint IS the idempotency key, so a row created between our read and this write is
  //    updated rather than erroring. (An upsert cannot carry a status predicate, so the claim rule
  //    is enforced by the planner refusing before we get here; a row claimed in the microseconds
  //    between read and write would be re-spanned — accepted for v1, noted in the report.)
  if (plan.upserts.length > 0) {
    const { error } = await admin
      .from('shift_instances')
      .upsert(plan.upserts, { onConflict: 'employee_id,shift_date' });
    if (error) throw new ScheduleBatchError('WRITE_FAILED', error.message);
  }

  // 2. Hard-delete one-off rows (same predicates the existing Remove Shift path re-asserts).
  if (plan.deleteIds.length > 0) {
    const { error } = await admin
      .from('shift_instances')
      .delete()
      .eq('user_id', input.userId)
      .eq('source', 'admin_open')
      .eq('status', 'scheduled')
      .in('id', plan.deleteIds);
    if (error) throw new ScheduleBatchError('WRITE_FAILED', error.message);
  }

  // 3. Cancel the removed non-one-off rows ('pattern' instances). The `status='scheduled'`
  //    predicate is the race guard AND a second line of defence for the claim rule: a row that was
  //    claimed between our read and this write matches 0 rows and is left alone rather than
  //    cancelled out from under an approved claim.
  if (plan.cancelIds.length > 0) {
    const { error } = await admin
      .from('shift_instances')
      .update({ status: 'cancelled' })
      .eq('user_id', input.userId)
      .eq('status', 'scheduled')
      .in('id', plan.cancelIds);
    if (error) throw new ScheduleBatchError('WRITE_FAILED', error.message);
  }

  return { ok: true, dryRun: false, counts: plan.counts, ...dates };
}
