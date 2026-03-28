import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchOrdersPage, fetchStatements, fetchUnsettledOrders } from '@/lib/tiktok/client';
import { syncLimiter } from '@/lib/rate-limit';
import { decryptOrFallback } from '@/lib/crypto';

const BACKFILL_DAYS = 365;
const TIME_BUDGET_MS = 50_000; // 50s for work, 10s buffer before Vercel's 60s timeout

export const maxDuration = 60;

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
  const dayEnd = dayStart + 86400;
  const windowSize = (dayEnd - dayStart) / splits;
  return {
    startTs: Math.floor(dayStart + windowSize * index),
    endTs: Math.floor(dayStart + windowSize * (index + 1)),
  };
}

function nextDayStr(day: string): string {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split('T')[0];
}

export async function POST() {
  const batchStart = Date.now();
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

  let syncCursor: string | null = connection.sync_cursor || null;
  let pageCursorRaw: string | null = connection.sync_page_cursor || null;
  let isCaughtUp = false;

  // Determine starting day
  let currentDay: string;
  if (!syncCursor || syncCursor < backfillStartStr) {
    currentDay = backfillStartStr;
  } else if (syncCursor >= todayStr) {
    currentDay = todayStr;
    isCaughtUp = true;
  } else {
    currentDay = syncCursor;
  }

  try {
    const shopName = connection.shop_name || 'TikTok Shop';
    const product = await getOrCreateProduct(admin, user.id, shopName);
    const productCache: Record<string, string> = {};
    const rebuildDates = new Set<string>();

    let totalNewOrders = 0;
    let totalSkipped = 0;
    let windowsProcessed = 0;
    let startDay = currentDay;

    // ===== MAIN BATCH LOOP — process windows/days until time runs out =====
    while (Date.now() - batchStart < TIME_BUDGET_MS && !isCaughtUp) {
      const win = parseWindowState(pageCursorRaw, currentDay);
      if (win.day !== currentDay) {
        win.day = currentDay;
        win.splits = 1;
        win.index = 0;
      }

      const { startTs, endTs } = getWindowTimestamps(win.day, win.splits, win.index);

      // Fetch one window
      let orders: Record<string, unknown>[] = [];
      let hasMorePages = false;

      try {
        const result = await fetchOrdersPage(accessToken, connection.shop_cipher, startTs, endTs, null);
        orders = result.orders;
        hasMorePages = !!result.nextCursor;
      } catch {
        // Skip this window on error — advance
        orders = [];
        hasMorePages = false;
      }

      // If window is too large, split it
      if (hasMorePages && orders.length >= 100 && win.splits < 48) {
        const newSplits = win.splits * 2;
        const newIndex = win.index * 2;
        pageCursorRaw = JSON.stringify({ day: win.day, splits: newSplits, index: newIndex });
        console.log(`[Sync] Splitting ${win.day} ${win.splits}→${newSplits}`);
        continue; // Retry with smaller window immediately
      }

      windowsProcessed++;

      // Dedup
      const orderIds = orders.map(o => String((o as Record<string, unknown>).id || '')).filter(Boolean);
      const { data: existingRows } = await admin
        .from('synced_order_ids')
        .select('order_id, status')
        .eq('user_id', user.id)
        .in('order_id', orderIds.length > 0 ? orderIds : ['__none__']);

      const existingMap = new Map((existingRows || []).map((r: { order_id: string; status: string }) => [r.order_id, r.status]));
      const newOrders = orders.filter(o => !existingMap.has(String((o as Record<string, unknown>).id || '')));
      totalNewOrders += newOrders.length;
      totalSkipped += orders.length - newOrders.length;

      // Update status on existing orders
      for (const order of orders) {
        const o = order as Record<string, unknown>;
        const oid = String(o.id || '');
        const ns = String(o.status || '').toUpperCase();
        const os = existingMap.get(oid);
        if (os !== undefined && os !== ns && ns) {
          await admin.from('synced_order_ids').update({ status: ns }).eq('user_id', user.id).eq('order_id', oid);
          const ct = o.create_time as number;
          if (ct) rebuildDates.add(new Date(ct * 1000).toISOString().split('T')[0]);
        }
      }

      // Insert new orders
      for (const order of newOrders) {
        const o = order as Record<string, unknown>;
        const orderId = String(o.id || '');
        const createTime = o.create_time as number;
        const date = new Date(createTime * 1000).toISOString().split('T')[0];
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

        for (const item of lineItems) {
          units += Number(item.quantity) || 1;
          if (affiliate === 0) affiliate += toNum(item.affiliate_commission) || toNum(item.creator_commission) || 0;
          if (!tikTokProductId) {
            tikTokProductId = String(item.product_id || '') || null;
            skuId = String(item.sku_id || '') || null;
            skuName = String(item.sku_name || '') || null;
            const productName = String(item.product_name || item.sku_name || '') || null;
            const skuImage = String(item.sku_image || item.product_image || '') || null;
            if (tikTokProductId && productName && !productCache[tikTokProductId]) {
              productCache[tikTokProductId] = await getOrCreateTikTokProduct(admin, user.id, tikTokProductId, productName, skuImage, skuId);
            }
          }
        }
        if (units === 0) units = 1;

        await admin.from('synced_order_ids').upsert({
          user_id: user.id, order_id: orderId, order_date: date,
          gmv, shipping, affiliate, platform_fee: platformFee, units,
          tiktok_product_id: tikTokProductId, sku_id: skuId, sku_name: skuName, status,
        }, { onConflict: 'user_id,order_id' });

        rebuildDates.add(date);
      }

      // Advance window/day
      const nextWinIdx = win.index + 1;
      if (nextWinIdx < win.splits) {
        pageCursorRaw = JSON.stringify({ day: win.day, splits: win.splits, index: nextWinIdx });
      } else {
        // Day complete
        const nd = nextDayStr(currentDay);
        if (nd > todayStr) {
          isCaughtUp = true;
          currentDay = todayStr;
        } else {
          currentDay = nd;
        }
        pageCursorRaw = null;
      }

      // Log every 10 windows
      if (windowsProcessed % 10 === 0) {
        console.log(`[Sync] ${windowsProcessed} windows, ${totalNewOrders} new orders, day=${currentDay}, elapsed=${Date.now() - batchStart}ms`);
      }
    }

    console.log(`[Sync] Batch done: ${windowsProcessed} windows, ${totalNewOrders} new, ${totalSkipped} skipped, ${Date.now() - batchStart}ms`);

    // ===== SAVE CURSOR =====
    await admin.from('tiktok_connections').update({
      last_synced_at: new Date().toISOString(),
      sync_cursor: isCaughtUp ? todayStr : currentDay,
      sync_page_cursor: pageCursorRaw,
    }).eq('user_id', user.id);

    // ===== REBUILD ENTRIES FOR AFFECTED DATES =====
    let totalCreated = 0;
    let totalUpdated = 0;

    for (const date of rebuildDates) {
      const { data: dayOrders } = await admin
        .from('synced_order_ids')
        .select('gmv, shipping, affiliate, platform_fee, units, status')
        .eq('user_id', user.id)
        .eq('order_date', date);

      type OrderRow = { gmv: number; shipping: number; affiliate: number; platform_fee: number; units: number; status: string };
      const active = (dayOrders as OrderRow[] || []).filter(row => !isOrderExcluded(row.status));
      const t = active.reduce((acc: { gmv: number; shipping: number; affiliate: number; platformFee: number; units: number }, row: OrderRow) => ({
        gmv: acc.gmv + Number(row.gmv),
        shipping: acc.shipping + Number(row.shipping),
        affiliate: acc.affiliate + Number(row.affiliate),
        platformFee: acc.platformFee + Number(row.platform_fee),
        units: acc.units + (Number(row.units) || 1),
      }), { gmv: 0, shipping: 0, affiliate: 0, platformFee: 0, units: 0 });

      const r = await rebuildEntry(admin, {
        user_id: user.id, product_id: product.id, date,
        gmv: t.gmv, shipping: t.shipping, affiliate: t.affiliate,
        platform_fee: t.platformFee, units_sold: t.units, source: 'tiktok',
      });
      if (r === 'created') totalCreated++;
      else if (r === 'updated') totalUpdated++;
    }

    if (rebuildDates.size > 0) {
      console.log(`[Sync] Rebuilt ${rebuildDates.size} dates: ${totalCreated} created, ${totalUpdated} updated`);
    }

    const { count: totalUniqueOrders } = await admin
      .from('synced_order_ids')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id);

    return NextResponse.json({
      success: true,
      summary: {
        dateRange: { startDate: startDay, endDate: currentDay },
        entriesCreated: totalCreated,
        entriesUpdated: totalUpdated,
        ordersFetched: totalNewOrders,
        ordersSkipped: totalSkipped,
        ordersThisBatch: totalNewOrders + totalSkipped,
        totalUniqueOrders: totalUniqueOrders || 0,
        isCaughtUp,
        hasMorePages: !isCaughtUp,
        windowsProcessed,
        elapsedMs: Date.now() - batchStart,
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

async function getOrCreateTikTokProduct(admin: ReturnType<typeof createAdminClient>, userId: string, tikTokProductId: string, name: string, imageUrl: string | null, sku: string | null): Promise<string> {
  const { data: existing } = await admin.from('products').select('id').eq('user_id', userId).eq('tiktok_product_id', tikTokProductId).single();
  if (existing) {
    if (imageUrl || sku) await admin.from('products').update({ ...(imageUrl ? { image_url: imageUrl } : {}), ...(sku ? { sku } : {}) }).eq('id', existing.id);
    return existing.id;
  }
  const { data: created, error } = await admin.from('products').insert({ user_id: userId, name: name || `Product ${tikTokProductId.slice(-6)}`, tiktok_product_id: tikTokProductId, image_url: imageUrl, sku }).select('id').single();
  if (error) {
    const { data: retry, error: retryErr } = await admin.from('products').insert({ user_id: userId, name: `${name} (${tikTokProductId.slice(-6)})`, tiktok_product_id: tikTokProductId, image_url: imageUrl, sku }).select('id').single();
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

async function rebuildEntry(admin: ReturnType<typeof createAdminClient>, entry: { user_id: string; product_id: string; date: string; gmv: number; shipping: number; affiliate: number; platform_fee: number; units_sold: number; source: string }): Promise<'created' | 'updated' | 'error'> {
  try {
    const { data: existing, error: selectErr } = await admin.from('entries').select('id').eq('user_id', entry.user_id).eq('product_id', entry.product_id).eq('date', entry.date).eq('source', 'tiktok').single();
    if (selectErr && selectErr.code !== 'PGRST116') { console.error(`[rebuildEntry] Select error:`, selectErr); return 'error'; }
    if (existing) {
      const { error: updateErr } = await admin.from('entries').update({ gmv: entry.gmv, shipping: entry.shipping, affiliate: entry.affiliate, platform_fee: entry.platform_fee, units_sold: entry.units_sold, ads: 0, updated_at: new Date().toISOString() }).eq('id', existing.id);
      if (updateErr) { console.error(`[rebuildEntry] Update error:`, updateErr); return 'error'; }
      return 'updated';
    }
    const { error: insertErr } = await admin.from('entries').insert({ user_id: entry.user_id, product_id: entry.product_id, date: entry.date, gmv: entry.gmv, ads: 0, shipping: entry.shipping, affiliate: entry.affiliate, platform_fee: entry.platform_fee, units_sold: entry.units_sold, videos_posted: 0, views: 0, source: entry.source });
    if (insertErr) { console.error(`[rebuildEntry] Insert error:`, insertErr, JSON.stringify(entry)); return 'error'; }
    return 'created';
  } catch (err) { console.error(`[rebuildEntry] Exception:`, err); return 'error'; }
}
