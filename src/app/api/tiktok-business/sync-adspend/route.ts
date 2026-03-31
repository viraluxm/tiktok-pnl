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
    // Get GMV Max campaign IDs, then query spend via reporting
    try {
      const bizBase = 'https://business-api.tiktok.com/open_api/v1.3';
      const advId = connection.advertiser_id;

      // Step 1: List all campaigns to find GMV Max ones
      try {
        const url = `${bizBase}/campaign/get/?advertiser_id=${advId}&page_size=50`;
        const res = await fetch(url, { headers: { 'Access-Token': accessToken } });
        const json = await res.json();
        const campaigns = (json.data?.list || []) as Array<Record<string, unknown>>;
        console.log(`[GMV Max] campaign/get: code=${json.code} total=${campaigns.length}`);
        for (const c of campaigns.slice(0, 5)) {
          console.log(`[GMV Max] Campaign: id=${c.campaign_id} name=${c.campaign_name} type=${c.campaign_type} objective=${c.objective_type} status=${c.operation_status}`);
        }

        // Step 2: Try reporting at campaign level with recent dates
        if (campaigns.length > 0) {
          const testStart = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
          const testEnd = new Date().toISOString().split('T')[0];
          const rptUrl = new URL(`${bizBase}/report/integrated/get/`);
          rptUrl.searchParams.set('advertiser_id', advId);
          rptUrl.searchParams.set('report_type', 'BASIC');
          rptUrl.searchParams.set('data_level', 'AUCTION_CAMPAIGN');
          rptUrl.searchParams.set('dimensions', JSON.stringify(['stat_time_day', 'campaign_id']));
          rptUrl.searchParams.set('metrics', JSON.stringify(['spend', 'impressions', 'clicks', 'conversion', 'total_complete_payment_rate']));
          rptUrl.searchParams.set('start_date', testStart);
          rptUrl.searchParams.set('end_date', testEnd);
          rptUrl.searchParams.set('page_size', '20');
          const rptRes = await fetch(rptUrl.toString(), { headers: { 'Access-Token': accessToken } });
          const rptJson = await rptRes.json();
          console.log(`[GMV Max] Campaign report: code=${rptJson.code} rows=${rptJson.data?.list?.length || 0} msg=${rptJson.message || ''}`);
          if (rptJson.data?.list?.[0]) console.log('[GMV Max] Report sample:', JSON.stringify(rptJson.data.list[0]).slice(0, 500));
        }
      } catch (e) { console.log('[GMV Max] campaign/get error:', (e as Error).message); }

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
