import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchStatements, fetchPayments, fetchSettlements } from '@/lib/tiktok/client';
import { decryptOrFallback } from '@/lib/crypto';

const SHOP_TIMEZONE = 'America/Los_Angeles';

function dayToTs(day: string): number {
  const refUtc = new Date(day + 'T12:00:00Z');
  const utcDateStr = refUtc.toLocaleDateString('en-CA', { timeZone: 'UTC' });
  const localDateStr = refUtc.toLocaleDateString('en-CA', { timeZone: SHOP_TIMEZONE });
  const utcHours = refUtc.getUTCHours();
  const localHoursStr = refUtc.toLocaleTimeString('en-GB', { timeZone: SHOP_TIMEZONE, hour: '2-digit', hour12: false });
  const localHours = parseInt(localHoursStr);
  let offsetHours = utcHours - localHours;
  if (utcDateStr !== localDateStr) {
    if (utcDateStr > localDateStr) offsetHours += 24;
    else offsetHours -= 24;
  }
  return Math.floor(new Date(day + 'T00:00:00Z').getTime() / 1000) + (offsetHours * 3600);
}

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data, error: authError } = await supabase.auth.getUser();
  if (authError || !data.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const dateFrom = searchParams.get('from');
  const dateTo = searchParams.get('to');

  const admin = createAdminClient();

  const { data: connection } = await admin.from('tiktok_connections').select('*').eq('user_id', data.user.id).single();

  if (!connection?.access_token || !connection?.shop_cipher) {
    return NextResponse.json({ error: 'No TikTok connection found' }, { status: 404 });
  }

  // Calculate date range
  const now = new Date();
  const defaultFrom = new Date();
  defaultFrom.setDate(defaultFrom.getDate() - 30);
  const fromStr = dateFrom || defaultFrom.toLocaleDateString('en-CA', { timeZone: SHOP_TIMEZONE });
  const toStr = dateTo || now.toLocaleDateString('en-CA', { timeZone: SHOP_TIMEZONE });
  // Add one day to 'to' so the end timestamp covers the full last day
  const toNext = new Date(toStr + 'T00:00:00Z');
  toNext.setUTCDate(toNext.getUTCDate() + 1);
  const toNextStr = toNext.toISOString().split('T')[0];

  const startTs = dayToTs(fromStr);
  const endTs = dayToTs(toNextStr);

  const accessToken = decryptOrFallback(connection.access_token, 'access_token');

  // Fetch all three in parallel
  const [statements, payments, settlements] = await Promise.all([
    fetchStatements(accessToken, connection.shop_cipher, startTs, endTs),
    fetchPayments(accessToken, connection.shop_cipher),
    fetchSettlements(accessToken, connection.shop_cipher, startTs, endTs),
  ]);

  // Debug logging for first-time API exploration
  const debug: Record<string, unknown> = {};
  if (payments.length > 0) {
    const firstPayment = payments[0];
    debug.paymentKeys = Object.keys(firstPayment);
    console.log('[Finance] First payment keys:', JSON.stringify(Object.keys(firstPayment)));
    console.log('[Finance] First payment sample:', JSON.stringify(firstPayment).slice(0, 500));
  } else {
    console.log('[Finance] No payments returned');
  }
  if (settlements.length > 0) {
    const firstSettlement = settlements[0];
    debug.settlementKeys = Object.keys(firstSettlement);
    console.log('[Finance] First settlement keys:', JSON.stringify(Object.keys(firstSettlement)));
    console.log('[Finance] First settlement sample:', JSON.stringify(firstSettlement).slice(0, 500));
  } else {
    console.log('[Finance] No settlements returned');
  }

  console.log(`[Finance] ${statements.length} statements, ${payments.length} payments, ${settlements.length} settlements (${fromStr} to ${toStr})`);

  return NextResponse.json({
    statements,
    payments,
    settlements,
    debug,
  });
}
