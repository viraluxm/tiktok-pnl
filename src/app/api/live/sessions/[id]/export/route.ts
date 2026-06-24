import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// CSV column order for the per-SKU-line show export.
const COLS = ['order_id', 'buyer', 'sku_number', 'title', 'quantity', 'won_price', 'cost', 'profit', 'status', 'bound_status'] as const;
const cell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const dollars = (c: number | null) => (c == null ? '' : (c / 100).toFixed(2));

// GET: one CSV per show. Scope = ALL captured wins for the session — bound
// auction items expanded to one row per SKU line, PLUS unbound captured wins
// (in capture_events but with no live_auction_items row) marked UNBOUND.
// Read-only; no count/binding logic touched.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: session } = await supabase
    .from('live_sessions')
    .select('id, title, started_at, ended_at')
    .eq('id', id).eq('user_id', user.id).maybeSingle();
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });

  // Bound auction items for this session.
  const { data: items } = await supabase
    .from('live_auction_items')
    .select('id, client_idempotency_key, status, sequence')
    .eq('user_id', user.id).eq('session_id', id).order('sequence', { ascending: true });
  const itemRows = items ?? [];
  const itemIds = itemRows.map((i) => i.id);

  // SKU lines for those items.
  let lines: Record<string, unknown>[] = [];
  if (itemIds.length) {
    const { data } = await supabase
      .from('live_auction_item_skus')
      .select('auction_item_id, inventory_sku_id, qty, unit_cost_cents_snapshot')
      .eq('user_id', user.id).in('auction_item_id', itemIds);
    lines = data ?? [];
  }

  // Live inventory title/number per SKU.
  const skuIds = [...new Set(lines.map((l) => String(l.inventory_sku_id)))];
  const inv: Record<string, { n: number; t: string }> = {};
  if (skuIds.length) {
    const { data } = await supabase
      .from('inventory_skus').select('id, sku_number, title')
      .eq('user_id', user.id).in('id', skuIds);
    for (const s of data ?? []) inv[String(s.id)] = { n: s.sku_number as number, t: (s.title as string) || '' };
  }

  // Capture window = this session's lifetime (open session → through now).
  let capQ = supabase
    .from('capture_events')
    .select('order_id, buyer_username, selling_price_cents, is_payment_successful')
    .eq('user_id', user.id)
    .gte('created_at', session.started_at);
  if (session.ended_at) capQ = capQ.lte('created_at', session.ended_at);
  const { data: caps } = await capQ;
  const capByOrder = new Map<string, Record<string, unknown>>();
  for (const c of caps ?? []) { const k = String(c.order_id); if (!capByOrder.has(k)) capByOrder.set(k, c); }

  const linesByItem = new Map<string, Record<string, unknown>[]>();
  for (const l of lines) {
    const k = String(l.auction_item_id);
    const arr = linesByItem.get(k);
    if (arr) arr.push(l); else linesByItem.set(k, [l]);
  }

  const out: Record<string, string | number>[] = [];
  const boundOrders = new Set<string>();

  // BOUND: one row per SKU line. won_price/profit on the first line of each
  // order only (so bundles don't double-count the order total).
  for (const it of itemRows) {
    const order = String(it.client_idempotency_key ?? '');
    if (order) boundOrders.add(order);
    const cap = capByOrder.get(order);
    const buyer = (cap?.buyer_username as string) ?? '';
    const wonC = cap ? (cap.selling_price_cents as number | null) : null;
    const ls = linesByItem.get(it.id) ?? [];
    const orderCostC = ls.reduce((a, l) => a + ((Number(l.unit_cost_cents_snapshot) || 0) * (Number(l.qty) || 1)), 0);
    ls.forEach((l, idx) => {
      const snap = l.unit_cost_cents_snapshot as number | null;
      const qty = Number(l.qty) || 1;
      const first = idx === 0;
      out.push({
        order_id: order, buyer,
        sku_number: inv[String(l.inventory_sku_id)]?.n ?? '',
        title: inv[String(l.inventory_sku_id)]?.t ?? '',
        quantity: qty,
        won_price: first ? dollars(wonC) : '',
        cost: dollars(snap == null ? null : snap * qty),
        profit: (first && it.status === 'sold' && wonC != null) ? ((wonC - orderCostC) / 100).toFixed(2) : '',
        status: it.status as string,
        bound_status: 'BOUND',
      });
    });
  }

  // UNBOUND: captured wins with no auction item, excluding the junk order_id '0'.
  const seen = new Set<string>();
  for (const c of caps ?? []) {
    const order = String(c.order_id);
    if (!order || order === '0' || seen.has(order) || boundOrders.has(order)) continue;
    seen.add(order);
    out.push({
      order_id: order, buyer: (c.buyer_username as string) ?? '',
      sku_number: '', title: '', quantity: '',
      won_price: dollars(c.selling_price_cents as number | null), cost: '', profit: '',
      status: c.is_payment_successful === false ? 'not_sold' : 'sold', bound_status: 'UNBOUND',
    });
  }

  const csv = [COLS.join(','), ...out.map((r) => COLS.map((k) => cell(r[k])).join(','))].join('\n');
  return NextResponse.json({ title: session.title, started_at: session.started_at, csv, row_count: out.length });
}
