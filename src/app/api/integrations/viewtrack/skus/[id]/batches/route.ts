import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertViewTrackAuth, IntegrationError } from '@/lib/integrations/viewtrack-auth';

export const dynamic = 'force-dynamic';

const MAX_UNIT_COST_CENTS = 100000; // $1,000/unit hard cap — no unbounded check.

// Endpoint B — land a ViewTrack shipment into Lensed as a new FIFO cost layer
// under an existing SKU (sku_id in the path, matching /api/inventory convention).
// Shared-secret + service-role. Idempotent on external_ref (same ref = one batch).
// Attribution + org resolution + SKU/org verification happen inside the RPC.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: skuId } = await params;

  let ctx;
  try {
    ctx = assertViewTrackAuth(req);
  } catch (e) {
    if (e instanceof IntegrationError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  let body: { qty?: unknown; unit_cost_cents?: unknown; external_ref?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 });
  }

  // qty > 0 integer (no zero-qty batches).
  const qty = Math.trunc(Number(body.qty));
  if (!Number.isFinite(qty) || qty <= 0) {
    return NextResponse.json({ error: 'qty must be a positive integer' }, { status: 400 });
  }

  // unit_cost_cents required, integer, 0..100000.
  const unitCost = Math.trunc(Number(body.unit_cost_cents));
  if (
    body.unit_cost_cents == null ||
    !Number.isFinite(unitCost) ||
    unitCost < 0 ||
    unitCost > MAX_UNIT_COST_CENTS
  ) {
    return NextResponse.json(
      { error: `unit_cost_cents must be an integer between 0 and ${MAX_UNIT_COST_CENTS}` },
      { status: 400 },
    );
  }

  // external_ref required (the idempotency key; ViewTrack shipment-line id).
  const externalRef = typeof body.external_ref === 'string' ? body.external_ref.trim() : '';
  if (!externalRef) {
    return NextResponse.json({ error: 'external_ref is required' }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc('lensed_add_batch_admin', {
    p_org_id: ctx.orgId,
    p_sku_id: skuId,
    p_qty: qty,
    p_unit_cost_cents: unitCost,
    p_external_ref: externalRef,
    p_system_user_id: ctx.systemUserId,
  });

  if (error) {
    const msg = error.message || '';
    if (msg.includes('SKU_NOT_FOUND')) return NextResponse.json({ error: 'SKU not found in org' }, { status: 404 });
    if (msg.includes('INVALID_QTY')) return NextResponse.json({ error: 'qty must be a positive integer' }, { status: 400 });
    if (msg.includes('INVALID_COST')) return NextResponse.json({ error: 'unit_cost_cents out of range' }, { status: 400 });
    console.error('[integrations/viewtrack/batches] add error:', error.code, msg);
    return NextResponse.json({ error: 'Failed to add batch' }, { status: 500 });
  }

  // RPC returns a single row (SETOF).
  const row = Array.isArray(data) ? data[0] : data;
  return NextResponse.json({
    ok: true,
    batch_id: row?.batch_id ?? null,
    sku_id: skuId,
    qty_on_hand: row?.qty_on_hand ?? null,
    replayed: row?.replayed ?? false,
  });
}
