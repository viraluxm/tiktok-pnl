import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchOrdersPage } from '@/lib/tiktok/client';
import { syncLimiter } from '@/lib/rate-limit';
import { decryptOrFallback } from '@/lib/crypto';

const BACKFILL_DAYS = 365;
const TIME_BUDGET_MS = 240_000; // 240s fetch, 60s for rebuild + cursor save
const DEFAULT_WINDOW_DAYS = 7;
const PARALLEL_FETCHES = 5;
const UPSERT_BATCH_SIZE = 500; // Rows per bulk upsert

export const maxDuration = 300;

type AdminClient = ReturnType<typeof createAdminClient>;
type OrderRow = { gmv: number; shipping: number; affiliate: number; platform_fee: number; units: number; status: string };

interface PendingWindow { startTs: number; endTs: number }

function dayToTs(day: string): number {
  return Math.floor(new Date(day + 'T00:00:00Z').getTime() / 1000);
}
function advanceDays(day: string, n: number): string {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}
function splitWindow(w: PendingWindow): PendingWindow[] {
  const mid = Math.floor((w.startTs + w.endTs) / 2);
  return [{ startTs: w.startTs, endTs: mid }, { startTs: mid, endTs: w.endTs }];
}
function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function toNum(val: unknown): number {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') return parseFloat(val) || 0;
  return 0;
}
function isOrderExcluded(status: string | null | undefined): boolean {
  if (!status) return false;
  const s = status.toUpperCase();
  return s === 'CANCELLED' || s.includes('CANCEL') || s.includes('REFUND');
}

// Parse order into a flat row for bulk upsert
function parseOrder(userId: string, o: Record<string, unknown>) {
  const orderId = String(o.id || '');
  const createTime = o.create_time as number;
  const date = createTime ? new Date(createTime * 1000).toISOString().split('T')[0] : '';
  const status = String(o.status || '').toUpperCase();
  const payment = (o.payment || {}) as Record<string, unknown>;
  const gmv = toNum(payment.total_amount) || toNum(payment.product_total_amount) || 0;
  const shipping = toNum(payment.shipping_fee) || toNum(payment.shipping_fee_amount) || 0;
  const platformFee = toNum(payment.platform_commission) || toNum(payment.platform_fee) || toNum(payment.transaction_fee) || 0;
  let affiliate = toNum(payment.affiliate_commission) || toNum(payment.creator_commission) || toNum(payment.referral_fee) || 0;

  const lineItems = (o.line_items || o.order_line_list || []) as Record<string, unknown>[];
  let units = 0;
  let tikTokProductId: string | null = null;
  let skuId: string | null = null;
  let skuName: string | null = null;
  let productName: string | null = null;
  let skuImage: string | null = null;

  for (const item of lineItems) {
    units += Number(item.quantity) || 1;
    if (affiliate === 0) affiliate += toNum(item.affiliate_commission) || toNum(item.creator_commission) || 0;
    if (!tikTokProductId) {
      tikTokProductId = String(item.product_id || '') || null;
      skuId = String(item.sku_id || '') || null;
      skuName = String(item.sku_name || '') || null;
      productName = String(item.product_name || item.sku_name || '') || null;
      skuImage = String(item.sku_image || item.product_image || '') || null;
    }
  }
  if (units === 0) units = 1;

  return {
    row: {
      user_id: userId, order_id: orderId, order_date: date,
      gmv, shipping, affiliate, platform_fee: platformFee, units,
      tiktok_product_id: tikTokProductId, sku_id: skuId, sku_name: skuName, status,
    },
    date,
    productInfo: tikTokProductId && productName ? { tikTokProductId, productName, skuImage, skuId } : null,
  };
}

function parsePendingWindows(raw: string | null): PendingWindow[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed.day && parsed.splits) {
      const windows: PendingWindow[] = [];
      const dayStart = dayToTs(parsed.day);
      const ws = 86400 / parsed.splits;
      for (let i = parsed.index || 0; i < parsed.splits; i++) {
        windows.push({ startTs: Math.floor(dayStart + ws * i), endTs: Math.floor(dayStart + ws * (i + 1)) });
      }
      return windows;
    }
    return [];
  } catch { return []; }
}

export async function POST() {
  const batchStart = Date.now();
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { success, retryAfterMs } = syncLimiter.check(`sync:${user.id}`);
  if (!success) return NextResponse.json({ error: 'Rate limited' }, { status: 429, headers: { 'Retry-After': String(Math.ceil((retryAfterMs || 0) / 1000)) } });

  const admin = createAdminClient();
  const { data: connection, error: connError } = await admin.from('tiktok_connections').select('*').eq('user_id', user.id).single();
  if (connError || !connection) return NextResponse.json({ error: 'No TikTok connection found' }, { status: 404 });
  if (!connection.shop_cipher) return NextResponse.json({ error: 'No shop_cipher' }, { status: 400 });

  // Mark sync start
  await admin.from('tiktok_connections').update({ sync_started_at: new Date().toISOString(), sync_progress_orders: 0, sync_progress_day: null }).eq('user_id', user.id);

  const accessToken = decryptOrFallback(connection.access_token, 'access_token');
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const todayTs = dayToTs(todayStr) + 86400;
  const backfillStartStr = advanceDays(todayStr, -BACKFILL_DAYS);

  let currentDay: string;
  let isCaughtUp = false;
  const dbSyncCursor = connection.sync_cursor || null;

  if (!dbSyncCursor || dbSyncCursor < backfillStartStr) currentDay = backfillStartStr;
  else if (dbSyncCursor >= todayStr) { currentDay = todayStr; isCaughtUp = true; }
  else currentDay = dbSyncCursor;

  try {
    const shopName = connection.shop_name || 'TikTok Shop';
    const product = await getOrCreateProduct(admin, user.id, shopName);
    const rebuildDates = new Set<string>();
    let totalProcessed = 0;
    let apiCalls = 0;
    const startDay = currentDay;
    let windowQueue: PendingWindow[] = [...parsePendingWindows(connection.sync_page_cursor)];
    let lastProgressSave = 0;

    // ===== MAIN LOOP: fetch in parallel, bulk insert =====
    while (Date.now() - batchStart < TIME_BUDGET_MS && !isCaughtUp) {
      // Fill queue with 7-day windows
      if (windowQueue.length === 0) {
        for (let i = 0; i < PARALLEL_FETCHES; i++) {
          if (currentDay >= todayStr) { isCaughtUp = true; break; }
          const endDay = advanceDays(currentDay, DEFAULT_WINDOW_DAYS);
          const endTs = Math.min(dayToTs(endDay), todayTs);
          windowQueue.push({ startTs: dayToTs(currentDay), endTs });
          currentDay = endDay >= todayStr ? todayStr : endDay;
        }
        if (windowQueue.length === 0) { isCaughtUp = true; break; }
      }

      // Fetch batch in parallel
      const batch = windowQueue.splice(0, PARALLEL_FETCHES);
      const results = await Promise.all(batch.map(async (w) => {
        try {
          const r = await fetchOrdersPage(accessToken, connection.shop_cipher, w.startTs, w.endTs, null);
          return { window: w, orders: r.orders, hasMore: !!r.nextCursor, error: false };
        } catch {
          return { window: w, orders: [] as Record<string, unknown>[], hasMore: false, error: true };
        }
      }));
      apiCalls += batch.length;

      // Collect orders, handle splits
      const batchRows: ReturnType<typeof parseOrder>[] = [];
      for (const r of results) {
        if (r.error) continue;
        if (r.hasMore && r.orders.length >= 100 && (r.window.endTs - r.window.startTs) > 1800) {
          windowQueue = [...splitWindow(r.window), ...windowQueue];
          continue;
        }
        for (const o of r.orders) batchRows.push(parseOrder(user.id, o));
      }

      if (batchRows.length === 0) continue;

      // ===== BULK UPSERT all orders from this batch =====
      const upsertRows = batchRows.map(b => b.row);
      for (const chunk of chunkArray(upsertRows, UPSERT_BATCH_SIZE)) {
        const { error: upsertErr } = await admin.from('synced_order_ids').upsert(chunk, { onConflict: 'user_id,order_id' });
        if (upsertErr) console.error('[Sync] Bulk upsert error:', upsertErr.message);
      }

      // Track dates for rebuild
      for (const b of batchRows) if (b.date) rebuildDates.add(b.date);
      totalProcessed += batchRows.length;

      // Batch create products (deduplicated by cache)
      const productInfos = new Map<string, { productName: string; skuImage: string | null; skuId: string | null }>();
      for (const b of batchRows) {
        if (b.productInfo && !productInfos.has(b.productInfo.tikTokProductId)) {
          productInfos.set(b.productInfo.tikTokProductId, { productName: b.productInfo.productName, skuImage: b.productInfo.skuImage, skuId: b.productInfo.skuId });
        }
      }
      // Bulk check which products exist
      const newProductIds = [...productInfos.keys()];
      if (newProductIds.length > 0) {
        const { data: existingProducts } = await admin.from('products').select('tiktok_product_id').eq('user_id', user.id).in('tiktok_product_id', newProductIds);
        const existingSet = new Set((existingProducts || []).map((p: { tiktok_product_id: string }) => p.tiktok_product_id));
        const toCreate = newProductIds.filter(id => !existingSet.has(id));
        if (toCreate.length > 0) {
          const productRows = toCreate.map(id => {
            const info = productInfos.get(id)!;
            return { user_id: user.id, name: info.productName || `Product ${id.slice(-6)}`, tiktok_product_id: id, image_url: info.skuImage, sku: info.skuId };
          });
          await admin.from('products').upsert(productRows, { onConflict: 'user_id,tiktok_product_id', ignoreDuplicates: true });
        }
      }

      // Save progress periodically
      const elapsed = Date.now() - batchStart;
      if (elapsed - lastProgressSave > 15_000) {
        await admin.from('tiktok_connections').update({ sync_progress_orders: totalProcessed, sync_progress_day: currentDay }).eq('user_id', user.id);
        lastProgressSave = elapsed;
        console.log(`[Sync] ${apiCalls} calls, ${totalProcessed} orders, day=${currentDay}, ${elapsed}ms`);
      }
    }

    console.log(`[Sync] Fetch done: ${apiCalls} calls, ${totalProcessed} orders, ${Date.now() - batchStart}ms`);

    // If no new orders fetched, check if entries need rebuilding (e.g. after a deploy)
    if (rebuildDates.size === 0) {
      const { count: entryCount } = await admin.from('entries').select('*', { count: 'exact', head: true }).eq('user_id', user.id).eq('source', 'tiktok');
      const { count: orderCount } = await admin.from('synced_order_ids').select('*', { count: 'exact', head: true }).eq('user_id', user.id);
      if ((orderCount || 0) > 0 && (entryCount || 0) === 0) {
        console.log(`[Sync] Entries empty but ${orderCount} orders exist — rebuilding all dates`);
        const { data: allDates } = await admin.from('synced_order_ids').select('order_date').eq('user_id', user.id);
        for (const r of (allDates || [])) rebuildDates.add(r.order_date);
      }
    }

    // ===== SAVE CURSOR =====
    await admin.from('tiktok_connections').update({
      last_synced_at: new Date().toISOString(),
      sync_cursor: isCaughtUp ? todayStr : currentDay,
      sync_page_cursor: windowQueue.length > 0 ? JSON.stringify(windowQueue) : null,
      sync_started_at: null,
      sync_progress_orders: totalProcessed,
      sync_progress_day: currentDay,
    }).eq('user_id', user.id);

    // ===== BULK REBUILD ENTRIES (3 DB calls instead of 730) =====
    let totalCreated = 0;
    const rebuildStart = Date.now();

    try {
      // 1. Fetch ALL orders in one query
      const { data: allOrders, error: allErr } = await admin.from('synced_order_ids')
        .select('order_date, gmv, shipping, affiliate, platform_fee, units, status')
        .eq('user_id', user.id);

      if (allErr) {
        console.error('[Rebuild] Failed to fetch orders:', allErr);
        throw new Error(`Fetch orders failed: ${allErr.message}`);
      }

      console.log(`[Rebuild] Fetched ${(allOrders || []).length} orders from synced_order_ids`);

      // 2. Aggregate by date in JS (instant)
      type FullOrderRow = OrderRow & { order_date: string };
      const dailyTotals = new Map<string, { gmv: number; shipping: number; affiliate: number }>();
      for (const row of (allOrders || []) as FullOrderRow[]) {
        if (isOrderExcluded(row.status)) continue;
        const date = row.order_date;
        const prev = dailyTotals.get(date) || { gmv: 0, shipping: 0, affiliate: 0 };
        prev.gmv += Number(row.gmv) || 0;
        prev.shipping += Number(row.shipping) || 0;
        prev.affiliate += Number(row.affiliate) || 0;
        dailyTotals.set(date, prev);
      }

      console.log(`[Rebuild] Aggregated into ${dailyTotals.size} unique dates`);

      // 3. Delete old tiktok entries
      const { error: delErr } = await admin.from('entries')
        .delete()
        .eq('user_id', user.id)
        .eq('source', 'tiktok');

      if (delErr) {
        console.error('[Rebuild] Delete error:', delErr);
      }

      // 4. Bulk insert — ONLY columns that exist in the entries table:
      // id, user_id, product_id (nullable), date, gmv, videos_posted, views,
      // shipping, affiliate, ads, created_at, updated_at, source
      const now = new Date().toISOString();
      const entryRows = [...dailyTotals.entries()].map(([date, t]) => ({
        user_id: user.id,
        product_id: null,
        date,
        gmv: t.gmv,
        shipping: t.shipping,
        affiliate: t.affiliate,
        ads: 0,
        videos_posted: 0,
        views: 0,
        source: 'tiktok' as const,
        created_at: now,
        updated_at: now,
      }));

      console.log(`[Rebuild] Inserting ${entryRows.length} entry rows...`);
      if (entryRows.length > 0) {
        console.log(`[Rebuild] Sample row:`, JSON.stringify(entryRows[0]));
      }

      for (const chunk of chunkArray(entryRows, 500)) {
        const { error: insertErr, count } = await admin.from('entries').insert(chunk);
        if (insertErr) {
          console.error('[Rebuild] INSERT ERROR:', insertErr.message);
          console.error('[Rebuild] Error details:', JSON.stringify(insertErr));
          console.error('[Rebuild] First row of failed chunk:', JSON.stringify(chunk[0]));
        } else {
          totalCreated += chunk.length;
          console.log(`[Rebuild] Inserted chunk: ${chunk.length} rows (total: ${totalCreated})`);
        }
      }
    } catch (rebuildErr) {
      console.error('[Rebuild] EXCEPTION:', rebuildErr);
    }

    console.log(`[Rebuild] Done: ${totalCreated} entries created in ${Date.now() - rebuildStart}ms`);

    const { count: totalUniqueOrders } = await admin.from('synced_order_ids').select('*', { count: 'exact', head: true }).eq('user_id', user.id);

    return NextResponse.json({
      success: true,
      summary: {
        dateRange: { startDate: startDay, endDate: currentDay },
        entriesCreated: totalCreated, entriesUpdated: 0,
        ordersFetched: totalProcessed, ordersSkipped: 0,
        ordersThisBatch: totalProcessed,
        totalUniqueOrders: totalUniqueOrders || 0,
        isCaughtUp, hasMorePages: !isCaughtUp,
        windowsProcessed: apiCalls, elapsedMs: Date.now() - batchStart,
      },
    });
  } catch (error) {
    console.error('Sync failed:', error);
    await admin.from('tiktok_connections').update({ sync_started_at: null }).eq('user_id', user.id);
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}

// ==================== HELPERS ====================

async function getOrCreateProduct(admin: AdminClient, userId: string, shopName: string) {
  const { data: existing } = await admin.from('products').select('*').eq('user_id', userId).eq('name', shopName).single();
  if (existing) return existing;
  const { data: created, error } = await admin.from('products').insert({ user_id: userId, name: shopName }).select().single();
  if (error) throw new Error(`Failed to create product: ${error.message}`);
  return created;
}

