import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchAdSpend } from '@/lib/tiktok/business-client';
import { decryptOrFallback } from '@/lib/crypto';

export const maxDuration = 60;

export async function POST() {
  const supabase = await createClient();
  const { data, error: authError } = await supabase.auth.getUser();
  if (authError || !data.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = data.user.id;

  const admin = createAdminClient();
  const { data: connection } = await admin
    .from('tiktok_business_connections')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (!connection) return NextResponse.json({ error: 'No business connection' }, { status: 404 });
  if (!connection.advertiser_id) return NextResponse.json({ error: 'No advertiser ID' }, { status: 400 });

  const accessToken = decryptOrFallback(connection.access_token, 'business_access_token');

  try {
    // Debug: fetch per-order settlement transactions via Shop API
    // This gives us actual fees, affiliate commission, ad costs per order
    try {
      const { shopGet: sGet } = await import('@/lib/tiktok/client');
      const { data: shopConn } = await admin.from('tiktok_connections').select('access_token, shop_cipher').eq('user_id', userId).single();
      if (shopConn?.shop_cipher) {
        const shopToken = (await import('@/lib/crypto')).decryptOrFallback(shopConn.access_token, 'shop_token');

        // Get a few recent order IDs to test
        const { data: recentOrders } = await admin
          .from('synced_order_ids')
          .select('order_id')
          .eq('user_id', userId)
          .order('order_date', { ascending: false })
          .limit(3);

        for (const row of (recentOrders || []).slice(0, 2)) {
          try {
            const path = `/finance/202501/orders/${row.order_id}/statement_transactions`;
            const d = await sGet(path, shopToken, { shop_cipher: shopConn.shop_cipher });
            console.log(`[Settlement] order=${row.order_id}:`);
            console.log(`[Settlement] data:`, JSON.stringify(d).slice(0, 3000));
          } catch (e) {
            console.log(`[Settlement] order=${row.order_id}: ${(e as Error).message}`);
          }
        }
      }
    } catch (e) {
      console.log('[Settlement] Error:', (e as Error).message);
    }

    // Sync last 365 days in 30-day chunks (Business API auction data)
    const now = new Date();
    let totalDays = 0;

    for (let i = 0; i < 13; i++) {
      const chunkEnd = new Date(now.getTime() - i * 30 * 86400000);
      const chunkStart = new Date(chunkEnd.getTime() - 29 * 86400000);
      const startDate = chunkStart.toISOString().split('T')[0];
      const endDate = chunkEnd.toISOString().split('T')[0];

      try {
        const rows = await fetchAdSpend(accessToken, connection.advertiser_id, startDate, endDate);

        if (rows.length > 0) {
          const dbRows = rows
            .filter(r => r.date)
            .map(r => ({
              user_id: userId,
              date: r.date,
              spend_amount: r.spend,
              spend_currency: r.currency,
              impressions: r.impressions,
              clicks: r.clicks,
              conversions: r.conversions,
              synced_at: new Date().toISOString(),
            }));

          const { error: upsertErr } = await admin
            .from('ad_spend')
            .upsert(dbRows, { onConflict: 'user_id,date' });

          if (upsertErr) console.error(`[AdSpend] Upsert error (${startDate}-${endDate}):`, upsertErr.message);
          else totalDays += dbRows.length;
        }
      } catch (err) {
        console.error(`[AdSpend] Chunk ${startDate}-${endDate} failed:`, (err as Error).message);
      }
    }

    console.log(`[AdSpend] Synced ${totalDays} days of ad spend`);
    return NextResponse.json({ success: true, days: totalDays });
  } catch (error) {
    console.error('[AdSpend] Failed:', error);
    return NextResponse.json({ error: 'Ad spend sync failed' }, { status: 500 });
  }
}
