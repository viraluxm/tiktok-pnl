import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

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
    .select('tiktok_product_id, sku_id, sku_name, gmv, shipping, units, status')
    .eq('user_id', data.user.id);

  if (dateFrom) query = query.gte('order_date', dateFrom);
  if (dateTo) query = query.lte('order_date', dateTo);

  // Supabase doesn't support GROUP BY in the client, so fetch and aggregate in JS
  // Use pagination to get all rows
  const allRows: Record<string, unknown>[] = [];
  let offset = 0;
  const PAGE = 5000;
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
    skus: Map<string, { sku_id: string; sku_name: string; orders: number; gmv: number; inventory: number }>;
  }>();

  for (const row of allRows) {
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
      sku = { sku_id: skuId, sku_name: skuName, orders: 0, gmv: 0, inventory: 0 };
      product.skus.set(skuId, sku);
    }
    sku.orders += 1;
    sku.gmv += gmv;
  }

  // Merge current catalog variants (from products.variants) so current SKUs
  // with 0 sales still appear — but NOT old/inactive variations from order history
  const { data: prods } = await admin.from('products').select('tiktok_product_id, name, image_url, variants').eq('user_id', data.user.id);
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
        const existing = product.skus.get(v.id);
        if (existing) {
          existing.inventory = Number(v.inventory) || 0;
        } else {
          product.skus.set(v.id, { sku_id: v.id, sku_name: v.name || v.sku || 'Default', orders: 0, gmv: 0, inventory: Number(v.inventory) || 0 });
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
          })),
      };
    });

  return NextResponse.json({ products: result });
}
