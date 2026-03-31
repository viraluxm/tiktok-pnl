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

      // 1. Get GMV Max campaigns with required filtering
      try {
        // Try different promotion types
        for (const promoType of ['SHOP_ADS', 'GMV_MAX', 'PRODUCT_GMV_MAX', 'LIVE_GMV_MAX', 'CUSTOM_SHOP_ADS']) {
          try {
            const filtering = JSON.stringify({ gmv_max_promotion_types: [promoType] });
            const url = `${bizBase}/gmv_max/campaign/get/?advertiser_id=${advId}&filtering=${encodeURIComponent(filtering)}`;
            const res = await fetch(url, { headers: { 'Access-Token': accessToken } });
            const json = await res.json();
            console.log(`[GMV Max] campaign(${promoType}): code=${json.code} msg=${json.message || ''} data=${JSON.stringify(json.data || {}).slice(0, 1000)}`);
          } catch (e) { /* skip */ }
        }
      } catch (e) { console.log('[GMV Max] campaign/get error:', (e as Error).message); }

      try {
        const url = `${bizBase}/gmv_max/campaign/get/?advertiser_id=${advId}`;
        const res = await fetch(url, { headers: { 'Access-Token': accessToken } });
        const json = await res.json();
        console.log(`[GMV Max] gmv_max/campaign/get (no filter): code=${json.code} msg=${json.message || ''}`);
        console.log(`[GMV Max] campaign data:`, JSON.stringify(json.data || json).slice(0, 3000));

        // If we got campaigns, try session list for each
        const campaigns = (json.data?.list || json.data?.campaigns || []) as Array<Record<string, unknown>>;
        for (const c of campaigns.slice(0, 3)) {
          const cid = String(c.campaign_id || c.id || '');
          if (cid) {
            try {
              const sessUrl = `${bizBase}/campaign/gmv_max/session/list/?advertiser_id=${advId}&campaign_id=${cid}&page_size=10`;
              const sessRes = await fetch(sessUrl, { headers: { 'Access-Token': accessToken } });
              const sessJson = await sessRes.json();
              console.log(`[GMV Max] sessions(campaign=${cid}): code=${sessJson.code}`);
              console.log(`[GMV Max] session data:`, JSON.stringify(sessJson.data || sessJson).slice(0, 2000));
            } catch (e) { console.log(`[GMV Max] sessions error:`, (e as Error).message); }
          }
        }
      } catch (e) { console.log('[GMV Max] campaign/get error:', (e as Error).message); }

      // 2. Also try campaign/gmv_max/info
      try {
        const url = `${bizBase}/campaign/gmv_max/info/?advertiser_id=${advId}`;
        const res = await fetch(url, { headers: { 'Access-Token': accessToken } });
        const json = await res.json();
        console.log(`[GMV Max] info: code=${json.code} msg=${json.message || ''}`);
        console.log(`[GMV Max] info data:`, JSON.stringify(json.data || json).slice(0, 2000));
      } catch (e) { console.log('[GMV Max] info error:', (e as Error).message); }

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
