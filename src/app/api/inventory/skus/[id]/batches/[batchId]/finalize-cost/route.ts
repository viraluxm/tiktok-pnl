import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { parseFinalizeCost, mapBatchRpcError } from '@/lib/inventory/batchMutations';

export const dynamic = 'force-dynamic';

// POST: set this FIFO cost layer's TRUE unit cost, and carry it back through every sale
// the layer actually supplied.
//
// This is the ONE way an attributable layer's cost may change. lensed_edit_batch refuses a
// cost change on such a layer (COST_EDIT_REQUIRES_FINALIZE) precisely so there are not two
// paths where only this one also fixes history.
//
// Handles both directions of the same fact — "this layer's true unit cost is now X":
//   • pending -> final   (cost was never known; its sales snapshotted NULL)
//   • final   -> final   (a correction, e.g. $3.40 -> $3.55)
//
// Everything happens inside lensed_finalize_batch_cost: the per-SKU advisory lock, the
// batch write, the reprice of live_auction_item_skus rows whose source_batch_id matches,
// the SKU cost-scalar mirror, and the append-only audit row — one transaction, all or
// nothing. Quantities are never touched. We never write any of it from here.
export async function POST(req: Request, { params }: { params: Promise<{ id: string; batchId: string }> }) {
  const { id, batchId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { unit_cost_cents?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }

  const parsed = parseFinalizeCost(body?.unit_cost_cents);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const { data, error } = await supabase.rpc('lensed_finalize_batch_cost', {
    p_sku_id: id,
    p_batch_id: batchId,
    p_unit_cost_cents: parsed.value.unit_cost_cents,
  });
  if (error) {
    const mapped = mapBatchRpcError(error.message);
    if (mapped.status === 500) console.error('[inventory/batches] finalize-cost error:', error.code, error.message);
    return NextResponse.json({ error: mapped.error }, { status: mapped.status });
  }
  // The RPC's row carries what changed: lines/units repriced, the COGS delta, and whether
  // an audit revision was recorded (false on an exact replay).
  return NextResponse.json({ ok: true, result: Array.isArray(data) ? (data[0] ?? null) : data });
}
