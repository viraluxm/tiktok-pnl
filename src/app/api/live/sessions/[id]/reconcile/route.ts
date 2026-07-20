import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getOrderById } from '@/lib/tiktok/client';
import { getFreshToken, refreshConnection, isExpiredCredsError, type ConnRow } from '@/lib/tiktok/tokens';

export const dynamic = 'force-dynamic';

const PAID = new Set(['AWAITING_SHIPMENT', 'AWAITING_COLLECTION', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED']);
// 027 transition path ignores p_skus; this only satisfies the RPC's NO_SKUS guard.
const PLACEHOLDER_SKUS = [{ sku_id: '00000000-0000-0000-0000-000000000000', qty: 1 }];

interface StatusInfo { paid: boolean; status: string; seller_sku: string; quantity: number }

// Batch Get Order Detail (≤50/call) → current status + seller_sku hint + qty.
// onExpired: called ONCE on a 105002 (expired credentials) to obtain a freshly-refreshed
// access token (persist-on-success), then the call is retried — the refresh-on-use net so
// a lapsed/mis-dated token self-heals mid-reconcile instead of failing the whole sync.
async function fetchStatuses(
  tokenInit: string,
  cipher: string,
  ids: string[],
  onExpired?: () => Promise<string>,
): Promise<Map<string, StatusInfo>> {
  const map = new Map<string, StatusInfo>();
  let token = tokenInit;
  let refreshedOnce = false;
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    let orders: Record<string, unknown>[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { orders = await getOrderById(token, cipher, chunk); break; }
      catch (e) {
        if (onExpired && !refreshedOnce && isExpiredCredsError(e)) {
          refreshedOnce = true;
          try { token = await onExpired(); orders = await getOrderById(token, cipher, chunk); break; }
          catch { /* refresh or retry failed → fall through to backoff/next attempt */ }
        }
        if (attempt < 3) await new Promise((r) => setTimeout(r, 700 * attempt));
      }
    }
    for (const o of orders) {
      const lineItems = (o.line_items as Record<string, unknown>[]) || [];
      const li = lineItems[0] || {};
      map.set(String(o.id), {
        paid: !!o.paid_time || PAID.has(String(o.status)),
        status: String(o.status || ''),
        seller_sku: String(li.seller_sku || ''),
        quantity: lineItems.reduce((a, l) => a + (Number(l.quantity) || 1), 0) || 1,
      });
    }
  }
  return map;
}

// POST: post-show reconciliation.
//  A) flip bound not_sold rows whose order is now paid → sold (027 transition, exactly-once).
//  B) detect captured orders with no auction-item row (unbound) for manual SKU assignment.
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
  // cookie — a session knows its own store). Admin client so a token refresh can persist.
  const admin = createAdminClient();
  const { data: conn } = await admin
    .from('tiktok_connections')
    .select('id, access_token, refresh_token, shop_cipher, token_expires_at')
    .eq('user_id', user.id).eq('store_id', session.store_id).maybeSingle();
  if (!conn?.access_token || !conn?.shop_cipher) {
    return NextResponse.json({ error: 'No TikTok connection' }, { status: 400 });
  }
  const connRow = conn as ConnRow;
  // Proactively refresh if the (corrected) expiry is near/past; else use the current token.
  const fresh = await getFreshToken(admin, connRow, { skewMinutes: 30 });
  const token = fresh.accessToken;
  const cipher = connRow.shop_cipher as string;
  // 105002 safety net for both fetchStatuses passes: refresh once + retry.
  const onExpired = async () => (await refreshConnection(admin, connRow)).accessToken;

  // Bound orders for this session.
  const { data: items } = await supabase
    .from('live_auction_items')
    .select('client_idempotency_key, status')
    .eq('user_id', user.id).eq('session_id', id);
  const bound = (items ?? []).filter((i) => i.client_idempotency_key);
  const boundIds = [...new Set(bound.map((i) => String(i.client_idempotency_key)))];

  const statuses = await fetchStatuses(token, cipher, boundIds, onExpired);

  // ── PART A: flip not_sold + paid → sold. Price is NOT written here; won price
  //    is always read from capture_events. Status is only the flip trigger.
  const flipped: string[] = [];
  for (const it of bound) {
    const oid = String(it.client_idempotency_key);
    if (it.status === 'not_sold' && statuses.get(oid)?.paid) {
      const { data, error } = await supabase.rpc('lensed_log_auction', {
        p_session_id: id, p_result: 'sold', p_skus: PLACEHOLDER_SKUS, p_idem_key: oid,
      });
      const row = Array.isArray(data) ? data[0] : data;
      if (!error && row?.replayed === false && row?.status === 'sold') flipped.push(oid);
    }
  }

  // Capture prices for the whole session window (one fetch; powers revenue + buyer).
  let capQ = supabase
    .from('capture_events')
    .select('order_id, buyer_username, selling_price_cents')
    .eq('user_id', user.id)
    .gte('created_at', session.started_at);
  if (session.ended_at) capQ = capQ.lte('created_at', session.ended_at);
  const { data: caps } = await capQ;
  const cap = new Map<string, { price: number; buyer: string }>();
  for (const c of caps ?? []) {
    const k = String(c.order_id);
    if (!cap.has(k)) cap.set(k, { price: Number(c.selling_price_cents) || 0, buyer: c.buyer_username || '' });
  }

  // ── PART B: unbound captured orders (excl junk '0'), confirmed real + PAID.
  // Flag = orders that have revenue but no cost (need inventory). Unpaid/cancelled excluded.
  const boundSet = new Set(boundIds);
  const seen = new Set<string>();
  const unboundCaps = (caps ?? []).filter((c) => {
    const o = String(c.order_id);
    if (o === '0' || boundSet.has(o) || seen.has(o)) return false;
    seen.add(o); return true;
  });
  const ub = await fetchStatuses(token, cipher, unboundCaps.map((c) => String(c.order_id)), onExpired);
  const unbound = unboundCaps
    .filter((c) => ub.get(String(c.order_id))?.paid)
    .map((c) => {
      const s = ub.get(String(c.order_id))!;
      return {
        order_id: String(c.order_id),
        buyer: c.buyer_username || '',
        won_price_cents: c.selling_price_cents ?? null,
        seller_sku: s.seller_sku,
        quantity: s.quantity,
        status: s.status,
      };
    });

  // ── REVENUE (capture-based) over all PAID wins: bound-sold (incl just-flipped)
  //    ∪ unbound-paid. A fresh sum each reconcile (read, not accumulated) → re-run safe.
  const flippedSet = new Set(flipped);
  const boundSold = new Set(
    bound
      .filter((i) => i.status === 'sold' || flippedSet.has(String(i.client_idempotency_key)))
      .map((i) => String(i.client_idempotency_key)),
  );
  const paidIds = new Set<string>([...boundSold, ...unbound.map((u) => u.order_id)]);
  let revenue_cents = 0;
  for (const oid of paidIds) revenue_cents += cap.get(oid)?.price ?? 0;

  // NOTE: per-order true payouts (TikTok Finance) are pulled separately by the
  // POST /payouts endpoint ("Refresh payouts" button) — it pages the shop's
  // unsettled list and is slow, so it is intentionally kept OUT of this fast
  // reconcile pass. Reconcile does flips + capture-based revenue + unbound only.

  return NextResponse.json({
    flipped,
    flipped_count: flipped.length,
    revenue_cents,
    revenue_count: paidIds.size,   // all paid wins (Y)
    costed_count: boundSold.size,  // bound sold = have cost (X)
    unbound,
    unbound_count: unbound.length,
  });
}
