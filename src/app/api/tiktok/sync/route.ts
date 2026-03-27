import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchOrdersPage, fetchStatements, fetchUnsettledOrders } from '@/lib/tiktok/client';
import { syncLimiter } from '@/lib/rate-limit';
import { decryptOrFallback } from '@/lib/crypto';

const BACKFILL_DAYS = 365;

export const maxDuration = 60;

// sync_cursor = current day (YYYY-MM-DD)
// sync_page_cursor = JSON: {"day":"2025-05-01","splits":4,"index":2}
//   splits=1 means whole day, splits=2 means 12hr halves, etc.
//   index=which window (0-based)

interface WindowState {
  day: string;
  splits: number;
  index: number;
}

function parseWindowState(raw: string | null, fallbackDay: string): WindowState {
  if (!raw) return { day: fallbackDay, splits: 1, index: 0 };
  try {
    const parsed = JSON.parse(raw);
    return { day: parsed.day, splits: parsed.splits || 1, index: parsed.index || 0 };
  } catch {
    return { day: fallbackDay, splits: 1, index: 0 };
  }
}

function getWindowTimestamps(day: string, splits: number, index: number): { startTs: number; endTs: number } {
  const dayStart = Math.floor(new Date(day + 'T00:00:00Z').getTime() / 1000);
  const dayEnd = dayStart + 86400; // next day 00:00:00
  const windowSize = (dayEnd - dayStart) / splits;
  return {
    startTs: Math.floor(dayStart + windowSize * index),
    endTs: Math.floor(dayStart + windowSize * (index + 1)),
  };
}

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

  const dbSyncCursor: string | null = connection.sync_cursor || null;
  const dbPageCursor: string | null = connection.sync_page_cursor || null;
  let isCaughtUp = false;

  // Determine current day
  let currentDay: string;
  if (!dbSyncCursor || dbSyncCursor < backfillStartStr) {
    currentDay = backfillStartStr;
  } else if (dbSyncCursor >= todayStr) {
    // Already caught up — re-sync today
    currentDay = todayStr;
    isCaughtUp = true;
  } else {
    currentDay = dbSyncCursor;
  }

  // Parse window state
  const win = parseWindowState(dbPageCursor, currentDay);
  // If the window state day doesn't match current day, reset
  if (win.day !== currentDay) {
    win.day = currentDay;
    win.splits = 1;
    win.index = 0;
  }

  const { startTs, endTs } = getWindowTimestamps(win.day, win.splits, win.index);

  console.log(`[Sync] day=${win.day} splits=${win.splits} index=${win.index}/${win.splits} ts=${startTs}..${endTs}`);

  try {
    const shopName = connection.shop_name || 'TikTok Shop';
    const product = await getOrCreateProduct(admin, user.id, shopName);

    // ===== FETCH ONE WINDOW =====
    let orders: Record<string, unknown>[] = [];
    let hasMorePages = false;

    try {
      const result = await fetchOrdersPage(accessToken, connection.shop_cipher, startTs, endTs, null);
      orders = result.orders;
      hasMorePages = !!result.nextCursor;
      console.log(`[Sync] Fetched ${orders.length} orders, hasMore=${hasMorePages}`);
    } catch (orderErr) {
      console.warn(`[Sync] Fetch failed for ${win.day} window ${win.index}:`, (orderErr as Error).message);
      // Skip this window on error
    }

    // If this window returned 100 orders AND has more pages, we need to split smaller
    if (hasMorePages && orders.length >= 100 && win.splits < 48) {
      // Don't process these orders — split the window and retry
      const newSplits = win.splits * 2;
      const newIndex = win.index * 2; // first half of current window
      const newState: WindowState = { day: win.day, splits: newSplits, index: newIndex };

      console.log(`[Sync] Window too large (${orders.length}+ orders) — splitting ${win.splits}→${newSplits}, starting at index ${newIndex}`);

      await admin.from('tiktok_connections').update({
        sync_cursor: currentDay,
        sync_page_cursor: JSON.stringify(newState),
        last_synced_at: new Date().toISOString(),
      }).eq('user_id', user.id);

      const { count: totalUniqueOrders } = await admin
        .from('synced_order_ids')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id);

      return NextResponse.json({
        success: true,
        summary: {
          dateRange: { startDate: win.day, endDate: win.day },
          entriesCreated: 0, entriesUpdated: 0,
          ordersFetched: 0, ordersSkipped: 0,
          totalUniqueOrders: totalUniqueOrders || 0,
          isCaughtUp: false, hasMorePages: true,
          windowInfo: `split ${win.splits}→${newSplits}`,
          currentChunk: `${win.day} w${newIndex}/${newSplits}`,
          nextChunk: `${win.day} w${newIndex}/${newSplits}`,
        },
      });
    }

    // ===== DEDUP & STATUS UPDATE =====
    const orderIds = orders.map(o => String((o as Record<string, unknown>).id || '')).filter(Boolean);
    const { data: existingRows } = await admin
      .from('synced_order_ids')
      .select('order_id, status')
      .eq('user_id', user.id)
      .in('order_id', orderIds.length > 0 ? orderIds : ['__none__']);

    const existingMap = new Map((existingRows || []).map(r => [r.order_id, r.status]));
    const newOrders = orders.filter(o => !existingMap.has(String((o as Record<string, unknown>).id || '')));
    const skippedCount = orders.length - newOrders.length;

    console.log(`[Sync] Deduped: ${newOrders.length} new, ${skippedCount} dupes`);

    // Track affected dates+products for rebuild
    const affectedKeys = new Set<string>(); // "date|productUuid"
    const productCache: Record<string, string> = {};

    // Update status on EXISTING orders (retroactive fix for cancelled/refunded)
    for (const order of orders) {
      const o = order as Record<string, unknown>;
      const orderId = String(o.id || '');
      const newStatus = String(o.status || '').toUpperCase();
      const oldStatus = existingMap.get(orderId);

      if (oldStatus !== undefined && oldStatus !== newStatus && newStatus) {
        await admin.from('synced_order_ids')
          .update({ status: newStatus })
          .eq('user_id', user.id)
          .eq('order_id', orderId);

        // Mark this order's date for rebuild since status changed
        const createTime = o.create_time as number;
        if (createTime) {
          const date = new Date(createTime * 1000).toISOString().split('T')[0];
          // We need the product UUID — look it up or use fallback
          affectedKeys.add(`${date}|${product.id}`);
        }
      }
    }

    // Insert NEW orders
    for (const order of newOrders) {
      const o = order as Record<string, unknown>;
      const orderId = String(o.id || '');
      const createTime = o.create_time as number;
      const date = new Date(createTime * 1000).toISOString().split('T')[0];
      const status = String(o.status || '').toUpperCase();

      const payment = (o.payment || {}) as Record<string, unknown>;
      const orderGmv = toNum(payment.total_amount) || toNum(payment.product_total_amount) || 0;
      const orderShipping = toNum(payment.shipping_fee) || toNum(payment.shipping_fee_amount) || 0;
      const orderPlatformFee = toNum(payment.platform_commission) || toNum(payment.platform_fee) || toNum(payment.transaction_fee) || 0;
      let orderAffiliate = toNum(payment.affiliate_commission) || toNum(payment.creator_commission) || toNum(payment.referral_fee) || 0;

      const lineItems = (o.line_items || o.order_line_list || []) as Record<string, unknown>[];
      let units = 0;

      let tikTokProductId: string | null = null;
      for (const item of lineItems) {
        units += Number(item.quantity) || 1;
        if (orderAffiliate === 0) {
          orderAffiliate += toNum(item.affiliate_commission) || toNum(item.creator_commission) || 0;
        }
        if (!tikTokProductId) {
          tikTokProductId = String(item.product_id || '') || null;
          const productName = String(item.product_name || item.sku_name || '') || null;
          const skuImage = String(item.sku_image || item.product_image || '') || null;
          const skuId = String(item.sku_id || '') || null;

          if (tikTokProductId && productName) {
            if (!productCache[tikTokProductId]) {
              const productUuid = await getOrCreateTikTokProduct(admin, user.id, tikTokProductId, productName, skuImage, skuId);
              productCache[tikTokProductId] = productUuid;
            }
          }
        }
      }
      if (units === 0) units = 1;

      const productUuid = (tikTokProductId && productCache[tikTokProductId])
        ? productCache[tikTokProductId]
        : product.id;

      await admin.from('synced_order_ids').upsert({
        user_id: user.id, order_id: orderId, order_date: date,
        gmv: orderGmv, shipping: orderShipping, affiliate: orderAffiliate,
        platform_fee: orderPlatformFee, units, tiktok_product_id: tikTokProductId,
        status,
      }, { onConflict: 'user_id,order_id' });

      affectedKeys.add(`${date}|${productUuid}`);
    }

    // ===== ADVANCE WINDOW / DAY =====
    let newSyncCursor: string;
    let newPageCursor: string | null = null;

    const nextWindowIndex = win.index + 1;
    if (nextWindowIndex < win.splits) {
      // More windows in this day
      newSyncCursor = currentDay;
      newPageCursor = JSON.stringify({ day: win.day, splits: win.splits, index: nextWindowIndex });
    } else {
      // Day complete — advance to next day
      const nextDay = new Date(currentDay + 'T00:00:00Z');
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      const nextDayStr = nextDay.toISOString().split('T')[0];

      if (nextDayStr > todayStr) {
        isCaughtUp = true;
        newSyncCursor = todayStr;
      } else {
        newSyncCursor = nextDayStr;
      }
      newPageCursor = null;
    }

    // ===== SAVE CURSOR =====
    console.log(`[Sync] Saving: sync_cursor=${newSyncCursor}, sync_page_cursor=${newPageCursor || 'null'}`);
    await admin.from('tiktok_connections').update({
      last_synced_at: new Date().toISOString(),
      sync_cursor: newSyncCursor,
      sync_page_cursor: newPageCursor,
    }).eq('user_id', user.id);

    // ===== REBUILD AFFECTED DATE+PRODUCT ENTRIES =====
    let totalCreated = 0;
    let totalUpdated = 0;

    if (affectedKeys.size > 0) {
      for (const key of affectedKeys) {
        const [date, productUuid] = key.split('|');

        // Find which tiktok_product_ids map to this product UUID
        const { data: productRow } = await admin.from('products').select('tiktok_product_id').eq('id', productUuid).single();
        const tikTokPid = productRow?.tiktok_product_id;

        // Query synced_order_ids for this date + product, excluding cancelled/refunded
        let q = admin.from('synced_order_ids')
          .select('gmv, shipping, affiliate, platform_fee, units, status')
          .eq('user_id', user.id)
          .eq('order_date', date);

        if (tikTokPid) {
          q = q.eq('tiktok_product_id', tikTokPid);
        } else {
          q = q.is('tiktok_product_id', null);
        }

        const { data: dayOrders } = await q;

        // Filter out cancelled/refunded orders
        const activeOrders = (dayOrders || []).filter(row => !isOrderExcluded(row.status));

        const t = activeOrders.reduce((acc, row) => ({
          gmv: acc.gmv + Number(row.gmv),
          shipping: acc.shipping + Number(row.shipping),
          affiliate: acc.affiliate + Number(row.affiliate),
          platformFee: acc.platformFee + Number(row.platform_fee),
          units: acc.units + (Number(row.units) || 1),
        }), { gmv: 0, shipping: 0, affiliate: 0, platformFee: 0, units: 0 });

        const result = await setEntry(admin, {
          user_id: user.id, product_id: productUuid, date,
          gmv: t.gmv, shipping: t.shipping, affiliate: t.affiliate,
          platform_fee: t.platformFee, units_sold: t.units, source: 'tiktok',
        });
        if (result === 'created') totalCreated++;
        else if (result === 'updated') totalUpdated++;
      }
      console.log(`[Sync] Rebuilt ${affectedKeys.size} date+product entries`);
    }

    // ===== FINANCE (when a full day completes) =====
    if (!newPageCursor && !isCaughtUp) {
      const dayStartTs = Math.floor(new Date(currentDay + 'T00:00:00Z').getTime() / 1000);
      const dayEndTs = dayStartTs + 86400;
      try {
        const statements = await fetchStatements(accessToken, connection.shop_cipher, dayStartTs, dayEndTs);
        console.log(`[Sync] Finance for ${currentDay}: ${statements.length} statements`);
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
        dateRange: { startDate: win.day, endDate: win.day },
        entriesCreated: totalCreated,
        entriesUpdated: totalUpdated,
        ordersFetched: newOrders.length,
        ordersSkipped: skippedCount,
        totalUniqueOrders: totalUniqueOrders || 0,
        isCaughtUp,
        hasMorePages: !!newPageCursor,
        windowInfo: `w${win.index}/${win.splits}`,
        currentChunk: `${win.day} w${win.index}/${win.splits}`,
        nextChunk: newPageCursor ? `${win.day} w${nextWindowIndex}/${win.splits}` : newSyncCursor,
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

async function getOrCreateTikTokProduct(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  tikTokProductId: string,
  name: string,
  imageUrl: string | null,
  sku: string | null,
): Promise<string> {
  // Check if product already exists by tiktok_product_id
  const { data: existing } = await admin.from('products')
    .select('id')
    .eq('user_id', userId)
    .eq('tiktok_product_id', tikTokProductId)
    .single();

  if (existing) {
    // Update image/sku if we have new data
    if (imageUrl || sku) {
      await admin.from('products').update({
        ...(imageUrl ? { image_url: imageUrl } : {}),
        ...(sku ? { sku } : {}),
      }).eq('id', existing.id);
    }
    return existing.id;
  }

  // Create new product
  const { data: created, error } = await admin.from('products').insert({
    user_id: userId,
    name: name || `Product ${tikTokProductId.slice(-6)}`,
    tiktok_product_id: tikTokProductId,
    image_url: imageUrl,
    sku,
  }).select('id').single();

  if (error) {
    // If unique constraint on (user_id, name) fails, try with a suffix
    const { data: retry, error: retryErr } = await admin.from('products').insert({
      user_id: userId,
      name: `${name} (${tikTokProductId.slice(-6)})`,
      tiktok_product_id: tikTokProductId,
      image_url: imageUrl,
      sku,
    }).select('id').single();
    if (retryErr) throw new Error(`Failed to create product: ${retryErr.message}`);
    return retry.id;
  }

  return created.id;
}

function isOrderExcluded(status: string | null | undefined): boolean {
  if (!status) return false;
  const s = status.toUpperCase();
  return s === 'CANCELLED' || s.includes('CANCEL') || s.includes('REFUND');
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
