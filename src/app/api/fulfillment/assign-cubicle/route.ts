import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getOrgId } from '@/lib/org';
import { resolveActor } from '@/lib/fulfillment/resolveActor';

export const dynamic = 'force-dynamic';

// POST { fulfillmentOrderId, cubicleBarcode } — assign a fully-picked box to a cubicle.
//
// The DB partial unique index (uniq_cubicle_active) enforces "one active box per
// cubicle" across BOTH operators. On collision (23505) we return CUBICLE_TAKEN with
// ONLY the cubicle_number (from the org-shared cubicles table) — never the occupying
// order's details, so nothing leaks across operators under RLS.
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const orgId = await getOrgId(supabase, user.id);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  let body: { fulfillmentOrderId?: string; cubicleBarcode?: string; override?: boolean; workerId?: string; shiftId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  const foId = typeof body.fulfillmentOrderId === 'string' ? body.fulfillmentOrderId : '';
  const cubicleBarcode = typeof body.cubicleBarcode === 'string' ? body.cubicleBarcode.trim() : '';
  const override = body.override === true;
  if (!foId || !cubicleBarcode) return NextResponse.json({ error: 'Missing fulfillmentOrderId or cubicleBarcode' }, { status: 400 });

  // Attribution actor (chunk 5): who completed the pick. Stamp if supplied, else no-op.
  const actor = await resolveActor(supabase, orgId, body.workerId, body.shiftId);
  if (!actor.ok) return NextResponse.json({ error: 'INVALID_ACTOR', message: actor.error }, { status: 400 });

  // Resolve cubicle (org-shared, active).
  const { data: cubicle } = await supabase
    .from('cubicles').select('id, cubicle_number')
    .eq('org_id', orgId).eq('cubicle_barcode', cubicleBarcode).eq('is_active', true)
    .maybeSingle();
  if (!cubicle) return NextResponse.json({ error: 'UNKNOWN_CUBICLE', message: 'Cubicle barcode not recognized' }, { status: 404 });

  // Box must be fully picked before assignment (org RLS scopes visibility).
  const { data: box } = await supabase
    .from('fulfillment_orders').select('id, status, missing_order_ids').eq('id', foId).maybeSingle();
  if (!box) return NextResponse.json({ error: 'Box not found' }, { status: 404 });
  if (box.status !== 'fully_picked' && box.status !== 'assigned') {
    return NextResponse.json({ error: 'NOT_FULLY_PICKED', message: 'Scan all items before assigning a cubicle', status: box.status }, { status: 409 });
  }
  // BLOCK COMPLETION while unbound orders remain — prevents a silent under-ship.
  // Requires a deliberate override to proceed.
  const unbound = (box.missing_order_ids as string[]) ?? [];
  if (unbound.length > 0 && !override) {
    return NextResponse.json({
      error: 'UNBOUND_PRESENT',
      unbound_count: unbound.length,
      message: `${unbound.length} order(s) in this box have no scanned SKUs — bind them first, or override to assign anyway.`,
    }, { status: 409 });
  }

  const patch: Record<string, unknown> = { cubicle_id: cubicle.id, status: 'assigned', assigned_at: new Date().toISOString() };
  if (actor.workerId) { patch.picked_by = actor.workerId; patch.picked_via_shift = actor.shiftId; } // who completed the pick
  const { error: uErr } = await supabase
    .from('fulfillment_orders')
    .update(patch)
    .eq('id', foId);

  if (uErr) {
    // 23505 = the cross-operator partial unique index → cubicle already holds an active box.
    if (uErr.code === '23505') {
      return NextResponse.json(
        { error: 'CUBICLE_TAKEN', message: `Cubicle ${cubicle.cubicle_number} is taken — scan a free cubicle`, cubicle_number: cubicle.cubicle_number },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: 'Failed to assign cubicle', detail: uErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, cubicle_number: cubicle.cubicle_number, status: 'assigned' });
}
