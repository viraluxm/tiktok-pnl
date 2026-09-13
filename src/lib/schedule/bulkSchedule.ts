import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { laTodayISO } from './timezone';
import {
  planScheduleBatch, entryDateRange, uniqueEmployeeIds, SCHEDULE_REFUSAL_MESSAGES,
  type ScheduleEntry, type ExistingInstance, type PlanEmployee, type ScheduleCounts, type ScheduleRefusal,
  type SchedulePlan,
} from './schedulePlan';
import { defaultCapacityJson, isMissingFunction, type BatchGuardResult } from './capacityGuard';

// THE bulk scheduling write path. Every new scheduling surface (the employee Schedule Builder,
// the day/crew modal, anything later) funnels through applyScheduleBatch so there is exactly one
// place that decides what a "working" or "off" day means in the database.
//
// Only `shift_instances` is ever written. `shifts` and `employee_time_entries` are READ for the
// removal guards and nothing else — this function has no code path that can create payable time,
// which is the property the tests pin.
//
// ATOMICITY. Migration 157 added `lensed_apply_schedule_batch`, the DB function this header used
// to describe as "a later migration": it runs the removals and the upserts in ONE transaction,
// holding the (owner, team, date) capacity lock across the recount and the write. When it is
// present, the batch is atomic and capacity-safe.
//
// It is also the ONLY way to be capacity-safe. A check written here, before the writes, is
// check-then-act across separate transactions: by the time the upsert lands, an approval on another
// connection may have taken the last shift. That was the residual 156's header admitted.
//
// FALLBACK (see capacityGuard.ts): when the function is absent — which is the state until 156 and
// 157 are hand-applied — this falls back to the exact pre-157 sequence below: plan first (any
// refusal → nothing written), then upsert → delete → cancel, with the torn-write window that
// sequence has always had. Safe, because capacity blocks live in 156: with no blocks there is
// nothing to exceed, and the two migrations are applied together.

export interface ApplyScheduleResult {
  ok: true;
  dryRun: boolean;
  counts: ScheduleCounts;
  /** Dates whose times this operation replaces / removes — for the repeat confirmation. */
  updatedDates: string[];
  removedDates: string[];
  /**
   * PER-ROW capacity refusals (157). Unlike planner refusals, these do NOT mean "nothing was
   * written": every other day in the batch landed. Empty on the pre-157 fallback and on a dry run.
   */
  refusals: ScheduleRefusal[];
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
  // A dry run is a "what would this replace or remove" preview for the repeat confirmation, and it
  // writes nothing — so it deliberately takes no capacity lock and reports no capacity refusal.
  // Locking a lane to answer a question nobody acted on would serialise real saves behind previews.
  if (input.dryRun) return { ok: true, dryRun: true, counts: plan.counts, ...dates, refusals: [] };

  // ── THE GUARDED PATH (157). One transaction, the lane locks held across the recount and the
  //    write. Returns per-row OVER_CAPACITY refusals; every other row still lands.
  //    rpc-grants: lensed_apply_schedule_batch
  const guarded = await admin.rpc('lensed_apply_schedule_batch', {
    p_owner: input.userId,
    p_upserts: plan.upserts,
    p_delete_ids: plan.deleteIds,
    p_cancel_ids: plan.cancelIds,
    p_default_capacity: defaultCapacityJson(),
  });
  if (!guarded.error) {
    const r = (guarded.data ?? {}) as BatchGuardResult;
    const refusals: ScheduleRefusal[] = (r.refusals ?? []).map((x) => ({
      employeeId: x.employee_id,
      date: x.shift_date,
      code: 'OVER_CAPACITY',
      message: SCHEDULE_REFUSAL_MESSAGES.OVER_CAPACITY,
    }));
    // Counts come from what the function ACTUALLY wrote, not from what the planner hoped to write:
    // a refused row must not be reported as created.
    return {
      ok: true,
      dryRun: false,
      counts: { ...plan.counts, created: r.created ?? 0, updated: r.updated ?? 0, removed: r.removed ?? 0 },
      ...dates,
      refusals,
    };
  }
  if (!isMissingFunction(guarded.error)) throw new ScheduleBatchError('WRITE_FAILED', guarded.error.message);

  // ── PRE-157 FALLBACK, unchanged. Reached only while the migration is unapplied, i.e. while no
  //    capacity block exists to exceed. See capacityGuard.ts for why this is safe rather than lax.
  await applyScheduleBatchUnguarded(admin, input.userId, plan);
  return { ok: true, dryRun: false, counts: plan.counts, ...dates, refusals: [] };
}

/**
 * The exact statement sequence this module used before 157: upsert → delete → cancel, three
 * PostgREST statements with no shared transaction. Extracted verbatim rather than rewritten, so the
 * fallback cannot drift from the behaviour it is meant to reproduce.
 *
 * A failure between the statements can leave a requested-off day still scheduled (visible,
 * re-saveable) but can never lose a requested-working day.
 */
async function applyScheduleBatchUnguarded(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  plan: SchedulePlan,
): Promise<void> {
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
      .eq('user_id', userId)
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
      .eq('user_id', userId)
      .eq('status', 'scheduled')
      .in('id', plan.cancelIds);
    if (error) throw new ScheduleBatchError('WRITE_FAILED', error.message);
  }
}
