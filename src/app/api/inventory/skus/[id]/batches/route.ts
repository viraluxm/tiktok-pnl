import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// POST: append a genuine new purchased cost layer (qty @ unit cost) to a SKU.
// Wraps lensed_add_batch — newest sequence, bumps qty_on_hand in lockstep.
// This is NOT settle (which only zeroes a negative layer). Ownership is enforced
// inside the RPC via auth.uid() + per-user RLS.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { qty?: number; unit_cost_cents?: number | null };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }

  const qty = Math.trunc(Number(body.qty));
  if (!Number.isFinite(qty) || qty < 0) {
    return NextResponse.json({ error: 'qty must be a non-negative integer' }, { status: 400 });
  }
  const unitCost = body.unit_cost_cents == null || body.unit_cost_cents === undefined
    ? null
    : Math.trunc(Number(body.unit_cost_cents));
  if (unitCost != null && !Number.isFinite(unitCost)) {
    return NextResponse.json({ error: 'unit_cost_cents must be a number' }, { status: 400 });
  }

  const { data, error } = await supabase.rpc('lensed_add_batch', {
    p_sku_id: id, p_qty: qty, p_unit_cost_cents: unitCost,
  });
  if (error) {
    if ((error.message || '').includes('SKU_NOT_FOUND')) return NextResponse.json({ error: 'SKU not found' }, { status: 404 });
    console.error('[inventory/batches] add error:', error.code, error.message);
    return NextResponse.json({ error: 'Failed to add batch' }, { status: 500 });
  }
  return NextResponse.json({ ok: true, batch_id: data });
}
