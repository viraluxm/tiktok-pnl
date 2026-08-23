import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getOrgId } from '@/lib/org';
import { selectAllPages } from '@/lib/supabase/inChunks';

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
  const { rows: prods, error: prodsErr } = await selectAllPages<Record<string, unknown>>((from, to) =>
    admin.from('products').select('tiktok_product_id, name, image_url, variants')
      .eq('org_id', orgId).order('id', { ascending: true }).range(from, to));
  if (prodsErr) console.error('Product stats: products read failed:', prodsErr);
  const productsData: Record<string, unknown>[] = prods;

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

  // ── TOTALS: ONE server-side aggregate (migration 114) ───────────────────────
  // This used to be assembled here in TypeScript: a totals loop over allRows, then three
  // chunked `.in()` joins (live_auction_items -> live_auction_item_skus for snapshot COGS, plus
  // capture_events to isolate catalog orders) at 300 ids per request. That was ~1,400 sequential
  // PostgREST round-trips on the 'all' filter at 0.2-0.36s each, and any one of them failing
  // silently zeroed COGS -- which renders net profit ~2.5x too high rather than erroring.
  // lensed_product_stats_totals_as does the whole thing in a single query (447ms for 3 days,
  // 2.5s for all 139,981 orders) and is a verified behaviour-identical port.
  //
  // p_store_ids is null (= all stores), which is what this route has always done -- it accepts no
  // store parameter today. Wiring a store filter through from the client is a separate change.
  // rpc-grants: lensed_product_stats_totals_as
  const { data: totalsJson, error: totalsErr } = await admin.rpc('lensed_product_stats_totals_as', {
    p_owner_user_ids: [data.user.id],
    p_store_ids: null,
    p_from: dateFrom,
    p_to: dateTo,
    p_tz: 'America/Los_Angeles',
  });
  if (totalsErr) console.error('Product stats: totals RPC failed:', totalsErr);

  const totals = (totalsJson ?? null) as Record<string, unknown> | null;

  // ── SANITY CHECK ─────────────────────────────────────────────────────────────
  // A period with revenue cannot legitimately resolve zero product cost: every order is either
  // an auction order (snapshot COGS) or a catalog order (tape-curve COGS). Log it with the row
  // counts -- a bare $0 in the response is unfalsifiable after the fact. Returning totals: null
  // on RPC failure is deliberate: the client throws on a missing `totals` and renders "cost data
  // didn't load" instead of a confident wrong number.
  const gmv = Number(totals?.totalGMV) || 0;
  const snapCogs = Number(totals?.snapshotCogs) || 0;
  const catCogs = Number(totals?.catalogCogs) || 0;
  if (!totals) {
    console.error('Product stats: totals RPC returned no row -- responding with totals: null', {
      userId: data.user.id, dateFrom, dateTo, orderRowsFetched: allRows.length,
      rpcError: totalsErr ? String(totalsErr.message ?? totalsErr) : null,
    });
  } else if (gmv > 0 && snapCogs === 0 && catCogs === 0) {
    console.error('Product stats: COGS resolved to $0 against non-zero GMV', {
      userId: data.user.id, dateFrom, dateTo,
      totalGMV: gmv, totalOrders: totals.totalOrders,
      orderRowsFetched: allRows.length,
      cogsCoveredOrders: totals.cogsCoveredOrders,
      catalogCostedOrders: totals.catalogCostedOrders,
      catalogUncostedUnparseable: totals.catalogUncostedUnparseable,
      catalogExcludedNumeric: totals.catalogExcludedNumeric,
    });
  }

  return NextResponse.json({
    products: result,
    totals,
  });
}

// NO LONGER CALLED at runtime — the live implementation is the CASE expression in migration
// 114_product_stats_totals_as.sql, which this function was ported to (\y not \b for the word
// boundary; -1 as the 'numeric' sentinel). Kept as the readable reference for that port and for
// the cost-curve rule itself. If you change one, change both.
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
