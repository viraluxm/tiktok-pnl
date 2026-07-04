import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getOrgId } from '@/lib/org';
import { resolveActor } from '@/lib/fulfillment/resolveActor';

export const dynamic = 'force-dynamic';

// POST { fulfillmentOrderId, workerId?, shiftId? } — slip-scan "Done / Staged".
//
// Bulk-marks the whole box picked and stamps attribution on every line, mirroring the exact
// fields scan-section stamps (picked / picked_qty / picked_at / picked_by / picked_via_shift) so
// KPIs keep working identically. Sets order status 'fully_picked' — TERMINAL in the slip-scan
// model: no cubicle, no pack station; the shipper grabs the staged rack item (slip + label
// already attached). Attribution is org-scoped via resolveActor (shift → worker).
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

  // Attribution actor (chunk 5): validated shift → worker. Stamped when supplied (always, in Pure A).
  const actor = await resolveActor(supabase, orgId, body.workerId, body.shiftId);
  if (!actor.ok) return NextResponse.json({ error: 'INVALID_ACTOR', message: actor.error }, { status: 400 });

  const { data: lines } = await supabase
    .from('fulfillment_lines').select('id, required_qty').eq('fulfillment_order_id', foId);
  if (!lines || lines.length === 0) return NextResponse.json({ error: 'No lines on this box' }, { status: 404 });

  const now = new Date().toISOString();
  // Bulk-stamp each line picked (per-line required_qty), mirroring scan-section:70-76.
  const results = await Promise.all(lines.map((l) => {
    const patch: Record<string, unknown> = { picked: true, picked_qty: l.required_qty, picked_at: now };
    if (actor.workerId) { patch.picked_by = actor.workerId; patch.picked_via_shift = actor.shiftId; }
    return supabase.from('fulfillment_lines').update(patch).eq('id', l.id);
  }));
  const failed = results.find((r) => r.error);
  if (failed?.error) return NextResponse.json({ error: 'Failed to stamp lines', detail: failed.error.message }, { status: 500 });

  await supabase.from('fulfillment_orders').update({ status: 'fully_picked' }).eq('id', foId);
  return NextResponse.json({ ok: true, status: 'fully_picked', lines_completed: lines.length });
}
