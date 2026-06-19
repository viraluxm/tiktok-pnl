import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const RESULTS = new Set(['sold', 'not_sold', 'canceled', 'manual']);
const EXPECTED_MULTIPLIER = 3; // expected price = total cost x 3

type Line = { sku_id: string; qty: number };

// POST: log one auction (sold / not_sold / canceled / manual).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: sessionId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { result?: string; skus?: Line[]; client_idempotency_key?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 });
  }

  const result = typeof body.result === 'string' && RESULTS.has(body.result) ? body.result : null;
  if (!result) return NextResponse.json({ error: 'Invalid result' }, { status: 400 });

  const idemKey =
    typeof body.client_idempotency_key === 'string' && body.client_idempotency_key.trim()
      ? body.client_idempotency_key.trim()
      : null;

  // Collapse duplicate SKUs into one line with summed qty.
  const byId = new Map<string, number>();
  for (const l of body.skus ?? []) {
    if (!l || typeof l.sku_id !== 'string') continue;
    const qty = Math.max(1, Math.trunc(Number(l.qty) || 1));
    byId.set(l.sku_id, (byId.get(l.sku_id) ?? 0) + qty);
  }
  const lines: Line[] = [...byId.entries()].map(([sku_id, qty]) => ({ sku_id, qty }));
  if (lines.length === 0) return NextResponse.json({ error: 'Select at least one SKU' }, { status: 400 });

  // Idempotency replay (before any guard, so a genuine prior success always replays).
  if (idemKey) {
    const { data: existing } = await supabase
      .from('live_auction_items')
      .select('id, sequence, status')
      .eq('session_id', sessionId)
      .eq('user_id', user.id)
      .eq('client_idempotency_key', idemKey)
      .maybeSingle();
    if (existing) {
      return NextResponse.json(
        { ok: true, replayed: true, id: existing.id, auction_number: existing.sequence, status: existing.status },
        { status: 200 },
      );
    }
  }

  // Session must exist, be owned, and still be open.
  const { data: session } = await supabase
    .from('live_sessions')
    .select('id, status')
    .eq('id', sessionId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  if (session.status === 'ended' || session.status === 'reconciled') {
    return NextResponse.json({ error: 'This session has ended' }, { status: 409 });
  }

  // Validate SKUs belong to the user; gather cost/qty/snapshot fields.
  const { data: owned } = await supabase
    .from('inventory_skus')
    .select('id, sku_number, title, unit_cost_cents, qty_on_hand')
    .in('id', lines.map((l) => l.sku_id))
    .eq('user_id', user.id);
  const ownedById = new Map((owned ?? []).map((s) => [s.id, s]));
  if (ownedById.size !== lines.length) {
    return NextResponse.json({ error: 'One or more SKUs not found' }, { status: 400 });
  }

  // Stock guard (sold only).
  if (result === 'sold') {
    for (const l of lines) {
      const sku = ownedById.get(l.sku_id)!;
      const available = (sku.qty_on_hand as number | null) ?? 0;
      if (available < l.qty) {
        return NextResponse.json(
          { error: `SKU ${sku.sku_number} is out of stock (have ${available}, need ${l.qty})` },
          { status: 409 },
        );
      }
    }
  }

  // Total cost + expected price (expected omitted if any cost is missing).
  let totalCost: number | null = 0;
  for (const l of lines) {
    const cost = (ownedById.get(l.sku_id)!.unit_cost_cents as number | null) ?? null;
    if (cost == null) totalCost = null;
    else if (totalCost != null) totalCost += cost * l.qty;
  }
  const expectedPrice = totalCost == null ? null : totalCost * EXPECTED_MULTIPLIER;

  const nowIso = new Date().toISOString();
  const isBundle = lines.length > 1;

  // Allocate sequence = max+1, retrying on the (session_id, sequence) unique race;
  // an idem-key unique violation means a concurrent same-key request won -> replay it.
  let created: { id: string; sequence: number; status: string } | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: last } = await supabase
      .from('live_auction_items')
      .select('sequence')
      .eq('session_id', sessionId)
      .eq('user_id', user.id)
      .order('sequence', { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextSeq = ((last?.sequence as number | null) ?? 0) + 1;

    const { data, error } = await supabase
      .from('live_auction_items')
      .insert({
        user_id: user.id,
        session_id: sessionId,
        sequence: nextSeq,
        status: result,
        is_bundle: isBundle,
        expected_price_cents: expectedPrice,
        client_idempotency_key: idemKey,
        activated_at: nowIso,
        closed_at: nowIso,
      })
      .select('id, sequence, status')
      .single();

    if (!error) { created = data; break; }

    if (error.code === '23505') {
      const msg = `${error.message} ${error.details ?? ''}`.toLowerCase();
      if (idemKey && msg.includes('idem')) {
        const { data: existing } = await supabase
          .from('live_auction_items')
          .select('id, sequence, status')
          .eq('session_id', sessionId)
          .eq('user_id', user.id)
          .eq('client_idempotency_key', idemKey)
          .maybeSingle();
        if (existing) {
          return NextResponse.json(
            { ok: true, replayed: true, id: existing.id, auction_number: existing.sequence, status: existing.status },
            { status: 200 },
          );
        }
      }
      continue; // sequence race -> recompute and retry
    }
    console.error('[live/quick-close] insert error:', error);
    return NextResponse.json({ error: 'Failed to log auction' }, { status: 500 });
  }
  if (!created) return NextResponse.json({ error: 'Could not allocate an auction number, try again' }, { status: 500 });

  // SKU snapshot rows.
  const skuRows = lines.map((l) => {
    const sku = ownedById.get(l.sku_id)!;
    return {
      user_id: user.id,
      auction_item_id: created!.id,
      inventory_sku_id: l.sku_id,
      qty: l.qty,
      unit_cost_cents_snapshot: (sku.unit_cost_cents as number | null) ?? null,
      sku_number_snapshot: sku.sku_number as number,
      title_snapshot: sku.title as string,
    };
  });
  const { error: skuErr } = await supabase.from('live_auction_item_skus').insert(skuRows);
  if (skuErr) {
    console.error('[live/quick-close] sku insert error:', skuErr);
    return NextResponse.json({ error: 'Failed to save SKU lines' }, { status: 500 });
  }

  // Decrement inventory (sold only). Per-line, non-blocking; the stock guard above is the gate.
  if (result === 'sold') {
    for (const l of lines) {
      try {
        const current = (ownedById.get(l.sku_id)!.qty_on_hand as number | null) ?? 0;
        await supabase
          .from('inventory_skus')
          .update({ qty_on_hand: current - l.qty })
          .eq('id', l.sku_id)
          .eq('user_id', user.id);
      } catch (e) {
        console.error('[live/quick-close] decrement failed (non-blocking):', e);
      }
    }
  }

  return NextResponse.json(
    {
      ok: true,
      replayed: false,
      id: created.id,
      auction_number: created.sequence,
      status: created.status,
      total_cost_cents: totalCost,
      expected_price_cents: expectedPrice,
    },
    { status: 201 },
  );
}
