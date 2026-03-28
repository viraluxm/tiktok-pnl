import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchOrdersPage } from '@/lib/tiktok/client';
import { syncLimiter } from '@/lib/rate-limit';
import { decryptOrFallback } from '@/lib/crypto';

const BACKFILL_DAYS = 365;
const TIME_BUDGET_MS = 55_000; // 55s fetch, 5s for rebuild + cursor save (fits in browser fetch timeout)
const DEFAULT_WINDOW_DAYS = 7;
const PARALLEL_FETCHES = 5;
const UPSERT_BATCH_SIZE = 500; // Rows per bulk upsert

export const maxDuration = 300;

type AdminClient = ReturnType<typeof createAdminClient>;

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

export async function POST(request: Request) {
  const batchStart = Date.now();

  // Auth: either user session OR internal self-chain with secret
  let userId: string;
  const body = await request.json().catch(() => ({}));
  const internalSecret = process.env.SYNC_INTERNAL_SECRET || process.env.TIKTOK_SHOP_APP_SECRET;

  if (body._internalSecret === internalSecret && body._userId) {
    // Self-chain call — trusted
    userId = body._userId;
  } else {
    // Normal user call — check Supabase auth
    const supabase = await createClient();
    const { data, error: authError } = await supabase.auth.getUser();
    if (authError || !data.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    userId = data.user.id;
  }

  const { success, retryAfterMs } = syncLimiter.check(`sync:${userId}`);
  if (!success) return NextResponse.json({ error: 'Rate limited' }, { status: 429, headers: { 'Retry-After': String(Math.ceil((retryAfterMs || 0) / 1000)) } });

  const admin = createAdminClient();
  const { data: connection, error: connError } = await admin.from('tiktok_connections').select('*').eq('user_id', userId).single();
  if (connError || !connection) return NextResponse.json({ error: 'No TikTok connection found' }, { status: 404 });
  if (!connection.shop_cipher) return NextResponse.json({ error: 'No shop_cipher' }, { status: 400 });

  // Sync lock — prevent overlapping calls (self-chain or manual)
  if (connection.sync_started_at) {
    const startedAt = new Date(connection.sync_started_at).getTime();
    if (Date.now() - startedAt < 120_000) { // 2 min lock
      return NextResponse.json({ success: true, status: 'already_syncing' });
    }
  }

  // Mark sync start
  await admin.from('tiktok_connections').update({ sync_started_at: new Date().toISOString(), sync_progress_orders: 0, sync_progress_day: null }).eq('user_id', userId);

  const accessToken = decryptOrFallback(connection.access_token, 'access_token');
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const todayTs = dayToTs(todayStr) + 86400;
  const backfillStartStr = advanceDays(todayStr, -BACKFILL_DAYS);

  let currentDay: string;
  let isCaughtUp = false;
  const dbSyncCursor = connection.sync_cursor || null;

  console.log(`[Sync] READ CURSOR: ${JSON.stringify(connection.sync_cursor)} type: ${typeof connection.sync_cursor}`);

  if (!dbSyncCursor || dbSyncCursor < backfillStartStr) currentDay = backfillStartStr;
  else if (dbSyncCursor >= todayStr) { currentDay = todayStr; isCaughtUp = true; }
  else currentDay = dbSyncCursor;

  console.log(`[Sync] Target end: ${todayStr}, backfill: ${backfillStartStr}, cursor: ${dbSyncCursor}, starting: ${currentDay}, isCaughtUp: ${isCaughtUp}`);

  try {
    const { count: existingOrderCount } = await admin.from('synced_order_ids').select('*', { count: 'exact', head: true }).eq('user_id', userId);
    console.log(`[Sync] Starting. Existing orders in DB: ${existingOrderCount}`);

    const shopName = connection.shop_name || 'TikTok Shop';
    const product = await getOrCreateProduct(admin, userId, shopName);
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
          return { window: w, orders: r.orders, hasMore: !!r.nextCursor, nextCursor: r.nextCursor, error: false };
        } catch {
          return { window: w, orders: [] as Record<string, unknown>[], hasMore: false, nextCursor: null as string | null, error: true };
        }
      }));
      apiCalls += batch.length;

      // Collect orders, handle splits and pagination
      const batchRows: ReturnType<typeof parseOrder>[] = [];
      for (const r of results) {
        if (r.error) continue;

        // Add orders from first page
        for (const o of r.orders) batchRows.push(parseOrder(userId, o));

        if (r.hasMore && r.orders.length >= 100) {
          const windowDuration = r.window.endTs - r.window.startTs;

          if (windowDuration > 86400) {
            // Multi-day window: split into halves
            windowQueue = [...splitWindow(r.window), ...windowQueue];
            // Don't use orders from this oversized window — they'll be re-fetched in halves
            batchRows.splice(batchRows.length - r.orders.length, r.orders.length);
          } else {
            // Single day or smaller: PAGINATE with next_page_token
            let cursor = r.nextCursor;
            let pageNum = 1;
            let dayTotal = r.orders.length;

            while (cursor && Date.now() - batchStart < TIME_BUDGET_MS) {
              pageNum++;
              try {
                const nextPage = await fetchOrdersPage(accessToken, connection.shop_cipher, r.window.startTs, r.window.endTs, cursor);
                apiCalls++;
                for (const o of nextPage.orders) batchRows.push(parseOrder(userId, o));
                dayTotal += nextPage.orders.length;
                cursor = nextPage.nextCursor;
                if (nextPage.orders.length < 100) cursor = null;
              } catch {
                cursor = null;
              }
            }

            const dayLabel = new Date(r.window.startTs * 1000).toISOString().split('T')[0];
            console.log(`[Sync] Day ${dayLabel}: ${pageNum} pages, ${dayTotal} total orders`);
          }
        }
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

      // Batch insert products — deduplicate by tiktok_product_id AND name, insert one at a time to handle conflicts
      const seenProductIds = new Set<string>();
      const seenProductNames = new Set<string>();
      for (const b of batchRows) {
        if (!b.productInfo) continue;
        const pid = b.productInfo.tikTokProductId;
        const pname = b.productInfo.productName || `Product ${pid.slice(-6)}`;
        if (seenProductIds.has(pid) || seenProductNames.has(pname)) continue;
        seenProductIds.add(pid);
        seenProductNames.add(pname);

        // Use individual upsert to handle both unique constraints gracefully
        const { error: prodErr } = await admin.from('products').upsert({
          user_id: userId, name: pname,
          tiktok_product_id: pid, image_url: b.productInfo.skuImage, sku: b.productInfo.skuId,
        }, { onConflict: 'user_id,tiktok_product_id', ignoreDuplicates: true });
        if (prodErr) {
          // If name conflict, try with suffix
          await admin.from('products').upsert({
            user_id: userId, name: `${pname} (${pid.slice(-6)})`,
            tiktok_product_id: pid, image_url: b.productInfo.skuImage, sku: b.productInfo.skuId,
          }, { onConflict: 'user_id,tiktok_product_id', ignoreDuplicates: true });
        }
      }

      // Save progress periodically
      const elapsed = Date.now() - batchStart;
      if (elapsed - lastProgressSave > 15_000) {
        await admin.from('tiktok_connections').update({ sync_progress_orders: totalProcessed, sync_progress_day: currentDay }).eq('user_id', userId);
        lastProgressSave = elapsed;
        console.log(`[Sync] ${apiCalls} calls, ${totalProcessed} orders, day=${currentDay}, ${elapsed}ms`);
      }
    }

    console.log(`[Sync] Fetch done: ${apiCalls} calls, ${totalProcessed} orders, currentDay=${currentDay}, isCaughtUp=${isCaughtUp}, queueLen=${windowQueue.length}, ${Date.now() - batchStart}ms`);

    // ===== SAVE CURSOR =====
    const saveCursor = isCaughtUp ? todayStr : currentDay;
    const { error: saveErr } = await admin.from('tiktok_connections').update({
      last_synced_at: new Date().toISOString(),
      sync_cursor: saveCursor,
      sync_page_cursor: windowQueue.length > 0 ? JSON.stringify(windowQueue) : null,
      sync_started_at: null,
      sync_progress_orders: totalProcessed,
      sync_progress_day: currentDay,
    }).eq('user_id', userId);
    if (saveErr) {
      console.error('[Sync] CURSOR SAVE FAILED:', saveErr.message);
    } else {
      console.log(`[Sync] CURSOR SAVED: ${saveCursor}`);
    }

    // ===== REBUILD ENTRIES VIA SQL FUNCTION (single call, no row limits) =====
    const rebuildStart = Date.now();
    let totalCreated = 0;

    const { data: rebuildCount, error: rebuildErr } = await admin.rpc('rebuild_entries', { p_user_id: userId });
    if (rebuildErr) {
      console.error('[Rebuild] SQL function error:', rebuildErr.message, JSON.stringify(rebuildErr));
    } else {
      totalCreated = rebuildCount || 0;
    }

    console.log(`[Rebuild] Created ${totalCreated} entries in ${Date.now() - rebuildStart}ms`);

    const { count: totalUniqueOrders } = await admin.from('synced_order_ids').select('*', { count: 'exact', head: true }).eq('user_id', userId);

    const response = {
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
    };
    console.log(`[Sync] Response: isCaughtUp=${isCaughtUp}, entries=${totalCreated}, orders=${totalUniqueOrders}, elapsed=${Date.now() - batchStart}ms`);

    // Self-chain: if not caught up, fire another sync call (fire-and-forget)
    if (!isCaughtUp) {
      const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://lensed.io';
      console.log(`[Sync] Not caught up — chaining next batch`);
      fetch(`${baseUrl}/api/tiktok/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _internalSecret: internalSecret, _userId: userId }),
      }).catch(err => console.error('[Sync] Self-chain failed:', err));
    }

    return NextResponse.json(response);
  } catch (error) {
    console.error('Sync failed:', error);
    await admin.from('tiktok_connections').update({ sync_started_at: null }).eq('user_id', userId);
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}

// ==================== HELPERS ====================

async function getOrCreateProduct(admin: AdminClient, userId: string, shopName: string) {
  // Try to find existing product first
  const { data: existing } = await admin.from('products').select('*').eq('user_id', userId).eq('name', shopName).single();
  if (existing) return existing;
  // Use upsert to handle race conditions (another call may have inserted between our select and insert)
  const { data: created, error } = await admin.from('products').upsert(
    { user_id: userId, name: shopName },
    { onConflict: 'user_id,name' }
  ).select().single();
  if (error) {
    // Final fallback: just re-fetch
    const { data: fallback } = await admin.from('products').select('*').eq('user_id', userId).eq('name', shopName).single();
    if (fallback) return fallback;
    throw new Error(`Failed to create product: ${error.message}`);
  }
  return created;
}

