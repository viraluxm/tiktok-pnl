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
    // Also try GMV Max / Shop Ads reporting via Business API with different data levels
    const { fetchAdSpend: fetchGmvMax } = await import('@/lib/tiktok/business-client');

    // Try to find which reporting endpoint has data
    const testStart = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
    const testEnd = new Date().toISOString().split('T')[0];

    // Try RESERVATION data level (GMV Max campaigns)
    try {
      const url = new URL('https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/');
      url.searchParams.set('advertiser_id', connection.advertiser_id);
      url.searchParams.set('report_type', 'BASIC');
      url.searchParams.set('data_level', 'RESERVATION_ADVERTISER');
      url.searchParams.set('dimensions', JSON.stringify(['stat_time_day']));
      url.searchParams.set('metrics', JSON.stringify(['spend', 'impressions', 'clicks']));
      url.searchParams.set('start_date', testStart);
      url.searchParams.set('end_date', testEnd);
      const res = await fetch(url.toString(), { headers: { 'Access-Token': accessToken } });
      const json = await res.json();
      console.log(`[AdSpend] RESERVATION test: code=${json.code} rows=${json.data?.list?.length || 0} msg=${json.message || ''}`);
      if (json.data?.list?.[0]) console.log('[AdSpend] RESERVATION sample:', JSON.stringify(json.data.list[0]).slice(0, 500));
    } catch (e) { console.log('[AdSpend] RESERVATION error:', (e as Error).message); }

    // Try campaign-level to see GMV Max
    try {
      const url = new URL('https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/');
      url.searchParams.set('advertiser_id', connection.advertiser_id);
      url.searchParams.set('report_type', 'BASIC');
      url.searchParams.set('data_level', 'AUCTION_CAMPAIGN');
      url.searchParams.set('dimensions', JSON.stringify(['stat_time_day', 'campaign_id']));
      url.searchParams.set('metrics', JSON.stringify(['spend', 'campaign_name']));
      url.searchParams.set('start_date', testStart);
      url.searchParams.set('end_date', testEnd);
      url.searchParams.set('page_size', '5');
      const res = await fetch(url.toString(), { headers: { 'Access-Token': accessToken } });
      const json = await res.json();
      console.log(`[AdSpend] CAMPAIGN test: code=${json.code} rows=${json.data?.list?.length || 0} msg=${json.message || ''}`);
      if (json.data?.list?.[0]) console.log('[AdSpend] CAMPAIGN sample:', JSON.stringify(json.data.list[0]).slice(0, 500));
    } catch (e) { console.log('[AdSpend] CAMPAIGN error:', (e as Error).message); }

    // Sync last 365 days in 30-day chunks (TikTok max time span is 30 days)
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
