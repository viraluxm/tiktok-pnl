import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { pacificDayStart } from './pacificDay';

// How many boxes have been verified today.
//
// Both the station and the owner-side pack overlay used to count this in a useState, so it
// reset to zero on every reload and every device swap. The number a picker reads should be the
// number the database holds — that is the only version that survives a refresh mid-shift, and
// the overlay's label already claimed "today" rather than "this session".

/**
 * Boxes verified today, optionally for one picker.
 *
 * `pickerEmployeeId` scopes it to a person, which is what the station counter wants: someone
 * reading "47 boxes" should be reading their own work, not the floor's. Attribution is
 * best-effort on the confirm write, so a box confirmed with no picker counts toward the account
 * total and toward nobody's personal one — the honest split, rather than inflating whoever
 * happens to be signed in with unattributed work.
 *
 * A counter is never worth failing a page load over, so an error reads as zero.
 */
export async function countBoxesPickedToday(
  db: SupabaseClient,
  userIds: string[],
  pickerEmployeeId?: string | null,
): Promise<number> {
  if (!userIds.length) return 0;

  let q = db
    .from('shipment_verifications')
    .select('group_key', { count: 'exact', head: true })
    .in('user_id', userIds)
    .gte('verified_at', pacificDayStart().toISOString());

  if (pickerEmployeeId) q = q.eq('picker_employee_id', pickerEmployeeId);

  const { count, error } = await q;
  if (error) return 0;
  return count ?? 0;
}
