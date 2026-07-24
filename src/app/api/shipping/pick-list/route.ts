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

// USPS IMpb mod-10 check digit, computed over the first 21 of a 22-digit tracking.
// (Rightmost of the 21 weighted ×3, then alternating ×1/×3.) Used to disambiguate the
// canonical tracking when a scanned barcode carries extra padding digits.
function uspsTrackingValid(t: string): boolean {
  if (!/^\d{22}$/.test(t)) return false;
  let sum = 0;
  for (let i = 0; i < 21; i++) sum += Number(t[i]) * (((20 - i) % 2 === 0) ? 3 : 1);
  return ((10 - (sum % 10)) % 10) === Number(t[21]);
}

// USPS IMpb mod-10 check digit for a 21-digit stem (same weighting uspsTrackingValid
// verifies against: rightmost of the 21 ×3, then alternating ×1/×3).
function uspsCheckDigit(first21: string): string {
  let sum = 0;
  for (let i = 0; i < 21; i++) sum += Number(first21[i]) * (((20 - i) % 2 === 0) ? 3 : 1);
  return String((10 - (sum % 10)) % 10);
}

// The canonical 22-digit tracking form(s) of a scanned 22-digit region:
//   • already CHECK-VALID → it IS canonical; return ONLY itself (never also emit
//     collapsed variants, so a clean scan can never be turned ambiguous — no regression).
//   • NOT check-valid → the barcode padded the serial with an extra zero inside a
//     zero-RUN (the exactly-22 form the labels fail on today). Remove ONE zero from each
//     maximal run (≥2) → a 21-digit stem → RECOMPUTE the IMpb check digit → a check-valid
//     22-digit canonical. Runs only (a lone zero isn't treated as padding). Every result
//     is check-valid by construction; a WRONG (mis-routed) match is prevented downstream
//     by requiring the candidate to EXIST in the DB and resolve to a SINGLE tracking.
function canonicalizeFrom22(w: string): string[] {
  if (!/^9[2-5]\d{20}$/.test(w)) return [];
  if (uspsTrackingValid(w)) return [w];
  const out = new Set<string>();
  for (const m of w.matchAll(/0{2,}/g)) {
    const idx = m.index ?? -1;
    if (idx < 0) continue;
    const stem = w.slice(0, idx) + w.slice(idx + 1); // drop one zero from the run → 21 digits
    if (stem.length !== 21 || !/^9[2-5]/.test(stem)) continue;
    out.add(stem + uspsCheckDigit(stem));
  }
  return [...out];
}

// All CHECK-VALID canonical tracking candidates for a scanned string (a SET — we never
// guess a single one). The resolver looks up `tracking_number IN candidates` and only
// proceeds when they map to a SINGLE stored tracking, so a padded barcode reconciles to
// the canonical form the DB stores while ambiguity fails safe (empty → order_id / null).
// Handles: bare 22-digit; "420"+ZIP(5/9)+22-digit routing labels; the EXACTLY-22 padded
// form (today's failing labels); and the >22 over-length padded form (HAZMAT).
function normalizeTrackingCandidates(digits: string): string[] {
  const out = new Set<string>();
  // Candidate regions: the whole string, and after stripping "420" + ZIP5 / ZIP+4 routing.
  const regions = new Set<string>([digits]);
  if (digits.startsWith('420')) { regions.add(digits.slice(8)); regions.add(digits.slice(12)); }
  for (const region of regions) {
    const start = region.search(/9[2-5]/);
    if (start < 0) continue;
    const tail = region.slice(start);
    if (tail.length === 22) {
      // Exactly 22 → valid returns itself; padded (invalid) returns the collapsed canonical.
      for (const c of canonicalizeFrom22(tail)) out.add(c);
    } else if (tail.length > 22 && tail.length <= 26) {
      // Over-length: collapse the longest zero-run until a check-VALID 22 remains (never
      // recomputes a check here — an over-length label already contains its real check).
      let s = tail;
      while (s.length > 22) {
        let best = -1, bestLen = 0; const re = /0+/g; let mm: RegExpExecArray | null;
        while ((mm = re.exec(s))) if (mm[0].length > bestLen) { bestLen = mm[0].length; best = mm.index; }
        if (best < 0) break;
        s = s.slice(0, best) + s.slice(best + 1);
      }
      if (s.length === 22 && /^9[2-5]/.test(s) && uspsTrackingValid(s)) out.add(s);
    }
  }
  return [...out];
}

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
  //   (a) USPS IMpb shipping label: "420" + ZIP(5 or 9) + 22-digit tracking (incl. HAZMAT
  //       labels that pad the serial with an extra zero — see normalizeTracking).
  //   (b) A bare 22-digit USPS tracking number (the tracking barcode scanned on its own).
  //   (c) A raw TikTok order_id (16–20 digits) — the original / back-compat path.
  const digits = raw.replace(/\s/g, '');
  // Canonical, check-valid tracking candidates (reconciles padded barcodes to the
  // form the DB stores). A SET — resolution below requires a SINGLE stored match.
  const trackingCandidates = normalizeTrackingCandidates(digits);
  const tracking = trackingCandidates[0] ?? null; // representative, for display / resolved_via

  // Seed rows for the scan. A tracking (physical label) maps to MANY orders — do NOT
  // limit(1): that made which box rendered arbitrary/nondeterministic. Pull them all.
  type SeedRow = { order_id: string; auto_combine_group_id: string | null; tracking_number: string | null; store_id: string | null; status: string | null; sku_name: string | null };
  const SEL = 'order_id, auto_combine_group_id, tracking_number, store_id, status, sku_name';
  let resolvedVia: 'tracking' | 'order_id' = trackingCandidates.length ? 'tracking' : 'order_id';
  let seed: SeedRow[] = [];
  if (trackingCandidates.length) {
    const { data } = await supabase.from('synced_order_ids').select(SEL)
      .eq('user_id', user.id).in('tracking_number', trackingCandidates);
    const rows = (data ?? []) as SeedRow[];
    // CONSERVATIVE: a padded scan can yield several canonical candidates. Only proceed
    // if they resolve to a SINGLE stored tracking. If candidates matched MORE THAN ONE
    // distinct tracking_number, the collapse is ambiguous — refuse to guess (a wrong
    // match could mis-route a package); leave seed empty → order_id fallback / no-match.
    const distinctTrk = new Set(rows.map((r) => r.tracking_number).filter((t): t is string => !!t));
    if (distinctTrk.size <= 1) seed = rows;
  }
  // Order-id fallback. Runs when the scan wasn't a tracking AND (belt-and-suspenders) when a
  // parsed tracking matched nothing — the label's tracking was never synced (today ~93% of
  // synced_order_ids rows have a NULL tracking_number, so tracking lookup misses most orders).
  // Harmless when `digits` isn't a real order_id: it simply finds no row. The picker's
  // practical path for such labels is to scan the packing-slip ORDER-ID barcode.
  if (!seed.length && /^\d{6,}$/.test(digits)) {
    const { data } = await supabase.from('synced_order_ids').select(SEL)
      .eq('user_id', user.id).eq('order_id', digits).maybeSingle();
    if (data) { seed = [data as SeedRow]; resolvedVia = 'order_id'; }
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
  // Captured from the SAME getOrderById response (no extra call) to enrich unbound orders
  // with a listing name + seller-SKU for the up-front alert. First line item is representative.
  const orderDetail = new Map<string, { product_name: string; seller_sku: string }>();
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
      for (const o of got ?? []) {
        liveStatus.set(String(o.id), String(o.status || ''));
        const li = (o.line_items as Record<string, unknown>[] | undefined)?.[0];
        if (li) orderDetail.set(String(o.id), { product_name: String(li.product_name || ''), seller_sku: String(li.seller_sku || '') });
      }
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

  // 6b) Enrich unbound (missing) orders with a listing name + seller-SKU for the up-front
  //     alert screen. NO new TikTok call — sources are (a) the getOrderById line items already
  //     fetched above, (b) capture_events for captured-unbound, (c) the synced sku_name.
  //     seller_sku is often empty (listing-dependent) → fall back to sku_name.
  const capByOrder = new Map<string, { product_name: string | null; platform_sku_ref: string | null }>();
  if (missingOrderIds.length) {
    const { data: caps } = await supabase
      .from('capture_events')
      .select('order_id, product_name, platform_sku_ref')
      .eq('user_id', user.id)
      .in('order_id', missingOrderIds);
    for (const c of caps ?? []) {
      const k = String(c.order_id);
      if (!capByOrder.has(k)) capByOrder.set(k, { product_name: (c.product_name as string | null) ?? null, platform_sku_ref: (c.platform_sku_ref as string | null) ?? null });
    }
  }
  const missing_orders = missingOrderIds.map((id) => {
    const d = orderDetail.get(id);
    const c = capByOrder.get(id);
    const sr = boxRows.get(id);
    const listing_name = (d?.product_name && d.product_name.trim()) || (c?.product_name && c.product_name.trim()) || sr?.sku_name || null;
    const sellerRaw = (d?.seller_sku && d.seller_sku.trim()) || (c?.platform_sku_ref && String(c.platform_sku_ref).trim()) || '';
    const seller_sku = sellerRaw || (sr?.sku_name ?? null); // fall back to variant/sku_name when TikTok seller_sku is empty
    return { order_id: id, listing_name, seller_sku };
  });

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
    missing_order_ids: missingOrderIds,          // back-compat (bare ids)
    missing_orders,                              // enriched: { order_id, listing_name, seller_sku }
    excluded,                          // do-not-pack, flagged (cancelled / on-hold / already-shipped)
    excluded_count: excluded.length,
    status_unverified: statusUnverified, // true → frontend shows the loud stale-status warning
    already_verified_at: verified?.verified_at ?? null,
  });
}
