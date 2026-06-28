import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getOrgId } from '@/lib/org';

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

  let body: { fulfillmentOrderId?: string; cubicleBarcode?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  const foId = typeof body.fulfillmentOrderId === 'string' ? body.fulfillmentOrderId : '';
  const cubicleBarcode = typeof body.cubicleBarcode === 'string' ? body.cubicleBarcode.trim() : '';
  if (!foId || !cubicleBarcode) return NextResponse.json({ error: 'Missing fulfillmentOrderId or cubicleBarcode' }, { status: 400 });

  // Resolve cubicle (org-shared, active).
  const { data: cubicle } = await supabase
    .from('cubicles').select('id, cubicle_number')
    .eq('org_id', orgId).eq('cubicle_barcode', cubicleBarcode).eq('is_active', true)
    .maybeSingle();
  if (!cubicle) return NextResponse.json({ error: 'UNKNOWN_CUBICLE', message: 'Cubicle barcode not recognized' }, { status: 404 });

  // Box must be fully picked before assignment.
  const { data: box } = await supabase
    .from('fulfillment_orders').select('id, status').eq('id', foId).eq('owner_user_id', user.id).maybeSingle();
  if (!box) return NextResponse.json({ error: 'Box not found' }, { status: 404 });
  if (box.status !== 'fully_picked' && box.status !== 'assigned') {
    return NextResponse.json({ error: 'NOT_FULLY_PICKED', message: 'Scan all items before assigning a cubicle', status: box.status }, { status: 409 });
  }

  const { error: uErr } = await supabase
    .from('fulfillment_orders')
    .update({ cubicle_id: cubicle.id, status: 'assigned', assigned_at: new Date().toISOString() })
    .eq('id', foId).eq('owner_user_id', user.id);

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
