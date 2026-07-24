import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// GET the running auction log/board for a session.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Ownership: the session must belong to the caller. tiktok_live_id (room) +
  // window are needed to union THIS-LIVE captured-but-unbound sales below.
  const { data: session } = await supabase
    .from('live_sessions')
    .select('id, status, tiktok_live_id, started_at, ended_at, created_at, store_id')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });

  const { data: items, error } = await supabase
    .from('live_auction_items')
    .select('id, sequence, status, is_bundle, expected_price_cents, sold_price_cents, buyer_handle, client_idempotency_key, closed_at, created_at')
    .eq('session_id', id)
    .eq('user_id', user.id)
    .order('sequence', { ascending: true });

  if (error) {
    console.error('[live/board] items error:', error);
    return NextResponse.json({ error: 'Failed to load log' }, { status: 500 });
  }

  // The extension binds an auction via lensed_log_auction using the TikTok
  // order_id as the idempotency key, and separately upserts capture_events
  // keyed by the same order_id. So client_idempotency_key === capture_events.order_id.
  // Join (read-only) to surface the real won price + TikTok product title.
  const orderIds = (items ?? [])
    .map((i) => i.client_idempotency_key)
    .filter((k): k is string => typeof k === 'string' && k.length > 0);
  const captureByOrderId = new Map<
    string,
    { won_price_cents: number | null; tiktok_title: string | null; payment_failed: boolean; order_status: number | null }
  >();
  if (orderIds.length) {
    const { data: captures, error: capErr } = await supabase
      .from('capture_events')
      // order_status is a read-only signal (TikTok tri-state: 2=pending/recoverable,
      // 3=paid/recovered, 4=cancelled) used only to render a badge on not_sold rows.
      .select('order_id, selling_price_cents, product_name, is_payment_successful, order_status')
      .eq('user_id', user.id)
      .in('order_id', orderIds);
    if (capErr) {
      // Non-fatal: the board still works without the capture join.
      console.error('[live/board] capture_events join error:', capErr);
    } else {
      for (const c of captures ?? []) {
        captureByOrderId.set(c.order_id as string, {
          won_price_cents: (c.selling_price_cents as number | null) ?? null,
          tiktok_title: (c.product_name as string | null) ?? null,
          // Only an explicit false means the payment failed (null/true = ok).
          payment_failed: c.is_payment_successful === false,
          order_status: (c.order_status as number | null) ?? null,
        });
      }
    }
  }

  // Join true payout (estimate or settled) by order_id, populated by Reconcile.
  const payoutByOrderId = new Map<string, { net_payout_cents: number | null; payout_settled: boolean }>();
  if (orderIds.length) {
    const { data: payouts, error: poErr } = await supabase
      .from('order_payouts')
      .select('order_id, net_payout_cents, settled')
      .eq('user_id', user.id)
      .in('order_id', orderIds);
    if (poErr) {
      console.error('[live/board] order_payouts join error:', poErr);
    } else {
      for (const p of payouts ?? []) {
        payoutByOrderId.set(p.order_id as string, {
          net_payout_cents: (p.net_payout_cents as number | null) ?? null,
          payout_settled: !!p.settled,
        });
      }
    }
  }

  const itemIds = (items ?? []).map((i) => i.id);
  let skuRows: Record<string, unknown>[] = [];
  if (itemIds.length) {
    const { data: skus, error: skuErr } = await supabase
      .from('live_auction_item_skus')
      .select('auction_item_id, inventory_sku_id, qty, unit_cost_cents_snapshot, sku_number_snapshot, title_snapshot')
      .in('auction_item_id', itemIds)
      .eq('user_id', user.id);
    if (skuErr) {
      console.error('[live/board] skus error:', skuErr);
      return NextResponse.json({ error: 'Failed to load log' }, { status: 500 });
    }
    skuRows = skus ?? [];
  }

  const byItem = new Map<string, Record<string, unknown>[]>();
  for (const r of skuRows) {
    const k = r.auction_item_id as string;
    if (!byItem.has(k)) byItem.set(k, []);
    byItem.get(k)!.push(r);
  }

  const assembled = (items ?? []).map((it) => {
    const skus = byItem.get(it.id) ?? [];
    let totalCost: number | null = 0;
    let units = 0;
    for (const s of skus) {
      const qty = (s.qty as number) ?? 1;
      units += qty;
      const cost = s.unit_cost_cents_snapshot as number | null;
      if (cost == null) totalCost = null;
      else if (totalCost != null) totalCost += cost * qty;
    }
    const capture = it.client_idempotency_key
      ? captureByOrderId.get(it.client_idempotency_key) ?? null
      : null;
    const payout = it.client_idempotency_key
      ? payoutByOrderId.get(it.client_idempotency_key) ?? null
      : null;
    return {
      id: it.id,
      auction_number: it.sequence,
      status: it.status,
      is_bundle: it.is_bundle,
      expected_price_cents: it.expected_price_cents,
      sold_price_cents: it.sold_price_cents,
      // Real winning bid from the captured sale (item price, excl. shipping).
      won_price_cents: capture?.won_price_cents ?? null,
      // TikTok auction item title from the capture (e.g. "Random Electronics").
      tiktok_title: capture?.tiktok_title ?? null,
      // True when the captured sale had a failed payment (logged as not_sold).
      payment_failed: capture?.payment_failed ?? false,
      // TikTok order status (read-only display signal): 2=pending/recoverable,
      // 3=paid (RECOVERED — needs review if still not_sold), 4=cancelled. null=unknown.
      order_status: capture?.order_status ?? null,
      // True net payout (estimate or settled), joined from order_payouts (Reconcile).
      net_payout_cents: payout?.net_payout_cents ?? null,
      payout_settled: payout?.payout_settled ?? false,
      buyer_handle: it.buyer_handle,
      logged_at: it.closed_at ?? it.created_at,
      units,
      total_cost_cents: totalCost,
      skus: skus.map((s) => ({
        inventory_sku_id: s.inventory_sku_id,
        sku_number: s.sku_number_snapshot,
        title: s.title_snapshot,
        qty: s.qty,
        unit_cost_cents: s.unit_cost_cents_snapshot,
      })),
    };
  });

  // ── Union: captured-but-unbound sales for THIS live, so the sold-items list
  //    shows EVERY captured sale (not just bound ones). Scope captures to this
  //    session by room_id (= live_sessions.tiktok_live_id) + the session's time
  //    window — THIS-LIVE-ONLY, not store-wide. A NULL-room session can't be
  //    room-scoped, so we skip the union there (never pull another live's sales).
  const boundOrderIdSet = new Set(orderIds); // client_idempotency_keys of bound items
  const unboundRows: Array<Record<string, unknown>> = [];
  const room = (session.tiktok_live_id as string | null) ?? null;
  const startIso = ((session.started_at as string | null) ?? (session.created_at as string | null)) ?? null;
  if (room && startIso) {
    const endIso = (session.ended_at as string | null) ?? new Date().toISOString(); // open live → now
    let capQ = supabase
      .from('capture_events')
      .select('order_id, selling_price_cents, product_name, platform_sku_ref, buyer_username, is_payment_successful, ordered_at, created_at')
      .eq('user_id', user.id)
      .eq('room_id', room)
      .gte('ordered_at', startIso)
      .lte('ordered_at', endIso);
    if (session.store_id) capQ = capQ.eq('store_id', session.store_id);
    const { data: caps, error: capUnionErr } = await capQ;
    if (capUnionErr) {
      console.error('[live/board] unbound-capture union error:', capUnionErr);
    } else {
      const seen = new Set<string>();
      for (const c of caps ?? []) {
        const oid = String(c.order_id ?? '');
        if (!oid || boundOrderIdSet.has(oid) || seen.has(oid)) continue; // bound already a row; dedup
        if (c.is_payment_successful === false) continue;                 // failed payment → not a sale
        seen.add(oid);
        unboundRows.push({
          id: `unbound:${oid}`,
          auction_number: 0,               // never auctioned as a numbered item (UI renders "—")
          status: 'sold',
          is_bundle: false,
          expected_price_cents: null,
          sold_price_cents: null,
          won_price_cents: (c.selling_price_cents as number | null) ?? null,
          tiktok_title: (c.product_name as string | null) ?? null,
          payment_failed: false,
          order_status: null,
          net_payout_cents: null,
          payout_settled: false,
          buyer_handle: (c.buyer_username as string | null) ?? null,
          logged_at: (c.ordered_at as string | null) ?? (c.created_at as string | null) ?? '',
          units: 0,                        // unknown until bound (UI renders "—"; totals count as 1)
          total_cost_cents: null,          // UNKNOWN cost — never 0 (kept out of profit)
          skus: [],
          unbound: true,
          order_id: oid,
          seller_sku_hint: (c.platform_sku_ref as string | null) ?? null,
        });
      }
    }
  }

  return NextResponse.json({ items: [...assembled, ...unboundRows] });
}
