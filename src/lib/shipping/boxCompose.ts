// Shared classification: three-way order type (bound / unbound_auction / catalog) with the
// auction-listing-set guard, plus per-order pickable quantity. ONE implementation — the compose
// route classifies the whole batch once; the sample classifies its one box. Aggregation into a
// box's authoritative counts is a pure helper over the classification.

import type { SupabaseClient } from '@supabase/supabase-js';

export interface BoxOrderRow {
  order_id: string; tiktok_product_id: string | null; sku_name: string | null; units: number | null;
}
export type OrderType = 'bound' | 'unbound' | 'catalog';
export interface OrderClass { type: OrderType; qty: number } // qty = pickable units (unbound → 0)

async function chunkedIn<T>(supabase: SupabaseClient, userId: string, table: string, sel: string, col: string, vals: string[]): Promise<T[]> {
  const out: T[] = []; const CH = 300;
  for (let i = 0; i < vals.length; i += CH) {
    const { data } = await supabase.from(table).select(sel).eq('user_id', userId).in(col, vals.slice(i, i + CH));
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

// Classify every order once (DB-only). Structural discriminator: capture_events = "auction";
// bound = has a live_auction_item_skus row; catalog fails SAFE to unbound when its listing is also
// used by auction sales OR has no products.name (capture-less auction guard — see [[shared-resolver]]).
export async function classifyOrders(supabase: SupabaseClient, userId: string, rows: BoxOrderRow[]): Promise<Map<string, OrderClass>> {
  const orderIds = rows.map((r) => r.order_id);
  const rowById = new Map(rows.map((r) => [r.order_id, r]));

  const items = await chunkedIn<{ id: string; client_idempotency_key: string }>(supabase, userId, 'live_auction_items', 'id, client_idempotency_key', 'client_idempotency_key', orderIds);
  const itemToOrder = new Map(items.map((i) => [String(i.id), String(i.client_idempotency_key)]));
  const skuLines = items.length
    ? await chunkedIn<{ auction_item_id: string; qty: number }>(supabase, userId, 'live_auction_item_skus', 'auction_item_id, qty', 'auction_item_id', items.map((i) => String(i.id)))
    : [];
  const boundQty = new Map<string, number>();
  for (const l of skuLines) { const oid = itemToOrder.get(String(l.auction_item_id)); if (!oid) continue; boundQty.set(oid, (boundQty.get(oid) ?? 0) + (Number(l.qty) || 1)); }

  const nonBound = orderIds.filter((id) => !boundQty.has(id));
  const captured = new Set((nonBound.length ? await chunkedIn<{ order_id: string }>(supabase, userId, 'capture_events', 'order_id', 'order_id', nonBound) : []).map((c) => String(c.order_id)));
  const candidatePids = [...new Set(nonBound.filter((id) => !captured.has(id)).map((id) => rowById.get(id)?.tiktok_product_id).filter((p): p is string => !!p))];
  const auctionPids = new Set((candidatePids.length ? await chunkedIn<{ tiktok_product_id: string }>(supabase, userId, 'capture_events', 'tiktok_product_id', 'tiktok_product_id', candidatePids) : []).map((r) => String(r.tiktok_product_id)));
  const productName = new Map((candidatePids.length ? await chunkedIn<{ tiktok_product_id: string; name: string | null }>(supabase, userId, 'products', 'tiktok_product_id, name', 'tiktok_product_id', candidatePids) : []).map((p) => [String(p.tiktok_product_id), ((p.name as string | null) ?? '').trim()]));

  const out = new Map<string, OrderClass>();
  for (const id of orderIds) {
    if (boundQty.has(id)) { out.set(id, { type: 'bound', qty: boundQty.get(id)! }); continue; }
    if (captured.has(id)) { out.set(id, { type: 'unbound', qty: 0 }); continue; }
    const r = rowById.get(id); const pid = r?.tiktok_product_id ?? ''; const name = pid ? productName.get(pid) : '';
    if (pid && !auctionPids.has(pid) && name) out.set(id, { type: 'catalog', qty: Number(r?.units) || 1 });
    else out.set(id, { type: 'unbound', qty: 0 }); // capture-less auction / shared listing / no name → fail safe
  }
  return out;
}

export interface BoxCounts {
  itemCount: number; orderCount: number; boundCount: number; unresolvedCount: number; catalogCount: number; allCatalog: boolean;
}
// Aggregate a box's authoritative counts from the classification (pure).
export function aggregateBox(orderIds: string[], cls: Map<string, OrderClass>): BoxCounts {
  let itemCount = 0, bound = 0, unresolved = 0, catalog = 0;
  for (const id of orderIds) {
    const c = cls.get(id); if (!c) { unresolved++; continue; }
    itemCount += c.qty;
    if (c.type === 'bound') bound++; else if (c.type === 'catalog') catalog++; else unresolved++;
  }
  return { itemCount, orderCount: orderIds.length, boundCount: bound, unresolvedCount: unresolved, catalogCount: catalog, allCatalog: catalog === orderIds.length && orderIds.length > 0 };
}
