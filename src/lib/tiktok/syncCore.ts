// SINGLE SOURCE OF TRUTH for the order sync: the watermark forward-edge + trailing-48h re-scan +
// per-day checkpoint logic, verified in item 1. BOTH the interactive route (/api/tiktok/sync) and
// the scheduled cron (/api/cron/sync-orders) import syncConnection from here — there is no second
// day loop to drift against, so an order is fetched and parsed identically no matter which path ran.
//
// opts.write (default true) = the interactive behavior (upserts orders + advances the cursor/rescan
// state). write:false = the cron's LOG-ONLY dry run: it still FETCHES every page (so read load and
// would-write volume are real and measurable) but persists NOTHING — no orders, no products, no
// cursor/rescan/last_pages state. Because dry-run never advances anything, it can't create a phantom
// "synced" gap, and (since sync_rescan_at is never stamped) it exercises the heaviest case — the full
// 48h re-scan — every run, which is exactly the load the ramp needs to confirm is safe.
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchOrdersPage } from '@/lib/tiktok/client';
import { getFreshToken, refreshConnection, isExpiredCredsError, type ConnRow } from '@/lib/tiktok/tokens';
import { getOrgId } from '@/lib/org';

type AdminClient = ReturnType<typeof createAdminClient>;

export const BACKFILL_DAYS = 365;
export const TIME_BUDGET_MS = 50_000; // 50s for fetching, rest for DB work
const FORWARD_OVERLAP_MS = 15 * 60 * 1000;    // (A) forward edge: re-pull the last 15 min each run
const RESCAN_INTERVAL_MS = 60 * 60 * 1000;    // (B) the "slower beat": at most one re-scan per hour
const RESCAN_WINDOW_MS = 48 * 60 * 60 * 1000; // (B) trailing 48h re-walk — covers the lag tail (p99 2.7h, max 12.7h)
const SHOP_TIMEZONE = 'America/Los_Angeles';

function toNum(val: unknown): number {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') return parseFloat(val) || 0;
  return 0;
}

export interface SyncStoreResult {
  store_id: string;
  isCaughtUp: boolean;
  ordersThisBatch: number;    // orders upserted (write) OR would-upsert (dry-run)
  totalUniqueOrders: number;
  daysProcessed: number;
  currentDay: string;
  pages: number;
  wrote: boolean;             // false in a dry run — makes log-only unmistakable in the summary
  // Which path ran this store: 'incremental' (caught-up update_time change-feed) vs 'backfill'
  // (create_time day-walk). Queryable from cron_sync_runs.summary so the dry-run day can count
  // how often a store drops to backfill (churn returning via the side door).
  mode: 'incremental' | 'backfill';
  budgetCut: boolean;         // true = stopped on the 50s budget and will resume next run
}

// Sync ONE store's connection: (optional) shop logo + catalog + day-loop of orders. All
// tiktok_connections updates are keyed by (user_id, store_id). Does NOT rebuild entries (the caller
// does that once, user-level). Verified in item 1; do not fork this loop — share it.
export async function syncConnection(
  admin: AdminClient,
  connection: Record<string, unknown>,
  userId: string,
  orgId: string | null,
  batchStart: number,
  opts: { write?: boolean } = {},
): Promise<SyncStoreResult> {
  const write = opts.write !== false;
  const storeId = connection.store_id as string;
  const shopCipher = connection.shop_cipher as string;

  const connRow: ConnRow = {
    id: connection.id as string,
    access_token: connection.access_token as string,
    refresh_token: (connection.refresh_token as string) ?? null,
    shop_cipher: shopCipher ?? null,
    token_expires_at: (connection.token_expires_at as string) ?? null,
  };
  const fresh = await getFreshToken(admin, connRow, { skewMinutes: 30 });
  let accessToken = fresh.accessToken;

  // 105002 refresh-on-use net: 3 attempts w/ backoff, refresh ONCE on expired creds + retry.
  let refreshedOnce = false;
  async function fetchPageWithRefresh(
    sTs: number, eTs: number, pageToken: string | null,
    opts?: { timeField?: 'create_time' | 'update_time'; sortOrder?: 'ASC' | 'DESC' },
  ) {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await fetchOrdersPage(accessToken, shopCipher, sTs, eTs, pageToken, opts);
      } catch (e) {
        lastErr = e;
        if (!refreshedOnce && isExpiredCredsError(e)) {
          refreshedOnce = true;
          try { accessToken = (await refreshConnection(admin, connRow)).accessToken; continue; }
          catch (re) { console.warn(`[Sync] on-105002 refresh failed store=${storeId}: ${(re as Error).message} — retrying with stale token`); }
        }
        if (attempt < 3) await new Promise((r) => setTimeout(r, 700 * attempt));
      }
    }
    throw lastErr;
  }

  // Shop logo + product catalog are catalog-side writes — skipped entirely in a dry run.
  if (write) {
    try {
      const { data: bizConn } = await admin.from('tiktok_business_connections').select('access_token, advertiser_id').eq('user_id', userId).single();
      if (bizConn?.advertiser_id) {
        const bizToken = (await import('@/lib/crypto')).decryptOrFallback(bizConn.access_token, 'biz_token');
        const storeRes = await fetch(`https://business-api.tiktok.com/open_api/v1.3/gmv_max/store/list/?advertiser_id=${bizConn.advertiser_id}`, { headers: { 'Access-Token': bizToken } });
        const storeJson = await storeRes.json();
        const stores = (storeJson.data?.store_list || []) as Array<Record<string, unknown>>;
        if (stores[0]?.thumbnail_url) {
          await admin.from('tiktok_connections').update({ shop_logo: String(stores[0].thumbnail_url) }).eq('user_id', userId).eq('store_id', storeId);
        }
      }
    } catch (err) { console.log('[Sync] Shop logo fetch failed:', (err as Error).message); }

    try {
      const { getProducts } = await import('@/lib/tiktok/client');
      const catalogProducts = await getProducts(accessToken, shopCipher);
      for (const cp of catalogProducts) {
        if (!cp.product_id) continue;
        const variants = cp.skus.map((s) => ({ id: s.sku_id, name: s.sku_name, sku: s.seller_sku, inventory: s.inventory }));
        const { error: catErr } = await admin.from('products').upsert({
          user_id: userId, org_id: orgId, tiktok_product_id: cp.product_id,
          name: cp.product_name || `Product ${cp.product_id.slice(-6)}`, image_url: cp.image_url, variants,
        }, { onConflict: 'user_id,tiktok_product_id' });
        if (catErr) console.error(`[Sync] Catalog upsert error for ${cp.product_id}:`, catErr.message);
      }
    } catch (err) { console.error('[Sync] Product catalog sync failed:', (err as Error).message); }
  }

  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: SHOP_TIMEZONE });
  const backfillStart = new Date();
  backfillStart.setDate(backfillStart.getDate() - BACKFILL_DAYS);
  const backfillStartStr = backfillStart.toLocaleDateString('en-CA', { timeZone: SHOP_TIMEZONE });

  // Clamp cursor so it never skips past today.
  const rawCursor = (connection.sync_cursor as string) || backfillStartStr;
  let currentDay = rawCursor > todayStr ? todayStr : rawCursor;
  if (currentDay < backfillStartStr) currentDay = backfillStartStr;
  const startProgress = (connection.sync_progress_orders as number) || 0;
  // startedCaughtUp: began with nothing to backfill. The watermark forward-edge applies ONLY then;
  // a store behind (backfill) OR pulled back by a re-scan walks its days FULLY. Captured BEFORE the
  // re-scan pull-back below.
  const startedCaughtUp = rawCursor >= todayStr;

  // ── INCREMENTAL CHANGE-FEED (caught-up stores) ──────────────────────────────────────
  // Once history is backfilled, we no longer re-walk create_time (the old forward-edge +
  // trailing-48h re-scan re-upserted the whole recent window every hour — churn that grows
  // with volume). Instead we pull ONLY orders changed since the update_time watermark. This
  // catches new orders (their update_time==create_time) AND status/tracking changes on older
  // orders, at a cost proportional to real activity, not backlog size. Probe-verified
  // (2026-08-02): update_time filters, sorts monotonically ASC, returns created-earlier-but-
  // changed orders, and update_time_ge is INCLUSIVE — so next cursor = max(update_time) seen
  // and the order_id upsert dedups the re-included boundary second (zero skip risk).
  if (startedCaughtUp) {
    // First switch (null cursor) seeds the last 48h of changes — a one-time catch-up that
    // matches the old re-scan window; thereafter it rides forward. endUpd fixed at run start;
    // anything changed mid-run has update_time > endUpd and is picked up next run (ge <= endUpd).
    const storedUpd = (connection.sync_update_cursor as number | null) ?? null;
    const startUpd = storedUpd ?? Math.floor((Date.now() - RESCAN_WINDOW_MS) / 1000);
    const endUpd = Math.floor(Date.now() / 1000) + 1;
    if (write) {
      await admin.from('tiktok_connections').update({ sync_started_at: new Date().toISOString() })
        .eq('user_id', userId).eq('store_id', storeId);
      await getOrCreateProduct(admin, userId, (connection.shop_name as string) || 'TikTok Shop');
    }
    let pageToken: string | null = null;
    let maxUpd = startUpd;
    let changed = 0;
    let incPages = 0;
    let incBudgetCut = false;
    try {
      do {
        if (Date.now() - batchStart >= TIME_BUDGET_MS || incPages >= 500) { incBudgetCut = true; break; }
        incPages++;
        // ASC so we walk oldest-change first; a budget cut leaves everything <= maxUpd done.
        const { orders, nextCursor } = await fetchPageWithRefresh(startUpd, endUpd, pageToken, { timeField: 'update_time', sortOrder: 'ASC' });
        if (orders.length > 0) {
          const rows = new Map<string, Record<string, unknown>>();
          for (const o of orders) {
            const parsed = parseOrder(userId, o as Record<string, unknown>);
            const oid = String(parsed.order_id || '');
            if (oid) rows.set(oid, parsed);
            const ut = Number((o as Record<string, unknown>).update_time) || 0;
            if (ut > maxUpd) maxUpd = ut;
          }
          const upsertData = [...rows.values()];
          const dbRows: Record<string, unknown>[] = upsertData.map(({ product_name: _p, ...rest }) => ({ ...rest, store_id: storeId }));
          const withTracking = dbRows.filter((r) => r.tracking_number != null);
          const withoutTracking = dbRows.filter((r) => r.tracking_number == null).map(({ tracking_number: _tn, ...rest }) => rest);
          if (write) {
            let upsertErr: { message: string } | null = null;
            if (withTracking.length) { const { error } = await admin.from('synced_order_ids').upsert(withTracking, { onConflict: 'user_id,order_id' }); if (error) upsertErr = error; }
            if (!upsertErr && withoutTracking.length) { const { error } = await admin.from('synced_order_ids').upsert(withoutTracking, { onConflict: 'user_id,order_id' }); if (error) upsertErr = error; }
            if (upsertErr) console.error('[Sync:update] upsert error:', upsertErr.message); else changed += upsertData.length;
            // Capture products for orders new to us (same as the create_time path).
            const products = new Map<string, Record<string, unknown>>();
            for (const row of upsertData) {
              const pid = row.tiktok_product_id as string;
              if (pid && !products.has(pid)) {
                const name = String(row.product_name || '') || String(row.sku_name || '') || `Product ${pid.slice(-6)}`;
                products.set(pid, { user_id: userId, org_id: orgId, tiktok_product_id: pid, name, _hasRealName: !!String(row.product_name || '') });
              }
            }
            for (const [, prod] of products) {
              const hasRealName = prod._hasRealName; delete prod._hasRealName;
              const { error: pErr } = await admin.from('products').upsert(prod, { onConflict: 'user_id,tiktok_product_id', ignoreDuplicates: !hasRealName });
              if (pErr) { /* ignore */ }
            }
          } else {
            changed += upsertData.length; // DRY RUN: count would-write, persist nothing
          }
        }
        pageToken = nextCursor;
      } while (pageToken);
    } catch (incErr) {
      const msg = (incErr as Error).message;
      console.error(`[Sync:update] store=${storeId} ABORT: ${msg}`);
      if (write) {
        await admin.from('tiktok_connections').update({
          sync_started_at: null, sync_error: `update-sync failed: ${msg}`.slice(0, 500), sync_error_at: new Date().toISOString(),
        }).eq('user_id', userId).eq('store_id', storeId);
      }
      throw new Error(`store ${storeId} update-sync aborted: ${msg}`);
    }
    if (write) {
      // Advance the cursor to max(update_time) seen (INCLUSIVE next ge; upsert dedups the
      // boundary). sync_cursor stays pinned to today so the store remains "caught up".
      const { error: saveErr } = await admin.from('tiktok_connections').update({
        sync_update_cursor: maxUpd, sync_cursor: todayStr, sync_page_cursor: null,
        sync_started_at: null, sync_progress_day: todayStr, sync_last_pages: incPages,
        last_synced_at: new Date().toISOString(), sync_error: null, sync_error_at: null,
      }).eq('user_id', userId).eq('store_id', storeId);
      if (saveErr) console.error('[Sync:update] SAVE FAILED:', saveErr.message);
    }
    console.log(`[Sync]${write ? '' : '[DRY]'} store=${storeId} INCREMENTAL: ${changed} changed since ${startUpd}${incBudgetCut ? ' (budget-cut, resumes at cursor)' : ''}, pages=${incPages}`);
    return {
      store_id: storeId, isCaughtUp: !incBudgetCut,
      ordersThisBatch: changed, totalUniqueOrders: startProgress,
      daysProcessed: 0, currentDay: todayStr, pages: incPages, wrote: write,
      mode: 'incremental', budgetCut: incBudgetCut,
    };
  }

  // ── (A) WATERMARK forward edge + (B) trailing 48h RE-SCAN ── (BACKFILL / not-yet-caught-up only)
  // (A) on a caught-up run TODAY starts at max(order_created_at)-15m (only new orders); (B) at most
  // once/hour pull the cursor back to the 48h window start and re-walk it FULLY, catching a
  // late-indexed order the overlap would skip. sync_rescan_at is stamped at re-scan START (below), so
  // rescanDue clears for the interval and a budget-spanning re-scan walks forward instead of
  // restarting itself. sync_rescan_at therefore reads "last re-scan STARTED", not "completed".
  const { data: wmRow } = await admin.from('synced_order_ids')
    .select('order_created_at').eq('store_id', storeId)
    .not('order_created_at', 'is', null).order('order_created_at', { ascending: false }).limit(1);
  const watermarkMs = wmRow?.[0]?.order_created_at ? new Date(wmRow[0].order_created_at as string).getTime() : null;
  const lastRescanMs = connection.sync_rescan_at ? new Date(connection.sync_rescan_at as string).getTime() : null;
  const rescanDue = !lastRescanMs || (Date.now() - lastRescanMs) >= RESCAN_INTERVAL_MS;
  // Alarm: sync_rescan_at now means "STARTED". Stale (>3h since a re-scan started) OR started-but-
  // stuck-behind-today are both surfaced by the external drift monitor; log loudly here too.
  if (lastRescanMs && Date.now() - lastRescanMs > 3 * RESCAN_INTERVAL_MS) {
    console.warn(`[Sync] store=${storeId} trailing 48h re-scan STALE — last STARTED ${Math.round((Date.now() - lastRescanMs) / 60000)}m ago (>3h). The late-index safety net may not be firing.`);
  }
  let rescanStarting = false;
  if (rescanDue && startedCaughtUp) {
    const rescanStartDay = new Date(Date.now() - RESCAN_WINDOW_MS).toLocaleDateString('en-CA', { timeZone: SHOP_TIMEZONE });
    if (rescanStartDay < currentDay && rescanStartDay >= backfillStartStr) { currentDay = rescanStartDay; rescanStarting = true; }
  }

  // Mid-day resume checkpoint: a mid-day stop saves the page cursor (sync_page_cursor) tagged to the
  // day (sync_progress_day); the next run RESUMES from it. A day advances only on natural page
  // exhaustion, so resuming never skips orders.
  const savedPageCursor = (connection.sync_page_cursor as string) || null;
  const savedPageDay = (connection.sync_progress_day as string) || null;

  console.log(`[Sync]${write ? '' : '[DRY]'} store=${storeId} START cursor=${currentDay} target=${todayStr}${savedPageCursor && savedPageDay === currentDay ? ` (resuming ${currentDay} mid-day)` : ''}`);

  // Mark in progress + stamp re-scan START (write mode only — a dry run persists nothing).
  if (write) {
    const markPayload: Record<string, unknown> = { sync_started_at: new Date().toISOString() };
    if (rescanStarting) markPayload.sync_rescan_at = new Date().toISOString();
    await admin.from('tiktok_connections').update(markPayload).eq('user_id', userId).eq('store_id', storeId);
  }

  const shopName = (connection.shop_name as string) || 'TikTok Shop';
  if (write) await getOrCreateProduct(admin, userId, shopName);
  let totalNew = 0;
  let daysProcessed = 0;
  let totalPages = 0;

  // ===== MAIN LOOP: one day at a time, paginate within each day =====
  let resumePageToken: string | null = null;
  while (currentDay <= todayStr) {
    if (Date.now() - batchStart >= TIME_BUDGET_MS) {
      if (savedPageCursor && savedPageDay === currentDay) resumePageToken = savedPageCursor;
      break;
    }
    const nextDay = advanceDay(currentDay);
    // (A) forward-edge incremental: TODAY starts at the watermark on a caught-up, non-rescan run.
    let startTs = dayToTs(currentDay);
    if (startedCaughtUp && !rescanDue && currentDay === todayStr && watermarkMs) {
      startTs = Math.max(startTs, Math.floor((watermarkMs - FORWARD_OVERLAP_MS) / 1000));
    }
    const endTs = dayToTs(nextDay);

    let pageToken: string | null = savedPageCursor && savedPageDay === currentDay ? savedPageCursor : null;
    let dayOrders = 0;
    let pageNum = 0;
    let budgetCut = false;

    try {
      do {
        if (Date.now() - batchStart >= TIME_BUDGET_MS) { budgetCut = true; break; }
        if (pageNum >= 500) { budgetCut = true; break; }
        pageNum++; totalPages++;
        const { orders, nextCursor } = await fetchPageWithRefresh(startTs, endTs, pageToken);

        if (orders.length > 0) {
          const rows = new Map<string, Record<string, unknown>>();
          for (const o of orders) {
            const parsed = parseOrder(userId, o as Record<string, unknown>);
            const oid = String(parsed.order_id || '');
            if (oid) rows.set(oid, parsed);
          }
          const upsertData = [...rows.values()];
          const dbRows: Record<string, unknown>[] = upsertData.map(({ product_name: _, ...rest }) => ({ ...rest, store_id: storeId }));
          const withTracking = dbRows.filter((r) => r.tracking_number != null);
          const withoutTracking = dbRows.filter((r) => r.tracking_number == null).map(({ tracking_number: _tn, ...rest }) => rest);
          if (write) {
            let upsertErr: { message: string } | null = null;
            if (withTracking.length) { const { error } = await admin.from('synced_order_ids').upsert(withTracking, { onConflict: 'user_id,order_id' }); if (error) upsertErr = error; }
            if (!upsertErr && withoutTracking.length) { const { error } = await admin.from('synced_order_ids').upsert(withoutTracking, { onConflict: 'user_id,order_id' }); if (error) upsertErr = error; }
            if (upsertErr) console.error('[Sync] Upsert error:', upsertErr.message); else totalNew += upsertData.length;
          } else {
            totalNew += upsertData.length; // DRY RUN: count what WOULD be written, persist nothing
          }
          dayOrders += upsertData.length;

          if (write) {
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
              const hasRealName = prod._hasRealName; delete prod._hasRealName;
              const { error: pErr } = await admin.from('products').upsert(prod, { onConflict: 'user_id,tiktok_product_id', ignoreDuplicates: !hasRealName });
              if (pErr) { /* ignore */ }
            }
          }
        }
        pageToken = nextCursor;
      } while (pageToken);
    } catch (dayErr) {
      const msg = (dayErr as Error).message;
      console.error(`[Sync] store=${storeId} ABORT on day ${currentDay} (p${pageNum}): ${msg}`);
      if (write) {
        await admin.from('tiktok_connections').update({
          sync_cursor: currentDay, sync_page_cursor: pageToken, sync_started_at: null,
          sync_progress_orders: startProgress + totalNew, sync_progress_day: currentDay,
          sync_error: `sync failed on ${currentDay}: ${msg}`.slice(0, 500), sync_error_at: new Date().toISOString(),
        }).eq('user_id', userId).eq('store_id', storeId);
      }
      throw new Error(`store ${storeId} sync aborted on day ${currentDay}: ${msg}`);
    }

    if (budgetCut) { resumePageToken = pageToken; break; }
    if (dayOrders > 50) console.log(`[Sync] store=${storeId} Day ${currentDay}: ${pageNum} pages, ${dayOrders} orders`);
    currentDay = nextDay;
    daysProcessed++;

    if (write && daysProcessed % 10 === 0) {
      await admin.from('tiktok_connections').update({
        sync_cursor: currentDay, sync_page_cursor: null,
        sync_progress_orders: startProgress + totalNew, sync_progress_day: currentDay,
      }).eq('user_id', userId).eq('store_id', storeId);
    }
  }

  const isCaughtUp = currentDay > todayStr;

  if (write) {
    const savePayload: Record<string, unknown> = {
      sync_cursor: isCaughtUp ? todayStr : currentDay,
      sync_page_cursor: resumePageToken,
      sync_started_at: null,
      sync_progress_orders: startProgress + totalNew,
      sync_progress_day: currentDay,
      sync_last_pages: totalPages,
      last_synced_at: new Date().toISOString(),
      sync_error: null,
      sync_error_at: null,
    };
    const { error: saveErr } = await admin.from('tiktok_connections').update(savePayload).eq('user_id', userId).eq('store_id', storeId);
    if (saveErr) console.error('[Sync] SAVE FAILED:', saveErr.message);
  }

  console.log(`[Sync]${write ? '' : '[DRY]'} store=${storeId} DONE: ${daysProcessed}d, ${totalNew} orders${write ? '' : ' (would-write)'}, caught_up=${isCaughtUp}, pages=${totalPages}`);

  return {
    store_id: storeId, isCaughtUp,
    ordersThisBatch: totalNew, totalUniqueOrders: startProgress + totalNew,
    daysProcessed, currentDay, pages: totalPages, wrote: write,
    mode: 'backfill', budgetCut: resumePageToken != null,
  };
}

// ===== HELPERS =====
function toLocalDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString('en-CA', { timeZone: SHOP_TIMEZONE });
}

function dayToTs(day: string): number {
  const refUtc = new Date(day + 'T12:00:00Z');
  const utcDateStr = refUtc.toLocaleDateString('en-CA', { timeZone: 'UTC' });
  const localDateStr = refUtc.toLocaleDateString('en-CA', { timeZone: SHOP_TIMEZONE });
  const utcHours = refUtc.getUTCHours();
  const localHoursStr = refUtc.toLocaleTimeString('en-GB', { timeZone: SHOP_TIMEZONE, hour: '2-digit', hour12: false });
  const localHours = parseInt(localHoursStr);
  let offsetHours = utcHours - localHours;
  if (utcDateStr !== localDateStr) { if (utcDateStr > localDateStr) offsetHours += 24; else offsetHours -= 24; }
  return Math.floor(new Date(day + 'T00:00:00Z').getTime() / 1000) + (offsetHours * 3600);
}

function advanceDay(day: string): string {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split('T')[0];
}

export function parseOrder(userId: string, o: Record<string, unknown>): Record<string, unknown> {
  const orderId = String(o.id || '');
  const createTime = o.create_time as number;
  const date = createTime ? toLocalDate(createTime) : '';
  const orderCreatedAt = createTime ? new Date(createTime * 1000).toISOString() : null;
  const updateTime = o.update_time as number;
  const updatedDate = updateTime ? toLocalDate(updateTime) : '';
  const status = String(o.status || '').toUpperCase();
  const autoCombineGroupId = o.auto_combine_group_id != null ? String(o.auto_combine_group_id) || null : null;
  const trackingNumber = String(o.tracking_number || '') || null;
  const payment = (o.payment || {}) as Record<string, unknown>;
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
  let tikTokProductId: string | null = null, skuId: string | null = null, skuName: string | null = null, productName: string | null = null;
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
    user_id: userId, order_id: orderId, order_date: date, updated_date: updatedDate, order_created_at: orderCreatedAt,
    gmv, shipping, affiliate, platform_fee: platformFee, units,
    tiktok_product_id: tikTokProductId, sku_id: skuId, sku_name: skuName,
    product_name: productName, status, auto_combine_group_id: autoCombineGroupId, tracking_number: trackingNumber,
  };
}

async function getOrCreateProduct(admin: AdminClient, userId: string, shopName: string) {
  const { data: existing } = await admin.from('products').select('*').eq('user_id', userId).eq('name', shopName).single();
  if (existing) return existing;
  const orgId = await getOrgId(admin, userId);
  const { data: created, error } = await admin.from('products').upsert({ user_id: userId, org_id: orgId, name: shopName }, { onConflict: 'user_id,name' }).select().single();
  if (error) {
    const { data: fallback } = await admin.from('products').select('*').eq('user_id', userId).eq('name', shopName).single();
    if (fallback) return fallback;
    throw new Error(`Failed to create product: ${error.message}`);
  }
  return created;
}
