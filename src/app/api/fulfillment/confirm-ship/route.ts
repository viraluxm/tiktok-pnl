import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getOrgId } from '@/lib/org';
import { resolveActor } from '@/lib/fulfillment/resolveActor';

export const dynamic = 'force-dynamic';

// POST { fulfillmentOrderId } — packer's Confirm & hand-off.
// The label already printed at cubicle-scan (pack-load); this just transitions
// packing→shipped (frees the cubicle — the partial unique index only covers
// assigned/packing) and records the ship. ORG-SCOPED. STUB: no real ship API.
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const orgId = await getOrgId(supabase, user.id);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  let body: { fulfillmentOrderId?: string; workerId?: string; shiftId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  const foId = typeof body.fulfillmentOrderId === 'string' ? body.fulfillmentOrderId : '';
  if (!foId) return NextResponse.json({ error: 'Missing fulfillmentOrderId' }, { status: 400 });

  // Attribution actor (chunk 5): who packed / handed off. Stamp if supplied, else no-op.
  const actor = await resolveActor(supabase, orgId, body.workerId, body.shiftId);
  if (!actor.ok) return NextResponse.json({ error: 'INVALID_ACTOR', message: actor.error }, { status: 400 });

  const { data: box } = await supabase
    .from('fulfillment_orders').select('id, group_key, order_ids, status')
    .eq('id', foId).maybeSingle(); // org RLS scopes visibility
  if (!box) return NextResponse.json({ error: 'Box not found' }, { status: 404 });
  if (box.status !== 'packing' && box.status !== 'assigned') {
    return NextResponse.json({ error: 'NOT_PACKING', message: 'Box is not in a packable state', status: box.status }, { status: 409 });
  }

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { status: 'shipped', packed_at: now, shipped_at: now, cubicle_id: null }; // free the cubicle
  if (actor.workerId) { patch.packed_by = actor.workerId; patch.packed_via_shift = actor.shiftId; } // who packed / handed off
  const { error: uErr } = await supabase
    .from('fulfillment_orders')
    .update(patch)
    .eq('id', foId);
  if (uErr) return NextResponse.json({ error: 'Failed to ship', detail: uErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, status: 'shipped' });
}
