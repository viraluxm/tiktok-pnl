import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { routePositionMap, sectionRoutePosition, pickerLabel } from '@/lib/mapping/route';
import { createAdminClient } from '@/lib/supabase/admin';
import { getOrderById } from '@/lib/tiktok/client';
import { getFreshToken, refreshConnection, isExpiredCredsError, type ConnRow } from '@/lib/tiktok/tokens';

export const dynamic = 'force-dynamic';

// Append-only scan log — fire-and-forget via the service role. LOG ONLY: a logging failure must
// NEVER block or fail a scan, so this never awaits and never throws. The RAW scanned string is the
// point (diagnose scanner formatting issues, e.g. GS1-128 AI prefixes).
function logScan(fields: { user_id: string; store_id: string | null; raw_scan: string; resolved: boolean; group_key: string | null; set_aside: boolean; error: string | null }) {
  try { void createAdminClient().from('scan_log').insert(fields).then(undefined, () => {}); } catch { /* never block a scan */ }
}

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

// Normalize a scanned shipping-label / tracking string to the canonical 22-digit USPS IMpb
// tracking (starts 92/93/94/95). Returns null when the scan isn't a tracking → order_id path.
// Handles three real-world barcode shapes:
//   • bare 22-digit tracking scanned on its own;
//   • "420" + ZIP(5 or 9) + 22-digit IMpb concatenated routing label (tracking is a clean
//     22-digit, check-valid substring);
//   • HAZMAT-style labels whose barcode pads the serial with an EXTRA leading zero, so the
//     tracking region is 23+ digits and the printed human-readable tracking is NOT a contiguous
//     substring. We recover it deterministically by collapsing the longest zero-run one digit
//     at a time until a check-valid 22-digit form remains.
//     e.g. "4208914992362903942203000007067" → "9236290394220300007067".
function normalizeTracking(digits: string): string | null {
  if (/^9[2-5]\d{20}$/.test(digits)) return digits;               // bare canonical tracking
  // Candidate regions: the whole string, and after stripping "420" + ZIP5 / ZIP+4 routing.
  const regions = [digits];
  if (digits.startsWith('420')) { regions.push(digits.slice(8)); regions.push(digits.slice(12)); }
  for (const region of regions) {
    // (1) a clean 22-digit window starting 9[2-5] that passes the USPS check digit.
    for (let i = 0; i + 22 <= region.length; i++) {
      if (!/^9[2-5]/.test(region.slice(i, i + 2))) continue;
      const win = region.slice(i, i + 22);
      if (uspsTrackingValid(win)) return win;
    }
    // (2) over-length region (barcode padded the serial with extra zeros): collapse the
    //     longest zero-run until 22 digits remain, then require a valid check digit. Only
    //     fires when no clean window validated, so it never rewrites a legitimate tracking.
    const start = region.search(/9[2-5]/);
    if (start >= 0 && region.length - start > 22 && region.length - start <= 26) {
      let s = region.slice(start);
      while (s.length > 22) {
        let best = -1, bestLen = 0; const re = /0+/g; let mm: RegExpExecArray | null;
        while ((mm = re.exec(s))) if (mm[0].length > bestLen) { bestLen = mm[0].length; best = mm.index; }
        if (best < 0) break;                                       // no zeros to collapse
        s = s.slice(0, best) + s.slice(best + 1);                  // drop one zero from the longest run
      }
      if (s.length === 22 && /^9[2-5]/.test(s) && uspsTrackingValid(s)) return s;
    }
  }
  return null;
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
  const tracking = normalizeTracking(digits);

  // Seed rows for the scan. A tracking (physical label) maps to MANY orders — do NOT
  // limit(1): that made which box rendered arbitrary/nondeterministic. Pull them all.
  type SeedRow = { order_id: string; auto_combine_group_id: string | null; tracking_number: string | null; store_id: string | null; status: string | null; sku_name: string | null; tiktok_product_id: string | null; units: number | null };
  const SEL = 'order_id, auto_combine_group_id, tracking_number, store_id, status, sku_name, tiktok_product_id, units';
  let resolvedVia: 'tracking' | 'order_id' = tracking ? 'tracking' : 'order_id';
  let seed: SeedRow[] = [];
  if (tracking) {
    const { data } = await supabase.from('synced_order_ids').select(SEL)
      .eq('user_id', user.id).eq('tracking_number', tracking);
    seed = (data ?? []) as SeedRow[];
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
    logScan({ user_id: user.id, store_id: null, raw_scan: raw, resolved: false, group_key: null, set_aside: false, error: 'No matching order' });
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
  // CAT4 multi-store: the live-status refresh needs the order's OWN store connection. If the
  // scanned order has NO store attribution (store_id NULL) we must NOT fall back to an
  // unfiltered tiktok_connections lookup — LATENT 2-CONNECTION BUG: with 2+ connected stores
  // that query matches multiple rows and .maybeSingle() errors, which used to surface to the
  // packer as a misleading "no connection for store". Fail loud with the real cause instead;
  // never guess a connection.
  if (!storeId) {
    return NextResponse.json(
      { error: `Order ${orderId} has no store attribution (store_id is null), so its live TikTok status can't be verified. Fix this order's store mapping, then re-scan.` },
      { status: 409 },
    );
  }
  try {
    const admin = createAdminClient();
    // storeId is guaranteed non-null here (guarded above) — always scope to the order's store,
    // so .maybeSingle() can only ever match that one store's connection, never all of them.
    const { data: conn } = await admin.from('tiktok_connections')
      .select('id, access_token, refresh_token, shop_cipher, token_expires_at')
      .eq('user_id', user.id)
      .eq('store_id', storeId)
      .maybeSingle();
    if (!conn?.access_token || !conn?.shop_cipher) throw new Error(`no connection for store ${storeId}`);
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
  type Line = { order_id: string; inventory_sku_id: string; sku_number: number | null; title: string; qty: number; short_at_bind: boolean };
  const lines: Line[] = [];
  if (itemIds.length) {
    const { data: raw2 } = await supabase
      .from('live_auction_item_skus')
      .select('auction_item_id, inventory_sku_id, qty, sku_number_snapshot, title_snapshot, short_at_bind')
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
        // null (pre-dates migration 104, or not a sale) reads as NOT short.
        short_at_bind: l.short_at_bind === true,
      });
    }
  }

  // PICKABLE aggregation: only lines from pickable orders, summed per inventory SKU across the box.
  const pickSet = new Set(pickOrderIds);
  // shelf_out is OR'd across the box's contributing lines: one short line makes the box short.
  const agg = new Map<string, { sku_number: number | null; title: string; qty: number; short: boolean }>();
  for (const l of lines) {
    if (!pickSet.has(l.order_id)) continue;
    const cur = agg.get(l.inventory_sku_id) ?? { sku_number: l.sku_number, title: l.title, qty: 0, short: false };
    cur.qty += l.qty;
    cur.short = cur.short || l.short_at_bind;
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
  // 5b) WHERE each SKU lives, and therefore what order to walk them in.
  //
  // This is the whole point of the mapping work: pick lines used to come back ordered by
  // sku_number, which is a catalogue identity with no relationship to the floor, so a
  // multi-SKU box sent the picker back and forth. Now they come back in walking order.
  //
  // A SKU can sit in more than one section (both faces of a rack, or two places entirely).
  // The picker is sent to whichever comes FIRST on the route, and every one of its slot codes
  // is accepted as a scan — walking to the other face is not an error.
  //
  // NOTE the start corner is not persisted anywhere yet, so this uses the same 'top-left'
  // default the Mapping tab opens with. If the owner changes it there, the picker's route is
  // unaffected until that setting has somewhere to live. Flagged rather than hidden: the
  // ORDER of stops is right either way, it is only which end you begin from that can differ.
  const locBySku = new Map<string, { label: string; position: number; codes: string[] }>();
  if (skuIds.length) {
    const [{ data: racks }, { data: mapSlots }] = await Promise.all([
      supabase
        .from('pick_racks')
        .select('id, name, grid_row, grid_col, route_pos_a, route_pos_b, is_active')
        .eq('user_id', user.id),
      supabase
        .from('pick_slots')
        .select('rack_id, shelf_index, section_index, side, slot_code, inventory_sku_id')
        .eq('user_id', user.id)
        .in('inventory_sku_id', skuIds),
    ]);

    const positions = routePositionMap(racks ?? []);
    const rackById = new Map((racks ?? []).map((r) => [r.id as string, r]));

    for (const slot of mapSlots ?? []) {
      const skuId = slot.inventory_sku_id as string;
      const rack = rackById.get(slot.rack_id as string);
      if (!rack) continue;
      const side = slot.side as 'A' | 'B' | 'AB';
      const pos = sectionRoutePosition(positions, rack.id as string, side);
      const prev = locBySku.get(skuId);
      const codes = [...(prev?.codes ?? []), slot.slot_code as string];
      // Nearest stop wins the label; every slot's code stays acceptable.
      if (pos == null) {
        locBySku.set(skuId, prev ? { ...prev, codes } : { label: '', position: Infinity, codes });
        continue;
      }
      const label = pickerLabel(
        rack.name as string,
        side === 'AB' ? 'A' : side,
        slot.shelf_index as number,
      );
      if (!prev || pos < prev.position) locBySku.set(skuId, { label, position: pos, codes });
      else locBySku.set(skuId, { ...prev, codes });
    }
  }

  const skus = skuIds
    .map((id) => {
      const a = agg.get(id)!;
      const inv = invById.get(id);
      const loc = locBySku.get(id);
      return {
        inventory_sku_id: id,
        sku_number: a.sku_number,
        title: a.title,
        barcode: inv?.barcode ?? null,
        thumbnail_url: inv?.thumbnail_url ?? null,
        required_qty: a.qty,
        shelf_out: a.short,
        // null when the SKU has no section yet — the device shows no guidance rather than
        // guessing, and these sort last.
        location_label: loc?.label || null,
        slot_codes: loc?.codes ?? [],
      };
    })
    // Walking order. Unmapped SKUs fall to the END and keep the old lowest-SKU#-first order
    // among themselves, so a partly-mapped catalogue is strictly better than an unmapped one
    // and never worse.
    .sort((x, y) => {
      const px = locBySku.get(x.inventory_sku_id)?.position ?? Infinity;
      const py = locBySku.get(y.inventory_sku_id)?.position ?? Infinity;
      if (px !== py) return px - py;
      return (Number(x.sku_number) || 0) - (Number(y.sku_number) || 0);
    });

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
  // ── 6c) THREE-WAY ORDER TYPE (Phase-0 discriminator, structural — no title matching):
  //   bound auction   → has a bound SKU (in `skus`); pick from the internal snapshot.
  //   unbound auction → captured during a live (capture_events) but never bound → SET ASIDE.
  //   catalog         → never captured; a normal pre-listed sale → PICKABLE (real listing +
  //     seller SKU). GUARD against capture-less auction items (the extension ran unauthenticated
  //     and discarded captures, leaving auction orders with no capture_events): a no-capture order
  //     is catalog ONLY when its listing is NOT also used by auction sales (tiktok_product_id absent
  //     from capture_events) AND it has a products.name; otherwise it fails SAFE to unbound. This is
  //     the SAME guard as the pick ticket — capByOrder (fetched above) is the capture signal.
  const candidatePids = [...new Set(missingOrderIds.filter((id) => !capByOrder.has(id)).map((id) => boxRows.get(id)?.tiktok_product_id).filter((p): p is string => !!p))];
  const auctionPidSet = new Set<string>();
  const productNameByPid = new Map<string, string>();
  if (candidatePids.length) {
    const { data: ap } = await supabase.from('capture_events').select('tiktok_product_id').eq('user_id', user.id).in('tiktok_product_id', candidatePids);
    for (const r of ap ?? []) auctionPidSet.add(String(r.tiktok_product_id));
    const { data: pn } = await supabase.from('products').select('tiktok_product_id, name').eq('user_id', user.id).in('tiktok_product_id', candidatePids);
    for (const p of pn ?? []) productNameByPid.set(String(p.tiktok_product_id), ((p.name as string | null) ?? '').trim());
  }
  const isCatalog = (id: string): boolean => {
    if (capByOrder.has(id)) return false;                  // captured → auction (unbound)
    const pid = boxRows.get(id)?.tiktok_product_id ?? '';
    const name = pid ? productNameByPid.get(pid) : '';
    return !!pid && !auctionPidSet.has(pid) && !!name;     // no-capture, non-auction listing, real name
  };
  const catalogIds = missingOrderIds.filter(isCatalog);
  const unboundIds = missingOrderIds.filter((id) => !isCatalog(id));

  // Shared display enrichment. For catalog the live product_name IS the real listing name.
  const displayOf = (id: string) => {
    const d = orderDetail.get(id);
    const c = capByOrder.get(id);
    const sr = boxRows.get(id);
    const pid = sr?.tiktok_product_id ?? '';
    const listing_name = (d?.product_name && d.product_name.trim()) || (pid ? productNameByPid.get(pid) || '' : '') || (c?.product_name && c.product_name.trim()) || sr?.sku_name || null;
    const sellerRaw = (d?.seller_sku && d.seller_sku.trim()) || (c?.platform_sku_ref && String(c.platform_sku_ref).trim()) || '';
    const seller_sku = sellerRaw || (sr?.sku_name ?? null); // fall back to variant/sku_name when seller_sku empty
    return { listing_name, seller_sku };
  };

  // Unbound-auction ONLY → the set-aside alert list (catalog no longer false-flagged here).
  const missing_orders = unboundIds.map((id) => ({ order_id: id, ...displayOf(id) }));
  // Catalog → pickable lines (real listing + seller SKU + qty).
  const catalog_orders = catalogIds.map((id) => {
    const { listing_name, seller_sku } = displayOf(id);
    return { order_id: id, listing_name, seller_sku, qty: Number(boxRows.get(id)?.units) || 1 };
  });
  // Per-order type tag for the pickable orders.
  const order_types: Record<string, 'bound' | 'unbound_auction' | 'catalog'> = {};
  for (const id of pickOrderIds) order_types[id] = orderIdsWithItems.has(id) ? 'bound' : (isCatalog(id) ? 'catalog' : 'unbound_auction');

  // 6) Already verified? (keyed by the physical-box idempotency key)
  const { data: verified } = await supabase
    .from('shipment_verifications')
    .select('verified_at')
    .eq('user_id', user.id)
    .eq('group_key', groupKey)
    .maybeSingle();

  // Resolved scan — log it (set_aside = box has an unbound-auction order → resolver requires set-aside).
  logScan({ user_id: user.id, store_id: storeId, raw_scan: raw, resolved: true, group_key: groupKey, set_aside: unboundIds.length > 0, error: null });

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
    catalog_orders,                              // pickable catalog lines: { order_id, listing_name, seller_sku, qty }
    order_types,                                 // { order_id: 'bound' | 'unbound_auction' | 'catalog' }
    missing_order_ids: unboundIds,               // back-compat (bare ids) — UNBOUND-AUCTION only now
    missing_orders,                              // enriched UNBOUND-AUCTION: { order_id, listing_name, seller_sku }
    excluded,                          // do-not-pack, flagged (cancelled / on-hold / already-shipped)
    excluded_count: excluded.length,
    status_unverified: statusUnverified, // true → frontend shows the loud stale-status warning
    already_verified_at: verified?.verified_at ?? null,
  });
}
