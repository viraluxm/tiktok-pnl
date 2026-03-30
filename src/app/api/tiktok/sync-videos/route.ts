import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchShopVideos } from '@/lib/tiktok/client';
import { decryptOrFallback } from '@/lib/crypto';

export const maxDuration = 60;

export async function POST() {
  const supabase = await createClient();
  const { data, error: authError } = await supabase.auth.getUser();
  if (authError || !data.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = data.user.id;

  const admin = createAdminClient();
  const { data: connection, error: connError } = await admin.from('tiktok_connections').select('*').eq('user_id', userId).single();
  if (connError || !connection) return NextResponse.json({ error: 'No TikTok connection' }, { status: 404 });
  if (!connection.shop_cipher) return NextResponse.json({ error: 'No shop_cipher' }, { status: 400 });

  const accessToken = decryptOrFallback(connection.access_token, 'access_token');

  try {
    let pageToken: string | null = null;
    let totalSynced = 0;
    let pageNum = 0;
    const MAX_PAGES = 100;

    do {
      pageNum++;
      if (pageNum > MAX_PAGES) break;

      const { videos, nextPageToken } = await fetchShopVideos(accessToken, connection.shop_cipher, pageToken);

      if (videos.length > 0) {
        const rows = videos.map(v => ({
          user_id: userId,
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

        if (upsertErr) {
          console.error('[VideoSync] Upsert error:', upsertErr.message);
        } else {
          totalSynced += rows.length;
        }
      }

      pageToken = nextPageToken;
    } while (pageToken);

    console.log(`[VideoSync] Done: ${totalSynced} videos synced across ${pageNum} pages`);

    return NextResponse.json({
      success: true,
      totalSynced,
      pages: pageNum,
    });
  } catch (error) {
    console.error('[VideoSync] Failed:', error);
    return NextResponse.json({ error: 'Video sync failed' }, { status: 500 });
  }
}
