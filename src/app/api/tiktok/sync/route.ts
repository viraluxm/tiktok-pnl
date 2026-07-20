import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchOrdersPage } from '@/lib/tiktok/client';
import { getFreshToken, refreshConnection, isExpiredCredsError, type ConnRow } from '@/lib/tiktok/tokens';
import { getOrgId } from '@/lib/org';
import { getActiveStore } from '@/lib/tiktok/activeStore';

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
  // SHARED catalog: products is org-owned. Service-role inserts (auth.uid()=NULL)
  // must stamp org_id explicitly — the auto-fill trigger can't fire here.
  const orgId = await getOrgId(admin, userId);

  // Connections are per-store (unique(user_id, store_id), migration 042). The active
  // store from the cookie decides scope: a specific store → just that connection;
  // 'all' → every store's connection, each synced against its OWN connection so its
  // orders tag to the correct store. Oldest cursor first so the most-behind store
  // gets time budget first (avoids starving a store in 'all' mode).
  const activeStore = await getActiveStore();
  let cq = admin.from('tiktok_connections').select('*').eq('user_id', userId)
    .order('sync_cursor', { ascending: true, nullsFirst: true });
  if (activeStore !== 'all') cq = cq.eq('store_id', activeStore);
  const { data: connections, error: connError } = await cq;
  if (connError || !connections || connections.length === 0) {
    return NextResponse.json({ error: 'No TikTok connection' }, { status: 404 });
  }

  const perStore: Array<Record<string, unknown>> = [];
  for (const connection of connections) {
    if (Date.now() - batchStart >= TIME_BUDGET_MS) break; // shared budget across stores
    if (!connection.shop_cipher) {
      perStore.push({ store_id: connection.store_id, skipped: 'no_shop_cipher' });
      continue;
    }
    try {
      perStore.push(await syncConnection(admin, connection, userId, orgId, batchStart));
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[Sync] store ${connection.store_id} failed:`, msg);
      // OBSERVABILITY: never leave a failed store silent (a silent skip is how the 7-day
      // outage went unnoticed). syncConnection already writes a day-specific sync_error on a
      // fetch abort AND leaves the cursor on the failed day; this is the catch-all so ANY
      // other failure (token, catalog, etc.) is still surfaced. Does NOT touch sync_cursor.
      await admin.from('tiktok_connections').update({
        sync_started_at: null,
        sync_error: msg.slice(0, 500),
        sync_error_at: new Date().toISOString(),
      }).eq('user_id', userId).eq('store_id', connection.store_id);
      // isCaughtUp:false so summary.isCaughtUp is truthful (a stuck store is NOT caught up)
      // and the caller knows to run again — the cursor is parked on the failed day to retry.
      perStore.push({ store_id: connection.store_id, error: 'sync_failed', isCaughtUp: false, message: msg });
    }
  }

  // Entries are USER-level daily aggregates (across all the user's stores) — rebuild
  // once after all in-scope stores have synced this batch.
  const { data: rebuildCount, error: rebuildErr } = await admin.rpc('rebuild_entries', { p_user_id: userId });
  if (rebuildErr) console.error('[Rebuild] Error:', rebuildErr.message);

  const isCaughtUp = perStore.every((s) => s.isCaughtUp !== false);
  const ordersThisBatch = perStore.reduce((a, s) => a + (Number(s.ordersThisBatch) || 0), 0);
  const totalUniqueOrders = perStore.reduce((a, s) => a + (Number(s.totalUniqueOrders) || 0), 0);

  console.log(`[Sync] DONE ${perStore.length} store(s): +${ordersThisBatch} orders, entries=${rebuildCount || 0}, caught_up=${isCaughtUp}, ${Date.now() - batchStart}ms`);

  return NextResponse.json({
    success: true,
    summary: {
      isCaughtUp,
      totalUniqueOrders,
      ordersThisBatch,
      entriesCreated: rebuildCount || 0,
      elapsedMs: Date.now() - batchStart,
      stores: perStore,
      // Progress display for the client driver (first in-scope store's cursor).
      currentDay: perStore[0]?.currentDay ?? null,
    },
  });
}

// Sync ONE store's connection: shop logo + product catalog + day-loop of orders.
// All tiktok_connections updates are keyed by (user_id, store_id) so they touch only
// this store's row. Returns a per-store summary. Does NOT rebuild entries (the caller
// does that once, user-level).
async function syncConnection(
  admin: AdminClient,
  connection: Record<string, unknown>,
  userId: string,
  orgId: string | null,
  batchStart: number,
) {
  const storeId = connection.store_id as string;
  const shopCipher = connection.shop_cipher as string;

  // Token lifecycle (mirrors the reconcile route). connRow carries the ENCRYPTED columns.
  const connRow: ConnRow = {
    id: connection.id as string,
    access_token: connection.access_token as string,
    refresh_token: (connection.refresh_token as string) ?? null,
    shop_cipher: shopCipher ?? null,
    token_expires_at: (connection.token_expires_at as string) ?? null,
  };
  // Proactively refresh if the (corrected) expiry is near/past; else use the current token.
  const fresh = await getFreshToken(admin, connRow, { skewMinutes: 30 });
  let accessToken = fresh.accessToken;

  // 105002 refresh-on-use net for order fetches: 3 attempts w/ backoff, and on an
  // "expired credentials" error refresh ONCE (persist-on-success) + retry with the new
  // token. Throws only after all recovery is exhausted → the caller treats that as a hard
  // day failure (abort, do not advance). This is the sync-path twin of reconcile's net.
  let refreshedOnce = false;
  async function fetchPageWithRefresh(sTs: number, eTs: number, pageToken: string | null) {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await fetchOrdersPage(accessToken, shopCipher, sTs, eTs, pageToken);
      } catch (e) {
        lastErr = e;
        if (!refreshedOnce && isExpiredCredsError(e)) {
          refreshedOnce = true;
          try {
            accessToken = (await refreshConnection(admin, connRow)).accessToken;
            continue; // immediate retry with the freshly-refreshed token
          } catch { /* refresh failed — fall through to backoff/next attempt */ }
        }
        if (attempt < 3) await new Promise((r) => setTimeout(r, 700 * attempt));
      }
    }
    throw lastErr;
  }

  // Sync shop logo via Business API (GMV Max store/list has thumbnail_url)
  try {
    const { data: bizConn } = await admin.from('tiktok_business_connections').select('access_token, advertiser_id').eq('user_id', userId).single();
    if (bizConn?.advertiser_id) {
      const bizToken = (await import('@/lib/crypto')).decryptOrFallback(bizConn.access_token, 'biz_token');
      const storeRes = await fetch(`https://business-api.tiktok.com/open_api/v1.3/gmv_max/store/list/?advertiser_id=${bizConn.advertiser_id}`, {
        headers: { 'Access-Token': bizToken },
      });
      const storeJson = await storeRes.json();
      const stores = (storeJson.data?.store_list || []) as Array<Record<string, unknown>>;
      if (stores[0]?.thumbnail_url) {
        await admin.from('tiktok_connections').update({ shop_logo: String(stores[0].thumbnail_url) })
          .eq('user_id', userId).eq('store_id', storeId);
      }
    }
  } catch (err) {
    console.log('[Sync] Shop logo fetch failed:', (err as Error).message);
  }

  // Always sync product catalog (for variant names and current SKU list)
  try {
    const { getProducts } = await import('@/lib/tiktok/client');
    const catalogProducts = await getProducts(accessToken, shopCipher);
    for (const cp of catalogProducts) {
      if (!cp.product_id) continue;
      const variants = cp.skus.map((s) => ({ id: s.sku_id, name: s.sku_name, sku: s.seller_sku, inventory: s.inventory }));
      const { error: catErr } = await admin.from('products').upsert({
        user_id: userId,
        org_id: orgId,
        tiktok_product_id: cp.product_id,
        name: cp.product_name || `Product ${cp.product_id.slice(-6)}`,
        image_url: cp.image_url,
        variants,
      }, { onConflict: 'user_id,tiktok_product_id' });
      if (catErr) console.error(`[Sync] Catalog upsert error for ${cp.product_id}:`, catErr.message);
    }
  } catch (err) {
    console.error('[Sync] Product catalog sync failed:', (err as Error).message);
  }

  // Use shop timezone for all date calculations
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const backfillStart = new Date();
  backfillStart.setDate(backfillStart.getDate() - BACKFILL_DAYS);
  const backfillStartStr = backfillStart.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

  // Always re-sync today: clamp cursor so it never skips past today
  const rawCursor = (connection.sync_cursor as string) || backfillStartStr;
  let currentDay = rawCursor > todayStr ? todayStr : rawCursor;
  if (currentDay < backfillStartStr) currentDay = backfillStartStr;
  const startProgress = (connection.sync_progress_orders as number) || 0;

  console.log(`[Sync] store=${storeId} START cursor=${currentDay} target=${todayStr}`);

  // Mark sync in progress
  await admin.from('tiktok_connections').update({ sync_started_at: new Date().toISOString() })
    .eq('user_id', userId).eq('store_id', storeId);

  const shopName = (connection.shop_name as string) || 'TikTok Shop';
  await getOrCreateProduct(admin, userId, shopName);
  let totalNew = 0;
  let daysProcessed = 0;

  // ===== MAIN LOOP: one day at a time, paginate within each day =====
  // HARDENED: a day advances ONLY after it fully syncs. A hard fetch failure (an
  // expired-credentials / network error that survives refresh + retries) ABORTS the run
  // with the cursor LEFT on the failed day (+ a visible sync_error) — never a silent skip
  // (the root cause of the 7-day outage). A time-budget cut mid-day also does NOT advance:
  // the day is redone (idempotent upsert) on the next run, so no partial day is ever lost.
  while (currentDay <= todayStr) {
    // Only START a new day if budget remains — keeps the request within maxDuration while
    // making each day all-or-nothing (no half-synced day that then advances the cursor).
    if (Date.now() - batchStart >= TIME_BUDGET_MS) break;
    const nextDay = advanceDay(currentDay);
    const startTs = dayToTs(currentDay);
    const endTs = dayToTs(nextDay);

    let pageToken: string | null = null;
    let dayOrders = 0;
    let pageNum = 0;
    let budgetCut = false;

    try {
      do {
        if (Date.now() - batchStart >= TIME_BUDGET_MS) { budgetCut = true; break; }
        if (pageNum >= 500) break; // Safety: max 500 pages per day (25,000 orders)
        pageNum++;

        // Throws only after refresh-on-use + retries are exhausted → a hard day failure,
        // caught below (abort, do NOT advance).
        const { orders, nextCursor } = await fetchPageWithRefresh(startTs, endTs, pageToken);

        if (orders.length > 0) {
          // Parse and deduplicate by order_id
          const rows = new Map<string, Record<string, unknown>>();
          for (const o of orders) {
            const parsed = parseOrder(userId, o as Record<string, unknown>);
            const oid = String(parsed.order_id || '');
            if (oid) rows.set(oid, parsed);
          }

          // Bulk upsert orders (strip product_name — not a DB column). Stamp store_id
          // explicitly from the connection being synced → correct per-store tagging.
          const upsertData = [...rows.values()];
          const dbRows = upsertData.map(({ product_name: _, ...rest }) => ({ ...rest, store_id: storeId }));
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
              products.set(pid, { user_id: userId, org_id: orgId, tiktok_product_id: pid, name, _hasRealName: hasRealName });
            }
          }
          for (const [, prod] of products) {
            const hasRealName = prod._hasRealName;
            delete prod._hasRealName;
            const { error: pErr } = await admin.from('products').upsert(prod, { onConflict: 'user_id,tiktok_product_id', ignoreDuplicates: !hasRealName });
            if (pErr) { /* ignore */ }
          }
        }

        pageToken = nextCursor;
      } while (pageToken);
    } catch (dayErr) {
      // FAIL-ABORT: this day could not sync even after refresh + retries. Do NOT advance
      // past it. Persist the cursor ON the failed day + a visible sync_error, then abort
      // this store (the POST-level catch records the per-store failure).
      const msg = (dayErr as Error).message;
      console.error(`[Sync] store=${storeId} ABORT on day ${currentDay} (p${pageNum}): ${msg}`);
      await admin.from('tiktok_connections').update({
        sync_cursor: currentDay,            // stay on the failed day → next run retries it
        sync_started_at: null,
        sync_progress_orders: startProgress + totalNew,
        sync_progress_day: currentDay,
        sync_error: `sync failed on ${currentDay}: ${msg}`.slice(0, 500),
        sync_error_at: new Date().toISOString(),
      }).eq('user_id', userId).eq('store_id', storeId);
      throw new Error(`store ${storeId} sync aborted on day ${currentDay}: ${msg}`);
    }

    // Time-budget cut mid-day: leave the cursor on currentDay (redone next run) — not an error.
    if (budgetCut) break;

    if (dayOrders > 50) console.log(`[Sync] store=${storeId} Day ${currentDay}: ${pageNum} pages, ${dayOrders} orders`);

    // Day fully synced → safe to advance.
    currentDay = nextDay;
    daysProcessed++;

    // Save progress every 10 days
    if (daysProcessed % 10 === 0) {
      await admin.from('tiktok_connections').update({
        sync_cursor: currentDay,
        sync_progress_orders: startProgress + totalNew,
        sync_progress_day: currentDay,
      }).eq('user_id', userId).eq('store_id', storeId);
    }
  }

  const isCaughtUp = currentDay > todayStr;

  // Save cursor + clear lock. Clear sync_error too: reaching here means this store synced
  // cleanly (caught up, or stopped only on the time budget) — a previously-stuck store recovers.
  const { error: saveErr } = await admin.from('tiktok_connections').update({
    sync_cursor: isCaughtUp ? todayStr : currentDay,
    sync_started_at: null,
    sync_progress_orders: startProgress + totalNew,
    sync_progress_day: currentDay,
    last_synced_at: new Date().toISOString(),
    sync_error: null,
    sync_error_at: null,
  }).eq('user_id', userId).eq('store_id', storeId);
  if (saveErr) console.error('[Sync] SAVE FAILED:', saveErr.message);

  console.log(`[Sync] store=${storeId} DONE: ${daysProcessed}d, ${totalNew} orders, caught_up=${isCaughtUp}`);

  return {
    store_id: storeId,
    isCaughtUp,
    ordersThisBatch: totalNew,
    totalUniqueOrders: startProgress + totalNew,
    daysProcessed,
    currentDay,
  };
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
  // Precise order timestamp (create_time is unix SECONDS). Kept ALONGSIDE order_date
  // — order_date stays exactly as before; this is additive. Null-safe: a missing
  // create_time writes null rather than crashing (migration 051).
  const orderCreatedAt = createTime ? new Date(createTime * 1000).toISOString() : null;
  const updateTime = o.update_time as number;
  const updatedDate = updateTime ? toLocalDate(updateTime) : '';
  const status = String(o.status || '').toUpperCase();
  // TikTok's combine-shipment group id (assigned at order time; groups a buyer's
  // multiple orders into one shipment). Stored so pick-verify reads it from our DB.
  const autoCombineGroupId = o.auto_combine_group_id != null ? String(o.auto_combine_group_id) || null : null;
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
    user_id: userId, order_id: orderId, order_date: date, updated_date: updatedDate,
    order_created_at: orderCreatedAt,
    gmv, shipping, affiliate, platform_fee: platformFee, units,
    tiktok_product_id: tikTokProductId, sku_id: skuId, sku_name: skuName,
    product_name: productName, status, auto_combine_group_id: autoCombineGroupId,
  };
}

async function getOrCreateProduct(admin: AdminClient, userId: string, shopName: string) {
  const { data: existing } = await admin.from('products').select('*').eq('user_id', userId).eq('name', shopName).single();
  if (existing) return existing;
  const orgId = await getOrgId(admin, userId); // SHARED catalog: stamp org_id (service-role)
  const { data: created, error } = await admin.from('products').upsert(
    { user_id: userId, org_id: orgId, name: shopName },
    { onConflict: 'user_id,name' }
  ).select().single();
  if (error) {
    const { data: fallback } = await admin.from('products').select('*').eq('user_id', userId).eq('name', shopName).single();
    if (fallback) return fallback;
    throw new Error(`Failed to create product: ${error.message}`);
  }
  return created;
}
