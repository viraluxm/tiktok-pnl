import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchReturns, fetchCancellations } from '@/lib/tiktok/client';
import { decryptOrFallback } from '@/lib/crypto';

const SHOP_TIMEZONE = 'America/Los_Angeles';

function dayToTs(day: string): number {
  const refUtc = new Date(day + 'T12:00:00Z');
  const utcDateStr = refUtc.toLocaleDateString('en-CA', { timeZone: 'UTC' });
  const localDateStr = refUtc.toLocaleDateString('en-CA', { timeZone: SHOP_TIMEZONE });
  const utcHours = refUtc.getUTCHours();
  const localHoursStr = refUtc.toLocaleTimeString('en-GB', { timeZone: SHOP_TIMEZONE, hour: '2-digit', hour12: false });
  const localHours = parseInt(localHoursStr);
  let offsetHours = utcHours - localHours;
  if (utcDateStr !== localDateStr) {
    if (utcDateStr > localDateStr) offsetHours += 24;
    else offsetHours -= 24;
  }
  return Math.floor(new Date(day + 'T00:00:00Z').getTime() / 1000) + (offsetHours * 3600);
}

function toLocalDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString('en-CA', { timeZone: SHOP_TIMEZONE });
}

// TikTok return statuses that mean "still in progress"
const PENDING_STATUSES = new Set([
  'RETURN_OR_REFUND_REQUEST_WAITING_FOR_SELLER_TO_PROCESS',
  'AWAITING_BUYER_SHIP',
  'BUYER_SHIPPED_ITEM',
  'SELLER_RECEIVE_AND_CHECK_ITEM',
  'AWAITING_SELLER_APPROVAL',
  'REPLACE_AWAITING_SELLER_SHIP',
  'IN_PROGRESS',
  'REQUESTED',
  'PENDING',
  'PROCESSING',
]);

function isPendingStatus(status: string): boolean {
  const s = status.toUpperCase();
  if (PENDING_STATUSES.has(s)) return true;
  // Catch-all: anything that's not explicitly completed/rejected/closed
  if (s.includes('COMPLETE') || s.includes('CLOSED') || s.includes('REJECT') || s.includes('CANCELLED') || s.includes('CANCEL_COMPLETE')) {
    return false;
  }
  // If it has "AWAITING" or "WAITING" or "IN_PROGRESS" or "SHIP" in it, it's pending
  if (s.includes('AWAITING') || s.includes('WAITING') || s.includes('IN_PROGRESS') || s.includes('PENDING')) {
    return true;
  }
  return false;
}

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data, error: authError } = await supabase.auth.getUser();
  if (authError || !data.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const dateFrom = searchParams.get('from');
  const dateTo = searchParams.get('to');

  const admin = createAdminClient();

  // Get TikTok connection for API calls
  const { data: connection } = await admin.from('tiktok_connections').select('*').eq('user_id', data.user.id).single();

  // Calculate date range
  const now = new Date();
  const defaultFrom = new Date();
  defaultFrom.setDate(defaultFrom.getDate() - 30);
  const fromStr = dateFrom || defaultFrom.toLocaleDateString('en-CA', { timeZone: SHOP_TIMEZONE });
  const toStr = dateTo || now.toLocaleDateString('en-CA', { timeZone: SHOP_TIMEZONE });
  // Add one day to 'to' so the end timestamp covers the full last day
  const toNext = new Date(toStr + 'T00:00:00Z');
  toNext.setUTCDate(toNext.getUTCDate() + 1);
  const toNextStr = toNext.toISOString().split('T')[0];

  const startTs = dayToTs(fromStr);
  const endTs = dayToTs(toNextStr);

  // Try fetching from TikTok Returns API directly
  let items: Array<{
    order_id: string;
    product_name: string;
    gmv: number;
    status: string;
    order_date: string;
    units: number;
  }> = [];
  let usedLiveApi = false;

  if (connection?.access_token && connection?.shop_cipher) {
    try {
      const accessToken = decryptOrFallback(connection.access_token, 'access_token');
      const [returns, cancellations] = await Promise.all([
        fetchReturns(accessToken, connection.shop_cipher, startTs, endTs),
        fetchCancellations(accessToken, connection.shop_cipher, startTs, endTs),
      ]);

      const allReturns = [...returns, ...cancellations];
      items = allReturns.map(r => ({
        order_id: r.order_id || r.return_id,
        product_name: r.product_name || r.sku_name || 'Unknown',
        gmv: r.refund_amount,
        status: r.status,
        order_date: r.create_time ? toLocalDate(r.create_time) : '',
        units: r.units,
      })).sort((a, b) => b.order_date.localeCompare(a.order_date));

      usedLiveApi = true;
      const distinctStatuses = [...new Set(allReturns.map(r => r.status))];
      const pendingItems = items.filter(i => isPendingStatus(i.status));
      console.log(`[Returns] Live API: ${returns.length} returns, ${cancellations.length} cancellations, statuses: ${JSON.stringify(distinctStatuses)}, pending: ${pendingItems.length}`);
    } catch (err) {
      console.error('[Returns] Live API failed, falling back to DB:', (err as Error).message);
    }
  }

  // Fallback: use synced_order_ids from DB
  if (!usedLiveApi) {
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

    const returns = allRows.filter(row => {
      const s = String(row.status || '').toUpperCase();
      return s === 'CANCELLED' || s.includes('CANCEL') || s.includes('REVERSE') || s.includes('REFUND') || s.includes('RETURN');
    });

    const productIds = [...new Set(returns.map(r => String(r.tiktok_product_id || '')).filter(Boolean))];
    const { data: products } = productIds.length > 0
      ? await admin.from('products').select('tiktok_product_id, name').eq('user_id', data.user.id).in('tiktok_product_id', productIds)
      : { data: [] };
    const nameMap = new Map((products || []).map((p: Record<string, string>) => [p.tiktok_product_id, p.name]));

    items = returns
      .map(r => ({
        order_id: String(r.order_id || ''),
        product_name: nameMap.get(String(r.tiktok_product_id)) || String(r.sku_name || 'Unknown'),
        gmv: Number(r.gmv) || 0,
        status: String(r.status || ''),
        order_date: String(r.order_date || ''),
        units: Number(r.units) || 0,
      }))
      .sort((a, b) => b.order_date.localeCompare(a.order_date));
  }

  // Summary
  const totalReturns = items.length;
  const totalAmount = items.reduce((sum, i) => sum + i.gmv, 0);
  const pendingReturns = items.filter(i => isPendingStatus(i.status)).length;
  const completedReturns = totalReturns - pendingReturns;

  return NextResponse.json({
    summary: { totalReturns, pendingReturns, completedReturns, totalAmount: Math.round(totalAmount * 100) / 100 },
    items,
  });
}
