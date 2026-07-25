import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// GET: the pack-ready batch for printing OUR OWN order-id pick tickets. READ-ONLY, our DB only
// (no TikTok API call, no writes). Returns AWAITING_COLLECTION orders for the optional active
// store, grouped by auto_combine_group_id (one box = one group). Item lines use the INTERNAL
// sku snapshot (#number + title) — never the generic TikTok sku_name. Orders with no bound SKU
// are counted as unresolved so the picker sees them on paper. Mirrors pick-list's user-scoped
// reads; no getFreshToken (that is only for pick-list's scan-time TikTok status refresh).
export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const uid = user.id;
  const storeId = new URL(req.url).searchParams.get('store_id'); // optional; null/'all' → all stores

  // 1) Pack-ready orders (paged to avoid the 1000-row cap; store-scoped when provided).
  interface Row { order_id: string; auto_combine_group_id: string | null }
  const rows: Row[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = supabase
      .from('synced_order_ids')
      .select('order_id, auto_combine_group_id')
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
  if (!rows.length) return NextResponse.json({ groups: [], store_id: storeId });

  const orderIds = rows.map((r) => r.order_id);

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

  // 2) Bound auction items → order_id.
  const items = await chunkedIn<{ id: string; client_idempotency_key: string }>(
    'live_auction_items', 'id, client_idempotency_key', 'client_idempotency_key', orderIds,
  );
  const itemToOrder = new Map(items.map((i) => [String(i.id), String(i.client_idempotency_key)]));
  const itemIds = items.map((i) => String(i.id));

  // 3) SKU snapshot lines (the authoritative internal SKU — survives later inventory edits).
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

  // 4) Group by combine-group (box = one group; a singleton order is its own group).
  const groupsMap = new Map<string, string[]>();
  for (const r of rows) {
    const g = r.auto_combine_group_id ?? r.order_id;
    const arr = groupsMap.get(g);
    if (arr) arr.push(r.order_id);
    else groupsMap.set(g, [r.order_id]);
  }

  const groups = [...groupsMap.values()]
    .map((groupOrderIds) => {
      const agg = new Map<string, { sku_number: number | null; title: string; qty: number }>();
      let unresolved = 0;
      for (const oid of groupOrderIds) {
        if (!orderHasSku.has(oid)) { unresolved += 1; continue; }
        for (const [k, v] of orderItems.get(oid) ?? []) {
          const cur = agg.get(k) ?? { sku_number: v.sku_number, title: v.title, qty: 0 };
          cur.qty += v.qty;
          agg.set(k, cur);
        }
      }
      return {
        // Deterministic representative order_id — any box-mate resolves the whole box on scan.
        barcode_order_id: groupOrderIds.slice().sort()[0],
        order_ids: groupOrderIds,
        order_count: groupOrderIds.length,
        items: [...agg.values()].sort((a, b) => (Number(a.sku_number) || 0) - (Number(b.sku_number) || 0)),
        unresolved_count: unresolved,
      };
    })
    .sort((a, b) => a.barcode_order_id.localeCompare(b.barcode_order_id));

  return NextResponse.json({ groups, store_id: storeId });
}
