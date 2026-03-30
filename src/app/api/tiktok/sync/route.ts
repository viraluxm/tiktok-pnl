import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchOrdersPage } from '@/lib/tiktok/client';
import { decryptOrFallback } from '@/lib/crypto';

const BACKFILL_DAYS = 365;
const TIME_BUDGET_MS = 50_000; // 50s for fetching, rest for DB work

export const maxDuration = 60;

type AdminClient = ReturnType<typeof createAdminClient>;

function toNum(val: unknown): number {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') return parseFloat(val) || 0;
  return 0;
}

export async function POST() {
  const batchStart = Date.now();

  // Auth via Supabase session
  const supabase = await createClient();
  const { data, error: authError } = await supabase.auth.getUser();
  if (authError || !data.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = data.user.id;

  const admin = createAdminClient();
  const { data: connection, error: connError } = await admin.from('tiktok_connections').select('*').eq('user_id', userId).single();
  if (connError || !connection) return NextResponse.json({ error: 'No TikTok connection' }, { status: 404 });
  if (!connection.shop_cipher) return NextResponse.json({ error: 'No shop_cipher' }, { status: 400 });

  const accessToken = decryptOrFallback(connection.access_token, 'access_token');

  // Always sync product catalog (for variant names and current SKU list)
  try {
    const { getProducts } = await import('@/lib/tiktok/client');
    const catalogProducts = await getProducts(accessToken, connection.shop_cipher);
    for (const cp of catalogProducts) {
      if (!cp.product_id) continue;
      const variants = cp.skus.map(s => ({ id: s.sku_id, name: s.sku_name, sku: s.seller_sku }));
      await admin.from('products').upsert({
        user_id: userId,
        tiktok_product_id: cp.product_id,
        name: cp.product_name || `Product ${cp.product_id.slice(-6)}`,
        variants: JSON.stringify(variants),
      }, { onConflict: 'user_id,tiktok_product_id' });
    }
    console.log(`[Sync] Product catalog: ${catalogProducts.length} products synced`);
  } catch (err) {
    console.error('[Sync] Product catalog sync failed:', (err as Error).message);
  }

  // Already caught up?
  // Use shop timezone for all date calculations
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  if (connection.sync_cursor && connection.sync_cursor >= todayStr) {
    return NextResponse.json({ success: true, summary: { isCaughtUp: true, totalUniqueOrders: connection.sync_progress_orders || 0 } });
  }
  const backfillStart = new Date();
  backfillStart.setDate(backfillStart.getDate() - BACKFILL_DAYS);
  const backfillStartStr = backfillStart.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

  let currentDay = connection.sync_cursor || backfillStartStr;
  if (currentDay < backfillStartStr) currentDay = backfillStartStr;

  console.log(`[Sync] START cursor=${currentDay} target=${todayStr}`);

  // Mark sync in progress
  await admin.from('tiktok_connections').update({ sync_started_at: new Date().toISOString() }).eq('user_id', userId);

  try {
    const shopName = connection.shop_name || 'TikTok Shop';
    const product = await getOrCreateProduct(admin, userId, shopName);
    let totalNew = 0;
    let daysProcessed = 0;

    // ===== MAIN LOOP: one day at a time, paginate within each day =====
    while (currentDay < todayStr && Date.now() - batchStart < TIME_BUDGET_MS) {
      const nextDay = advanceDay(currentDay);
      const startTs = dayToTs(currentDay);
      const endTs = dayToTs(nextDay);

      // Fetch ALL pages for this day
      let pageToken: string | null = null;
      let dayOrders = 0;
      let pageNum = 0;

      do {
        if (Date.now() - batchStart >= TIME_BUDGET_MS) break;
        if (pageNum >= 500) break; // Safety: max 500 pages per day (25,000 orders)
        pageNum++;

        try {
          const { orders, nextCursor } = await fetchOrdersPage(accessToken, connection.shop_cipher, startTs, endTs, pageToken);

          if (orders.length > 0) {
            // Parse and deduplicate by order_id
            const rows = new Map<string, Record<string, unknown>>();
            for (const o of orders) {
              const parsed = parseOrder(userId, o as Record<string, unknown>);
              const oid = String(parsed.order_id || '');
              if (oid) rows.set(oid, parsed);
            }

            // Bulk upsert orders (strip product_name — not a DB column, used only for product naming)
            const upsertData = [...rows.values()];
            const dbRows = upsertData.map(({ product_name: _, ...rest }) => rest);
            const { error: upsertErr } = await admin.from('synced_order_ids').upsert(dbRows, { onConflict: 'user_id,order_id' });
            if (upsertErr) console.error('[Sync] Upsert error:', upsertErr.message);
            else totalNew += upsertData.length;

            dayOrders += upsertData.length;

            // Upsert unique products (use actual product_name from TikTok, not sku_name)
            const products = new Map<string, Record<string, unknown>>();
            for (const row of upsertData) {
              const pid = row.tiktok_product_id as string;
              if (pid && !products.has(pid)) {
                const name = String(row.product_name || '') || String(row.sku_name || '') || `Product ${pid.slice(-6)}`;
                const hasRealName = !!String(row.product_name || '');
                products.set(pid, { user_id: userId, tiktok_product_id: pid, name, _hasRealName: hasRealName });
              }
            }
            for (const [, prod] of products) {
              const hasRealName = prod._hasRealName;
              delete prod._hasRealName;
              // If we have a real product_name, update existing rows; otherwise only insert new
              const { error: pErr } = await admin.from('products').upsert(prod, { onConflict: 'user_id,tiktok_product_id', ignoreDuplicates: !hasRealName });
              if (pErr) { /* ignore */ }
            }
          }

          // Next page or done — ONLY stop when TikTok returns no next_page_token
          pageToken = nextCursor;
        } catch (err) {
          console.error(`[Sync] Fetch error ${currentDay} p${pageNum}:`, (err as Error).message);
          pageToken = null;
        }
      } while (pageToken);

      if (dayOrders > 50) console.log(`[Sync] Day ${currentDay}: ${pageNum} pages, ${dayOrders} orders`);

      currentDay = nextDay;
      daysProcessed++;

      // Save progress every 10 days
      if (daysProcessed % 10 === 0) {
        await admin.from('tiktok_connections').update({
          sync_cursor: currentDay,
          sync_progress_orders: (connection.sync_progress_orders || 0) + totalNew,
          sync_progress_day: currentDay,
        }).eq('user_id', userId);
      }
    }

    const isCaughtUp = currentDay >= todayStr;

    // Save cursor + clear lock
    const { error: saveErr } = await admin.from('tiktok_connections').update({
      sync_cursor: isCaughtUp ? todayStr : currentDay,
      sync_started_at: null,
      sync_progress_orders: (connection.sync_progress_orders || 0) + totalNew,
      sync_progress_day: currentDay,
      last_synced_at: new Date().toISOString(),
    }).eq('user_id', userId);

    if (saveErr) console.error('[Sync] SAVE FAILED:', saveErr.message);
    else console.log(`[Sync] SAVED cursor=${isCaughtUp ? todayStr : currentDay}`);

    // Rebuild entries via SQL
    const { data: rebuildCount, error: rebuildErr } = await admin.rpc('rebuild_entries', { p_user_id: userId });
    if (rebuildErr) console.error('[Rebuild] Error:', rebuildErr.message);

    console.log(`[Sync] DONE: ${daysProcessed}d, ${totalNew} orders, entries=${rebuildCount || 0}, caught_up=${isCaughtUp}, ${Date.now() - batchStart}ms`);

    return NextResponse.json({
      success: true,
      summary: {
        isCaughtUp,
        totalUniqueOrders: (connection.sync_progress_orders || 0) + totalNew,
        ordersThisBatch: totalNew,
        entriesCreated: rebuildCount || 0,
        daysProcessed,
        currentDay,
        elapsedMs: Date.now() - batchStart,
      },
    });
  } catch (error) {
    console.error('[Sync] FAILED:', error);
    await admin.from('tiktok_connections').update({ sync_started_at: null }).eq('user_id', userId);
    return NextResponse.json({ error: 'Sync failed' }, { status: 500 });
  }
}

// ===== HELPERS =====

const SHOP_TIMEZONE = 'America/Los_Angeles';

// Convert Unix timestamp to YYYY-MM-DD in shop's timezone
function toLocalDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString('en-CA', { timeZone: SHOP_TIMEZONE });
}

// Convert YYYY-MM-DD to Unix timestamp at midnight in shop's timezone
// Uses Intl to get the exact UTC offset (handles DST correctly)
function dayToTs(day: string): number {
  // Get what date/time it is in the shop timezone for a known UTC reference
  // Then calculate the offset
  const refUtc = new Date(day + 'T12:00:00Z'); // noon UTC on the target date
  const utcDateStr = refUtc.toLocaleDateString('en-CA', { timeZone: 'UTC' });
  const localDateStr = refUtc.toLocaleDateString('en-CA', { timeZone: SHOP_TIMEZONE });

  // Get hours in both timezones to determine offset
  const utcHours = refUtc.getUTCHours();
  const localHoursStr = refUtc.toLocaleTimeString('en-GB', { timeZone: SHOP_TIMEZONE, hour: '2-digit', hour12: false });
  const localHours = parseInt(localHoursStr);
  let offsetHours = utcHours - localHours;
  // Adjust for date boundary crossing
  if (utcDateStr !== localDateStr) {
    if (utcDateStr > localDateStr) offsetHours += 24;
    else offsetHours -= 24;
  }

  // Midnight in shop timezone = midnight UTC + offset
  return Math.floor(new Date(day + 'T00:00:00Z').getTime() / 1000) + (offsetHours * 3600);
}

function advanceDay(day: string): string {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split('T')[0];
}

function parseOrder(userId: string, o: Record<string, unknown>): Record<string, unknown> {
  const orderId = String(o.id || '');
  const createTime = o.create_time as number;
  const date = createTime ? toLocalDate(createTime) : '';
  const status = String(o.status || '').toUpperCase();
  const payment = (o.payment || {}) as Record<string, unknown>;
  // TikTok GMV = Price × Items + Shipping - Seller promotions - Platform co-funding (excludes tax)
  const productPrice = toNum(payment.original_total_product_price) || toNum(payment.sub_total) || 0;
  const shippingFee = toNum(payment.shipping_fee) || 0;
  const sellerDiscount = toNum(payment.seller_discount) || 0;
  const platformDiscount = toNum(payment.platform_discount) || 0;
  const gmv = productPrice + shippingFee - sellerDiscount - platformDiscount;
  const shipping = shippingFee;
  const platformFee = toNum(payment.platform_commission) || toNum(payment.platform_fee) || 0;
  let affiliate = toNum(payment.affiliate_commission) || toNum(payment.creator_commission) || 0;

  const lineItems = (o.line_items || o.order_line_list || []) as Record<string, unknown>[];
  let units = 0;
  let tikTokProductId: string | null = null;
  let skuId: string | null = null;
  let skuName: string | null = null;

  let productName: string | null = null;

  for (const item of lineItems) {
    units += Number(item.quantity) || 1;
    if (affiliate === 0) affiliate += toNum(item.affiliate_commission) || toNum(item.creator_commission) || 0;
    if (!tikTokProductId) {
      tikTokProductId = String(item.product_id || '') || null;
      skuId = String(item.sku_id || '') || null;
      skuName = String(item.sku_name || '') || null;
      productName = String(item.product_name || '') || null;
    }
  }
  if (units === 0) units = 1;

  return {
    user_id: userId, order_id: orderId, order_date: date,
    gmv, shipping, affiliate, platform_fee: platformFee, units,
    tiktok_product_id: tikTokProductId, sku_id: skuId, sku_name: skuName,
    product_name: productName, status,
  };
}

async function getOrCreateProduct(admin: AdminClient, userId: string, shopName: string) {
  const { data: existing } = await admin.from('products').select('*').eq('user_id', userId).eq('name', shopName).single();
  if (existing) return existing;
  const { data: created, error } = await admin.from('products').upsert(
    { user_id: userId, name: shopName },
    { onConflict: 'user_id,name' }
  ).select().single();
  if (error) {
    const { data: fallback } = await admin.from('products').select('*').eq('user_id', userId).eq('name', shopName).single();
    if (fallback) return fallback;
    throw new Error(`Failed to create product: ${error.message}`);
  }
  return created;
}
