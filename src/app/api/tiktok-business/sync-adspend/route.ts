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
    // Try ALL advertiser IDs to find where GMV Max spend lives
    try {
      const bizBase = 'https://business-api.tiktok.com/open_api/v1.3';
      const testStart = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
      const testEnd = new Date().toISOString().split('T')[0];

      // All 3 advertiser IDs from the account
      const allAdvIds = ['7408778789712396289', '7433963997021421584', '7522264856004814401'];

      for (const advId of allAdvIds) {
        try {
          const url = new URL(`${bizBase}/report/integrated/get/`);
          url.searchParams.set('advertiser_id', advId);
          url.searchParams.set('report_type', 'BASIC');
          url.searchParams.set('data_level', 'AUCTION_ADVERTISER');
          url.searchParams.set('dimensions', JSON.stringify(['stat_time_day']));
          url.searchParams.set('metrics', JSON.stringify(['spend', 'impressions', 'clicks']));
          url.searchParams.set('start_date', testStart);
          url.searchParams.set('end_date', testEnd);
          const res = await fetch(url.toString(), { headers: { 'Access-Token': accessToken } });
          const json = await res.json();
          console.log(`[AdSpend] advId=${advId} last7d: code=${json.code} rows=${json.data?.list?.length || 0} msg=${json.message || ''}`);
          if (json.data?.list?.[0]) console.log(`[AdSpend] sample:`, JSON.stringify(json.data.list[0]).slice(0, 300));
        } catch (e) { console.log(`[AdSpend] advId=${advId}: ${(e as Error).message}`); }

        // Also try campaign list for each
        try {
          const url = `${bizBase}/campaign/get/?advertiser_id=${advId}&page_size=20`;
          const res = await fetch(url, { headers: { 'Access-Token': accessToken } });
          const json = await res.json();
          const campaigns = (json.data?.list || []) as Array<Record<string, unknown>>;
          console.log(`[AdSpend] advId=${advId} campaigns: total=${campaigns.length}`);
          for (const c of campaigns.slice(0, 3)) {
            console.log(`  campaign: id=${c.campaign_id} name=${c.campaign_name} type=${c.campaign_type} obj=${c.objective_type}`);
          }
        } catch (e) { /* skip */ }
      }

    } catch (e) {
      console.log('[AdSpend] Error:', (e as Error).message);
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
