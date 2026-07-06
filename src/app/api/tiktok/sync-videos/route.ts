import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchShopVideos } from '@/lib/tiktok/client';
import { decryptOrFallback } from '@/lib/crypto';
import { getActiveStore } from '@/lib/tiktok/activeStore';

export const maxDuration = 60;

type AdminClient = ReturnType<typeof createAdminClient>;

export async function POST() {
  const supabase = await createClient();
  const { data, error: authError } = await supabase.auth.getUser();
  if (authError || !data.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = data.user.id;

  const admin = createAdminClient();
  // Per-store connections. Active store from the cookie: specific → that store's
  // connection; 'all' → each store's connection (videos tagged to their own store).
  const activeStore = await getActiveStore();
  let cq = admin.from('tiktok_connections').select('*').eq('user_id', userId);
  if (activeStore !== 'all') cq = cq.eq('store_id', activeStore);
  const { data: connections, error: connError } = await cq;
  if (connError || !connections || connections.length === 0) {
    return NextResponse.json({ error: 'No TikTok connection' }, { status: 404 });
  }

  const perStore: Array<Record<string, unknown>> = [];
  for (const connection of connections) {
    if (!connection.shop_cipher) {
      perStore.push({ store_id: connection.store_id, skipped: 'no_shop_cipher' });
      continue;
    }
    try {
      perStore.push(await syncVideosForConnection(admin, connection, userId));
    } catch (err) {
      console.error(`[VideoSync] store ${connection.store_id} failed:`, (err as Error).message);
      perStore.push({ store_id: connection.store_id, error: 'video_sync_failed' });
    }
  }

  const totalSynced = perStore.reduce((a, s) => a + (Number(s.totalSynced) || 0), 0);
  return NextResponse.json({ success: true, totalSynced, stores: perStore });
}

async function syncVideosForConnection(admin: AdminClient, connection: Record<string, unknown>, userId: string) {
  const storeId = connection.store_id as string;
  const accessToken = decryptOrFallback(connection.access_token as string, 'access_token');

  // Sync last 365 days of video data
  const endDate = new Date().toISOString().split('T')[0];
  const startDate = new Date(Date.now() - 365 * 86400000).toISOString().split('T')[0];

  let pageToken: string | null = null;
  let totalSynced = 0;
  let pageNum = 0;
  const MAX_PAGES = 100;

  do {
    pageNum++;
    if (pageNum > MAX_PAGES) break;

    const { videos, nextPageToken } = await fetchShopVideos(accessToken, connection.shop_cipher as string, startDate, endDate, pageToken);

    if (videos.length > 0) {
      const rows = videos.map((v) => ({
        user_id: userId,
        store_id: storeId, // connection-scoped tagging
        tiktok_video_id: v.id,
        title: v.title,
        username: v.username,
        video_post_time: v.video_post_time || null,
        duration: v.duration,
        hash_tags: v.hash_tags,
        gmv_amount: v.gmv_amount,
        gmv_currency: v.gmv_currency,
        gpm_amount: v.gpm_amount,
        gpm_currency: v.gpm_currency,
        avg_customers: v.avg_customers,
        sku_orders: v.sku_orders,
        items_sold: v.items_sold,
        views: v.views,
        click_through_rate: v.click_through_rate,
        products: v.products,
        synced_at: new Date().toISOString(),
      }));

      const { error: upsertErr } = await admin
        .from('shop_videos')
        .upsert(rows, { onConflict: 'user_id,tiktok_video_id' });

      if (upsertErr) console.error('[VideoSync] Upsert error:', upsertErr.message);
      else totalSynced += rows.length;
    }

    pageToken = nextPageToken;
  } while (pageToken);

  console.log(`[VideoSync] store=${storeId}: ${totalSynced} videos across ${pageNum} pages`);
  return { store_id: storeId, totalSynced, pages: pageNum };
}
