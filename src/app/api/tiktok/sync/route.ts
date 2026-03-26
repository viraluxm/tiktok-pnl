import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchOrdersPage } from '@/lib/tiktok/client';
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

  // sync_cursor = date chunk start (YYYY-MM-DD), sync_page_cursor = TikTok pagination token
  const syncCursor: string | null = connection.sync_cursor || null;
  const syncPageCursor: string | null = connection.sync_page_cursor || null;

  // Determine which chunk + page to fetch
  let chunkStart: string;
  let pageCursor: string | null = syncPageCursor;
  let isCaughtUp = false;

  if (syncPageCursor && syncCursor) {
    // Resuming pagination within a chunk
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

    // Single API call — one page of up to 50 orders
    const { orders, nextCursor } = await fetchOrdersPage(
      accessToken,
      connection.shop_cipher,
      startTs,
      endTs,
      pageCursor,
    );

    console.log(`[Sync] Got ${orders.length} orders, nextCursor=${nextCursor || 'none'}`);

    // Aggregate this page's orders by date
    let totalCreated = 0;
    let totalUpdated = 0;

    const dailyMap: Record<string, { gmv: number; shipping: number; affiliate: number; orderCount: number }> = {};
    for (const order of orders) {
      const createTime = order.create_time as number;
      const date = new Date(createTime * 1000).toISOString().split('T')[0];
      if (!dailyMap[date]) {
        dailyMap[date] = { gmv: 0, shipping: 0, affiliate: 0, orderCount: 0 };
      }
      const payment = (order.payment || {}) as Record<string, string>;
      dailyMap[date].gmv += parseFloat(payment.total_amount || '0');
      dailyMap[date].shipping += parseFloat(payment.shipping_fee || '0');
      dailyMap[date].orderCount++;
      const lineItems = (order.line_items || []) as Record<string, string>[];
      for (const item of lineItems) {
        dailyMap[date].affiliate += parseFloat(item.platform_commission || '0');
      }
    }

    console.log(`[Sync] Aggregated into ${Object.keys(dailyMap).length} days:`, Object.entries(dailyMap).map(([d, v]) => `${d}=${v.orderCount}orders/$${v.gmv.toFixed(2)}`).join(', '));

    // Add this page's amounts to existing DB rows (accumulate across pages)
    for (const [date, agg] of Object.entries(dailyMap)) {
      const result = await accumulateEntry(admin, {
        user_id: user.id,
        product_id: product.id,
        date,
        gmv: agg.gmv,
        shipping: agg.shipping,
        affiliate: agg.affiliate,
        source: 'tiktok',
        isFirstPageOfChunk: !pageCursor,
      });
      if (result === 'created') totalCreated++;
      else if (result === 'updated') totalUpdated++;
    }

    // Decide next state
    let newSyncCursor: string;
    let newPageCursor: string | null = null;

    if (nextCursor) {
      // More pages in this chunk — stay on same chunk, save page cursor
      newSyncCursor = chunkStart;
      newPageCursor = nextCursor;
    } else {
      // Chunk exhausted — advance to next chunk
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

    return NextResponse.json({
      success: true,
      summary: {
        dateRange: { startDate: chunkStart, endDate: chunkEnd },
        entriesCreated: totalCreated,
        entriesUpdated: totalUpdated,
        ordersFetched: orders.length,
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

// Accumulate order data into daily entries.
// On the first page of a chunk, replace the row (fresh data for this chunk).
// On subsequent pages, ADD to the existing row (same chunk, more orders).
async function accumulateEntry(
  admin: ReturnType<typeof createAdminClient>,
  entry: {
    user_id: string;
    product_id: string;
    date: string;
    gmv: number;
    shipping: number;
    affiliate: number;
    source: string;
    isFirstPageOfChunk: boolean;
  }
): Promise<'created' | 'updated'> {
  const { data: existing } = await admin
    .from('entries')
    .select('id, gmv, shipping, affiliate')
    .eq('user_id', entry.user_id)
    .eq('product_id', entry.product_id)
    .eq('date', entry.date)
    .eq('source', 'tiktok')
    .single();

  if (existing) {
    let newGmv: number;
    let newShipping: number;
    let newAffiliate: number;

    if (entry.isFirstPageOfChunk) {
      // First page of chunk: replace with fresh data
      newGmv = entry.gmv;
      newShipping = entry.shipping;
      newAffiliate = entry.affiliate;
    } else {
      // Subsequent page: add to existing totals
      newGmv = Number(existing.gmv) + entry.gmv;
      newShipping = Number(existing.shipping) + entry.shipping;
      newAffiliate = Number(existing.affiliate) + entry.affiliate;
    }

    await admin
      .from('entries')
      .update({
        gmv: newGmv,
        shipping: newShipping,
        affiliate: newAffiliate,
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
        videos_posted: 0,
        views: 0,
        source: entry.source,
      });

    return 'created';
  }
}
