import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getOrgId } from '@/lib/org';

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

  // ── COGS + non-auction merchandise from the CANONICAL order-grain view (pnl_order_grain) ──
  //    snapshot COGS (auction cost snapshot) and the non-auction identity both come from the SAME
  //    source the P&L tab / fingerprint use — not ad-hoc joins or a name-based catalog resolver.
  //    snapshotCogs is PARTIAL BY DESIGN: only auction orders carry a cost snapshot (cogsCoveredOrders
  //    vs totalOrders lets the UI label that honestly). Non-auction orders (source='non_auction')
  //    recognise no auction revenue; their merchandise (uncaptured_gmv = gmv − shipping) is reported
  //    as nonAuctionMerch and dropped from the dashboard headline GMV (auction GMV is untouched).
  //
  // AGGREGATED SERVER-SIDE (migration 116). This used to page the view 1000 rows at a time and sum
  // in JS. One 1000-row page costs 32.6s — LIMIT/OFFSET forces an incremental sort over the view's
  // 195k-row UNION dedup, redone per page — against the 8s statement_timeout PostgREST enforces.
  // So page 1 always errored, the loop broke with snapshotCogs still 0, and the card rendered a net
  // profit with no COGS subtracted. Dropping the LIMIT drops the pathology: ~2s warm, ~6.6s cold.
  let cogsReadFailed = false;
  let snapshotCogs = 0;                 // dollars — canonical auction cost snapshot (matches fingerprint)
  let nonAuctionMerch = 0;              // dollars — non-auction gmv−shipping, dropped from headline GMV
  let cogsCoveredOrders = 0;
  {
    const { data: cogsRow, error: cerr } = await admin.rpc('lensed_product_stats_cogs_as', {
      p_owner_user_ids: [data.user.id],
      p_from: dateFrom,
      p_to: dateTo,
    });
    const c = cogsRow as { snapshotCogsCents?: number; cogsCoveredOrders?: number; nonAuctionMerchCents?: number } | null;
    if (cerr || !c) {
      // Same contract as before: flag it rather than let a $0 COGS read as a healthy margin.
      console.error('lensed_product_stats_cogs_as read failed:', cerr ?? 'no row returned');
      cogsReadFailed = true;
    } else {
      snapshotCogs = (Number(c.snapshotCogsCents) || 0) / 100;
      nonAuctionMerch = (Number(c.nonAuctionMerchCents) || 0) / 100;
      cogsCoveredOrders = Number(c.cogsCoveredOrders) || 0;
    }
  }

  return NextResponse.json({
    products: result,
    totals: {
      totalGMV, totalShipping, totalAffiliate, totalPlatformFee, totalUnits, totalOrders, byDate,
      returnsCount, returnsAmount, samplesCount,
      snapshotCogs, cogsCoveredOrders, nonAuctionMerch,
      cogsUnavailable: cogsReadFailed,
    },
  });
}
