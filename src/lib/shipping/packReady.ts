import type { SupabaseClient } from '@supabase/supabase-js';

// Pack-ready box batch, scoped to a set of user_ids. This is the /api/shipping/pick-tickets
// logic generalized to run under the station's owner scope (an array of owner user_ids and NO
// store filter) as well as the operator's own single user_id. The existing pick-tickets route
// is intentionally left untouched; this is a standalone copy consumed by /api/station/boxes.
//
// READ-ONLY, our DB only. AWAITING_COLLECTION orders grouped by auto_combine_group_id (one box =
// one group), with an age window (?days=N, default 3; 'all' disables). Item lines use the INTERNAL
// sku snapshot; non-bound orders are classified unbound-auction vs catalog (Phase-0 discriminator).

export interface PackReadyResult {
  groups: {
    barcode_order_id: string;
    order_ids: string[];
    order_count: number;
    catalog_items: { listing_name: string; seller_sku: string; qty: number }[];
    items: { sku_number: number | null; title: string; qty: number }[];
    unresolved_count: number;
  }[];
  store_id: string | null;
  days: string | number;
  included_boxes: number;
  included_orders: number;
  excluded_boxes: number;
  excluded_orders: number;
  no_timestamp_orders: number;
}

export async function computePackReadyBoxes(
  db: SupabaseClient,
  userIds: string[],
  opts: { storeId: string | null; daysParam: string | null },
): Promise<PackReadyResult> {
  const { storeId, daysParam } = opts;

  const allDays = daysParam === 'all';
  const parsedDays = Number.parseInt(daysParam ?? '', 10);
  const days = allDays ? null : (Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : 3);
  const cutoffMs = allDays ? null : Date.now() - (days as number) * 86_400_000;

  // 1) Pack-ready orders (paged; user-scoped; store-scoped only when provided).
  interface Row { order_id: string; auto_combine_group_id: string | null; order_created_at: string | null; tiktok_product_id: string | null; sku_name: string | null; units: number | null }
  const rows: Row[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = db
      .from('synced_order_ids')
      .select('order_id, auto_combine_group_id, order_created_at, tiktok_product_id, sku_name, units')
      .in('user_id', userIds)
      .eq('status', 'AWAITING_COLLECTION')
      .order('order_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (storeId && storeId !== 'all') q = q.eq('store_id', storeId);
    const { data, error } = await q;
    if (error) throw new Error(`pack-ready orders query failed: ${error.message}`);
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < PAGE) break;
  }

  const no_timestamp_orders = rows.filter((r) => !r.order_created_at).length;

  const emptyCounts = {
    store_id: storeId,
    days: allDays ? 'all' : (days as number),
    included_boxes: 0,
    included_orders: 0,
    excluded_boxes: 0,
    excluded_orders: 0,
    no_timestamp_orders,
  } as const;
  if (!rows.length) return { groups: [], ...emptyCounts };

  // 2) Group into boxes (box = combine-group; a singleton order is its own box). Included when ANY
  //    of its orders falls inside the window.
  const boxMap = new Map<string, Row[]>();
  for (const r of rows) {
    const g = r.auto_combine_group_id ?? r.order_id;
    const arr = boxMap.get(g);
    if (arr) arr.push(r);
    else boxMap.set(g, [r]);
  }

  const includedBoxes: Row[][] = [];
  let excluded_boxes = 0;
  let excluded_orders = 0;
  for (const boxRows of boxMap.values()) {
    const inWindow = cutoffMs === null
      ? true
      : boxRows.some((r) => r.order_created_at != null && new Date(r.order_created_at).getTime() >= cutoffMs);
    if (inWindow) includedBoxes.push(boxRows);
    else { excluded_boxes += 1; excluded_orders += boxRows.length; }
  }
  const included_boxes = includedBoxes.length;
  const included_orders = includedBoxes.reduce((n, b) => n + b.length, 0);
  const counts = {
    store_id: storeId,
    days: allDays ? 'all' : (days as number),
    included_boxes,
    included_orders,
    excluded_boxes,
    excluded_orders,
    no_timestamp_orders,
  };
  if (!includedBoxes.length) return { groups: [], ...counts };

  const includedOrderIds = includedBoxes.flat().map((r) => r.order_id);

  async function chunkedIn<T>(table: string, sel: string, col: string, vals: string[]): Promise<T[]> {
    const out: T[] = [];
    const CH = 300;
    for (let i = 0; i < vals.length; i += CH) {
      const { data } = await db.from(table).select(sel).in('user_id', userIds).in(col, vals.slice(i, i + CH));
      out.push(...((data ?? []) as T[]));
    }
    return out;
  }

  // 3) Bound auction items → order_id.
  const items = await chunkedIn<{ id: string; client_idempotency_key: string }>(
    'live_auction_items', 'id, client_idempotency_key', 'client_idempotency_key', includedOrderIds,
  );
  const itemToOrder = new Map(items.map((i) => [String(i.id), String(i.client_idempotency_key)]));
  const itemIds = items.map((i) => String(i.id));

  // 4) SKU snapshot lines.
  const skuLines = itemIds.length
    ? await chunkedIn<{ auction_item_id: string; sku_number_snapshot: number | null; title_snapshot: string | null; qty: number }>(
        'live_auction_item_skus', 'auction_item_id, sku_number_snapshot, title_snapshot, qty', 'auction_item_id', itemIds,
      )
    : [];

  const orderHasSku = new Set<string>();
  const orderItems = new Map<string, Map<string, { sku_number: number | null; title: string; qty: number }>>();
  for (const l of skuLines) {
    const oid = itemToOrder.get(String(l.auction_item_id));
    if (!oid) continue;
    orderHasSku.add(oid);
    const key = `${l.sku_number_snapshot ?? '?'}|${l.title_snapshot ?? ''}`;
    const m = orderItems.get(oid) ?? new Map<string, { sku_number: number | null; title: string; qty: number }>();
    const cur = m.get(key) ?? { sku_number: (l.sku_number_snapshot as number | null) ?? null, title: (l.title_snapshot as string | null) || 'Untitled', qty: 0 };
    cur.qty += Number(l.qty) || 1;
    m.set(key, cur);
    orderItems.set(oid, m);
  }

  // 5) Classify every non-bound order: unbound-AUCTION vs CATALOG (Phase-0 discriminator).
  const nonBoundIds = includedOrderIds.filter((oid) => !orderHasSku.has(oid));
  const capRows = nonBoundIds.length
    ? await chunkedIn<{ order_id: string }>('capture_events', 'order_id', 'order_id', nonBoundIds)
    : [];
  const captureSet = new Set(capRows.map((c) => String(c.order_id)));
  const rowByOrder = new Map(includedBoxes.flat().map((r) => [r.order_id, r]));
  const candidateOrders = nonBoundIds.filter((oid) => !captureSet.has(oid));
  const candidatePids = [...new Set(candidateOrders.map((oid) => rowByOrder.get(oid)?.tiktok_product_id).filter((p): p is string => !!p))];
  const auctionPidRows = candidatePids.length
    ? await chunkedIn<{ tiktok_product_id: string }>('capture_events', 'tiktok_product_id', 'tiktok_product_id', candidatePids)
    : [];
  const auctionPids = new Set(auctionPidRows.map((r) => String(r.tiktok_product_id)));
  const prodRows = candidatePids.length
    ? await chunkedIn<{ tiktok_product_id: string; name: string | null }>('products', 'tiktok_product_id, name', 'tiktok_product_id', candidatePids)
    : [];
  const productName = new Map(prodRows.map((p) => [String(p.tiktok_product_id), (p.name ?? '').trim()]));

  type OType = 'bound' | 'unbound' | 'catalog';
  const orderType = new Map<string, OType>();
  const catalogByOrder = new Map<string, { listing_name: string; seller_sku: string; qty: number }>();
  for (const oid of includedOrderIds) {
    if (orderHasSku.has(oid)) { orderType.set(oid, 'bound'); continue; }
    if (captureSet.has(oid)) { orderType.set(oid, 'unbound'); continue; }
    const r = rowByOrder.get(oid);
    const pid = r?.tiktok_product_id ?? '';
    const name = pid ? productName.get(pid) : '';
    if (pid && !auctionPids.has(pid) && name) {
      orderType.set(oid, 'catalog');
      catalogByOrder.set(oid, { listing_name: name, seller_sku: (r?.sku_name ?? '').trim(), qty: Number(r?.units) || 1 });
    } else {
      orderType.set(oid, 'unbound');
    }
  }

  // 6) One group per INCLUDED box.
  const groups = includedBoxes
    .map((boxRows) => {
      const groupOrderIds = boxRows.map((r) => r.order_id);
      const agg = new Map<string, { sku_number: number | null; title: string; qty: number }>();
      const catAgg = new Map<string, { listing_name: string; seller_sku: string; qty: number }>();
      let unresolved = 0;
      for (const oid of groupOrderIds) {
        const t = orderType.get(oid);
        if (t === 'bound') {
          for (const [k, v] of orderItems.get(oid) ?? []) {
            const cur = agg.get(k) ?? { sku_number: v.sku_number, title: v.title, qty: 0 };
            cur.qty += v.qty;
            agg.set(k, cur);
          }
        } else if (t === 'catalog') {
          const c = catalogByOrder.get(oid)!;
          const key = `${c.listing_name}||${c.seller_sku}`;
          const cur = catAgg.get(key) ?? { listing_name: c.listing_name, seller_sku: c.seller_sku, qty: 0 };
          cur.qty += c.qty;
          catAgg.set(key, cur);
        } else {
          unresolved += 1;
        }
      }
      return {
        barcode_order_id: groupOrderIds.slice().sort()[0],
        order_ids: groupOrderIds,
        order_count: groupOrderIds.length,
        catalog_items: [...catAgg.values()].sort((a, b) => a.listing_name.localeCompare(b.listing_name)),
        items: [...agg.values()].sort((a, b) => (Number(a.sku_number) || 0) - (Number(b.sku_number) || 0)),
        unresolved_count: unresolved,
      };
    })
    .sort((a, b) => a.barcode_order_id.localeCompare(b.barcode_order_id));

  return { groups, ...counts };
}
