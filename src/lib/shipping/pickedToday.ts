import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { zonedDayKey, zonedDayStartUtcMs } from './pickerPerformance';

// How many boxes have been verified today.
//
// Both the station and the owner-side pack overlay used to count this in a useState, so it
// reset to zero on every reload and every device swap. The number a picker reads should be the
// number the database holds — that is the only version that survives a refresh mid-shift, and
// the overlay's label already claimed "today" rather than "this session".
//
// "TODAY" IS THE FULFILMENT DAY (local 04:00 → 04:00), not the calendar day. This deliberately
// reuses the boundary the picker KPIs already own rather than defining a second one:
//   * the night crew works ~17:00–01:00, so a midnight boundary would reset a picker's counter
//     to zero in the middle of their shift — the number would go DOWN while they worked;
//   * and the counter would then disagree with the performance view for the same shift, which
//     is worse than either convention on its own.
// 04:00 sits in a measured dead zone (<0.05% of box completions) and clears the DST
// transition, so no real shift straddles it.

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
    .gte('verified_at', new Date(zonedDayStartUtcMs(zonedDayKey(Date.now()))).toISOString());

  if (pickerEmployeeId) q = q.eq('picker_employee_id', pickerEmployeeId);

  const { count, error } = await q;
  if (error) return 0;
  return count ?? 0;
}
