import 'server-only';
import type { createAdminClient } from '@/lib/supabase/admin';

// THE CAPACITY WRITE GUARD SEAM (migration 157).
//
// 156 made APPROVING a shift request race-safe. The manager WRITE paths — bulk scheduling, a
// one-time admin shift, and assigning the legacy open board — were still check-then-act across
// separate PostgREST statements, so a capacity check written in TypeScript could not be race-safe
// no matter how carefully it re-read. 157 moves those writes into SQL functions that hold the same
// (owner, team, date) advisory lock across the recount and the write.
//
// ── WHY THIS MODULE EXISTS: THE FALLBACK ──────────────────────────────────────────────────────
// Bulk scheduling, claiming and claim-approval are all SHIPPED paths that work in production
// today. 157 is deliberately NOT applied yet (nor is 156). If these call sites called the new
// functions unconditionally, merging this branch would break scheduling the moment it deployed and
// leave it broken until someone hand-applied the migration.
//
// So every call site tries the RPC and falls back to its exact pre-157 statement sequence when the
// function does not exist. That is safe rather than sloppy, because the guard and the thing it
// guards arrive together: capacity blocks live in 156, and with no blocks there is nothing to
// exceed. The fallback window is precisely the window in which capacity does not exist.
//
// Once 156 + 157 are applied the RPC resolves and the guard is live, with no deploy and no flag.

/**
 * Is this Supabase error "that function does not exist"?
 *
 * PostgREST reports an unresolvable RPC as PGRST202 with a schema-cache message; a direct SQL miss
 * is SQLSTATE 42883. Matched on BOTH so the fallback cannot be defeated by which layer answered.
 * Deliberately narrow: any other error is a real failure and must surface, not silently downgrade
 * to an unguarded write.
 */
export function isMissingFunction(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  const code = error.code ?? '';
  if (code === 'PGRST202' || code === '42883') return true;
  const msg = (error.message ?? '').toLowerCase();
  return msg.includes('could not find the function') || msg.includes('does not exist');
}

/** What `lensed_apply_schedule_batch` returns. */
export interface BatchGuardResult {
  ok: true;
  created: number;
  updated: number;
  removed: number;
  refusals: { employee_id: string; shift_date: string; code: 'OVER_CAPACITY'; block_id: string; staffed: number; capacity: number }[];
}

/** What `lensed_assign_released_shift` returns. */
export type AssignGuardResult =
  | { ok: true; id: string; shift_date: string; user_id: string }
  | { ok: false; reason: 'SHIFT_NOT_FOUND' | 'EMPLOYEE_NOT_FOUND' | 'ALREADY_CLAIMED' | 'NO_CAPACITY'; staffed?: number; capacity?: number };

/** The manager-facing sentence for a capacity refusal on a write path. */
export const OVER_CAPACITY_MESSAGE =
  'That block is fully staffed for this day. Raise the capacity or free a shift first.';


/**
 * Assign a RELEASED shift to an employee, capacity-guarded (157).
 *
 * The legacy open board is the one count-increasing path outside bulk scheduling: a released row
 * carries no employee, so it is not staffed, and assigning someone adds one to every capacity block
 * that row overlaps. Both callers — claimShift's auto-approve branch and approveClaim's over-40h
 * branch — used an identical CAS update; this runs that CAS inside lensed_assign_released_shift,
 * which holds the (owner, team, date) lock across a recount and the write.
 *
 * Returns a RESULT rather than throwing, so this module needs no ScheduleError import and claim.ts
 * does not have to reach into adminShifts.ts for it. Each caller maps the reason to its own error.
 *
 * FALLBACK: while 157 is unapplied the original CAS runs, byte-for-byte, including the
 * `employee_id IS NULL` predicate — see the module header for why that is safe.
 */
export async function assignReleasedShift(
  admin: ReturnType<typeof createAdminClient>,
  input: { ownerId: string; instanceId: string; employeeId: string },
): Promise<
  | { ok: true; row: { id: string; shift_date: string; user_id: string } }
  | { ok: false; reason: 'NO_CAPACITY' | 'UNAVAILABLE' | 'FAILED'; message?: string }
> {
  // rpc-grants: lensed_assign_released_shift
  const guarded = await admin.rpc('lensed_assign_released_shift', {
    p_owner: input.ownerId,
    p_instance_id: input.instanceId,
    p_employee_id: input.employeeId,
  });
  if (!guarded.error) {
    const r = (guarded.data ?? {}) as AssignGuardResult;
    if (r.ok) return { ok: true, row: { id: r.id, shift_date: r.shift_date, user_id: r.user_id } };
    return { ok: false, reason: r.reason === 'NO_CAPACITY' ? 'NO_CAPACITY' : 'UNAVAILABLE' };
  }
  if (!isMissingFunction(guarded.error)) return { ok: false, reason: 'FAILED', message: guarded.error.message };

  const { data: won, error: uErr } = await admin
    .from('shift_instances')
    .update({ status: 'claimed', employee_id: input.employeeId, source: 'claim', released_at: null })
    .eq('id', input.instanceId)
    .eq('user_id', input.ownerId)
    .eq('status', 'released')
    .is('employee_id', null)
    .select('id, shift_date, user_id')
    .maybeSingle();
  if (uErr) return { ok: false, reason: 'FAILED', message: uErr.message };
  if (!won) return { ok: false, reason: 'UNAVAILABLE' };
  return { ok: true, row: won as { id: string; shift_date: string; user_id: string } };
}
