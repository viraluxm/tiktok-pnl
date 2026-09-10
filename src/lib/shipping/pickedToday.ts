import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { zonedDayKey, zonedDayStartUtcMs } from './pickerPerformance';
import { weightedBoxes } from './crewBoard';

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


// ─────────────────────────────────────────────────────────────────────────────
// The same number the manager board shows
// ─────────────────────────────────────────────────────────────────────────────

export interface PickedTodayTotals {
  /** Typical-box equivalents — the number the per-shift target is measured on. */
  weighted: number;
  /** Raw boxes, so the weighted figure is never a black box the picker cannot check. */
  boxes: number;
  /** Order lines across those boxes. */
  items: number;
  /** Singles credited by batch scan. Counted, never weighted — see crewBoard.ts. */
  singles: number;
}

const PAGE = 1000;
const IN_CHUNK = 300;

/**
 * A picker's day in the SAME units the manager board uses.
 *
 * The device used to show raw boxes while the board showed weighted, so a picker checking their
 * own progress against a 200 target read a different number from the one they are judged on —
 * on 2026-09-10 Alex's device would have said 256 while the board said 302. Two numbers for one
 * shift is worse than either.
 *
 * Errors read as zero, everywhere: a counter is never worth failing the pack screen over.
 */
export async function pickedTodayTotals(
  db: SupabaseClient,
  userIds: string[],
  pickerEmployeeId?: string | null,
): Promise<PickedTodayTotals> {
  const empty: PickedTodayTotals = { weighted: 0, boxes: 0, items: 0, singles: 0 };
  if (!userIds.length) return empty;

  const sinceISO = new Date(zonedDayStartUtcMs(zonedDayKey(Date.now()))).toISOString();

  let q = db
    .from('shipment_verifications')
    .select('group_key, source')
    .in('user_id', userIds)
    .gte('verified_at', sinceISO)
    .order('group_key', { ascending: true });
  if (pickerEmployeeId) q = q.eq('picker_employee_id', pickerEmployeeId);

  const { data, error } = await q;
  if (error || !data) return empty;

  // NULL source means 'scan' — every row written before the singles station was instrumented.
  const singlesRows = data.filter((r) => (r.source as string | null) === 'singles_batch');
  const boxRows = data.filter((r) => (r.source as string | null) !== 'singles_batch');
  if (boxRows.length === 0) return { ...empty, singles: singlesRows.length };

  // Line counts for the picked boxes, chunked and paged: a silent truncation here would
  // understate the picker's own number, which is the one they trust least when it looks wrong.
  const trackings = [...new Set(
    boxRows.map((r) => String(r.group_key)).filter((k) => k.startsWith('trk:')).map((k) => k.slice(4)),
  )];
  const lines = new Map<string, number>();
  for (let i = 0; i < trackings.length; i += IN_CHUNK) {
    const slice = trackings.slice(i, i + IN_CHUNK);
    for (let from = 0; ; from += PAGE) {
      const { data: rows, error: err } = await db
        .from('synced_order_ids')
        .select('id, tracking_number')
        .in('user_id', userIds)
        .in('tracking_number', slice)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (err) return empty;
      const page = rows ?? [];
      for (const r of page) {
        const t = r.tracking_number as string | null;
        if (t) lines.set(t, (lines.get(t) ?? 0) + 1);
      }
      if (page.length < PAGE) break;
    }
  }

  // A box whose lines cannot be resolved counts as 1 item, never 0 — an unknown count must not
  // erase work that demonstrably happened.
  let items = 0;
  for (const r of boxRows) {
    const k = String(r.group_key);
    items += lines.get(k.startsWith('trk:') ? k.slice(4) : '') ?? 1;
  }

  return {
    weighted: Math.round(weightedBoxes(boxRows.length, items)),
    boxes: boxRows.length,
    items,
    singles: singlesRows.length,
  };
}
