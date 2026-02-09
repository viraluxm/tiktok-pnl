import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getShopOrders, getDateRange } from '@/lib/tiktok/client';

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Parse optional date range from request body
  let syncDays = 30;
  try {
    const body = await request.json();
    if (body.days) syncDays = Math.min(body.days, 365);
  } catch {
    // Use default 30 days
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

  // Create sync log
  const { data: syncLog } = await admin
    .from('sync_logs')
    .insert({
      user_id: user.id,
      sync_type: 'full',
      status: 'running',
    })
    .select()
    .single();

  const { startDate, endDate } = getDateRange(syncDays);
  let totalCreated = 0;
  let totalUpdated = 0;
  const errors: string[] = [];

  try {
    // Get or create product for this shop
    const shopName = connection.shop_name || 'TikTok Shop';
    let product = await getOrCreateProduct(admin, user.id, shopName);

    // ======= SYNC ORDERS FROM SHOP API =======
    if (connection.shop_cipher) {
      try {
        const orderData = await getShopOrders(
          connection.access_token,
          connection.shop_cipher,
          startDate,
          endDate
        );

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
      } catch (shopError) {
        const msg = `Shop order sync failed: ${shopError}`;
        console.error(msg);
        errors.push(msg);
      }
    }

    // Update last synced timestamp
    await admin
      .from('tiktok_connections')
      .update({ last_synced_at: new Date().toISOString() })
      .eq('user_id', user.id);

    // Update sync log
    if (syncLog) {
      await admin
        .from('sync_logs')
        .update({
          status: errors.length > 0 ? 'partial' : 'completed',
          entries_created: totalCreated,
          entries_updated: totalUpdated,
          error_message: errors.length > 0 ? errors.join('; ') : null,
          completed_at: new Date().toISOString(),
        })
        .eq('id', syncLog.id);
    }

    return NextResponse.json({
      success: true,
      summary: {
        dateRange: { startDate, endDate },
        entriesCreated: totalCreated,
        entriesUpdated: totalUpdated,
        errors: errors.length > 0 ? errors : undefined,
      },
    });
  } catch (error) {
    // Update sync log with failure
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
    return NextResponse.json({ error: 'Sync failed', details: String(error) }, { status: 500 });
  }
}

// ==================== HELPERS ====================

async function getOrCreateProduct(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  shopName: string
) {
  // Check if product already exists
  const { data: existing } = await admin
    .from('products')
    .select('*')
    .eq('user_id', userId)
    .eq('name', shopName)
    .single();

  if (existing) return existing;

  // Create new product
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
  // Check if entry exists for this date/product/source
  const { data: existing } = await admin
    .from('entries')
    .select('id, gmv, ads, shipping, affiliate')
    .eq('user_id', entry.user_id)
    .eq('product_id', entry.product_id)
    .eq('date', entry.date)
    .eq('source', 'tiktok')
    .single();

  if (existing) {
    // Merge: only update fields that have new values (don't overwrite with 0)
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
    // Insert new entry
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
