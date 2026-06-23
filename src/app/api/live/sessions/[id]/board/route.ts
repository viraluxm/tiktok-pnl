import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// GET the running auction log/board for a session.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Ownership: the session must belong to the caller.
  const { data: session } = await supabase
    .from('live_sessions')
    .select('id, status')
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
  const captureByOrderId = new Map<string, { won_price_cents: number | null; tiktok_title: string | null }>();
  if (orderIds.length) {
    const { data: captures, error: capErr } = await supabase
      .from('capture_events')
      .select('order_id, selling_price_cents, product_name')
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

  return NextResponse.json({ items: assembled });
}
