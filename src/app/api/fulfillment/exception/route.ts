import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// POST { fulfillmentOrderId, action, reason? } — exception escape hatch (#9 minimal).
//
// Defined transitions (so 'exception' is never orphaned):
//   flag            : picking|fully_picked|assigned|packing → exception
//                     (frees any held cubicle so a missing/damaged item can't trap it)
//   resolve_requeue : exception → unpicked  (back to the active queue to retry)
//   resolve_ship    : exception → shipped   (manual resolution / shipped off-system)
type Action = 'flag' | 'resolve_requeue' | 'resolve_ship';
const FROM: Record<Action, string[]> = {
  flag: ['picking', 'fully_picked', 'assigned', 'packing', 'unpicked'],
  resolve_requeue: ['exception'],
  resolve_ship: ['exception'],
};

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { fulfillmentOrderId?: string; action?: Action; reason?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  const foId = typeof body.fulfillmentOrderId === 'string' ? body.fulfillmentOrderId : '';
  const action = body.action as Action;
  if (!foId || !FROM[action]) return NextResponse.json({ error: 'Missing fulfillmentOrderId or valid action' }, { status: 400 });

  const { data: box } = await supabase
    .from('fulfillment_orders').select('id, status').eq('id', foId).eq('owner_user_id', user.id).maybeSingle();
  if (!box) return NextResponse.json({ error: 'Box not found' }, { status: 404 });
  if (!FROM[action].includes(box.status)) {
    return NextResponse.json({ error: 'ILLEGAL_TRANSITION', message: `Cannot ${action} from ${box.status}`, status: box.status }, { status: 409 });
  }

  const patch: Record<string, unknown> =
    action === 'flag'
      ? { status: 'exception', exception_reason: (body.reason || 'flagged').slice(0, 500), cubicle_id: null } // free cubicle
      : action === 'resolve_requeue'
        ? { status: 'unpicked', exception_reason: null }
        : { status: 'shipped', shipped_at: new Date().toISOString(), exception_reason: null };

  const { error: uErr } = await supabase
    .from('fulfillment_orders').update(patch).eq('id', foId).eq('owner_user_id', user.id);
  if (uErr) return NextResponse.json({ error: 'Failed to update', detail: uErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, status: patch.status });
}
