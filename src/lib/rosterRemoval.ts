import type { SupabaseClient } from '@supabase/supabase-js';
import type { Employee, EmployeeStatus } from '@/types';

// REMOVING A PERSON FROM THE ROSTER IS AN ARCHIVE, NOT A ROW DELETE.
//
// WHY THIS FILE EXISTS. `delete from employees where id = $1` cannot succeed for anyone who
// has ever hosted a show, and it destroys pay history for everyone who has not:
//
//   * live_session_host_segments.host_id carries ON DELETE SET NULL (migration 106 line 178;
//     verified against the live schema — constraint live_session_host_segments_host_id_fkey,
//     confdeltype 'n'). Deleting the employee makes Postgres issue
//     `update live_session_host_segments set host_id = null` on every segment they hosted.
//   * That UPDATE fires trg_lshs_append_only -> lensed_guard_host_segment_append_only(),
//     whose first check is `NEW.host_id is distinct from OLD.host_id`, and it aborts the
//     whole transaction with HOST_SEGMENT_IMMUTABLE. The trigger is right: segments are the
//     only record that a mid-show host switch happened, so host attribution is immutable.
//   * Every OTHER reference to employees is ON DELETE CASCADE — shifts (044), recurring
//     shifts (047), time-clock entries and attendance (070), badges (091), QR clock-ins
//     (099), scheduling v1 (085), time-off requests (120). For an employee with no segments
//     the delete therefore SUCCEEDS and silently takes their whole worked-time and pay
//     history with it. The segment trigger has been the accidental guard on that.
//
// THE SUPPORTED OPERATION ALREADY EXISTS: status 'former' (migration 044 check constraint).
// It is what the rest of the app already means by "off the roster" — schedulableEmployees()
// drops them from the weekly grid (weeklySchedule.ts), schedulePlan refuses to assign them
// (EMPLOYEE_FORMER), the open-shift and day-add pickers filter them out, and the roster grid
// renders them dimmed and labelled "Former". Their history stays exactly where it is.
//
// The trigger's own hint — "insert a replacement and stamp superseded_by" — is the remedy for
// CORRECTING A MIS-ATTRIBUTED SEGMENT. It does not apply here. Roster removal has no opinion
// about who hosted a past show, so it must not touch segments at all.

/** The status an employee carries once a manager takes them off the roster. */
export const ROSTER_REMOVED_STATUS: EmployeeStatus = 'former';

/**
 * The exact column set roster removal is allowed to write. Deliberately narrow: it names
 * `status` and nothing else, so no removal can ever carry `host_id` (or any other segment
 * column) into an UPDATE. Exported so the regression test can assert that directly.
 */
export function buildRosterRemovalPatch(now: Date = new Date()): {
  status: EmployeeStatus;
  updated_at: string;
} {
  return { status: ROSTER_REMOVED_STATUS, updated_at: now.toISOString() };
}

/**
 * Take one person off the current roster, preserving every historical record that references
 * them. Idempotent — archiving an already-former employee is a no-op write that still
 * resolves. Never issues a DELETE, and never touches live_session_host_segments.
 */
export async function removeFromRoster(
  client: SupabaseClient,
  employeeId: string,
): Promise<Employee> {
  const { data, error } = await client
    .from('employees')
    .update(buildRosterRemovalPatch())
    .eq('id', employeeId)
    .select('*')
    .single();
  if (error) throw error;
  return data as Employee;
}
