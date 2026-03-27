import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchOrdersPage, fetchStatements } from '@/lib/tiktok/client';
import { syncLimiter } from '@/lib/rate-limit';
import { decryptOrFallback } from '@/lib/crypto';

const CHUNK_DAYS = 7;
const BACKFILL_DAYS = 30;

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { success, retryAfterMs } = syncLimiter.check(`sync:${user.id}`);
  if (!success) {
    return NextResponse.json(
      { error: 'Too many sync requests. Please try again later.' },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil((retryAfterMs || 0) / 1000)) },
      },
    );
  }

  const admin = createAdminClient();

  const { data: connection, error: connError } = await admin
    .from('tiktok_connections')
    .select('*')
    .eq('user_id', user.id)
    .single();

  if (connError || !connection) {
    return NextResponse.json({ error: 'No TikTok connection found' }, { status: 404 });
  }

  if (!connection.shop_cipher) {
    return NextResponse.json({ error: 'No shop_cipher — reconnect TikTok' }, { status: 400 });
  }

  const accessToken = decryptOrFallback(connection.access_token, 'access_token');

  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  const backfillStart = new Date(today);
  backfillStart.setUTCDate(backfillStart.getUTCDate() - BACKFILL_DAYS);
  const backfillStartStr = backfillStart.toISOString().split('T')[0];

  const syncCursor: string | null = connection.sync_cursor || null;
  const syncPageCursor: string | null = connection.sync_page_cursor || null;

  let chunkStart: string;
  let pageCursor: string | null = syncPageCursor;
  let isCaughtUp = false;

  if (syncPageCursor && syncCursor) {
    chunkStart = syncCursor;
    pageCursor = syncPageCursor;
  } else if (!syncCursor || syncCursor < backfillStartStr) {
    chunkStart = backfillStartStr;
    pageCursor = null;
  } else if (syncCursor >= todayStr) {
    const weekAgo = new Date(today);
    weekAgo.setUTCDate(weekAgo.getUTCDate() - CHUNK_DAYS);
    chunkStart = weekAgo.toISOString().split('T')[0];
    pageCursor = null;
    isCaughtUp = true;
  } else {
    chunkStart = syncCursor;
    pageCursor = null;
  }

  const chunkEndDate = new Date(chunkStart + 'T00:00:00Z');
  chunkEndDate.setUTCDate(chunkEndDate.getUTCDate() + CHUNK_DAYS - 1);
  let chunkEnd: string;
  if (chunkEndDate > today) {
    chunkEnd = todayStr;
  } else {
    chunkEnd = chunkEndDate.toISOString().split('T')[0];
  }

  const startTs = Math.floor(new Date(chunkStart + 'T00:00:00Z').getTime() / 1000);
  const endTs = Math.floor(new Date(chunkEnd + 'T23:59:59Z').getTime() / 1000);

  console.log(`[Sync] chunk=${chunkStart}..${chunkEnd} ts=${startTs}..${endTs} pageCursor=${pageCursor || 'none'}`);

  try {
    const shopName = connection.shop_name || 'TikTok Shop';
    const product = await getOrCreateProduct(admin, user.id, shopName);

    // Fetch one page of orders
    const { orders, nextCursor } = await fetchOrdersPage(
      accessToken,
      connection.shop_cipher,
      startTs,
      endTs,
      pageCursor,
    );

    console.log(`[Sync] Got ${orders.length} orders, nextCursor=${nextCursor || 'none'}`);

    if (orders.length > 0) {
      const sample = orders[0] as Record<string, unknown>;
      console.log('[Sync] SAMPLE ORDER keys:', Object.keys(sample).join(', '));
      console.log('[Sync] SAMPLE ORDER payment:', JSON.stringify(sample.payment, null, 2));
      const sampleItems = (sample.line_items || sample.order_line_list || sample.item_list || []) as Record<string, unknown>[];
      if (sampleItems.length > 0) {
        console.log('[Sync] SAMPLE LINE ITEM keys:', Object.keys(sampleItems[0]).join(', '));
        console.log('[Sync] SAMPLE LINE ITEM:', JSON.stringify(sampleItems[0], null, 2).slice(0, 2000));
      }
      console.log('[Sync] SAMPLE ORDER full:', JSON.stringify(sample, null, 2).slice(0, 3000));
    }

    // Extract order IDs from this page
    const orderIds = orders.map(o => String((o as Record<string, unknown>).id || '')).filter(Boolean);

    // Check which order IDs already exist in the DB
    const { data: existingRows } = await admin
      .from('synced_order_ids')
      .select('order_id')
      .eq('user_id', user.id)
      .in('order_id', orderIds.length > 0 ? orderIds : ['__none__']);

    const existingIds = new Set((existingRows || []).map(r => r.order_id));
    const newOrders = orders.filter(o => !existingIds.has(String((o as Record<string, unknown>).id || '')));
    const duplicateCount = orders.length - newOrders.length;

    console.log(`[Sync] Deduped: ${newOrders.length} new orders, ${duplicateCount} already existed`);

    // Aggregate only NEW orders by date
    const dailyMap: Record<string, { gmv: number; shipping: number; affiliate: number; platformFee: number; orderCount: number }> = {};

    for (const order of newOrders) {
      const o = order as Record<string, unknown>;
      const orderId = String(o.id || '');
      const createTime = o.create_time as number;
      const date = new Date(createTime * 1000).toISOString().split('T')[0];

      if (!dailyMap[date]) {
        dailyMap[date] = { gmv: 0, shipping: 0, affiliate: 0, platformFee: 0, orderCount: 0 };
      }

      const payment = (o.payment || {}) as Record<string, unknown>;
      const gmv = toNum(payment.total_amount) || toNum(payment.product_total_amount) || toNum(payment.original_total_product_price) || 0;
      const shipping = toNum(payment.shipping_fee) || toNum(payment.shipping_fee_amount) || toNum(payment.actual_shipping_fee_amount) || 0;
      const platformFee = toNum(payment.platform_commission) || toNum(payment.platform_fee) || toNum(payment.transaction_fee) || 0;
      let affiliate = toNum(payment.affiliate_commission) || toNum(payment.creator_commission) || toNum(payment.referral_fee) || toNum(payment.affiliate_partner_commission) || 0;

      // Check line items if no payment-level affiliate
      if (affiliate === 0) {
        const lineItems = (o.line_items || o.order_line_list || []) as Record<string, unknown>[];
        for (const item of lineItems) {
          affiliate += toNum(item.platform_commission) || toNum(item.affiliate_commission) || toNum(item.creator_commission) || 0;
        }
      }

      dailyMap[date].gmv += gmv;
      dailyMap[date].shipping += shipping;
      dailyMap[date].platformFee += platformFee;
      dailyMap[date].affiliate += affiliate;
      dailyMap[date].orderCount++;

      // Store this order ID with its amounts
      await admin
        .from('synced_order_ids')
        .upsert({
          user_id: user.id,
          order_id: orderId,
          order_date: date,
          gmv,
          shipping,
          affiliate,
          platform_fee: platformFee,
        }, { onConflict: 'user_id,order_id' });
    }

    console.log(`[Sync] Aggregated ${newOrders.length} new orders into ${Object.keys(dailyMap).length} days:`,
      Object.entries(dailyMap).map(([d, v]) => `${d}=${v.orderCount}orders gmv=$${v.gmv.toFixed(2)}`).join(' | '));

    // Fetch finance statements on the last page of a chunk (1 extra API call)
    if (!nextCursor) {
      try {
        const { statements, rawResponse } = await fetchStatements(
          accessToken, connection.shop_cipher, startTs, endTs,
        );
        console.log(`[Sync] Finance: ${statements.length} statements for chunk`);
        if (statements.length > 0) {
          console.log('[Sync] SAMPLE STATEMENT:', JSON.stringify(statements[0].raw, null, 2).slice(0, 2000));
        }
      } catch (finErr) {
        console.warn('[Sync] Finance statements fetch failed (non-fatal):', (finErr as Error).message);
      }
    }

    // Rebuild daily totals from ALL synced orders for affected dates
    let totalCreated = 0;
    let totalUpdated = 0;

    const affectedDates = Object.keys(dailyMap);
    for (const date of affectedDates) {
      // Sum all synced orders for this date from the DB (single source of truth)
      const { data: dayOrders } = await admin
        .from('synced_order_ids')
        .select('gmv, shipping, affiliate, platform_fee')
        .eq('user_id', user.id)
        .eq('order_date', date);

      const totals = (dayOrders || []).reduce((acc, row) => ({
        gmv: acc.gmv + Number(row.gmv),
        shipping: acc.shipping + Number(row.shipping),
        affiliate: acc.affiliate + Number(row.affiliate),
        platformFee: acc.platformFee + Number(row.platform_fee),
      }), { gmv: 0, shipping: 0, affiliate: 0, platformFee: 0 });

      const result = await setEntry(admin, {
        user_id: user.id,
        product_id: product.id,
        date,
        gmv: totals.gmv,
        shipping: totals.shipping,
        affiliate: totals.affiliate,
        platform_fee: totals.platformFee,
        source: 'tiktok',
      });
      if (result === 'created') totalCreated++;
      else if (result === 'updated') totalUpdated++;
    }

    // Decide next state
    let newSyncCursor: string;
    let newPageCursor: string | null = null;

    if (nextCursor) {
      newSyncCursor = chunkStart;
      newPageCursor = nextCursor;
    } else {
      const nextChunkDate = new Date(chunkEnd + 'T00:00:00Z');
      nextChunkDate.setUTCDate(nextChunkDate.getUTCDate() + 1);
      newSyncCursor = nextChunkDate.toISOString().split('T')[0];
      newPageCursor = null;

      if (chunkEnd >= todayStr) {
        isCaughtUp = true;
        newSyncCursor = todayStr;
      }
    }

    await admin
      .from('tiktok_connections')
      .update({
        last_synced_at: new Date().toISOString(),
        sync_cursor: newSyncCursor,
        sync_page_cursor: newPageCursor,
      })
      .eq('user_id', user.id);

    // Get total unique orders count for this user
    const { count: totalUniqueOrders } = await admin
      .from('synced_order_ids')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id);

    return NextResponse.json({
      success: true,
      summary: {
        dateRange: { startDate: chunkStart, endDate: chunkEnd },
        entriesCreated: totalCreated,
        entriesUpdated: totalUpdated,
        ordersFetched: newOrders.length,
        ordersSkipped: duplicateCount,
        totalUniqueOrders: totalUniqueOrders || 0,
        isCaughtUp,
        hasMorePages: !!nextCursor,
      },
    });
  } catch (error) {
    console.error('Sync failed:', error);
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 });
  }
}

// ==================== HELPERS ====================

async function getOrCreateProduct(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  shopName: string
) {
  const { data: existing } = await admin
    .from('products')
    .select('*')
    .eq('user_id', userId)
    .eq('name', shopName)
    .single();

  if (existing) return existing;

  const { data: created, error } = await admin
    .from('products')
    .insert({ user_id: userId, name: shopName })
    .select()
    .single();

  if (error) throw new Error(`Failed to create product: ${error.message}`);
  return created;
}

function toNum(val: unknown): number {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') return parseFloat(val) || 0;
  return 0;
}

// Set daily entry to exact totals (rebuilt from synced_order_ids)
async function setEntry(
  admin: ReturnType<typeof createAdminClient>,
  entry: {
    user_id: string;
    product_id: string;
    date: string;
    gmv: number;
    shipping: number;
    affiliate: number;
    platform_fee: number;
    source: string;
  }
): Promise<'created' | 'updated'> {
  const { data: existing } = await admin
    .from('entries')
    .select('id')
    .eq('user_id', entry.user_id)
    .eq('product_id', entry.product_id)
    .eq('date', entry.date)
    .eq('source', 'tiktok')
    .single();

  if (existing) {
    await admin
      .from('entries')
      .update({
        gmv: entry.gmv,
        shipping: entry.shipping,
        affiliate: entry.affiliate,
        platform_fee: entry.platform_fee,
        ads: 0,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id);
    return 'updated';
  } else {
    await admin
      .from('entries')
      .insert({
        user_id: entry.user_id,
        product_id: entry.product_id,
        date: entry.date,
        gmv: entry.gmv,
        ads: 0,
        shipping: entry.shipping,
        affiliate: entry.affiliate,
        platform_fee: entry.platform_fee,
        videos_posted: 0,
        views: 0,
        source: entry.source,
      });
    return 'created';
  }
}
