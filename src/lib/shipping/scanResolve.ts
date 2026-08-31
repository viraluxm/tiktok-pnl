import type { SupabaseClient } from '@supabase/supabase-js';
import { routePositionMap, sectionRoutePosition, slotAddress } from '@/lib/mapping/route';

// Shared scan → box resolution used by both /api/shipping/pick-list (the
// operator-facing picker, scoped to the caller's own user_id) and
// /api/station/scan (the warehouse station, scoped to the store owners'
// user_ids). The logic is identical; only the user_id scope differs, so every
// query filters `.in('user_id', userIds)` instead of hard-coding one id.
//
// This module is PURE DB resolution. It deliberately does NOT do the live
// TikTok status refresh, scan_log writes, or shipment_verifications — those
// stay in the callers (pick-list keeps them; station omits them).

export const BUCKET = 'inventory-thumbnails';

// Statuses that must NOT be packed into the box: cancelled/held (never ship)
// and already-gone (re-picking = over-pick). Everything else —
// AWAITING_COLLECTION / AWAITING_SHIPMENT — is packable.
export const DO_NOT_PACK = new Set(['CANCELLED', 'ON_HOLD', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED']);

// USPS IMpb mod-10 check digit, computed over the first 21 of a 22-digit
// tracking. (Rightmost of the 21 weighted ×3, then alternating ×1/×3.) Used to
// disambiguate the canonical tracking when a scanned barcode carries extra
// padding digits.
function uspsTrackingValid(t: string): boolean {
  if (!/^\d{22}$/.test(t)) return false;
  let sum = 0;
  for (let i = 0; i < 21; i++) sum += Number(t[i]) * (((20 - i) % 2 === 0) ? 3 : 1);
  return ((10 - (sum % 10)) % 10) === Number(t[21]);
}

// Normalize a scanned shipping-label / tracking string to the canonical
// 22-digit USPS IMpb tracking (starts 92/93/94/95). Returns null when the scan
// isn't a tracking → order_id path. Handles three real-world barcode shapes:
//   • bare 22-digit tracking scanned on its own;
//   • "420" + ZIP(5 or 9) + 22-digit IMpb concatenated routing label (tracking
//     is a clean 22-digit, check-valid substring);
//   • HAZMAT-style labels whose barcode pads the serial with an EXTRA leading
//     zero, so the tracking region is 23+ digits and the printed human-readable
//     tracking is NOT a contiguous substring. We recover it deterministically
//     by collapsing the longest zero-run one digit at a time until a check-valid
//     22-digit form remains.
//     e.g. "4208914992362903942203000007067" → "9236290394220300007067".
export function normalizeTracking(digits: string): string | null {
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

export type SeedRow = {
  order_id: string;
  auto_combine_group_id: string | null;
  tracking_number: string | null;
  store_id: string | null;
  status: string | null;
  sku_name: string | null;
  tiktok_product_id: string | null;
  units: number | null;
};

const SEL = 'order_id, auto_combine_group_id, tracking_number, store_id, status, sku_name, tiktok_product_id, units';

export type ResolveMiss = { ok: false; resolved_via: 'tracking' | 'order_id'; parsed_tracking: string | null };
export type ResolveHit = {
  ok: true;
  boxRows: Map<string, SeedRow>;
  orderIds: string[];
  orderId: string;         // representative (scanned) order, for display
  groupId: string | null;
  groupKey: string;        // stable idempotency key for the physical box
  tracking: string | null;
  resolvedVia: 'tracking' | 'order_id';
  storeId: string | null;
};

// Steps 1–2: resolve the scanned value → the FULL physical box.
//   scan → synced_order_ids (by tracking, else order_id)
//        → all siblings sharing tracking (authoritative) ∪ combine-group (fallback)
export async function resolveBox(
  db: SupabaseClient,
  userIds: string[],
  raw: string,
): Promise<ResolveMiss | ResolveHit> {
  const digits = raw.replace(/\s/g, '');
  const tracking = normalizeTracking(digits);

  let resolvedVia: 'tracking' | 'order_id' = tracking ? 'tracking' : 'order_id';
  let seed: SeedRow[] = [];
  if (tracking) {
    const { data } = await db.from('synced_order_ids').select(SEL)
      .in('user_id', userIds).eq('tracking_number', tracking);
    seed = (data ?? []) as SeedRow[];
  }
  // Order-id fallback (also belt-and-suspenders when a parsed tracking matched nothing —
  // today ~93% of synced_order_ids rows have a NULL tracking_number).
  if (!seed.length && /^\d{6,}$/.test(digits)) {
    const { data } = await db.from('synced_order_ids').select(SEL)
      .in('user_id', userIds).eq('order_id', digits).maybeSingle();
    if (data) { seed = [data as SeedRow]; resolvedVia = 'order_id'; }
  }
  if (!seed.length) return { ok: false, resolved_via: resolvedVia, parsed_tracking: tracking };

  // The box is the physical PACKAGE; its authoritative key is tracking_number (one label =
  // one package). Resolve by TRACKING (primary) UNION combine-group (fallback for rows whose
  // tracking isn't populated yet). Scope every box query to the seed's store_id so a tracking
  // can never pull a different store.
  const boxTrackings = [...new Set(seed.map((s) => s.tracking_number).filter((t): t is string => !!t))];
  const boxGroups = [...new Set(seed.map((s) => s.auto_combine_group_id).filter((g): g is string => !!g))];
  const storeId: string | null = seed[0].store_id ?? null;

  const boxRows = new Map<string, SeedRow>();
  seed.forEach((s) => boxRows.set(String(s.order_id), s));
  if (boxTrackings.length) {
    let q = db.from('synced_order_ids').select(SEL).in('user_id', userIds).in('tracking_number', boxTrackings);
    if (storeId) q = q.eq('store_id', storeId);
    const { data } = await q;
    (data ?? []).forEach((r: SeedRow) => boxRows.set(String(r.order_id), r));
  }
  if (boxGroups.length) {
    let q = db.from('synced_order_ids').select(SEL).in('user_id', userIds).in('auto_combine_group_id', boxGroups);
    if (storeId) q = q.eq('store_id', storeId);
    const { data } = await q;
    for (const r of (data ?? []) as SeedRow[]) {
      const t = r.tracking_number;
      if (!boxTrackings.length || t === null || boxTrackings.includes(t)) boxRows.set(String(r.order_id), r);
    }
  }

  const orderIds = [...boxRows.keys()];
  const orderId = String(seed[0].order_id);
  const groupId: string | null = boxGroups[0] ?? null;
  const groupKey = boxTrackings[0] ? `trk:${boxTrackings[0]}` : (groupId ?? `order:${orderId}`);

  return { ok: true, boxRows, orderIds, orderId, groupId, groupKey, tracking, resolvedVia, storeId };
}

export type SkuBlock = {
  inventory_sku_id: string;
  sku_number: number | null;
  title: string;
  barcode: string | null;
  thumbnail_url: string | null;
  required_qty: number;
  // TRUE when ANY order line contributing to this box's SKU total could not be filled from
  // stock at BIND time (live_auction_item_skus.short_at_bind). Per-line, OR'd up to the box:
  // if the box holds two orders for one SKU and only one was short, the box still cannot be
  // filled, so it warns. Display-only — it never gates grabbing, navigation, or completion.
  shelf_out: boolean;
  /**
   * Live stock. Distinct from shelf_out, which is a frozen fact about the ORDER (it could not
   * be filled at bind time). This is what is on the shelf now, and may be negative on an
   * oversell. Carried so the screen can say "in stock but not mapped" truthfully rather than
   * implying it.
   */
  qty_on_hand: number;
  // Where this SKU lives, e.g. "R3A L2". Null when it has no section mapped yet — the device
  // then shows no guidance rather than guessing, and the line sorts last.
  location_label: string | null;
  // Every slot code that legitimately holds this SKU. More than one when it sits on both faces
  // of a rack, or in two places: walking to the far face is not an error.
  slot_codes: string[];
};
export type ExcludedOrder = { order_id: string; reason: string; skus: string[] };
export type MissingOrder = { order_id: string; listing_name: string | null; seller_sku: string | null };
export type CatalogOrder = { order_id: string; listing_name: string | null; seller_sku: string | null; qty: number };

export type AssembleResult = {
  skus: SkuBlock[];
  excluded: ExcludedOrder[];
  missing_order_ids: string[];
  missing_orders: MissingOrder[];
  catalog_orders: CatalogOrder[];
  order_types: Record<string, 'bound' | 'unbound_auction' | 'catalog'>;
};

// Steps 3–6c: bound auction items → SKU lines → aggregation + inventory
// enrichment (thumbnail), plus the unbound-auction / catalog classification.
//   statusOf  — the effective status per order (pick-list passes live-when-known;
//               station passes the stored status). Drives the excluded reason.
//   orderDetail — live line-item names when the caller fetched them (pick-list);
//               empty for station, which falls back to capture_events/products.
/**
 * Attach WHERE each SKU lives, and re-order the list into walking order.
 *
 * Lives here rather than in a route because BOTH pick paths must behave identically:
 * /api/shipping/pick-list (owner login) and /api/station/scan (the fulfilment station login).
 * They already duplicate the aggregation above; duplicating this too is how the station login
 * would silently keep the old sku_number ordering and show no location — the exact bug this
 * function exists to prevent.
 *
 * A SKU can occupy more than one section (both faces of a rack, or two places). The picker is
 * sent to whichever comes FIRST on the route, and every one of its slot codes stays valid.
 *
 * Unmapped SKUs fall to the END, keeping lowest-SKU#-first among themselves, so a partly
 * mapped catalogue is strictly better than an unmapped one and never worse.
 *
 * NOTE the route's start corner is not persisted anywhere yet, so this uses the 'top-left'
 * default the Mapping tab opens with. The ORDER of stops is correct either way; only which
 * end you begin from can differ.
 */
export async function attachLocations(
  db: SupabaseClient,
  userIds: string[],
  skus: SkuBlock[],
): Promise<SkuBlock[]> {
  if (!skus.length) return skus;
  const skuIds = skus.map((s) => s.inventory_sku_id);

  const [{ data: racks }, { data: slots }] = await Promise.all([
    db.from('pick_racks')
      .select('id, name, grid_row, grid_col, route_pos_a, route_pos_b, is_active')
      .in('user_id', userIds),
    db.from('pick_slots')
      .select('rack_id, shelf_index, section_index, side, slot_code, inventory_sku_id')
      .in('user_id', userIds)
      .in('inventory_sku_id', skuIds),
  ]);

  const positions = routePositionMap(racks ?? []);
  type RackRow = { id: string; name: string };
  const rackById = new Map<string, RackRow>(
    ((racks ?? []) as RackRow[]).map((r) => [String(r.id), r]),
  );
  const byS = new Map<string, { label: string; position: number; shelf: number; section: number; codes: string[] }>();

  for (const slot of slots ?? []) {
    const skuId = String(slot.inventory_sku_id);
    const rack = rackById.get(String(slot.rack_id));
    if (!rack) continue;
    const side = slot.side as 'A' | 'B' | 'AB';
    const pos = sectionRoutePosition(positions, String(rack.id), side);
    const prev = byS.get(skuId);
    const codes = [...(prev?.codes ?? []), String(slot.slot_code)];
    if (pos == null) {
      byS.set(skuId, prev ? { ...prev, codes }
        : { label: '', position: Infinity, shelf: 0, section: 0, codes });
      continue;
    }
    // Includes the SECTION. Originally stopped at the level on the reasoning that a picker
    // finds the item by eye once at the right shelf — but in use the section is what matches
    // the printed label they are about to scan, so leaving it off made the screen and the
    // label disagree.
    const label = slotAddress(
      String(rack.name),
      side === 'AB' ? 'A' : side,
      Number(slot.shelf_index),
      Number(slot.section_index),
    );
    if (!prev || pos < prev.position) {
      byS.set(skuId, {
        label, position: pos, codes,
        shelf: Number(slot.shelf_index), section: Number(slot.section_index),
      });
    } else byS.set(skuId, { ...prev, codes });
  }

  return skus
    .map((s) => {
      const loc = byS.get(s.inventory_sku_id);
      return { ...s, location_label: loc?.label || null, slot_codes: loc?.codes ?? [] };
    })
    // Walking order, then order WITHIN a rack face.
    //
    // Route position is per rack-SIDE, so every item on R1A shares one position. Without the
    // secondary keys they all tied and fell back to sku_number — which put a picker standing
    // at R1A through L3 → L1 → L4, reintroducing at one rack exactly the zigzag the route
    // ordering removes between racks.
    //
    // Section before shelf, because you walk ALONG a rack and reach up and down at each
    // position — not up one whole shelf and back for the next.
    .sort((x, y) => {
      const lx = byS.get(x.inventory_sku_id);
      const ly = byS.get(y.inventory_sku_id);
      const px = lx?.position ?? Infinity;
      const py = ly?.position ?? Infinity;
      if (px !== py) return px - py;
      if ((lx?.section ?? 0) !== (ly?.section ?? 0)) return (lx?.section ?? 0) - (ly?.section ?? 0);
      if ((lx?.shelf ?? 0) !== (ly?.shelf ?? 0)) return (lx?.shelf ?? 0) - (ly?.shelf ?? 0);
      return (Number(x.sku_number) || 0) - (Number(y.sku_number) || 0);
    });
}

export async function assembleBox(
  db: SupabaseClient,
  userIds: string[],
  args: {
    boxRows: Map<string, SeedRow>;
    orderIds: string[];
    pickOrderIds: string[];
    excludedOrderIds: string[];
    orderDetail: Map<string, { product_name: string; seller_sku: string }>;
    statusOf: (id: string) => string;
  },
): Promise<AssembleResult> {
  const { boxRows, orderIds, pickOrderIds, excludedOrderIds, orderDetail, statusOf } = args;

  // 3) Bound auction items for ALL box orders; map item→order.
  const { data: items } = await db
    .from('live_auction_items')
    .select('id, client_idempotency_key')
    .in('user_id', userIds)
    .in('client_idempotency_key', orderIds);
  const itemRows = items ?? [];
  const itemToOrder = new Map<string, string>(itemRows.map((i: { id: string; client_idempotency_key: string }) => [String(i.id), String(i.client_idempotency_key)]));
  const itemIds = itemRows.map((i: { id: string }) => i.id);
  const orderIdsWithItems = new Set(itemRows.map((i: { client_idempotency_key: string }) => String(i.client_idempotency_key)));
  const missingOrderIds = pickOrderIds.filter((id) => !orderIdsWithItems.has(id));

  // 4) SKU lines, attributed to their order via auction_item_id (snapshot fields).
  type Line = { order_id: string; inventory_sku_id: string; sku_number: number | null; title: string; qty: number; short_at_bind: boolean };
  const lines: Line[] = [];
  if (itemIds.length) {
    const { data: raw2 } = await db
      .from('live_auction_item_skus')
      .select('auction_item_id, inventory_sku_id, qty, sku_number_snapshot, title_snapshot, short_at_bind')
      .in('user_id', userIds)
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

  // PICKABLE aggregation: only lines from pickable orders, summed per inventory SKU.
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

  // 5) Best-effort inventory enrichment (barcode + thumbnail) for pickable SKUs.
  const skuIds = [...agg.keys()];
  const invById = new Map<string, { barcode: string | null; thumbnail_url: string | null; qty_on_hand: number }>();
  if (skuIds.length) {
    const { data: inv } = await db
      .from('inventory_skus')
      .select('id, barcode, thumbnail_path, qty_on_hand')
      .in('user_id', userIds)
      .in('id', skuIds);
    for (const s of inv ?? []) {
      const path = (s.thumbnail_path as string | null) ?? null;
      invById.set(String(s.id), {
        barcode: (s.barcode as string | null) ?? null,
        thumbnail_url: path ? db.storage.from(BUCKET).getPublicUrl(path).data.publicUrl : null,
        qty_on_hand: (s.qty_on_hand as number | null) ?? 0,
      });
    }
  }
  const skus: SkuBlock[] = await attachLocations(
    db,
    userIds,
    skuIds.map((id) => {
      const a = agg.get(id)!;
      const inv = invById.get(id);
      return {
        inventory_sku_id: id,
        sku_number: a.sku_number,
        title: a.title,
        barcode: inv?.barcode ?? null,
        thumbnail_url: inv?.thumbnail_url ?? null,
        required_qty: a.qty,
        shelf_out: a.short,
        qty_on_hand: inv?.qty_on_hand ?? 0,
        location_label: null,
        slot_codes: [],
      };
    }),
  );

  // EXCLUDED (do-not-pack) orders, kept VISIBLE so screen ⟷ paper slip stays reconciled.
  const linesByOrder = new Map<string, string[]>();
  for (const l of lines) {
    const arr = linesByOrder.get(l.order_id) ?? [];
    arr.push(`#${l.sku_number ?? '?'} ${l.title} x${l.qty}`);
    linesByOrder.set(l.order_id, arr);
  }
  const excluded: ExcludedOrder[] = excludedOrderIds.map((id) => ({
    order_id: id,
    reason: statusOf(id) || 'UNKNOWN',
    skus: linesByOrder.get(id) ?? [],
  }));

  // 6b) Enrich unbound (missing) orders with a listing name + seller-SKU. NO new TikTok call —
  //     sources are the passed-in orderDetail, capture_events, and the synced sku_name.
  const capByOrder = new Map<string, { product_name: string | null; platform_sku_ref: string | null }>();
  if (missingOrderIds.length) {
    const { data: caps } = await db
      .from('capture_events')
      .select('order_id, product_name, platform_sku_ref')
      .in('user_id', userIds)
      .in('order_id', missingOrderIds);
    for (const c of caps ?? []) {
      const k = String(c.order_id);
      if (!capByOrder.has(k)) capByOrder.set(k, { product_name: (c.product_name as string | null) ?? null, platform_sku_ref: (c.platform_sku_ref as string | null) ?? null });
    }
  }
  // 6c) THREE-WAY ORDER TYPE: bound / unbound-auction (captured, never bound → set aside) /
  //     catalog (never captured, real listing → pickable). Guard a no-capture order to catalog
  //     ONLY when its listing isn't also used by auction sales AND it has a products.name.
  const candidatePids = [...new Set(missingOrderIds.filter((id) => !capByOrder.has(id)).map((id) => boxRows.get(id)?.tiktok_product_id).filter((p): p is string => !!p))];
  const auctionPidSet = new Set<string>();
  const productNameByPid = new Map<string, string>();
  if (candidatePids.length) {
    const { data: ap } = await db.from('capture_events').select('tiktok_product_id').in('user_id', userIds).in('tiktok_product_id', candidatePids);
    for (const r of ap ?? []) auctionPidSet.add(String(r.tiktok_product_id));
    const { data: pn } = await db.from('products').select('tiktok_product_id, name').in('user_id', userIds).in('tiktok_product_id', candidatePids);
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

  const displayOf = (id: string) => {
    const d = orderDetail.get(id);
    const c = capByOrder.get(id);
    const sr = boxRows.get(id);
    const pid = sr?.tiktok_product_id ?? '';
    const listing_name = (d?.product_name && d.product_name.trim()) || (pid ? productNameByPid.get(pid) || '' : '') || (c?.product_name && c.product_name.trim()) || sr?.sku_name || null;
    const sellerRaw = (d?.seller_sku && d.seller_sku.trim()) || (c?.platform_sku_ref && String(c.platform_sku_ref).trim()) || '';
    const seller_sku = sellerRaw || (sr?.sku_name ?? null);
    return { listing_name, seller_sku };
  };

  const missing_orders: MissingOrder[] = unboundIds.map((id) => ({ order_id: id, ...displayOf(id) }));
  const catalog_orders: CatalogOrder[] = catalogIds.map((id) => {
    const { listing_name, seller_sku } = displayOf(id);
    return { order_id: id, listing_name, seller_sku, qty: Number(boxRows.get(id)?.units) || 1 };
  });
  const order_types: Record<string, 'bound' | 'unbound_auction' | 'catalog'> = {};
  for (const id of pickOrderIds) order_types[id] = orderIdsWithItems.has(id) ? 'bound' : (isCatalog(id) ? 'catalog' : 'unbound_auction');

  return { skus, excluded, missing_order_ids: unboundIds, missing_orders, catalog_orders, order_types };
}
