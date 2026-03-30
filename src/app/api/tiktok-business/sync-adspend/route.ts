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
    // Sync last 365 days
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 365 * 86400000).toISOString().split('T')[0];

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

      if (upsertErr) {
        console.error('[AdSpend] Upsert error:', upsertErr.message);
        return NextResponse.json({ error: upsertErr.message }, { status: 500 });
      }

      console.log(`[AdSpend] Synced ${dbRows.length} days of ad spend`);
      return NextResponse.json({ success: true, days: dbRows.length });
    }

    return NextResponse.json({ success: true, days: 0 });
  } catch (error) {
    console.error('[AdSpend] Failed:', error);
    return NextResponse.json({ error: 'Ad spend sync failed' }, { status: 500 });
  }
}
