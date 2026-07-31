import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getOrgId } from '@/lib/org';
import { inChunks } from '@/lib/supabase/inChunks';

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data, error: authError } = await supabase.auth.getUser();
  if (authError || !data.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const dateFrom = searchParams.get('from');
  const dateTo = searchParams.get('to');

  const admin = createAdminClient();

  // Get per-product stats from synced_order_ids
  let query = admin
    .from('synced_order_ids')
    .select('order_id, tiktok_product_id, sku_id, sku_name, gmv, shipping, affiliate, platform_fee, units, status, order_date')
    .eq('user_id', data.user.id);

  if (dateFrom) query = query.gte('order_date', dateFrom);
  if (dateTo) query = query.lte('order_date', dateTo);

  // Supabase doesn't support GROUP BY in the client, so fetch and aggregate in JS
  // Use pagination to get all rows
  const allRows: Record<string, unknown>[] = [];
  let offset = 0;
  const PAGE = 1000; // Supabase default row limit per request
  while (true) {
    const { data: page, error } = await query.range(offset, offset + PAGE - 1);
    if (error) { console.error('Product stats error:', error); break; }
    if (!page || page.length === 0) break;
    allRows.push(...page);
    if (page.length < PAGE) break;
    offset += PAGE;
  }

  // Aggregate by tiktok_product_id (hero product level)
  const productMap = new Map<string, {
    tiktok_product_id: string;
    total_orders: number;
    total_gmv: number;
    total_shipping: number;
    skus: Map<string, { sku_id: string; sku_name: string; orders: number; gmv: number; inventory: number; active: boolean }>;
  }>();

  // Track active SKU IDs from the current catalog (populated during merge below)
  const activeSku = new Set<string>();

  for (const row of allRows) {
    const status = String(row.status || '').toUpperCase();
    if (status === 'CANCELLED' || status.includes('CANCEL')) continue;

    const pid = String(row.tiktok_product_id || 'unknown');
    const skuId = String(row.sku_id || '');
    const skuName = String(row.sku_name || 'Default');
    const gmv = Number(row.gmv) || 0;
    const shipping = Number(row.shipping) || 0;

    let product = productMap.get(pid);
    if (!product) {
      product = { tiktok_product_id: pid, total_orders: 0, total_gmv: 0, total_shipping: 0, skus: new Map() };
      productMap.set(pid, product);
    }

    product.total_orders += 1;
    product.total_gmv += gmv;
    product.total_shipping += shipping;

    // Key by sku_id only to avoid duplicates from name variations
    let sku = product.skus.get(skuId);
    if (!sku) {
      sku = { sku_id: skuId, sku_name: skuName, orders: 0, gmv: 0, inventory: 0, active: false };
      product.skus.set(skuId, sku);
    }
    sku.orders += 1;
    sku.gmv += gmv;
  }

  // Merge current catalog variants (from products.variants) so current SKUs
  // with 0 sales still appear — but NOT old/inactive variations from order history.
  // SHARED catalog: scope by org (admin bypasses RLS, so filter explicitly).
  const orgId = await getOrgId(admin, data.user.id);
  const { data: prods } = await admin.from('products').select('tiktok_product_id, name, image_url, variants').eq('org_id', orgId);
  const productsData: Record<string, unknown>[] = prods || [];

  const productLookup = new Map<string, { name: string; image_url: string | null }>();
  for (const p of productsData) {
    const pid = String(p.tiktok_product_id || '');
    if (!pid) continue;
    productLookup.set(pid, { name: String(p.name || ''), image_url: p.image_url as string | null });

    // Merge current catalog variants so SKUs with 0 sales in this period still appear
    let rawVariants = p.variants;
    if (typeof rawVariants === 'string') {
      try { rawVariants = JSON.parse(rawVariants); } catch { rawVariants = null; }
    }
    const variants = (Array.isArray(rawVariants) ? rawVariants : null) as Array<{ id: string; name: string; sku?: string; inventory?: number }> | null;
    if (variants && variants.length > 0) {
      let product = productMap.get(pid);
      if (!product) {
        product = { tiktok_product_id: pid, total_orders: 0, total_gmv: 0, total_shipping: 0, skus: new Map() };
        productMap.set(pid, product);
      }
      for (const v of variants) {
        if (!v.id) continue;
        activeSku.add(v.id);
        const existing = product.skus.get(v.id);
        if (existing) {
          existing.inventory = Number(v.inventory) || 0;
          existing.active = true;
        } else {
          product.skus.set(v.id, { sku_id: v.id, sku_name: v.name || v.sku || 'Default', orders: 0, gmv: 0, inventory: Number(v.inventory) || 0, active: true });
        }
      }
    }
  }

  // Build response
  const result = [...productMap.entries()]
    .sort((a, b) => b[1].total_gmv - a[1].total_gmv)
    .map(([pid, stats]) => {
      const info = productLookup.get(pid);
      return {
        tiktok_product_id: pid,
        name: info?.name || `Product ${pid.slice(-8)}`,
        image_url: info?.image_url || null,
        total_orders: stats.total_orders,
        total_gmv: Math.round(stats.total_gmv * 100) / 100,
        total_shipping: Math.round(stats.total_shipping * 100) / 100,
        skus: [...stats.skus.values()]
          .sort((a, b) => b.gmv - a.gmv)
          .map(s => ({
            sku_id: s.sku_id,
            sku_name: s.sku_name,
            orders: s.orders,
            gmv: Math.round(s.gmv * 100) / 100,
            inventory: s.inventory,
            active: s.active,
          })),
      };
    });

  // Compute aggregate dashboard totals from the same raw order data
  let totalGMV = 0;
  let totalShipping = 0;
  let totalAffiliate = 0;
  let totalPlatformFee = 0;
  let totalUnits = 0;
  let totalOrders = 0;
  const byDate: Record<string, { gmv: number; shipping: number; affiliate: number; platformFee: number }> = {};

  let returnsCount = 0;
  let returnsAmount = 0;
  let samplesCount = 0;

  for (const row of allRows) {
    const status = String(row.status || '').toUpperCase();
    const gmv = Number(row.gmv) || 0;
    const shipping = Number(row.shipping) || 0;
    const affiliate = Number(row.affiliate) || 0;
    const platformFee = Number(row.platform_fee) || 0;
    const date = String(row.order_date || '');

    // Count returns/cancellations
    if (status === 'CANCELLED' || status.includes('CANCEL') || status.includes('REVERSE') || status.includes('REFUND') || status.includes('RETURN')) {
      returnsCount += 1;
      returnsAmount += gmv;
      continue; // Don't include in GMV totals
    }

    // Count samples ($0 GMV completed orders)
    if (gmv === 0 && (status === 'COMPLETED' || status === 'DELIVERED' || status === 'IN_TRANSIT' || status === '')) {
      samplesCount += 1;
    }

    totalGMV += gmv;
    totalShipping += shipping;
    totalAffiliate += affiliate;
    totalPlatformFee += platformFee;
    totalUnits += Number(row.units) || 0;
    totalOrders += 1;
    if (date) {
      if (!byDate[date]) byDate[date] = { gmv: 0, shipping: 0, affiliate: 0, platformFee: 0 };
      byDate[date].gmv += gmv;
      byDate[date].shipping += shipping;
      byDate[date].affiliate += affiliate;
      byDate[date].platformFee += platformFee;
    }
  }

  // ── COGS from the AUCTION COST SNAPSHOT (live_auction_item_skus.unit_cost_cents_snapshot) —
  //    the same populated source P&L/Shows/export use, joined order_id -> sold auction item.
  //    Replaces the product_costs/costsMap path, which is nearly empty (~13 rows) and read $0.
  //    PARTIAL BY DESIGN: only AUCTION orders have a snapshot; catalog/non-auction orders carry
  //    no COGS here (cogsCoveredOrders vs totalOrders lets the UI label that honestly).
  const orderIds = [...new Set(allRows.map((r) => String(r.order_id || '')).filter(Boolean))];
  let snapshotCogs = 0;               // dollars
  const coveredOrders = new Set<string>();
  if (orderIds.length) {
    const { rows: items } = await inChunks<{ id: string; client_idempotency_key: string }>(orderIds, (slice) =>
      admin.from('live_auction_items').select('id, client_idempotency_key')
        .eq('user_id', data.user.id).eq('status', 'sold').in('client_idempotency_key', slice));
    const itemToOrder = new Map(items.map((i) => [String(i.id), String(i.client_idempotency_key)]));
    const itemIds = items.map((i) => String(i.id));
    if (itemIds.length) {
      const { rows: skus } = await inChunks<{ auction_item_id: string; qty: number | null; unit_cost_cents_snapshot: number | null }>(itemIds, (slice) =>
        admin.from('live_auction_item_skus').select('auction_item_id, qty, unit_cost_cents_snapshot')
          .eq('user_id', data.user.id).in('auction_item_id', slice));
      for (const s of skus) {
        snapshotCogs += ((Number(s.unit_cost_cents_snapshot) || 0) * (Number(s.qty) || 1)) / 100;
        const oid = itemToOrder.get(String(s.auction_item_id));
        if (oid) coveredOrders.add(oid);
      }
    }
  }
  const cogsCoveredOrders = coveredOrders.size;

  // ── CATALOG COGS (non-auction storefront orders) ─────────────────────────────
  // Auction orders get COGS from the snapshot above. Catalog (storefront) orders never touch
  // an auction, so they have no snapshot — resolve their cost from the sku NAME via the Snore
  // tape cost curve. Name-based ON PURPOSE: the product is re-listed constantly (6× so far),
  // each re-list minting new sku_ids that orphan product_costs; the name pattern is stable.
  //   cost = $0.80 × (boxes + 1)  PER ORDER — a "3 Black" bundle is $3.20 total, not ×3.
  //   Verified against all 12 legacy product_costs tiers (1→$1.60, 4→$4.00, 12/"1 Year"→$10.40).
  // TWO HARD GUARDS (both produced wrong answers in analysis):
  //   • "N Pcs" = N/30 boxes ("120 Pcs" = 4, not 120) — a leading-int read overcounts 30×.
  //   • pure-numeric sku_names ("9","21") are AUCTION LOT numbers (class-c never-captured
  //     auction), NOT catalog — excluded entirely, never given tape cost (this is what made
  //     June's modeled COGS exceed its revenue during analysis).
  // Unresolvable names ("Default", no pack indicator) are LEFT UNCOSTED and COUNTED — never
  // silently defaulted. Catalog = orders with NO capture_events row (every auction order, bound
  // or unbound, has one); that filter plus the numeric guard isolates true storefront sales.
  let catalogCogs = 0;                  // dollars
  const catalogCostedOrders = new Set<string>();
  let catalogUncostedUnparseable = 0;   // named but no pack indicator (e.g. "Default")
  let catalogExcludedNumeric = 0;       // class-c auction lots sitting in the no-capture set
  if (orderIds.length) {
    const { rows: caps } = await inChunks<{ order_id: string }>(orderIds, (slice) =>
      admin.from('capture_events').select('order_id').eq('user_id', data.user.id).in('order_id', slice));
    const captureSet = new Set(caps.map((c) => String(c.order_id)));
    for (const row of allRows) {
      const oid = String(row.order_id || '');
      if (!oid || captureSet.has(oid) || coveredOrders.has(oid)) continue; // any auction order → skip
      const status = String(row.status || '').toUpperCase();
      if (/CANCEL|REVERSE|REFUND|RETURN/.test(status)) continue;           // mirror GMV's exclusion
      const boxes = resolveCatalogBoxes(String(row.sku_name || ''));
      if (boxes === 'numeric') { catalogExcludedNumeric += 1; continue; }
      if (boxes == null) { catalogUncostedUnparseable += 1; continue; }
      const units = Number(row.units) || 1;
      catalogCogs += 0.8 * (boxes + 1) * units;
      catalogCostedOrders.add(oid);
    }
  }
  const catalogCostedOrdersCount = catalogCostedOrders.size;

  return NextResponse.json({
    products: result,
    totals: {
      totalGMV, totalShipping, totalAffiliate, totalPlatformFee, totalUnits, totalOrders, byDate,
      returnsCount, returnsAmount, samplesCount,
      snapshotCogs, cogsCoveredOrders,
      catalogCogs, catalogCostedOrders: catalogCostedOrdersCount,
      catalogUncostedUnparseable, catalogExcludedNumeric,
    },
  });
}

// Resolve the number of 30-day BOXES a catalog sku_name represents, for the $0.80×(boxes+1)
// tape cost curve. Returns 'numeric' for pure-numeric auction lot numbers (NOT catalog — must be
// excluded), or null when the name has no pack indicator (leave uncosted + count, never guess).
// Order matters: numeric guard → "year" (=12) → "N Pcs" (÷30) → any leading/embedded integer.
export function resolveCatalogBoxes(rawName: string): number | 'numeric' | null {
  const name = rawName.trim();
  if (!name) return null;
  if (/^\d+$/.test(name)) return 'numeric';                 // auction lot number, not catalog
  if (/year/i.test(name)) return 12;                        // "1 Year" / "360 Pcs (1 Year Supply)"
  const pcs = name.match(/(\d+)\s*pcs?\b/i);                // "120 Pcs" → round(120/30) = 4 boxes
  if (pcs) return Math.max(1, Math.round(parseInt(pcs[1], 10) / 30));
  const lead = name.match(/\d+/);                           // "3 Black", "Black, 1 Pack", "2 Month Supply"
  if (lead) return parseInt(lead[0], 10);
  return null;                                              // no pack indicator — uncosted, counted
}
