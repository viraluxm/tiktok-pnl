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

  let query = admin
    .from('synced_order_ids')
    .select('order_id, tiktok_product_id, sku_name, gmv, shipping, status, order_date, units')
    .eq('user_id', data.user.id);

  if (dateFrom) query = query.gte('order_date', dateFrom);
  if (dateTo) query = query.lte('order_date', dateTo);

  const allRows: Record<string, unknown>[] = [];
  let offset = 0;
  const PAGE = 1000;
  while (true) {
    const { data: page, error } = await query.range(offset, offset + PAGE - 1);
    if (error) break;
    if (!page || page.length === 0) break;
    allRows.push(...page);
    if (page.length < PAGE) break;
    offset += PAGE;
  }

  // Filter for return/cancellation/refund statuses
  const returns = allRows.filter(row => {
    const s = String(row.status || '').toUpperCase();
    return s === 'CANCELLED' || s.includes('CANCEL') || s.includes('REVERSE') || s.includes('REFUND') || s.includes('RETURN');
  });

  // Look up product names
  const productIds = [...new Set(returns.map(r => String(r.tiktok_product_id || '')).filter(Boolean))];
  const { data: products } = productIds.length > 0
    ? await admin.from('products').select('tiktok_product_id, name').eq('user_id', data.user.id).in('tiktok_product_id', productIds)
    : { data: [] };
  const nameMap = new Map((products || []).map((p: Record<string, string>) => [p.tiktok_product_id, p.name]));

  const items = returns
    .map(r => ({
      order_id: String(r.order_id || ''),
      product_name: nameMap.get(String(r.tiktok_product_id)) || String(r.sku_name || 'Unknown'),
      gmv: Number(r.gmv) || 0,
      status: String(r.status || ''),
      order_date: String(r.order_date || ''),
      units: Number(r.units) || 0,
    }))
    .sort((a, b) => b.order_date.localeCompare(a.order_date));

  // Summary
  const totalReturns = items.length;
  const totalAmount = items.reduce((sum, i) => sum + i.gmv, 0);
  const pendingReturns = items.filter(i => {
    const s = i.status.toUpperCase();
    return s.includes('IN_CANCEL') || s.includes('REQUESTED') || s.includes('IN_PROGRESS') || s.includes('PENDING') || s.includes('AWAITING') || s.includes('IN_TRANSIT');
  }).length;
  const completedReturns = totalReturns - pendingReturns;

  // Debug: all distinct statuses in the DB for this user/period
  const allStatuses = [...new Set(allRows.map(r => String(r.status || '')))].sort();
  const returnStatuses = [...new Set(items.map(i => i.status))].sort();

  return NextResponse.json({
    summary: { totalReturns, pendingReturns, completedReturns, totalAmount: Math.round(totalAmount * 100) / 100 },
    items,
    debug: { allStatuses, returnStatuses, totalOrders: allRows.length },
  });
}
