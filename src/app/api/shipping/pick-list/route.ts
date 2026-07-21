import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getOrderById } from '@/lib/tiktok/client';
import { getFreshToken, refreshConnection, isExpiredCredsError, type ConnRow } from '@/lib/tiktok/tokens';

export const dynamic = 'force-dynamic';

// Statuses that must NOT be packed into the box: cancelled/held (never ship) and already-gone
// (re-picking = over-pick). Everything else — AWAITING_COLLECTION / AWAITING_SHIPMENT — is packable.
const DO_NOT_PACK = new Set(['CANCELLED', 'ON_HOLD', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED']);

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
  type SeedRow = { order_id: string; auto_combine_group_id: string | null; tracking_number: string | null; store_id: string | null; status: string | null };
  const SEL = 'order_id, auto_combine_group_id, tracking_number, store_id, status';
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
  // CAT4 store scope: a physical box is one store's orders. Both stores share a user_id, so
  // scope every box query to the seed's store_id — a tracking can never pull a different store.
  const storeId: string | null = seed[0].store_id ?? null;

  const boxRows = new Map<string, SeedRow>();
  seed.forEach((s) => boxRows.set(String(s.order_id), s));
  // (a) same tracking = same physical package. Authoritative — must never be under-counted.
  if (boxTrackings.length) {
    let q = supabase.from('synced_order_ids').select(SEL).eq('user_id', user.id).in('tracking_number', boxTrackings);
    if (storeId) q = q.eq('store_id', storeId);
    const { data } = await q;
    (data ?? []).forEach((r) => boxRows.set(String(r.order_id), r as SeedRow));
  }
  // (b) fallback: same combine-group. Only add a group sibling whose tracking is null or one
  //   of the box's trackings — so a group that ever spanned packages can't pull an order from
  //   ANOTHER box (prevalence check: 0 such groups today; this stays correct if that changes).
  if (boxGroups.length) {
    let q = supabase.from('synced_order_ids').select(SEL).eq('user_id', user.id).in('auto_combine_group_id', boxGroups);
    if (storeId) q = q.eq('store_id', storeId);
    const { data } = await q;
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

  // ── 2b) SCAN-TIME LIVE STATUS REFRESH (CAT9). Stored status is materially stale (~60% of
  //   older AWAITING_COLLECTION rows have already moved on), and an order cancelled AFTER the
  //   last sync would still read "active" in our DB → we'd over-pick a refunded item. So fetch
  //   AUTHORITATIVE live status for the box and classify on it. Applied to the FINAL assembled
  //   set, so it also catches cancelled orders that entered via the group fallback (null tracking).
  //   Degrade: if the API is unavailable/partial, fall back to stored status + a loud warning.
  const liveStatus = new Map<string, string>();
  let statusUnverified = false;
  try {
    const admin = createAdminClient();
    let connQ = admin.from('tiktok_connections')
      .select('id, access_token, refresh_token, shop_cipher, token_expires_at')
      .eq('user_id', user.id);
    if (storeId) connQ = connQ.eq('store_id', storeId);
    const { data: conn } = await connQ.maybeSingle();
    if (!conn?.access_token || !conn?.shop_cipher) throw new Error('no connection for store');
    const connRow = conn as ConnRow;
    const fresh = await getFreshToken(admin, connRow, { skewMinutes: 30 });
    let token = fresh.accessToken;
    const cipher = connRow.shop_cipher as string;
    let refreshedOnce = false;
    // getOrderById accepts ≤50 ids/call; 105002 refresh-on-use + light retry (reconcile pattern).
    for (let i = 0; i < orderIds.length; i += 50) {
      const chunk = orderIds.slice(i, i + 50);
      let got: Record<string, unknown>[] | null = null;
      for (let attempt = 1; attempt <= 3 && !got; attempt++) {
        try { got = await getOrderById(token, cipher, chunk); }
        catch (e) {
          if (!refreshedOnce && isExpiredCredsError(e)) {
            refreshedOnce = true;
            try { token = (await refreshConnection(admin, connRow)).accessToken; continue; } catch { /* fall through */ }
          }
          if (attempt >= 3) throw e;
          await new Promise((r) => setTimeout(r, 500 * attempt));
        }
      }
      for (const o of got ?? []) liveStatus.set(String(o.id), String(o.status || ''));
    }
    // Any order the API didn't return → we'd be trusting its (possibly stale) stored status,
    // so flag the whole pass as unverified rather than silently trust partial data.
    if (orderIds.some((id) => !liveStatus.has(id))) statusUnverified = true;
  } catch {
    statusUnverified = true; // degrade → stored status below + loud warning in the response
  }

  // Effective status: live when we have it, else stored. Partition the box into pick vs do-not-pack.
  const effStatus = (id: string) => liveStatus.get(id) ?? boxRows.get(id)?.status ?? '';
  const pickOrderIds = orderIds.filter((id) => !DO_NOT_PACK.has(effStatus(id)));
  const excludedOrderIds = orderIds.filter((id) => DO_NOT_PACK.has(effStatus(id)));

  // 3) Bound auction items for ALL box orders; map item→order so SKUs attribute to their order
  //    (needed to split pickable SKUs from the excluded "would-have-packed" list).
  const { data: items } = await supabase
    .from('live_auction_items')
    .select('id, client_idempotency_key')
    .eq('user_id', user.id)
    .in('client_idempotency_key', orderIds);
  const itemRows = items ?? [];
  const itemToOrder = new Map<string, string>(itemRows.map((i) => [String(i.id), String(i.client_idempotency_key)]));
  const itemIds = itemRows.map((i) => i.id);
  const orderIdsWithItems = new Set(itemRows.map((i) => String(i.client_idempotency_key)));
  // Unbound wins among PICKABLE orders only (an excluded order's binding is irrelevant to picking).
  const missingOrderIds = pickOrderIds.filter((id) => !orderIdsWithItems.has(id));

  // 4) SKU lines, attributed to their order via auction_item_id. Snapshot fields are the
  //    authoritative "what was sold" (survive later inventory edits/deletes).
  type Line = { order_id: string; inventory_sku_id: string; sku_number: number | null; title: string; qty: number };
  const lines: Line[] = [];
  if (itemIds.length) {
    const { data: raw2 } = await supabase
      .from('live_auction_item_skus')
      .select('auction_item_id, inventory_sku_id, qty, sku_number_snapshot, title_snapshot')
      .eq('user_id', user.id)
      .in('auction_item_id', itemIds);
    for (const l of raw2 ?? []) {
      const oid = itemToOrder.get(String(l.auction_item_id));
      if (!oid) continue;
      lines.push({
        order_id: oid,
        inventory_sku_id: String(l.inventory_sku_id),
        sku_number: (l.sku_number_snapshot as number | null) ?? null,
        title: (l.title_snapshot as string | null) || 'Untitled',
        qty: Number(l.qty) || 1,
      });
    }
  }

  // PICKABLE aggregation: only lines from pickable orders, summed per inventory SKU across the box.
  const pickSet = new Set(pickOrderIds);
  const agg = new Map<string, { sku_number: number | null; title: string; qty: number }>();
  for (const l of lines) {
    if (!pickSet.has(l.order_id)) continue;
    const cur = agg.get(l.inventory_sku_id) ?? { sku_number: l.sku_number, title: l.title, qty: 0 };
    cur.qty += l.qty;
    agg.set(l.inventory_sku_id, cur);
  }

  // 5) Best-effort inventory enrichment (barcode for item-verify + thumbnail) for pickable SKUs.
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

  // EXCLUDED (do-not-pack) orders, kept VISIBLE so screen ⟷ paper slip stays reconciled.
  const linesByOrder = new Map<string, string[]>();
  for (const l of lines) {
    const arr = linesByOrder.get(l.order_id) ?? [];
    arr.push(`#${l.sku_number ?? '?'} ${l.title} x${l.qty}`);
    linesByOrder.set(l.order_id, arr);
  }
  const excluded = excludedOrderIds.map((id) => ({
    order_id: id,
    reason: effStatus(id) || 'UNKNOWN',   // CANCELLED / ON_HOLD / IN_TRANSIT / DELIVERED / COMPLETED
    skus: linesByOrder.get(id) ?? [],      // what would have been packed — for the picker's awareness
  }));

  // 6) Already verified? (keyed by the physical-box idempotency key)
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
    order_ids: pickOrderIds,           // pickable only — what confirm/verify covers
    order_count: pickOrderIds.length,  // "N SKUs across M orders" counts pickable orders only
    skus,
    missing_order_ids: missingOrderIds,
    excluded,                          // do-not-pack, flagged (cancelled / on-hold / already-shipped)
    excluded_count: excluded.length,
    status_unverified: statusUnverified, // true → frontend shows the loud stale-status warning
    already_verified_at: verified?.verified_at ?? null,
  });
}
