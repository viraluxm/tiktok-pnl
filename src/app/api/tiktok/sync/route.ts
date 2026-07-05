import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchOrdersPage } from '@/lib/tiktok/client';
import { getValidAccessToken, type SyncErrorCode } from '@/lib/tiktok/token';
import { getOrgId } from '@/lib/org';

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
  const { data: connection, error: connError } = await admin.from('tiktok_connections').select('*').eq('user_id', userId).single();
  if (connError || !connection) return NextResponse.json({ error: 'No TikTok connection' }, { status: 404 });
  if (!connection.shop_cipher) return NextResponse.json({ error: 'No shop_cipher' }, { status: 400 });

  // Get a valid access token (refresh + persist if expired/near-expiry). Fail loud if unavailable.
  const tokenRes = await getValidAccessToken(admin, connection);
  if (!tokenRes.ok) {
    await admin.from('tiktok_connections').update({
      sync_started_at: null, sync_error: tokenRes.error, sync_error_at: new Date().toISOString(),
    }).eq('user_id', userId);
    return NextResponse.json({ error: 'token_unavailable', reason: tokenRes.error }, { status: 409 });
  }
  let accessToken = tokenRes.accessToken;

  // Sync shop logo via Business API (GMV Max store/list has thumbnail_url).
  // Option A (matched-only): the store list belongs to the ADS advertiser, which can cover a
  // different brand than THIS TikTok Shop (e.g. a lots-of-steals login whose only business
  // connection is Snore's advertiser). Only adopt a logo from a store that actually MATCHES
  // this connection (by shop name or cipher/id); if the advertiser has stores but none match,
  // CLEAR shop_logo rather than show the wrong brand (the UI falls back to a neutral
  // placeholder). Proper long-term fix is a shop-native logo source (TikTok Shop API) — backlog.
  try {
    const { data: bizConn } = await admin.from('tiktok_business_connections').select('access_token, advertiser_id').eq('user_id', userId).single();
    if (bizConn?.advertiser_id) {
      const bizToken = (await import('@/lib/crypto')).decryptOrFallback(bizConn.access_token, 'biz_token');
      const storeRes = await fetch(`https://business-api.tiktok.com/open_api/v1.3/gmv_max/store/list/?advertiser_id=${bizConn.advertiser_id}`, {
        headers: { 'Access-Token': bizToken },
      });
      const storeJson = await storeRes.json();
      const stores = (storeJson.data?.store_list || []) as Array<Record<string, unknown>>;

      // Match a store to THIS connection by name or id/cipher (case-insensitive, defensive on
      // field names since the store object shape is loosely typed).
      const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();
      const shopName = norm(connection.shop_name);
      const shopCipher = norm(connection.shop_cipher);
      const matched = stores.find((st) => {
        const nameHit = !!shopName && [st.store_name, st.name, st.shop_name].some((f) => norm(f) === shopName);
        const idHit = !!shopCipher && [st.store_id, st.store_code, st.shop_id, st.shop_code, st.id].some((f) => norm(f) === shopCipher);
        return nameHit || idHit;
      });

      if (matched?.thumbnail_url) {
        await admin.from('tiktok_connections').update({ shop_logo: String(matched.thumbnail_url) }).eq('user_id', userId);
        console.log('[Sync] Shop logo matched + synced');
      } else if (stores.length > 0) {
        // Advertiser returned stores but none is this shop → clear the stale wrong-brand logo.
        await admin.from('tiktok_connections').update({ shop_logo: null }).eq('user_id', userId);
        console.log('[Sync] No matching advertiser store — shop logo cleared');
      }
      // stores empty (or a thrown fetch) → learned nothing; leave shop_logo untouched.
    }
  } catch (err) {
    console.log('[Sync] Shop logo fetch failed:', (err as Error).message);
  }

  // Always sync product catalog (for variant names and current SKU list)
  try {
    const { getProducts } = await import('@/lib/tiktok/client');
    const catalogProducts = await getProducts(accessToken, connection.shop_cipher);
    for (const cp of catalogProducts) {
      if (!cp.product_id) continue;
      const variants = cp.skus.map(s => ({ id: s.sku_id, name: s.sku_name, sku: s.seller_sku, inventory: s.inventory }));
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
    console.log(`[Sync] Product catalog: ${catalogProducts.length} products synced`);
  } catch (err) {
    console.error('[Sync] Product catalog sync failed:', (err as Error).message);
  }

  // Already caught up?
  // Use shop timezone for all date calculations
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const backfillStart = new Date();
  backfillStart.setDate(backfillStart.getDate() - BACKFILL_DAYS);
  const backfillStartStr = backfillStart.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

  // Always re-sync today: clamp cursor so it never skips past today
  const rawCursor = connection.sync_cursor || backfillStartStr;
  let currentDay = rawCursor > todayStr ? todayStr : rawCursor;
  if (currentDay < backfillStartStr) currentDay = backfillStartStr;

  console.log(`[Sync] START cursor=${currentDay} target=${todayStr}`);

  // Mark sync in progress
  await admin.from('tiktok_connections').update({ sync_started_at: new Date().toISOString() }).eq('user_id', userId);

  try {
    const shopName = connection.shop_name || 'TikTok Shop';
    const product = await getOrCreateProduct(admin, userId, shopName);
    let totalNew = 0;
    let daysProcessed = 0;
    let fetchError: SyncErrorCode | null = null;
    let refreshedThisRun = false;
    const isAuthErr = (m: string) => m.includes('105002') || /expired/i.test(m) || m.includes('access_token');
    const countStored = async (): Promise<number> => {
      const { count } = await admin.from('synced_order_ids').select('id', { count: 'exact', head: true }).eq('user_id', userId);
      return count ?? 0;
    };

    // ===== MAIN LOOP: one day at a time, paginate within each day =====
    while (currentDay <= todayStr && Date.now() - batchStart < TIME_BUDGET_MS) {
      const nextDay = advanceDay(currentDay);
      const startTs = dayToTs(currentDay);
      const endTs = dayToTs(nextDay);

      // Fetch ALL pages for this day
      let pageToken: string | null = null;
      let prevToken: string | null = null;
      let dayOrders = 0;
      let pageNum = 0;
      const daySeen = new Set<string>(); // loop-guard: distinct order_ids seen this day

      do {
        if (Date.now() - batchStart >= TIME_BUDGET_MS) break;
        if (pageNum >= 500) break; // Safety backstop: max 500 pages per day
        pageNum++;

        let orders: Record<string, unknown>[];
        let nextCursor: string | null;
        try {
          ({ orders, nextCursor } = await fetchOrdersPage(accessToken, connection.shop_cipher, startTs, endTs, pageToken));
        } catch (err) {
          const msg = (err as Error).message || '';
          // Reactive net: token expired mid-run → refresh ONCE and retry the SAME page.
          if (isAuthErr(msg) && !refreshedThisRun) {
            refreshedThisRun = true;
            const r = await getValidAccessToken(admin, connection, true);
            if (!r.ok) { fetchError = r.error; break; }
            accessToken = r.accessToken;
            try {
              ({ orders, nextCursor } = await fetchOrdersPage(accessToken, connection.shop_cipher, startTs, endTs, pageToken));
            } catch (e2) {
              console.error(`[Sync] Fetch still failing after refresh ${currentDay} p${pageNum}:`, (e2 as Error).message);
              fetchError = isAuthErr((e2 as Error).message) ? 'NEEDS_RECONNECT' : 'FETCH_ERROR';
              break;
            }
          } else {
            console.error(`[Sync] Fetch error ${currentDay} p${pageNum}:`, msg);
            fetchError = isAuthErr(msg) ? 'NEEDS_RECONNECT' : 'FETCH_ERROR';
            break;
          }
        }

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
              products.set(pid, { user_id: userId, org_id: orgId, tiktok_product_id: pid, name, _hasRealName: hasRealName });
            }
          }
          for (const [, prod] of products) {
            const hasRealName = prod._hasRealName;
            delete prod._hasRealName;
            // If we have a real product_name, update existing rows; otherwise only insert new
            const { error: pErr } = await admin.from('products').upsert(prod, { onConflict: 'user_id,tiktok_product_id', ignoreDuplicates: !hasRealName });
            if (pErr) { /* ignore */ }
          }

          // Loop-guard: if this page added NO new distinct order_ids, we're re-serving → stop the day.
          const before = daySeen.size;
          for (const oid of rows.keys()) daySeen.add(oid);
          if (daySeen.size === before) {
            console.warn(`[Sync] ${currentDay} p${pageNum}: 0 new distinct orders — stopping day (duplicate page)`);
            break;
          }
        }

        // Loop-guard: a non-advancing / repeating next_page_token → stop the day.
        if (nextCursor && (nextCursor === pageToken || nextCursor === prevToken)) {
          console.warn(`[Sync] ${currentDay} p${pageNum}: next_page_token not advancing — stopping day`);
          break;
        }
        prevToken = pageToken;
        pageToken = nextCursor;
      } while (pageToken);

      if (fetchError) break; // stop the whole sync — do NOT advance the cursor (fail loud)

      if (dayOrders > 50) console.log(`[Sync] Day ${currentDay}: ${pageNum} pages, ${dayOrders} orders`);

      currentDay = nextDay;
      daysProcessed++;

      // Save progress every 10 days (reconcile counter to actual stored count — never inflate)
      if (daysProcessed % 10 === 0) {
        await admin.from('tiktok_connections').update({
          sync_cursor: currentDay,
          sync_progress_orders: await countStored(),
          sync_progress_day: currentDay,
        }).eq('user_id', userId);
      }
    }

    // Fail loud: on a fetch/token error, do NOT advance the cursor or mark caught-up — so the
    // next run resumes from the same day (no silent skip), and the error is visible.
    if (fetchError) {
      await admin.from('tiktok_connections').update({
        sync_started_at: null,
        sync_error: fetchError,
        sync_error_at: new Date().toISOString(),
        sync_progress_orders: await countStored(),
      }).eq('user_id', userId);
      console.error(`[Sync] STOPPED at ${currentDay} due to ${fetchError} — cursor NOT advanced`);
      return NextResponse.json({ error: 'sync_incomplete', reason: fetchError, currentDay }, { status: 200 });
    }

    const isCaughtUp = currentDay > todayStr;
    const storedCount = await countStored();

    // Save cursor + clear lock + clear any prior error (this batch completed cleanly)
    const { error: saveErr } = await admin.from('tiktok_connections').update({
      sync_cursor: isCaughtUp ? todayStr : currentDay,
      sync_started_at: null,
      sync_progress_orders: storedCount,   // reconcile to actual stored count — never inflate
      sync_progress_day: currentDay,
      last_synced_at: new Date().toISOString(),
      sync_error: null,
      sync_error_at: null,
    }).eq('user_id', userId);

    if (saveErr) console.error('[Sync] SAVE FAILED:', saveErr.message);
    else console.log(`[Sync] SAVED cursor=${isCaughtUp ? todayStr : currentDay}`);

    // Rebuild entries via SQL
    const { data: rebuildCount, error: rebuildErr } = await admin.rpc('rebuild_entries', { p_user_id: userId });
    if (rebuildErr) console.error('[Rebuild] Error:', rebuildErr.message);

    console.log(`[Sync] DONE: ${daysProcessed}d, ${totalNew} upserts, stored=${storedCount}, entries=${rebuildCount || 0}, caught_up=${isCaughtUp}, ${Date.now() - batchStart}ms`);

    return NextResponse.json({
      success: true,
      summary: {
        isCaughtUp,
        totalUniqueOrders: storedCount,
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
