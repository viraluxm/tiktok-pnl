import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getShopOrders } from '@/lib/tiktok/client';
import { syncLimiter } from '@/lib/rate-limit';
import { decryptOrFallback } from '@/lib/crypto';

const CHUNK_DAYS = 7;
const BACKFILL_DAYS = 90;

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { success, retryAfterMs } = syncLimiter.check(`sync:${user.id}`);
  if (!success) {
    return NextResponse.json(
      { error: 'Too many sync requests. Please try again later.' },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil((retryAfterMs || 0) / 1000)) },
      },
    );
  }

  const admin = createAdminClient();

  // Get TikTok connection
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

  // Determine the chunk to sync
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  const backfillStart = new Date(today);
  backfillStart.setUTCDate(backfillStart.getUTCDate() - BACKFILL_DAYS);
  const backfillStartStr = backfillStart.toISOString().split('T')[0];

  // sync_cursor stores where we left off (YYYY-MM-DD), null means never synced
  const syncCursor: string | null = connection.sync_cursor || null;

  let chunkStart: string;
  let chunkEnd: string;
  let isCaughtUp = false;

  if (!syncCursor || syncCursor < backfillStartStr) {
    // First sync or cursor is older than backfill window — start from backfill start
    chunkStart = backfillStartStr;
  } else if (syncCursor >= todayStr) {
    // Already caught up — re-sync the last 7 days for fresh data
    const weekAgo = new Date(today);
    weekAgo.setUTCDate(weekAgo.getUTCDate() - CHUNK_DAYS);
    chunkStart = weekAgo.toISOString().split('T')[0];
    isCaughtUp = true;
  } else {
    // Resume from where we left off
    chunkStart = syncCursor;
  }

  // Chunk end is chunkStart + CHUNK_DAYS, capped at today
  const chunkEndDate = new Date(chunkStart + 'T00:00:00Z');
  chunkEndDate.setUTCDate(chunkEndDate.getUTCDate() + CHUNK_DAYS - 1);
  if (chunkEndDate > today) {
    chunkEnd = todayStr;
    isCaughtUp = true;
  } else {
    chunkEnd = chunkEndDate.toISOString().split('T')[0];
  }

  // If chunk end reaches today, we're caught up
  if (chunkEnd >= todayStr) {
    isCaughtUp = true;
  }

  console.log(`[Sync] Chunk: ${chunkStart} to ${chunkEnd} (cursor was: ${syncCursor || 'none'}, caught_up: ${isCaughtUp})`);

  // Create sync log
  const { data: syncLog } = await admin
    .from('sync_logs')
    .insert({
      user_id: user.id,
      sync_type: 'incremental',
      status: 'running',
    })
    .select()
    .single();

  let totalCreated = 0;
  let totalUpdated = 0;

  try {
    const shopName = connection.shop_name || 'TikTok Shop';
    const product = await getOrCreateProduct(admin, user.id, shopName);

    const orderData = await getShopOrders(
      accessToken,
      connection.shop_cipher,
      chunkStart,
      chunkEnd,
    );

    console.log(`[Sync] orderData returned: ${orderData.length} days of aggregated data`);

    for (const day of orderData) {
      const result = await upsertEntry(admin, {
        user_id: user.id,
        product_id: product.id,
        date: day.date,
        gmv: day.total_amount,
        shipping: day.shipping_fee,
        affiliate: day.affiliate_commission,
        source: 'tiktok',
      });
      if (result === 'created') totalCreated++;
      else if (result === 'updated') totalUpdated++;
    }

    // Advance the cursor to the day after chunk end
    const nextCursorDate = new Date(chunkEnd + 'T00:00:00Z');
    nextCursorDate.setUTCDate(nextCursorDate.getUTCDate() + 1);
    const nextCursor = nextCursorDate.toISOString().split('T')[0];

    await admin
      .from('tiktok_connections')
      .update({
        last_synced_at: new Date().toISOString(),
        sync_cursor: isCaughtUp ? todayStr : nextCursor,
      })
      .eq('user_id', user.id);

    if (syncLog) {
      await admin
        .from('sync_logs')
        .update({
          status: 'completed',
          entries_created: totalCreated,
          entries_updated: totalUpdated,
          completed_at: new Date().toISOString(),
        })
        .eq('id', syncLog.id);
    }

    return NextResponse.json({
      success: true,
      summary: {
        dateRange: { startDate: chunkStart, endDate: chunkEnd },
        entriesCreated: totalCreated,
        entriesUpdated: totalUpdated,
        isCaughtUp,
      },
    });
  } catch (error) {
    if (syncLog) {
      await admin
        .from('sync_logs')
        .update({
          status: 'failed',
          error_message: String(error),
          completed_at: new Date().toISOString(),
        })
        .eq('id', syncLog.id);
    }

    console.error('Sync failed:', error);
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 });
  }
}

// ==================== HELPERS ====================

async function getOrCreateProduct(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  shopName: string
) {
  const { data: existing } = await admin
    .from('products')
    .select('*')
    .eq('user_id', userId)
    .eq('name', shopName)
    .single();

  if (existing) return existing;

  const { data: created, error } = await admin
    .from('products')
    .insert({ user_id: userId, name: shopName })
    .select()
    .single();

  if (error) throw new Error(`Failed to create product: ${error.message}`);
  return created;
}

async function upsertEntry(
  admin: ReturnType<typeof createAdminClient>,
  entry: {
    user_id: string;
    product_id: string;
    date: string;
    gmv?: number;
    ads?: number;
    shipping?: number;
    affiliate?: number;
    source: string;
  }
): Promise<'created' | 'updated' | 'unchanged'> {
  const { data: existing } = await admin
    .from('entries')
    .select('id, gmv, ads, shipping, affiliate')
    .eq('user_id', entry.user_id)
    .eq('product_id', entry.product_id)
    .eq('date', entry.date)
    .eq('source', 'tiktok')
    .single();

  if (existing) {
    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    let hasChanges = false;

    if (entry.gmv !== undefined && entry.gmv !== Number(existing.gmv)) {
      updates.gmv = entry.gmv;
      hasChanges = true;
    }
    if (entry.ads !== undefined && entry.ads !== Number(existing.ads)) {
      updates.ads = entry.ads;
      hasChanges = true;
    }
    if (entry.shipping !== undefined && entry.shipping !== Number(existing.shipping)) {
      updates.shipping = entry.shipping;
      hasChanges = true;
    }
    if (entry.affiliate !== undefined && entry.affiliate !== Number(existing.affiliate)) {
      updates.affiliate = entry.affiliate;
      hasChanges = true;
    }

    if (!hasChanges) return 'unchanged';

    await admin
      .from('entries')
      .update(updates)
      .eq('id', existing.id);

    return 'updated';
  } else {
    await admin
      .from('entries')
      .insert({
        user_id: entry.user_id,
        product_id: entry.product_id,
        date: entry.date,
        gmv: entry.gmv || 0,
        ads: entry.ads || 0,
        shipping: entry.shipping || 0,
        affiliate: entry.affiliate || 0,
        videos_posted: 0,
        views: 0,
        source: entry.source,
      });

    return 'created';
  }
}
