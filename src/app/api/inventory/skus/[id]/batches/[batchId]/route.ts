import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { parseBatchEdit, mapBatchRpcError } from '@/lib/inventory/batchMutations';

export const dynamic = 'force-dynamic';

// PATCH: edit ONE FIFO cost layer's remaining quantity and/or unit cost.
// Wraps lensed_edit_batch (security invoker): org-scoped, SKU-advisory-locked, keeps
// inventory_skus.qty_on_hand in lockstep with the qty delta, and NEVER touches a
// recorded sale's unit_cost_cents_snapshot — a cost change re-prices future sales
// only. All rules are enforced in the RPC; we never write sku_batches directly.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; batchId: string }> }) {
  const { id, batchId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { qty_remaining?: unknown; unit_cost_cents?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }

  // Distinguish an EXPLICIT unit_cost_cents (even null/blank ⇒ set cost to unknown)
  // from an OMITTED field (leave the existing cost untouched). Only a present key
  // sets the cost, so a qty-only request can never accidentally clear a cost.
  const costProvided =
    !!body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'unit_cost_cents');

  const parsed = parseBatchEdit({ qty_remaining: body.qty_remaining, unit_cost_cents: body.unit_cost_cents }, costProvided);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const { data, error } = await supabase.rpc('lensed_edit_batch', {
    p_sku_id: id,
    p_batch_id: batchId,
    p_qty_remaining: parsed.value.qty_remaining,
    p_unit_cost_cents: parsed.value.unit_cost_cents,
    p_set_cost: parsed.value.set_cost,
  });
  if (error) {
    const mapped = mapBatchRpcError(error.message);
    if (mapped.status === 500) console.error('[inventory/batches] edit error:', error.code, error.message);
    return NextResponse.json({ error: mapped.error }, { status: mapped.status });
  }
  return NextResponse.json({ ok: true, batch: Array.isArray(data) ? (data[0] ?? null) : data });
}

// DELETE: physically remove ONE untouched cost layer. Wraps lensed_delete_batch
// (security invoker): allowed only when the layer has a known original qty
// (qty_added IS NOT NULL), is unconsumed (qty_remaining = qty_added), and is not the
// SKU's last layer; it subtracts the removed qty_remaining from qty_on_hand under the
// SKU lock. Legacy/consumed layers → 409 BATCH_NOT_DELETABLE; last layer → 409.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; batchId: string }> }) {
  const { id, batchId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabase.rpc('lensed_delete_batch', {
    p_sku_id: id,
    p_batch_id: batchId,
  });
  if (error) {
    const mapped = mapBatchRpcError(error.message);
    if (mapped.status === 500) console.error('[inventory/batches] delete error:', error.code, error.message);
    return NextResponse.json({ error: mapped.error }, { status: mapped.status });
  }
  return NextResponse.json({ ok: true, deleted: Array.isArray(data) ? (data[0] ?? null) : data });
}
