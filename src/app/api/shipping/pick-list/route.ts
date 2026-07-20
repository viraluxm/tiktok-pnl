import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const BUCKET = 'inventory-thumbnails';

// POST: resolve a packing "box" from a scanned slip order_id.
//
// Flow (all reads from our own DB):
//   order_id → synced_order_ids.auto_combine_group_id
//          → all sibling order_ids sharing that group (the whole box)
//          → live_auction_items (client_idempotency_key = order_id)
//          → live_auction_item_skus → inventory_skus
//   aggregated into one block per SKU with the total required qty across the box.
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { scan?: string; orderId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  // Accept `scan` (raw scanned value: a shipping label OR an order id). `orderId` is kept
  // for backward-compat with older clients that sent the order id directly.
  const raw = (typeof body.scan === 'string' ? body.scan : typeof body.orderId === 'string' ? body.orderId : '').trim();
  if (!raw) return NextResponse.json({ error: 'Scan a shipping label or order ID' }, { status: 400 });

  // ── 1) Resolve the scanned value → one of our order rows. Three shapes:
  //   (a) USPS IMpb shipping label: "420" + ZIP(5 or 9) + 22-digit tracking. The tracking
  //       is the trailing 22 digits — slice(-22) == slice(8) for ZIP5 and is also correct
  //       for ZIP+4, so it's more robust than a fixed 8-char strip.
  //   (b) A bare 22-digit USPS tracking number (the tracking barcode scanned on its own).
  //   (c) A raw TikTok order_id (16–20 digits) — the original / back-compat path.
  const digits = raw.replace(/\s/g, '');
  let tracking: string | null = null;
  if (/^420\d{27,}$/.test(digits)) tracking = digits.slice(-22);        // (a) IMpb label
  else if (/^9\d{21}$/.test(digits)) tracking = digits;                 // (b) bare tracking

  // Seed rows for the scan. A tracking (physical label) maps to MANY orders — do NOT
  // limit(1): that made which box rendered arbitrary/nondeterministic. Pull them all.
  type SeedRow = { order_id: string; auto_combine_group_id: string | null; tracking_number: string | null };
  const SEL = 'order_id, auto_combine_group_id, tracking_number';
  const resolvedVia: 'tracking' | 'order_id' = tracking ? 'tracking' : 'order_id';
  let seed: SeedRow[] = [];
  if (tracking) {
    const { data } = await supabase.from('synced_order_ids').select(SEL)
      .eq('user_id', user.id).eq('tracking_number', tracking);
    seed = (data ?? []) as SeedRow[];
  } else {
    const { data } = await supabase.from('synced_order_ids').select(SEL)
      .eq('user_id', user.id).eq('order_id', digits).maybeSingle();
    if (data) seed = [data as SeedRow];
  }
  if (!seed.length) {
    // Echo exactly what was scanned (+ the parsed tracking) so the picker can flag it.
    return NextResponse.json(
      { error: 'No matching order', scanned_value: raw, parsed_tracking: tracking, resolved_via: resolvedVia },
      { status: 404 },
    );
  }

  // ── 2) Resolve the FULL physical box. The box is the physical PACKAGE; its authoritative
  //   key is tracking_number (one label = one package). TikTok can split one package across
  //   MULTIPLE auto_combine_group_ids, so grouping by combine-group alone SILENTLY under-shows
  //   the box → the picker omits an order's items → wrong shipment. So resolve by TRACKING
  //   (primary, never under-counted) UNION combine-group (fallback for rows whose tracking
  //   isn't populated yet — older / pre-backfill / unshipped edge cases).
  const boxTrackings = [...new Set(seed.map((s) => s.tracking_number).filter((t): t is string => !!t))];
  const boxGroups = [...new Set(seed.map((s) => s.auto_combine_group_id).filter((g): g is string => !!g))];

  const boxRows = new Map<string, SeedRow>();
  seed.forEach((s) => boxRows.set(String(s.order_id), s));
  // (a) same tracking = same physical package. Authoritative — must never be under-counted.
  if (boxTrackings.length) {
    const { data } = await supabase.from('synced_order_ids').select(SEL)
      .eq('user_id', user.id).in('tracking_number', boxTrackings);
    (data ?? []).forEach((r) => boxRows.set(String(r.order_id), r as SeedRow));
  }
  // (b) fallback: same combine-group. Only add a group sibling whose tracking is null or one
  //   of the box's trackings — so a group that ever spanned packages can't pull an order from
  //   ANOTHER box (prevalence check: 0 such groups today; this stays correct if that changes).
  if (boxGroups.length) {
    const { data } = await supabase.from('synced_order_ids').select(SEL)
      .eq('user_id', user.id).in('auto_combine_group_id', boxGroups);
    for (const r of (data ?? []) as SeedRow[]) {
      const t = r.tracking_number;
      if (!boxTrackings.length || t === null || boxTrackings.includes(t)) boxRows.set(String(r.order_id), r);
    }
  }

  const orderIds = [...boxRows.keys()];
  const orderId = String(seed[0].order_id); // representative (scanned) order, for display
  const groupId: string | null = boxGroups[0] ?? null;
  // Stable idempotency key for the physical box: tracking (label) when present, else the
  // combine-group, else the single order. Drives the verify/confirm dedup below.
  const groupKey = boxTrackings[0] ? `trk:${boxTrackings[0]}` : (groupId ?? `order:${orderId}`);

  // 3) Bound auction items for those orders (client_idempotency_key = order_id).
  const { data: items } = await supabase
    .from('live_auction_items')
    .select('id, client_idempotency_key, status')
    .eq('user_id', user.id)
    .in('client_idempotency_key', orderIds);
  const itemRows = items ?? [];
  const itemIds = itemRows.map((i) => i.id);
  const orderIdsWithItems = new Set(itemRows.map((i) => String(i.client_idempotency_key)));
  // A win that was never bound during the live → no auction item for its order.
  const missingOrderIds = orderIds.filter((id) => !orderIdsWithItems.has(id));

  // 4) SKU lines for those items. Snapshot fields (sku_number_snapshot / title_snapshot)
  //    are the authoritative "what was sold" — they survive later inventory edits/deletes.
  //    Aggregate required qty per inventory SKU across the whole box.
  const agg = new Map<string, { sku_number: number | null; title: string; qty: number }>();
  if (itemIds.length) {
    const { data: lines } = await supabase
      .from('live_auction_item_skus')
      .select('inventory_sku_id, qty, sku_number_snapshot, title_snapshot')
      .eq('user_id', user.id)
      .in('auction_item_id', itemIds);
    for (const l of lines ?? []) {
      const key = String(l.inventory_sku_id);
      const cur = agg.get(key) ?? {
        sku_number: (l.sku_number_snapshot as number | null) ?? null,
        title: (l.title_snapshot as string | null) || 'Untitled',
        qty: 0,
      };
      cur.qty += Number(l.qty) || 1;
      agg.set(key, cur);
    }
  }

  // 5) Best-effort enrichment from live inventory: barcode (drives the item-verify scan)
  //    + thumbnail. Number/title/qty come from the snapshot, so a SKU still displays even
  //    if its inventory row was deleted (barcode just null → can't green-verify, still pick).
  const skuIds = [...agg.keys()];
  const invById = new Map<string, { barcode: string | null; thumbnail_url: string | null }>();
  if (skuIds.length) {
    const { data: inv } = await supabase
      .from('inventory_skus')
      .select('id, barcode, thumbnail_path')
      .eq('user_id', user.id)
      .in('id', skuIds);
    for (const s of inv ?? []) {
      const path = (s.thumbnail_path as string | null) ?? null;
      invById.set(String(s.id), {
        barcode: (s.barcode as string | null) ?? null,
        thumbnail_url: path ? supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl : null,
      });
    }
  }
  const skus = skuIds
    .map((id) => {
      const a = agg.get(id)!;
      const inv = invById.get(id);
      return {
        inventory_sku_id: id,
        sku_number: a.sku_number,
        title: a.title,
        barcode: inv?.barcode ?? null,
        thumbnail_url: inv?.thumbnail_url ?? null,
        required_qty: a.qty,
      };
    })
    // Stable order: lowest SKU# first.
    .sort((a, b) => (Number(a.sku_number) || 0) - (Number(b.sku_number) || 0));

  // 6) Already verified?
  const { data: verified } = await supabase
    .from('shipment_verifications')
    .select('verified_at')
    .eq('user_id', user.id)
    .eq('group_key', groupKey)
    .maybeSingle();

  return NextResponse.json({
    scanned_value: raw,
    resolved_via: resolvedVia,       // 'tracking' (shipping label) | 'order_id'
    tracking_number: tracking,        // the parsed tracking when resolved via a label
    scanned_order_id: orderId,
    group_key: groupKey,
    group_id: groupId,
    order_ids: orderIds,
    order_count: orderIds.length,
    skus,
    missing_order_ids: missingOrderIds,
    already_verified_at: verified?.verified_at ?? null,
  });
}
