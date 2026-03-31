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
    // Try GMV Max specific endpoints (separate from regular campaign system)
    try {
      const bizBase = 'https://business-api.tiktok.com/open_api/v1.3';
      const advId = connection.advertiser_id;

      // 1. Get all GMV Max campaign IDs
      const allCampaignIds: string[] = [];
      for (const promoType of ['PRODUCT_GMV_MAX', 'LIVE_GMV_MAX']) {
        try {
          const filtering = JSON.stringify({ gmv_max_promotion_types: [promoType] });
          const url = `${bizBase}/gmv_max/campaign/get/?advertiser_id=${advId}&filtering=${encodeURIComponent(filtering)}&page_size=50`;
          const res = await fetch(url, { headers: { 'Access-Token': accessToken } });
          const json = await res.json();
          const campaigns = (json.data?.list || []) as Array<Record<string, unknown>>;
          for (const c of campaigns) {
            const cid = String(c.campaign_id || '');
            if (cid) allCampaignIds.push(cid);
          }
          console.log(`[GMV Max] ${promoType}: ${campaigns.length} campaigns`);
        } catch (e) { /* skip */ }
      }
      console.log(`[GMV Max] Total campaign IDs: ${allCampaignIds.length} → ${allCampaignIds.join(', ')}`);

      // 2. Get sessions for active campaign + try reporting with campaign filter
      if (allCampaignIds.length > 0) {
        // Try sessions for first few campaigns
        for (const cid of allCampaignIds.slice(0, 3)) {
          try {
            const url = `${bizBase}/campaign/gmv_max/session/list/?advertiser_id=${advId}&campaign_id=${cid}&page_size=10`;
            const res = await fetch(url, { headers: { 'Access-Token': accessToken } });
            const json = await res.json();
            console.log(`[GMV Max] sessions(${cid}): code=${json.code} msg=${json.message || ''}`);
            console.log(`[GMV Max] session data:`, JSON.stringify(json.data || json).slice(0, 3000));
          } catch (e) { console.log(`[GMV Max] sessions error:`, (e as Error).message); }
        }

        // Get campaign info (might have spend/budget data)
        for (const cid of allCampaignIds.slice(0, 2)) {
          try {
            const url = `${bizBase}/campaign/gmv_max/info/?advertiser_id=${advId}&campaign_id=${cid}`;
            const res = await fetch(url, { headers: { 'Access-Token': accessToken } });
            const json = await res.json();
            console.log(`[GMV Max] info(${cid}): code=${json.code}`);
            console.log(`[GMV Max] info data:`, JSON.stringify(json.data || json).slice(0, 3000));
          } catch (e) { console.log(`[GMV Max] info error:`, (e as Error).message); }
        }

        // Try reporting with correct filtering format
        const testStart = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
        const testEnd = new Date().toISOString().split('T')[0];
        try {
          const url = new URL(`${bizBase}/report/integrated/get/`);
          url.searchParams.set('advertiser_id', advId);
          url.searchParams.set('report_type', 'BASIC');
          url.searchParams.set('data_level', 'AUCTION_CAMPAIGN');
          url.searchParams.set('dimensions', JSON.stringify(['stat_time_day', 'campaign_id']));
          url.searchParams.set('metrics', JSON.stringify(['spend', 'impressions', 'clicks']));
          url.searchParams.set('start_date', testStart);
          url.searchParams.set('end_date', testEnd);
          url.searchParams.set('filtering', JSON.stringify([{ field_name: 'campaign_ids', filter_type: 'IN', filter_value: JSON.stringify(allCampaignIds) }]));
          url.searchParams.set('page_size', '30');
          const res = await fetch(url.toString(), { headers: { 'Access-Token': accessToken } });
          const json = await res.json();
          console.log(`[GMV Max] Report v2: code=${json.code} rows=${json.data?.list?.length || 0} msg=${json.message || ''}`);
          if (json.data?.list?.[0]) console.log(`[GMV Max] Report sample:`, JSON.stringify(json.data.list[0]).slice(0, 500));
        } catch (e) { console.log('[GMV Max] report error:', (e as Error).message); }
      }

    } catch (e) {
      console.log('[GMV Max] Error:', (e as Error).message);
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
