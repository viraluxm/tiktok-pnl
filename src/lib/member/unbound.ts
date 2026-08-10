import type { SupabaseClient } from '@supabase/supabase-js';

// Shared unbound-queue filter, used by BOTH /api/member/unbound (keyset-paginated list) and
// /api/member/unbound/count (full-scan total). The predicate mirrors the per-session unbound
// synthesis in src/app/api/live/sessions/[id]/board/route.ts:239-281:
//   • order_id non-empty and !== '0'
//   • is_payment_successful !== false               (drop failed payments)
//   • NOT bound in any session (live_auction_items.client_idempotency_key = order_id)
//   • NOT CANCELLED (synced_order_ids.status)
//   • store scope: an all-stores member keeps everything; a store-restricted member keeps only
//     orders whose synced store_id is one of theirs
//   • store_id taken from synced_order_ids (reliable) — capture_events.store_id is often NULL

export const CAP_SELECT =
  'order_id, selling_price_cents, product_name, platform_sku_ref, buyer_username, is_payment_successful, ordered_at, created_at, store_id';

export type Cap = {
  order_id: string; selling_price_cents: number | null; product_name: string | null;
  platform_sku_ref: string | null; buyer_username: string | null; is_payment_successful: boolean | null;
  ordered_at: string | null; created_at: string | null; store_id: string | null;
};

// The row carries ordered_at (the keyset sort key) alongside the display fields; the list route
// uses it to build next_cursor and strips it from the response.
export type UnboundRow = {
  order_id: string; tiktok_title: string | null; seller_sku_hint: string | null;
  won_price_cents: number | null; buyer_handle: string | null; logged_at: string;
  store_id: string | null; ordered_at: string | null;
};

// storeFilter (optional): a SINGLE store_id to narrow to — the binding page's store pill. It uses
// the synced_order_ids store_id, so a row with no synced match (null store_id) is excluded from any
// specific store and shows only under "All stores" (storeFilter absent). Independent of the
// restricted-member `storeIds`/`allStores` scope, which still applies.
export interface UnboundScope { ownerIds: string[]; allStores: boolean; storeIds: string[]; storeFilter?: string | null }

// Filter one chunk of capture rows to the UNBOUND ones. Two IN queries per chunk: the bound
// anti-join (live_auction_items) and CANCELLED/store (synced_order_ids). `seen` dedups by order_id
// across chunks (mutated in place). Throws on a query error so callers map it to a 500.
export async function filterUnboundChunk(
  db: SupabaseClient,
  scope: UnboundScope,
  caps: Cap[],
  seen: Set<string>,
): Promise<UnboundRow[]> {
  const { ownerIds, allStores, storeIds, storeFilter } = scope;
  const storeSet = new Set(storeIds);

  const chunkOids = [...new Set(caps.map((c) => String(c.order_id ?? '')).filter((oid) => oid && oid !== '0'))];
  if (!chunkOids.length) return [];

  // Bound anti-join for exactly this chunk (one IN query).
  const bound = new Set<string>();
  {
    const { data, error } = await db
      .from('live_auction_items')
      .select('client_idempotency_key')
      .in('user_id', ownerIds)
      .in('client_idempotency_key', chunkOids);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) { const k = r.client_idempotency_key; if (k) bound.add(String(k)); }
  }

  // CANCELLED + reliable store_id (one IN query).
  const cancelled = new Set<string>();
  const syncedStore = new Map<string, string | null>();
  {
    const { data, error } = await db
      .from('synced_order_ids')
      .select('order_id, status, store_id')
      .in('user_id', ownerIds)
      .in('order_id', chunkOids);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) {
      const oid = String(r.order_id);
      if (String(r.status) === 'CANCELLED') cancelled.add(oid);
      syncedStore.set(oid, (r.store_id as string | null) ?? null);
    }
  }

  const out: UnboundRow[] = [];
  for (const c of caps) {
    const oid = String(c.order_id ?? '');
    if (!oid || oid === '0' || seen.has(oid)) continue;
    if (c.is_payment_successful === false) continue;
    if (bound.has(oid)) continue;
    if (cancelled.has(oid)) continue;
    const st = syncedStore.get(oid) ?? null;
    if (!allStores && (!st || !storeSet.has(st))) continue;      // restricted-member scope
    if (storeFilter && st !== storeFilter) continue;              // specific-store pill (null st excluded)
    seen.add(oid);
    out.push({
      order_id: oid,
      tiktok_title: (c.product_name as string | null) ?? null,
      seller_sku_hint: (c.platform_sku_ref as string | null) ?? null, // lot #
      won_price_cents: (c.selling_price_cents as number | null) ?? null,
      buyer_handle: (c.buyer_username as string | null) ?? null,
      logged_at: (c.ordered_at as string | null) ?? (c.created_at as string | null) ?? '',
      store_id: syncedStore.get(oid) ?? (c.store_id as string | null) ?? null,
      ordered_at: (c.ordered_at as string | null) ?? null,
    });
  }
  return out;
}
