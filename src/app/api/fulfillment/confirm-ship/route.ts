import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { printLabel } from '@/lib/fulfillment/printLabel';

export const dynamic = 'force-dynamic';

// POST { fulfillmentOrderId } — packer's Confirm & Print.
// Transitions packing→shipped (which frees the cubicle: the partial unique index only
// covers assigned/packing), triggers the label (stub + fallback today), returns result.
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { fulfillmentOrderId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  const foId = typeof body.fulfillmentOrderId === 'string' ? body.fulfillmentOrderId : '';
  if (!foId) return NextResponse.json({ error: 'Missing fulfillmentOrderId' }, { status: 400 });

  const { data: box } = await supabase
    .from('fulfillment_orders').select('id, group_key, order_ids, status')
    .eq('id', foId).eq('owner_user_id', user.id).maybeSingle();
  if (!box) return NextResponse.json({ error: 'Box not found' }, { status: 404 });
  if (box.status !== 'packing' && box.status !== 'assigned') {
    return NextResponse.json({ error: 'NOT_PACKING', message: 'Box is not in a packable state', status: box.status }, { status: 409 });
  }

  const now = new Date().toISOString();
  const { error: uErr } = await supabase
    .from('fulfillment_orders')
    .update({ status: 'shipped', packed_at: now, shipped_at: now, cubicle_id: null }) // free the cubicle
    .eq('id', foId).eq('owner_user_id', user.id);
  if (uErr) return NextResponse.json({ error: 'Failed to ship', detail: uErr.message }, { status: 500 });

  const label = await printLabel({ group_key: box.group_key, order_ids: box.order_ids });

  return NextResponse.json({ ok: true, status: 'shipped', label });
}
