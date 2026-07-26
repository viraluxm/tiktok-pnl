import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// GET the running auction log/board for a session.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Ownership: the session must belong to the caller. tiktok_live_id (room) + window scope the
  // captured-but-unbound union to THIS live.
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
      // Bound rows expose their order_id (= client_idempotency_key) so the UI can unbind them.
      order_id: it.client_idempotency_key ?? null,
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

  // ── PRIMARY narrowing list: the distinct internal SKUs actually sold in THIS show (+ category),
  //    so the bind picker offers ~10-50 SKUs, never the full 217 catalogue. The full list stays a
  //    searchable fallback in the client.
  const soldSkuIds = [...new Set(skuRows.map((s) => String(s.inventory_sku_id)))];
  let sessionSkus: Array<{ id: string; sku_number: number | null; title: string | null; category: string | null; barcode: string | null }> = [];
  if (soldSkuIds.length) {
    const { data: inv } = await supabase.from('inventory_skus')
      .select('id, sku_number, title, category, barcode').eq('user_id', user.id).in('id', soldSkuIds);
    sessionSkus = (inv ?? []).map((s) => ({
      id: String(s.id), sku_number: (s.sku_number as number | null) ?? null, title: (s.title as string | null) ?? null,
      category: (s.category as string | null) ?? null, barcode: (s.barcode as string | null) ?? null,
    })).sort((a, b) => (Number(a.sku_number) || 0) - (Number(b.sku_number) || 0));
  }
  const liveCategories = [...new Set(sessionSkus.map((s) => s.category).filter((c): c is string => !!c))];

  // ── Union: captured-but-unbound sales for THIS show. ONE definition, shared with the coverage
  //    banner (/api/shows/[id]/coverage): synced orders in the show's store + window that HAVE a
  //    capture but no bind. Deliberately ROOM- and capture-store-AGNOSTIC: concurrent same-store
  //    lives tag captures with a SIBLING room, and capture_events.store_id is frequently NULL, so
  //    scoping the union by capture room/store hid real unbound sales (banner said 19, table showed
  //    0). The authoritative store + window come from synced_order_ids (which HAS store_id);
  //    capture_events is joined only to hydrate display fields. CANCELLED + junk '0' + failed-payment
  //    are excluded (binding one would decrement stock for a non-sale).
  const SHOP_TZ = 'America/Los_Angeles';
  const localDate = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: SHOP_TZ });
  const isCancelled = (s: string | null | undefined) => {
    const u = (s ?? '').toUpperCase();
    return u === 'CANCELLED' || u.includes('CANCEL');
  };
  const unboundRows: Array<Record<string, unknown>> = [];
  const startIso = ((session.started_at as string | null) ?? (session.created_at as string | null)) ?? null;
  if (startIso) {
    const endIso = (session.ended_at as string | null) ?? new Date().toISOString();
    const startDate = localDate(startIso), endDate = localDate(endIso);
    const startMs = new Date(startIso).getTime(), endMs = new Date(endIso).getTime();

    // Authoritative order set: synced_order_ids for the store + date window (refined to the exact
    // timestamp when order_created_at is present; date-window fallback for un-backfilled rows).
    interface SyncRow { order_id: string; status: string | null; order_created_at: string | null }
    const synced: SyncRow[] = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      let q = supabase.from('synced_order_ids')
        .select('order_id, status, order_created_at')
        .eq('user_id', user.id).gte('order_date', startDate).lte('order_date', endDate)
        .order('order_date', { ascending: true }).range(from, from + PAGE - 1);
      if (session.store_id) q = q.eq('store_id', session.store_id);
      const { data, error: syncErr } = await q;
      if (syncErr) { console.error('[live/board] unbound synced-scan error:', syncErr); break; }
      synced.push(...((data ?? []) as SyncRow[]));
      if (!data || data.length < PAGE) break;
    }
    const candidateSet = [...new Set(
      synced.filter((o) => {
        if (!o.order_id || o.order_id === '0' || isCancelled(o.status)) return false;
        if (o.order_created_at) {
          const t = new Date(o.order_created_at).getTime();
          if (Number.isFinite(t)) return t >= startMs && t <= endMs;
        }
        return true; // no timestamp → keep on the date window (coverage parity)
      }).map((o) => o.order_id),
    )];

    // captured = has a capture (ANY room/store, payment not failed); bound = has an auction item in
    // ANY session. Chunk the .in() lists so a long day never blows the query-string limit.
    const capById = new Map<string, { won: number | null; title: string | null; seller: string | null; buyer: string | null; when: string | null }>();
    const boundIds = new Set<string>();
    for (let i = 0; i < candidateSet.length; i += 300) {
      const chunk = candidateSet.slice(i, i + 300);
      const { data: caps } = await supabase.from('capture_events')
        .select('order_id, selling_price_cents, product_name, platform_sku_ref, buyer_username, ordered_at, created_at, is_payment_successful')
        .eq('user_id', user.id).in('order_id', chunk);
      for (const c of caps ?? []) {
        const oid = String(c.order_id);
        if (c.is_payment_successful === false) continue; // failed payment ≠ a sale
        if (!capById.has(oid)) capById.set(oid, {
          won: (c.selling_price_cents as number | null) ?? null,
          title: (c.product_name as string | null) ?? null,
          seller: (c.platform_sku_ref as string | null) ?? null,
          buyer: (c.buyer_username as string | null) ?? null,
          when: (c.ordered_at as string | null) ?? (c.created_at as string | null) ?? null,
        });
      }
      const { data: bnd } = await supabase.from('live_auction_items')
        .select('client_idempotency_key').eq('user_id', user.id).in('client_idempotency_key', chunk);
      for (const b of bnd ?? []) if (b.client_idempotency_key) boundIds.add(String(b.client_idempotency_key));
    }

    for (const oid of candidateSet) {
      if (boundIds.has(oid)) continue;  // bound in some session → not unbound
      const cap = capById.get(oid);
      if (!cap) continue;               // not captured → that's "never captured" (coverage/CoveragePanel), not here
      unboundRows.push({
        id: `unbound:${oid}`, auction_number: 0, status: 'sold', is_bundle: false,
        expected_price_cents: null, sold_price_cents: null,
        won_price_cents: cap.won, tiktok_title: cap.title,
        payment_failed: false, order_status: null, net_payout_cents: null, payout_settled: false,
        buyer_handle: cap.buyer, logged_at: cap.when ?? '',
        units: 0, total_cost_cents: null, skus: [],
        unbound: true, order_id: oid, seller_sku_hint: cap.seller,
      });
    }
  }

  return NextResponse.json({ items: [...assembled, ...unboundRows], session_skus: sessionSkus, live_categories: liveCategories });
}
