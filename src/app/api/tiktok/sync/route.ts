import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchOrdersPage, fetchStatements, fetchUnsettledOrders } from '@/lib/tiktok/client';
import { syncLimiter } from '@/lib/rate-limit';
import { decryptOrFallback } from '@/lib/crypto';

const CHUNK_DAYS = 7;
const BACKFILL_DAYS = 365;

export const maxDuration = 60;

export async function POST() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { success, retryAfterMs } = syncLimiter.check(`sync:${user.id}`);
  if (!success) {
    return NextResponse.json(
      { error: 'Too many sync requests. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((retryAfterMs || 0) / 1000)) } },
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

  // Read cursors from DB
  const dbSyncCursor: string | null = connection.sync_cursor || null;
  const dbPageCursor: string | null = connection.sync_page_cursor || null;
  let isCaughtUp = false;

  // Determine chunk start and page cursor
  let chunkStart: string;
  let pageCursor: string | null;

  if (dbPageCursor && dbSyncCursor) {
    // Resuming pagination within a chunk
    chunkStart = dbSyncCursor;
    pageCursor = dbPageCursor;
  } else if (!dbSyncCursor || dbSyncCursor < backfillStartStr) {
    chunkStart = backfillStartStr;
    pageCursor = null;
  } else if (dbSyncCursor >= todayStr) {
    const weekAgo = new Date(today);
    weekAgo.setUTCDate(weekAgo.getUTCDate() - CHUNK_DAYS);
    chunkStart = weekAgo.toISOString().split('T')[0];
    pageCursor = null;
    isCaughtUp = true;
  } else {
    chunkStart = dbSyncCursor;
    pageCursor = null;
  }

  // Chunk end
  const chunkEndDate = new Date(chunkStart + 'T00:00:00Z');
  chunkEndDate.setUTCDate(chunkEndDate.getUTCDate() + CHUNK_DAYS - 1);
  const chunkEnd = chunkEndDate > today ? todayStr : chunkEndDate.toISOString().split('T')[0];

  const nextChunkDate = new Date(chunkEnd + 'T00:00:00Z');
  nextChunkDate.setUTCDate(nextChunkDate.getUTCDate() + 1);
  const nextChunkStr = nextChunkDate.toISOString().split('T')[0];

  const startTs = Math.floor(new Date(chunkStart + 'T00:00:00Z').getTime() / 1000);
  const endTs = Math.floor(new Date(chunkEnd + 'T23:59:59Z').getTime() / 1000);

  console.log(`[Sync] chunk=${chunkStart}..${chunkEnd} dbPageCursor=${dbPageCursor || 'null'} pageCursor=${pageCursor || 'null'}`);

  try {
    const shopName = connection.shop_name || 'TikTok Shop';
    const product = await getOrCreateProduct(admin, user.id, shopName);

    // ===== FETCH ONE PAGE =====
    let orders: Record<string, unknown>[] = [];
    let rawNextCursor: string | null = null;

    try {
      console.log(`[Sync] Fetching page with cursor: ${pageCursor || 'null'}`);
      const result = await fetchOrdersPage(accessToken, connection.shop_cipher, startTs, endTs, pageCursor);
      orders = result.orders;
      rawNextCursor = result.nextCursor;
      console.log(`[Sync] Got ${orders.length} orders, rawNextCursor=${rawNextCursor || 'null'}`);
    } catch (orderErr) {
      console.warn(`[Sync] Orders fetch failed for chunk ${chunkStart}..${chunkEnd}:`, (orderErr as Error).message);
    }

    // ===== DEDUP =====
    const orderIds = orders.map(o => String((o as Record<string, unknown>).id || '')).filter(Boolean);
    const { data: existingRows } = await admin
      .from('synced_order_ids')
      .select('order_id')
      .eq('user_id', user.id)
      .in('order_id', orderIds.length > 0 ? orderIds : ['__none__']);

    const existingIds = new Set((existingRows || []).map(r => r.order_id));
    const newOrders = orders.filter(o => !existingIds.has(String((o as Record<string, unknown>).id || '')));
    const skippedCount = orders.length - newOrders.length;

    console.log(`[Sync] Deduped: ${newOrders.length} new, ${skippedCount} dupes`);

    // ===== INSERT NEW ORDERS =====
    const newOrderDates: string[] = [];

    for (const order of newOrders) {
      const o = order as Record<string, unknown>;
      const orderId = String(o.id || '');
      const createTime = o.create_time as number;
      const date = new Date(createTime * 1000).toISOString().split('T')[0];

      const payment = (o.payment || {}) as Record<string, unknown>;
      const gmv = toNum(payment.total_amount) || toNum(payment.product_total_amount) || 0;
      const shipping = toNum(payment.shipping_fee) || toNum(payment.shipping_fee_amount) || 0;
      const platformFee = toNum(payment.platform_commission) || toNum(payment.platform_fee) || toNum(payment.transaction_fee) || 0;
      let affiliate = toNum(payment.affiliate_commission) || toNum(payment.creator_commission) || toNum(payment.referral_fee) || 0;

      const lineItems = (o.line_items || o.order_line_list || []) as Record<string, unknown>[];
      let units = 0;
      for (const item of lineItems) {
        units += Number(item.quantity) || 1;
        if (affiliate === 0) {
          affiliate += toNum(item.affiliate_commission) || toNum(item.creator_commission) || 0;
        }
      }
      if (units === 0) units = 1;

      await admin.from('synced_order_ids').upsert({
        user_id: user.id, order_id: orderId, order_date: date,
        gmv, shipping, affiliate, platform_fee: platformFee, units,
      }, { onConflict: 'user_id,order_id' });

      newOrderDates.push(date);
    }

    // ===== DECIDE NEXT CURSOR =====
    // Simple: if TikTok gave us a cursor → save it, more pages in this chunk
    //         if no cursor → chunk done, advance to next chunk
    let newSyncCursor: string;
    let newPageCursor: string | null;
    const allDuplicates = orders.length > 0 && newOrders.length === 0;

    if (rawNextCursor && !allDuplicates) {
      // More pages in this chunk
      newSyncCursor = chunkStart;
      newPageCursor = rawNextCursor;
    } else {
      // Chunk done (no cursor, or all dupes) → advance
      newSyncCursor = nextChunkStr;
      newPageCursor = null;
      if (chunkEnd >= todayStr) {
        isCaughtUp = true;
        newSyncCursor = todayStr;
      }
      if (allDuplicates) {
        console.log(`[Sync] All ${orders.length} orders were dupes — advancing to next chunk`);
      }
    }

    // ===== SAVE CURSOR =====
    console.log(`[Sync] Saving cursor: sync_cursor=${newSyncCursor}, sync_page_cursor=${newPageCursor || 'null'}`);
    await admin.from('tiktok_connections').update({
      last_synced_at: new Date().toISOString(),
      sync_cursor: newSyncCursor,
      sync_page_cursor: newPageCursor,
    }).eq('user_id', user.id);

    // ===== REBUILD ENTRIES FOR AFFECTED DATES ONLY =====
    let totalCreated = 0;
    let totalUpdated = 0;
    const affectedDates = [...new Set(newOrderDates)];

    if (affectedDates.length > 0) {
      for (const date of affectedDates) {
        const { data: dayOrders } = await admin
          .from('synced_order_ids')
          .select('gmv, shipping, affiliate, platform_fee, units')
          .eq('user_id', user.id)
          .eq('order_date', date);

        const t = (dayOrders || []).reduce((acc, row) => ({
          gmv: acc.gmv + Number(row.gmv),
          shipping: acc.shipping + Number(row.shipping),
          affiliate: acc.affiliate + Number(row.affiliate),
          platformFee: acc.platformFee + Number(row.platform_fee),
          units: acc.units + (Number(row.units) || 1),
        }), { gmv: 0, shipping: 0, affiliate: 0, platformFee: 0, units: 0 });

        const result = await setEntry(admin, {
          user_id: user.id, product_id: product.id, date,
          gmv: t.gmv, shipping: t.shipping, affiliate: t.affiliate,
          platform_fee: t.platformFee, units_sold: t.units, source: 'tiktok',
        });
        if (result === 'created') totalCreated++;
        else if (result === 'updated') totalUpdated++;
      }
      console.log(`[Sync] Rebuilt ${affectedDates.length} daily entries`);
    }

    // ===== FETCH FINANCE (only when chunk fully done) =====
    if (!newPageCursor && !isCaughtUp) {
      try {
        const statements = await fetchStatements(accessToken, connection.shop_cipher, startTs, endTs);
        console.log(`[Sync] Finance: ${statements.length} statements`);
      } catch { /* non-fatal */ }

      if (!dbSyncCursor) {
        try { await fetchUnsettledOrders(accessToken, connection.shop_cipher); } catch { /* non-fatal */ }
      }
    }

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
        ordersSkipped: skippedCount,
        totalUniqueOrders: totalUniqueOrders || 0,
        isCaughtUp,
        hasMorePages: !!newPageCursor,
        currentChunk: `${chunkStart}..${chunkEnd}`,
        nextChunk: newPageCursor ? `${chunkStart} (page)` : nextChunkStr,
        rawNextCursor: rawNextCursor || null,
        savedPageCursor: newPageCursor || null,
      },
    });
  } catch (error) {
    console.error('Sync failed:', error);
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 });
  }
}

// ==================== HELPERS ====================

async function getOrCreateProduct(admin: ReturnType<typeof createAdminClient>, userId: string, shopName: string) {
  const { data: existing } = await admin.from('products').select('*').eq('user_id', userId).eq('name', shopName).single();
  if (existing) return existing;
  const { data: created, error } = await admin.from('products').insert({ user_id: userId, name: shopName }).select().single();
  if (error) throw new Error(`Failed to create product: ${error.message}`);
  return created;
}

function toNum(val: unknown): number {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') return parseFloat(val) || 0;
  return 0;
}

async function setEntry(
  admin: ReturnType<typeof createAdminClient>,
  entry: { user_id: string; product_id: string; date: string; gmv: number; shipping: number; affiliate: number; platform_fee: number; units_sold: number; source: string }
): Promise<'created' | 'updated'> {
  const { data: existing } = await admin.from('entries').select('id')
    .eq('user_id', entry.user_id).eq('product_id', entry.product_id)
    .eq('date', entry.date).eq('source', 'tiktok').single();

  if (existing) {
    await admin.from('entries').update({
      gmv: entry.gmv, shipping: entry.shipping, affiliate: entry.affiliate,
      platform_fee: entry.platform_fee, units_sold: entry.units_sold, ads: 0,
      updated_at: new Date().toISOString(),
    }).eq('id', existing.id);
    return 'updated';
  }

  await admin.from('entries').insert({
    user_id: entry.user_id, product_id: entry.product_id, date: entry.date,
    gmv: entry.gmv, ads: 0, shipping: entry.shipping, affiliate: entry.affiliate,
    platform_fee: entry.platform_fee, units_sold: entry.units_sold,
    videos_posted: 0, views: 0, source: entry.source,
  });
  return 'created';
}
