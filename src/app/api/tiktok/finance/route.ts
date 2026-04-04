import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchStatements, fetchPayments, fetchUnsettledOrders } from '@/lib/tiktok/client';
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

function toAmount(val: unknown): number {
  if (!val) return 0;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') return parseFloat(val) || 0;
  if (typeof val === 'object' && val !== null) {
    const obj = val as Record<string, unknown>;
    return parseFloat(String(obj.value || obj.amount || '0')) || 0;
  }
  return 0;
}

function toDateStr(unixSeconds: number): string {
  if (!unixSeconds) return '';
  return new Date(unixSeconds * 1000).toLocaleDateString('en-CA', { timeZone: SHOP_TIMEZONE });
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

  const now = new Date();
  const defaultFrom = new Date();
  defaultFrom.setDate(defaultFrom.getDate() - 30);
  const fromStr = dateFrom || defaultFrom.toLocaleDateString('en-CA', { timeZone: SHOP_TIMEZONE });
  const toStr = dateTo || now.toLocaleDateString('en-CA', { timeZone: SHOP_TIMEZONE });
  const toNext = new Date(toStr + 'T00:00:00Z');
  toNext.setUTCDate(toNext.getUTCDate() + 1);
  const toNextStr = toNext.toISOString().split('T')[0];

  const startTs = dayToTs(fromStr);
  const endTs = dayToTs(toNextStr);

  const accessToken = decryptOrFallback(connection.access_token, 'access_token');

  const [statements, paymentsRaw, unsettledRaw] = await Promise.all([
    fetchStatements(accessToken, connection.shop_cipher, startTs, endTs),
    fetchPayments(accessToken, connection.shop_cipher),
    fetchUnsettledOrders(accessToken, connection.shop_cipher).catch(err => {
      console.error('[Finance] fetchUnsettledOrders error:', (err as Error).message);
      return {} as Record<string, unknown>;
    }),
  ]);

  // Parse payments: {amount:{currency,value}, bank_account, create_time, paid_time, id, status, settlement_amount:{currency,value}}
  const payments = paymentsRaw.map(p => ({
    id: String(p.id || ''),
    amount: toAmount(p.amount),
    currency: (p.amount as Record<string, string>)?.currency || 'USD',
    status: String(p.status || ''),
    createTime: toDateStr(Number(p.create_time) || 0),
    paidTime: toDateStr(Number(p.paid_time) || 0),
    bankAccount: String(p.bank_account || ''),
  }));

  // Parse unsettled: {sum_est_revenue_amount, sum_est_fee_amount, sum_est_adjustment_amount, sum_est_settlement_amount, total_count, transactions}
  const unsettled = {
    totalCount: Number(unsettledRaw.total_count) || 0,
    estRevenue: toAmount(unsettledRaw.sum_est_revenue_amount),
    estFees: toAmount(unsettledRaw.sum_est_fee_amount),
    estAdjustments: toAmount(unsettledRaw.sum_est_adjustment_amount),
    estSettlement: toAmount(unsettledRaw.sum_est_settlement_amount),
  };

  console.log(`[Finance] ${statements.length} statements, ${payments.length} payments, unsettled: ${unsettled.totalCount} orders / est payout ${unsettled.estSettlement}`);

  return NextResponse.json({
    statements,
    payments,
    unsettled,
  });
}
