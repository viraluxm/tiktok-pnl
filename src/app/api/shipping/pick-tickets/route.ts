import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// GET: the pack-ready batch for printing OUR OWN order-id pick tickets. READ-ONLY, our DB only
// (no TikTok API call, no writes). Returns AWAITING_COLLECTION orders for the optional active
// store, grouped by auto_combine_group_id (one box = one group). Item lines use the INTERNAL
// sku snapshot (#number + title) — never the generic TikTok sku_name. Orders with no bound SKU
// are counted as unresolved so the picker sees them on paper. Mirrors pick-list's user-scoped
// reads; no getFreshToken (that is only for pick-list's scan-time TikTok status refresh).
//
// AGE FILTER (?days=N, default 3; ?days=all disables it). AWAITING_COLLECTION is a frozen
// create-day snapshot — the sync bounds on create_time and never revisits past days, so ~90% of
// the all-time batch already shipped and is only STALE in our DB. `days` is a proxy for "snapshot
// probably still accurate": we EMIT tickets only for boxes with a recent order, but we NEVER hide
// anything silently. The response reports included/excluded box+order counts and a separate
// no_timestamp bucket so the UI can always surface what was left out. NULL order_created_at is
// never guessed — it just can't satisfy the window, so those orders are counted and surfaced.
export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const uid = user.id;
  const url = new URL(req.url);
  const storeId = url.searchParams.get('store_id'); // optional; null/'all' → all stores

  // Age window. 'all' → no cutoff (every box included). Any positive integer → that many days.
  // Anything else (missing/garbage) → default 3.
  const daysParam = url.searchParams.get('days');
  const allDays = daysParam === 'all';
  const parsedDays = Number.parseInt(daysParam ?? '', 10);
  const days = allDays ? null : (Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : 3);
  const cutoffMs = allDays ? null : Date.now() - (days as number) * 86_400_000;

  // 1) Pack-ready orders (paged to avoid the 1000-row cap; store-scoped when provided). Fetch the
  //    FULL set (no date filter in SQL) so excluded/no-timestamp counts are truthful.
  interface Row { order_id: string; auto_combine_group_id: string | null; order_created_at: string | null; tiktok_product_id: string | null; sku_name: string | null; units: number | null }
  const rows: Row[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = supabase
      .from('synced_order_ids')
      .select('order_id, auto_combine_group_id, order_created_at, tiktok_product_id, sku_name, units')
      .eq('user_id', uid)
      .eq('status', 'AWAITING_COLLECTION')
      .order('order_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (storeId && storeId !== 'all') q = q.eq('store_id', storeId);
    const { data, error } = await q;
    if (error) {
      console.error('[shipping/pick-tickets] orders error:', error.message);
      return NextResponse.json({ error: 'Failed to load orders' }, { status: 500 });
    }
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < PAGE) break;
  }

  // Orders with no order_created_at can never satisfy an age window — surface them, never guess.
  const no_timestamp_orders = rows.filter((r) => !r.order_created_at).length;

  const emptyCounts = {
    store_id: storeId,
    days: allDays ? 'all' : days,
    included_boxes: 0,
    included_orders: 0,
    excluded_boxes: 0,
    excluded_orders: 0,
    no_timestamp_orders,
  };
  if (!rows.length) return NextResponse.json({ groups: [], ...emptyCounts });

  // 2) Group into boxes (box = combine-group; a singleton order is its own box). A box is INCLUDED
  //    when ANY of its orders falls inside the window — so a fresh order never drags its box out of
  //    view, and box-mates that ship together stay together. cutoff null ('all') → every box in.
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
    days: allDays ? 'all' : days,
    included_boxes,
    included_orders,
    excluded_boxes,
    excluded_orders,
    no_timestamp_orders,
  };
  if (!includedBoxes.length) return NextResponse.json({ groups: [], ...counts });

  // Only resolve SKUs for orders we will actually print (perf + correctness).
  const includedOrderIds = includedBoxes.flat().map((r) => r.order_id);

  // Chunk .in() lists so a long day never blows the query-string limit (same as coverage route).
  async function chunkedIn<T>(table: string, sel: string, col: string, vals: string[]): Promise<T[]> {
    const out: T[] = [];
    const CH = 300;
    for (let i = 0; i < vals.length; i += CH) {
      const { data } = await supabase.from(table).select(sel).eq('user_id', uid).in(col, vals.slice(i, i + CH));
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

  // 4) SKU snapshot lines (the authoritative internal SKU — survives later inventory edits).
  const skuLines = itemIds.length
    ? await chunkedIn<{ auction_item_id: string; sku_number_snapshot: number | null; title_snapshot: string | null; qty: number }>(
        'live_auction_item_skus', 'auction_item_id, sku_number_snapshot, title_snapshot, qty', 'auction_item_id', itemIds,
      )
    : [];

  // order_id → aggregated internal-SKU lines; track which orders have ANY bound SKU.
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
  //    Structural, no title matching. capture_events presence = "captured during a live auction".
  //    A catalog order was never in the auction pipeline → no capture_events row. GUARD against
  //    capture-less auction items (a real failure mode: when the host extension ran unauthenticated
  //    it captured sales and discarded them, leaving auction orders with NO capture_events). So a
  //    no-capture order is CATALOG only when its listing is NOT also used by auction sales (its
  //    tiktok_product_id never appears in capture_events) AND it has a real products.name; anything
  //    else fails SAFE to unbound (UNRESOLVED) — we would rather false-flag a catalog item than tell
  //    a packer to pick an unresolvable box. (5 listings are shared auction+catalog in prod → those
  //    catalog orders correctly fail safe.)
  const nonBoundIds = includedOrderIds.filter((oid) => !orderHasSku.has(oid));
  const capRows = nonBoundIds.length
    ? await chunkedIn<{ order_id: string }>('capture_events', 'order_id', 'order_id', nonBoundIds)
    : [];
  const captureSet = new Set(capRows.map((c) => String(c.order_id)));
  const rowByOrder = new Map(includedBoxes.flat().map((r) => [r.order_id, r]));
  // Catalog candidates = non-bound AND never captured. Check their listings against the auction set.
  const candidateOrders = nonBoundIds.filter((oid) => !captureSet.has(oid));
  const candidatePids = [...new Set(candidateOrders.map((oid) => rowByOrder.get(oid)?.tiktok_product_id).filter((p): p is string => !!p))];
  const auctionPidRows = candidatePids.length
    ? await chunkedIn<{ tiktok_product_id: string }>('capture_events', 'tiktok_product_id', 'tiktok_product_id', candidatePids)
    : [];
  const auctionPids = new Set(auctionPidRows.map((r) => String(r.tiktok_product_id))); // listings ALSO sold via auction
  const prodRows = candidatePids.length
    ? await chunkedIn<{ tiktok_product_id: string; name: string | null }>('products', 'tiktok_product_id, name', 'tiktok_product_id', candidatePids)
    : [];
  const productName = new Map(prodRows.map((p) => [String(p.tiktok_product_id), (p.name ?? '').trim()]));

  type OType = 'bound' | 'unbound' | 'catalog';
  const orderType = new Map<string, OType>();
  const catalogByOrder = new Map<string, { listing_name: string; seller_sku: string; qty: number }>();
  for (const oid of includedOrderIds) {
    if (orderHasSku.has(oid)) { orderType.set(oid, 'bound'); continue; }
    if (captureSet.has(oid)) { orderType.set(oid, 'unbound'); continue; } // captured but unbound → genuine unresolved
    const r = rowByOrder.get(oid);
    const pid = r?.tiktok_product_id ?? '';
    const name = pid ? productName.get(pid) : '';
    if (pid && !auctionPids.has(pid) && name) {
      orderType.set(oid, 'catalog');
      catalogByOrder.set(oid, { listing_name: name, seller_sku: (r?.sku_name ?? '').trim(), qty: Number(r?.units) || 1 });
    } else {
      orderType.set(oid, 'unbound'); // capture-less auction / shared-listing / no name → fail safe
    }
  }

  // 6) One group per INCLUDED box, rendering each order line by its own type.
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
          unresolved += 1; // unbound auction — box carries the set-aside warning
        }
      }
      return {
        // Deterministic representative order_id — any box-mate resolves the whole box on scan.
        barcode_order_id: groupOrderIds.slice().sort()[0],
        order_ids: groupOrderIds,
        order_count: groupOrderIds.length,
        catalog_items: [...catAgg.values()].sort((a, b) => a.listing_name.localeCompare(b.listing_name)),
        items: [...agg.values()].sort((a, b) => (Number(a.sku_number) || 0) - (Number(b.sku_number) || 0)),
        unresolved_count: unresolved,
      };
    })
    .sort((a, b) => a.barcode_order_id.localeCompare(b.barcode_order_id));

  return NextResponse.json({ groups, ...counts });
}
