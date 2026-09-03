import { NextResponse } from 'next/server';
import { requireMemberScope } from '@/lib/station/guard';
import { resolveOwnedSession } from '@/lib/member/shows';
import { inChunks } from '@/lib/supabase/inChunks';
import { readAllPaged } from '@/lib/db/readAll';

export const dynamic = 'force-dynamic';

// Owner-scoped, READ-ONLY mirror of /api/live/sessions/[id]/board for the member 'shows' scope.
//
// COST/MARGIN IS DELIBERATELY EXCLUDED — that is what separates `shows` from `pnl`. This route must
// NOT return: skus[].unit_cost_cents, total_cost_cents, or expected_price_cents (the last is
// total_cost_cents × 3, so leaving it in would let cost be recovered by /3). unit_cost_cents_snapshot
// is not even SELECTed; the two derived cost fields are never computed or emitted. Revenue fields
// (won_price_cents, sold_price_cents, net_payout_cents) are fine for this scope.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const scope = await requireMemberScope('shows');
  if (!scope.ok) return scope.response;
  const { admin, ownerIds, storeIds, allStores } = scope;

  const owned = await resolveOwnedSession(admin, id, { ownerIds, storeIds, allStores },
    'user_id, store_id, id, status, tiktok_live_id, started_at, ended_at, created_at');
  if (!owned.ok) return owned.response;
  const { session, ownerUserId } = owned;

  // NOTE: expected_price_cents is NOT selected (cost-derived; excluded from the shows scope).
  // PAGED. Mirrors the owner-side board: a single response is capped at 1000 rows silently,
  // and the largest show in the last 30 days holds 1,049 items.
  const items = await readAllPaged(
    (from, to) => admin
      .from('live_auction_items')
      .select('id, sequence, status, is_bundle, sold_price_cents, buyer_handle, client_idempotency_key, closed_at, created_at')
      .eq('session_id', id)
      .eq('user_id', ownerUserId)
      .order('sequence', { ascending: true })
      .range(from, to),
    'member/shows/board items',
  ).catch((e: unknown) => e as Error);

  if (items instanceof Error) {
    console.error('[member/shows/board] items error:', items);
    return NextResponse.json({ error: 'Failed to load log' }, { status: 500 });
  }

  const orderIds = (items ?? [])
    .map((i) => i.client_idempotency_key)
    .filter((k): k is string => typeof k === 'string' && k.length > 0);

  // Capture join: real won price + TikTok title/status/lot.
  const captureByOrderId = new Map<
    string,
    { won_price_cents: number | null; tiktok_title: string | null; payment_failed: boolean; order_status: number | null; seller_sku_hint: string | null }
  >();
  if (orderIds.length) {
    const { rows: captures, error: capErr } = await inChunks<Record<string, unknown>>(orderIds, (slice) =>
      admin.from('capture_events')
        .select('order_id, selling_price_cents, product_name, is_payment_successful, order_status, platform_sku_ref')
        .eq('user_id', ownerUserId)
        .in('order_id', slice));
    if (capErr) console.error('[member/shows/board] capture join error:', capErr);
    else for (const c of captures ?? []) {
      captureByOrderId.set(c.order_id as string, {
        won_price_cents: (c.selling_price_cents as number | null) ?? null,
        tiktok_title: (c.product_name as string | null) ?? null,
        payment_failed: c.is_payment_successful === false,
        order_status: (c.order_status as number | null) ?? null,
        seller_sku_hint: (c.platform_sku_ref as string | null) ?? null,
      });
    }
  }

  // Refreshed TikTok status (synced_order_ids) — preferred over the frozen capture snapshot.
  const syncedStatusByOrderId = new Map<string, string | null>();
  if (orderIds.length) {
    const { rows: synced, error: syncErr } = await inChunks<Record<string, unknown>>(orderIds, (slice) =>
      admin.from('synced_order_ids').select('order_id, status').eq('user_id', ownerUserId).in('order_id', slice));
    if (syncErr) console.error('[member/shows/board] synced join error:', syncErr);
    else for (const s of synced ?? []) syncedStatusByOrderId.set(s.order_id as string, (s.status as string | null) ?? null);
  }

  // Net payout (revenue side) by order_id.
  const payoutByOrderId = new Map<string, { net_payout_cents: number | null; payout_settled: boolean }>();
  if (orderIds.length) {
    const { rows: payouts, error: poErr } = await inChunks<Record<string, unknown>>(orderIds, (slice) =>
      admin.from('order_payouts').select('order_id, net_payout_cents, settled').eq('user_id', ownerUserId).in('order_id', slice));
    if (poErr) console.error('[member/shows/board] payouts join error:', poErr);
    else for (const p of payouts ?? []) {
      payoutByOrderId.set(p.order_id as string, {
        net_payout_cents: (p.net_payout_cents as number | null) ?? null,
        payout_settled: !!p.settled,
      });
    }
  }

  // SKU lines — for units + labels ONLY. unit_cost_cents_snapshot is NOT selected (cost excluded).
  const itemIds = (items ?? []).map((i) => i.id);
  let skuRows: Record<string, unknown>[] = [];
  let warning: string | null = null;
  if (itemIds.length) {
    const { rows: skus, error: skuErr } = await inChunks<Record<string, unknown>>(itemIds, (slice) =>
      admin.from('live_auction_item_skus')
        .select('auction_item_id, inventory_sku_id, qty, sku_number_snapshot, title_snapshot')
        .in('auction_item_id', slice)
        .eq('user_id', ownerUserId));
    if (skuErr) {
      console.error('[member/shows/board] skus error (degrading, non-fatal):', skuErr);
      warning = 'Some line-item details (units) could not be loaded. Sale value is unaffected.';
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
    let units = 0;
    for (const s of skus) units += (s.qty as number) ?? 1;
    const capture = it.client_idempotency_key ? captureByOrderId.get(it.client_idempotency_key) ?? null : null;
    const payout = it.client_idempotency_key ? payoutByOrderId.get(it.client_idempotency_key) ?? null : null;
    return {
      id: it.id,
      order_id: it.client_idempotency_key ?? null,
      auction_number: it.sequence,
      status: it.status,
      is_bundle: it.is_bundle,
      sold_price_cents: it.sold_price_cents,
      won_price_cents: capture?.won_price_cents ?? null,
      tiktok_title: capture?.tiktok_title ?? null,
      seller_sku_hint: capture?.seller_sku_hint ?? null,
      payment_failed: capture?.payment_failed ?? false,
      order_status: capture?.order_status ?? null,
      synced_status: it.client_idempotency_key ? syncedStatusByOrderId.get(it.client_idempotency_key) ?? null : null,
      net_payout_cents: payout?.net_payout_cents ?? null,
      payout_settled: payout?.payout_settled ?? false,
      buyer_handle: it.buyer_handle,
      logged_at: it.closed_at ?? it.created_at,
      units,
      // NO total_cost_cents. skus carry qty + labels only, NO unit_cost_cents.
      skus: skus.map((s) => ({
        inventory_sku_id: s.inventory_sku_id,
        sku_number: s.sku_number_snapshot,
        title: s.title_snapshot,
        qty: s.qty,
      })),
    };
  });

  // Distinct internal SKUs sold in this show (labels only; inventory_skus.unit_cost is NOT selected).
  const soldSkuIds = [...new Set(skuRows.map((s) => String(s.inventory_sku_id)))];
  let sessionSkus: Array<{ id: string; sku_number: number | null; title: string | null; category: string | null; barcode: string | null }> = [];
  if (soldSkuIds.length) {
    const { rows: inv } = await inChunks<Record<string, unknown>>(soldSkuIds, (slice) =>
      admin.from('inventory_skus').select('id, sku_number, title, category, barcode').eq('user_id', ownerUserId).in('id', slice));
    sessionSkus = (inv ?? []).map((s) => ({
      id: String(s.id), sku_number: (s.sku_number as number | null) ?? null, title: (s.title as string | null) ?? null,
      category: (s.category as string | null) ?? null, barcode: (s.barcode as string | null) ?? null,
    })).sort((a, b) => (Number(a.sku_number) || 0) - (Number(b.sku_number) || 0));
  }
  const liveCategories = [...new Set(sessionSkus.map((s) => s.category).filter((c): c is string => !!c))];

  // Captured-but-unbound sales for THIS show (attribution BY ROOM). Store scope from synced_order_ids.
  const boundOrderIdSet = new Set(orderIds);
  const unboundRows: Array<Record<string, unknown>> = [];
  const room = (session.tiktok_live_id as string | null) ?? null;
  const startIso = ((session.started_at as string | null) ?? (session.created_at as string | null)) ?? null;
  const sessionStoreId = (session.store_id as string | null) ?? null;
  if (room && startIso) {
    const endIso = (session.ended_at as string | null) ?? new Date().toISOString();
    // PAGED and ORDERED — it was neither.
    const capsOrErr = await readAllPaged(
      (from, to) => admin.from('capture_events')
        .select('order_id, selling_price_cents, product_name, platform_sku_ref, buyer_username, is_payment_successful, ordered_at, created_at')
        .eq('user_id', ownerUserId).eq('room_id', room)
        .gte('ordered_at', startIso).lte('ordered_at', endIso)
        .order('ordered_at', { ascending: true })
        .range(from, to),
      'member/shows/board room captures',
    ).catch((e: unknown) => e as Error);

    if (capsOrErr instanceof Error) {
      console.error('[member/shows/board] unbound-capture union error:', capsOrErr);
    } else {
      const caps = capsOrErr;
      const capUnbound = (caps ?? []).filter((c) => {
        const oid = String(c.order_id ?? '');
        return oid && oid !== '0' && !boundOrderIdSet.has(oid) && c.is_payment_successful !== false;
      });
      const uoids = [...new Set(capUnbound.map((c) => String(c.order_id)))];
      const cancelled = new Set<string>();
      const storeOk = new Set<string>();
      for (let i = 0; i < uoids.length; i += 300) {
        const { data: so } = await admin.from('synced_order_ids')
          .select('order_id, status, store_id').eq('user_id', ownerUserId).in('order_id', uoids.slice(i, i + 300));
        for (const r of so ?? []) {
          const oid = String(r.order_id);
          if (String(r.status) === 'CANCELLED') cancelled.add(oid);
          if (!sessionStoreId || String(r.store_id) === String(sessionStoreId)) storeOk.add(oid);
        }
      }
      const seen = new Set<string>();
      for (const c of capUnbound) {
        const oid = String(c.order_id);
        if (seen.has(oid) || cancelled.has(oid)) continue;
        if (sessionStoreId && !storeOk.has(oid)) continue;
        seen.add(oid);
        unboundRows.push({
          id: `unbound:${oid}`, auction_number: 0, status: 'sold', is_bundle: false,
          sold_price_cents: null,
          won_price_cents: (c.selling_price_cents as number | null) ?? null,
          tiktok_title: (c.product_name as string | null) ?? null,
          payment_failed: false, order_status: null, net_payout_cents: null, payout_settled: false,
          buyer_handle: (c.buyer_username as string | null) ?? null,
          logged_at: (c.ordered_at as string | null) ?? (c.created_at as string | null) ?? '',
          units: 0, skus: [],
          unbound: true, order_id: oid, seller_sku_hint: (c.platform_sku_ref as string | null) ?? null,
        });
      }
    }
  }

  return NextResponse.json({ items: [...assembled, ...unboundRows], session_skus: sessionSkus, live_categories: liveCategories, warning });
}
