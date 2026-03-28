import { NextResponse, after } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchOrdersPage } from '@/lib/tiktok/client';
import { decryptOrFallback } from '@/lib/crypto';

const BACKFILL_DAYS = 365;
const TIME_BUDGET_MS = 50_000;

export const maxDuration = 300;

type AdminClient = ReturnType<typeof createAdminClient>;

function toNum(val: unknown): number {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') return parseFloat(val) || 0;
  return 0;
}

export async function POST(request: Request) {
  const batchStart = Date.now();

  // Auth: user session OR internal self-chain
  let userId: string;
  const body = await request.json().catch(() => ({}));
  const internalSecret = process.env.SYNC_INTERNAL_SECRET || process.env.TIKTOK_SHOP_APP_SECRET;

  if (body._internalSecret === internalSecret && body._userId) {
    userId = body._userId;
  } else {
    const supabase = await createClient();
    const { data, error: authError } = await supabase.auth.getUser();
    if (authError || !data.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    userId = data.user.id;
  }

  const admin = createAdminClient();
  const { data: connection, error: connError } = await admin.from('tiktok_connections').select('*').eq('user_id', userId).single();
  if (connError || !connection) return NextResponse.json({ error: 'No TikTok connection' }, { status: 404 });
  if (!connection.shop_cipher) return NextResponse.json({ error: 'No shop_cipher' }, { status: 400 });

  // Already caught up?
  const todayStr = new Date().toISOString().split('T')[0];
  if (connection.sync_cursor && connection.sync_cursor >= todayStr) {
    return NextResponse.json({ success: true, summary: { isCaughtUp: true } });
  }

  const accessToken = decryptOrFallback(connection.access_token, 'access_token');
  const backfillStart = new Date();
  backfillStart.setUTCDate(backfillStart.getUTCDate() - BACKFILL_DAYS);
  const backfillStartStr = backfillStart.toISOString().split('T')[0];

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

    // ===== SIMPLE LOOP: one day at a time, one fetch per day =====
    while (currentDay < todayStr && Date.now() - batchStart < TIME_BUDGET_MS) {
      const nextDay = advanceDay(currentDay);
      const startTs = dayToTs(currentDay);
      const endTs = dayToTs(nextDay);

      try {
        const { orders } = await fetchOrdersPage(accessToken, connection.shop_cipher, startTs, endTs, null);

        if (orders.length > 0) {
          // Parse and deduplicate
          const rows = new Map<string, Record<string, unknown>>();
          for (const o of orders) {
            const parsed = parseOrder(userId, o as Record<string, unknown>);
            const oid = String(parsed.order_id || '');
            if (oid) rows.set(oid, parsed);
          }

          // Bulk upsert orders
          const upsertData = [...rows.values()];
          const { error: upsertErr } = await admin.from('synced_order_ids').upsert(upsertData, { onConflict: 'user_id,order_id' });
          if (upsertErr) console.error('[Sync] Upsert error:', upsertErr.message);
          else totalNew += upsertData.length;

          // Upsert products (one per unique tiktok_product_id)
          const products = new Map<string, Record<string, unknown>>();
          for (const row of upsertData) {
            const pid = row.tiktok_product_id as string;
            if (pid && !products.has(pid)) {
              products.set(pid, { user_id: userId, tiktok_product_id: pid, name: (row as Record<string, unknown>).product_name || `Product ${pid.slice(-6)}` });
            }
          }
          for (const prod of products.values()) {
            await admin.from('products').upsert(prod, { onConflict: 'user_id,tiktok_product_id', ignoreDuplicates: true }).catch(() => {});
          }
        }
      } catch (err) {
        console.error(`[Sync] Fetch error for ${currentDay}:`, (err as Error).message);
      }

      currentDay = nextDay;
      daysProcessed++;

      // Save progress every 10 days
      if (daysProcessed % 10 === 0) {
        await admin.from('tiktok_connections').update({
          sync_cursor: currentDay,
          sync_progress_orders: totalNew + (connection.sync_progress_orders || 0),
          sync_progress_day: currentDay,
        }).eq('user_id', userId);
      }
    }

    const isCaughtUp = currentDay >= todayStr;

    // Save cursor
    const { error: saveErr } = await admin.from('tiktok_connections').update({
      sync_cursor: isCaughtUp ? todayStr : currentDay,
      sync_started_at: null,
      sync_progress_orders: totalNew + (connection.sync_progress_orders || 0),
      sync_progress_day: currentDay,
      last_synced_at: new Date().toISOString(),
    }).eq('user_id', userId);

    if (saveErr) console.error('[Sync] CURSOR SAVE FAILED:', saveErr.message);
    else console.log(`[Sync] CURSOR SAVED: ${isCaughtUp ? todayStr : currentDay}`);

    // Rebuild entries
    const { data: rebuildCount, error: rebuildErr } = await admin.rpc('rebuild_entries', { p_user_id: userId });
    if (rebuildErr) console.error('[Rebuild] Error:', rebuildErr.message);
    console.log(`[Sync] Done: ${daysProcessed} days, ${totalNew} orders, entries=${rebuildCount || 0}, caught_up=${isCaughtUp}, ${Date.now() - batchStart}ms`);

    // Self-chain if not caught up
    if (!isCaughtUp) {
      const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : (process.env.NEXT_PUBLIC_SITE_URL || 'https://www.lensed.io');
      const chainUrl = `${baseUrl}/api/tiktok/sync`;
      after(async () => {
        await new Promise(r => setTimeout(r, 3000));
        console.log('[Sync] Chaining to:', chainUrl);
        try {
          await fetch(chainUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ _internalSecret: internalSecret, _userId: userId }),
          });
          console.log('[Sync] Chain sent');
        } catch (err) {
          console.error('[Sync] Chain failed:', err);
        }
      });
    }

    return NextResponse.json({
      success: true,
      summary: { isCaughtUp, totalUniqueOrders: totalNew + (connection.sync_progress_orders || 0), ordersThisBatch: totalNew, entriesCreated: rebuildCount || 0, daysProcessed, elapsedMs: Date.now() - batchStart },
    });
  } catch (error) {
    console.error('[Sync] Failed:', error);
    await admin.from('tiktok_connections').update({ sync_started_at: null }).eq('user_id', userId);
    return NextResponse.json({ error: 'Sync failed' }, { status: 500 });
  }
}

// ===== HELPERS =====

function dayToTs(day: string): number {
  return Math.floor(new Date(day + 'T00:00:00Z').getTime() / 1000);
}

function advanceDay(day: string): string {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split('T')[0];
}

function parseOrder(userId: string, o: Record<string, unknown>): Record<string, unknown> {
  const orderId = String(o.id || '');
  const createTime = o.create_time as number;
  const date = createTime ? new Date(createTime * 1000).toISOString().split('T')[0] : '';
  const status = String(o.status || '').toUpperCase();
  const payment = (o.payment || {}) as Record<string, unknown>;
  const gmv = toNum(payment.total_amount) || toNum(payment.product_total_amount) || 0;
  const shipping = toNum(payment.shipping_fee) || toNum(payment.shipping_fee_amount) || 0;
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
      productName = String(item.product_name || item.sku_name || '') || null;
    }
  }
  if (units === 0) units = 1;

  return {
    user_id: userId, order_id: orderId, order_date: date,
    gmv, shipping, affiliate, platform_fee: platformFee, units,
    tiktok_product_id: tikTokProductId, sku_id: skuId, sku_name: skuName, status,
    product_name: productName,
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
