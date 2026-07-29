import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { inChunks } from '@/lib/supabase/inChunks';

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
    const { rows: captures, error: capErr } = await inChunks<Record<string, unknown>>(orderIds, (slice) =>
      supabase
        .from('capture_events')
        // order_status is a read-only signal (TikTok tri-state: 2=pending/recoverable,
        // 3=paid/recovered, 4=cancelled) used only to render a badge on not_sold rows.
        .select('order_id, selling_price_cents, product_name, is_payment_successful, order_status')
        .eq('user_id', user.id)
        .in('order_id', slice));
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

  // Join the TRUTHFUL, refreshed TikTok order status from synced_order_ids (the order
  // sweep). capture_events.order_status is a write-once snapshot frozen at capture time,
  // so the payment badge must prefer this. Fallback to the snapshot only when the order
  // isn't in synced_order_ids yet. Read-only; keyed by the same order_id.
  const syncedStatusByOrderId = new Map<string, string | null>();
  if (orderIds.length) {
    const { rows: synced, error: syncErr } = await inChunks<Record<string, unknown>>(orderIds, (slice) =>
      supabase
        .from('synced_order_ids')
        .select('order_id, status')
        .eq('user_id', user.id)
        .in('order_id', slice));
    if (syncErr) {
      // Non-fatal: the board still works without the synced-status join (badge falls
      // back to the capture snapshot).
      console.error('[live/board] synced_order_ids join error:', syncErr);
    } else {
      for (const s of synced ?? []) {
        syncedStatusByOrderId.set(s.order_id as string, (s.status as string | null) ?? null);
      }
    }
  }

  // Join true payout (estimate or settled) by order_id, populated by Reconcile.
  const payoutByOrderId = new Map<string, { net_payout_cents: number | null; payout_settled: boolean }>();
  if (orderIds.length) {
    const { rows: payouts, error: poErr } = await inChunks<Record<string, unknown>>(orderIds, (slice) =>
      supabase
        .from('order_payouts')
        .select('order_id, net_payout_cents, settled')
        .eq('user_id', user.id)
        .in('order_id', slice));
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
  // NON-FATAL: the skus join enriches rows with units/cost. If it fails we DEGRADE
  // (units/cost read as unknown) and flag `warning` rather than 500-ing the board —
  // a show that reads zero must be distinguishable from a show with no sales. Won-price
  // revenue comes from the capture join above, so the headline sale value still renders.
  let warning: string | null = null;
  if (itemIds.length) {
    const { rows: skus, error: skuErr } = await inChunks<Record<string, unknown>>(itemIds, (slice) =>
      supabase
        .from('live_auction_item_skus')
        .select('auction_item_id, inventory_sku_id, qty, unit_cost_cents_snapshot, sku_number_snapshot, title_snapshot')
        .in('auction_item_id', slice)
        .eq('user_id', user.id));
    if (skuErr) {
      console.error('[live/board] skus error (degrading, non-fatal):', skuErr);
      warning = 'Some line-item details (units and cost) could not be loaded, so cost and profit may be incomplete. Sale value is unaffected.';
    }
    skuRows = skus;
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
      // Truthful refreshed TikTok status string (from synced_order_ids); the payment
      // badge prefers this over the frozen order_status snapshot. null = not yet swept.
      synced_status: it.client_idempotency_key
        ? syncedStatusByOrderId.get(it.client_idempotency_key) ?? null
        : null,
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
    const { rows: inv } = await inChunks<Record<string, unknown>>(soldSkuIds, (slice) =>
      supabase.from('inventory_skus')
        .select('id, sku_number, title, category, barcode').eq('user_id', user.id).in('id', slice));
    sessionSkus = (inv ?? []).map((s) => ({
      id: String(s.id), sku_number: (s.sku_number as number | null) ?? null, title: (s.title as string | null) ?? null,
      category: (s.category as string | null) ?? null, barcode: (s.barcode as string | null) ?? null,
    })).sort((a, b) => (Number(a.sku_number) || 0) - (Number(b.sku_number) || 0));
  }
  const liveCategories = [...new Set(sessionSkus.map((s) => s.category).filter((c): c is string => !!c))];

  // ── Union: captured-but-unbound sales for THIS show. ATTRIBUTION IS BY ROOM:
  //    capture_events.room_id = the session's tiktok_live_id. Under concurrent same-store lives the
  //    Order API has no room signal, so the capture's room is the ONLY reliable attribution — an
  //    order captured in a sibling live's room is that host's sale, NOT this show's, and must NOT be
  //    bindable here (binding it would mis-attribute revenue + host ASP/below-BE, which read
  //    live_sessions.host_id). Store scoping, however, is taken from synced_order_ids (which HAS a
  //    reliable store_id) — NOT from capture_events.store_id, which is frequently NULL (the known
  //    backfill gap) and was hiding a session's OWN unbound orders. CANCELLED/'0'/failed-payment excluded.
  const boundOrderIdSet = new Set(orderIds);
  const unboundRows: Array<Record<string, unknown>> = [];
  const room = (session.tiktok_live_id as string | null) ?? null;
  const startIso = ((session.started_at as string | null) ?? (session.created_at as string | null)) ?? null;
  if (room && startIso) {
    const endIso = (session.ended_at as string | null) ?? new Date().toISOString();
    // Captures for THIS ROOM + window. No store filter here (capture store_id is unreliable/NULL).
    const { data: caps, error: capUnionErr } = await supabase.from('capture_events')
      .select('order_id, selling_price_cents, product_name, platform_sku_ref, buyer_username, is_payment_successful, ordered_at, created_at')
      .eq('user_id', user.id).eq('room_id', room).gte('ordered_at', startIso).lte('ordered_at', endIso);
    if (capUnionErr) {
      console.error('[live/board] unbound-capture union error:', capUnionErr);
    } else {
      const capUnbound = (caps ?? []).filter((c) => {
        const oid = String(c.order_id ?? '');
        return oid && oid !== '0' && !boundOrderIdSet.has(oid) && c.is_payment_successful !== false;
      });
      // Store scope + CANCELLED come from synced_order_ids (reliable store_id + authoritative status).
      // When the session is store-scoped, keep an order only if its synced row confirms THIS store
      // (a room-captured order whose synced row is another store — or has no synced row — isn't
      // confirmable as this store's sale). CANCELLED always dropped.
      const uoids = [...new Set(capUnbound.map((c) => String(c.order_id)))];
      const cancelled = new Set<string>();
      const storeOk = new Set<string>();
      for (let i = 0; i < uoids.length; i += 300) {
        const { data: so } = await supabase.from('synced_order_ids')
          .select('order_id, status, store_id').eq('user_id', user.id).in('order_id', uoids.slice(i, i + 300));
        for (const r of so ?? []) {
          const oid = String(r.order_id);
          if (String(r.status) === 'CANCELLED') cancelled.add(oid);
          if (!session.store_id || String(r.store_id) === String(session.store_id)) storeOk.add(oid);
        }
      }
      const seen = new Set<string>();
      for (const c of capUnbound) {
        const oid = String(c.order_id);
        if (seen.has(oid) || cancelled.has(oid)) continue;
        if (session.store_id && !storeOk.has(oid)) continue; // store-scoped: require synced-store confirmation
        seen.add(oid);
        unboundRows.push({
          id: `unbound:${oid}`, auction_number: 0, status: 'sold', is_bundle: false,
          expected_price_cents: null, sold_price_cents: null,
          won_price_cents: (c.selling_price_cents as number | null) ?? null,
          tiktok_title: (c.product_name as string | null) ?? null,
          payment_failed: false, order_status: null, net_payout_cents: null, payout_settled: false,
          buyer_handle: (c.buyer_username as string | null) ?? null,
          logged_at: (c.ordered_at as string | null) ?? (c.created_at as string | null) ?? '',
          units: 0, total_cost_cents: null, skus: [],
          unbound: true, order_id: oid, seller_sku_hint: (c.platform_sku_ref as string | null) ?? null,
        });
      }
    }
  }

  return NextResponse.json({ items: [...assembled, ...unboundRows], session_skus: sessionSkus, live_categories: liveCategories, warning });
}
