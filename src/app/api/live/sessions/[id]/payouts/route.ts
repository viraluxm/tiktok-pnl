import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { decryptOrFallback } from '@/lib/crypto';
import { shopGet } from '@/lib/tiktok/client';

export const dynamic = 'force-dynamic';

// POST: pull per-order TRUE payouts (TikTok Finance) for the session and upsert
// into order_payouts keyed (user_id, order_id). SLOW — pages the shop's unsettled
// list — so it is deliberately split out of the fast Reconcile pass into its own
// "Refresh payouts" action. Read-only against inventory; no flips, no decrements.
//
// Logic is unchanged from the old reconcile payout block: prefer SETTLED actual,
// else UNSETTLED estimate, else no row (stays blank, never a 0). Upserting on
// (user_id, order_id) is exactly-once — re-running updates in place (incl.
// estimate→settled flips), never duplicates.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: session } = await supabase
    .from('live_sessions')
    .select('id, started_at, ended_at, store_id')
    .eq('id', id).eq('user_id', user.id).maybeSingle();
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });

  // Session-scoped: use the connection for THIS session's store (not the active-store
  // cookie — a session knows its own store).
  const { data: conn } = await supabase
    .from('tiktok_connections')
    .select('shop_cipher, access_token')
    .eq('user_id', user.id).eq('store_id', session.store_id).maybeSingle();
  if (!conn?.access_token || !conn?.shop_cipher) {
    return NextResponse.json({ error: 'No TikTok connection' }, { status: 400 });
  }
  const token = decryptOrFallback(conn.access_token as string, 'access_token');
  const cipher = conn.shop_cipher as string;

  // Order set to price = the session's orders: bound auction items ∪ captured
  // orders in the session window (excl junk '0'). The Finance API only returns
  // figures for payable orders, so cancelled/unpaid ones simply get no row —
  // the resulting rows match the old reconcile `paidIds` set, independently.
  const { data: items } = await supabase
    .from('live_auction_items')
    .select('client_idempotency_key')
    .eq('user_id', user.id).eq('session_id', id);

  let capQ = supabase
    .from('capture_events')
    .select('order_id')
    .eq('user_id', user.id)
    .gte('created_at', session.started_at);
  if (session.ended_at) capQ = capQ.lte('created_at', session.ended_at);
  const { data: caps } = await capQ;

  const orderIds = [...new Set([
    ...(items ?? []).map((i) => String(i.client_idempotency_key)),
    ...(caps ?? []).map((c) => String(c.order_id)),
  ].filter((o) => o && o !== '0'))];

  // ── PAYOUTS: prefer SETTLED actual, else UNSETTLED estimate, else no row.
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Estimate-first: page the shop's unsettled list once (capped at 100 pages).
  const estMap = new Map<string, { net: number; fees: unknown }>();
  let pageToken = '';
  for (let page = 0; page < 100; page++) {
    let data: Record<string, unknown> | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        data = await shopGet('/finance/202507/orders/unsettled', token, {
          shop_cipher: cipher, page_size: '50', sort_field: 'order_create_time', sort_order: 'DESC',
          ...(pageToken ? { page_token: pageToken } : {}),
        });
        break;
      } catch { if (attempt < 3) await sleep(700 * attempt); }
    }
    if (!data) break;
    for (const t of (data.transactions as Record<string, unknown>[]) || []) {
      const oid = String(t.order_id || '');
      if (oid && !estMap.has(oid)) estMap.set(oid, { net: Math.round((Number(t.est_settlement_amount) || 0) * 100), fees: t.fee_tax_breakdown ?? null });
    }
    pageToken = String(data.next_page_token || '');
    if (!pageToken) break;
  }

  const payoutRows: Record<string, unknown>[] = [];
  for (const oid of orderIds) {
    const e = estMap.get(oid);
    if (e) {
      payoutRows.push({ user_id: user.id, order_id: oid, net_payout_cents: e.net, settled: false, fees: e.fees, store_id: session.store_id });
    } else {
      // Not in unsettled → may be settled. Per-order settled lookup (precise).
      let s: Record<string, unknown> | null = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try { s = await shopGet(`/finance/202501/orders/${oid}/statement_transactions`, token, { shop_cipher: cipher }); break; }
        catch { if (attempt < 3) await sleep(500 * attempt); }
      }
      if (s && Number(s.total_count) > 0) {
        payoutRows.push({ user_id: user.id, order_id: oid, net_payout_cents: Math.round((Number(s.settlement_amount) || 0) * 100), settled: true, fees: s, store_id: session.store_id });
      }
      // else: TikTok has neither yet → no row (stays blank, never a 0).
    }
  }
  if (payoutRows.length) {
    const { error: upErr } = await supabase.from('order_payouts').upsert(payoutRows, { onConflict: 'user_id,order_id' });
    if (upErr) console.error('[live/payouts] order_payouts upsert error:', upErr.message);
  }
  const net_payout_cents_total = payoutRows.reduce((a, r) => a + (Number(r.net_payout_cents) || 0), 0);
  const settled_count = payoutRows.filter((r) => r.settled).length;

  return NextResponse.json({
    net_payout_cents_total,
    payout_count: payoutRows.length,
    settled_count,
    estimate_count: payoutRows.length - settled_count,
  });
}
