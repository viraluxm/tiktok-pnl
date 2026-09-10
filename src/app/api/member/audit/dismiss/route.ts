import { NextResponse } from 'next/server';
import { requireMemberScope } from '@/lib/station/guard';
import { boundUnits, dismissVerdict } from '@/lib/member/multibind';

export const dynamic = 'force-dynamic';

// POST /api/member/audit/dismiss — "this multi-unit squish order is NOT an error, stop showing it".
//
// WHY THIS EXISTS. Without it the queue can never empty. A mis-tagged SKU, or a genuine two-piece
// squish deal, would resurface every day forever and the team would learn to scroll past the whole
// screen. A dismissal has to stick.
//
// IT IS SCOPED TO THE ITEM, NOT THE ORDER. The decision row carries item_id, and the queue read
// excludes an order only when a decision matches its CURRENT live_auction_items row. A correction
// deletes that row, so a later re-bind that is over-bound again comes back into the queue under a
// fresh item_id instead of being hidden by an old verdict.
//
// NO STOCK MOVES HERE. This writes one row and nothing else.
export async function POST(req: Request) {
  const scope = await requireMemberScope('binding');
  if (!scope.ok) return scope.response;
  const { admin, ownerIds, storeIds, allStores, actorId } = scope;

  let body: { order_id?: unknown; item_id?: unknown; note?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }

  const orderId = typeof body.order_id === 'string' ? body.order_id.trim() : '';
  const itemId = typeof body.item_id === 'string' ? body.item_id.trim() : '';
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : null;
  if (!orderId || !itemId) return NextResponse.json({ error: 'order_id and item_id required' }, { status: 400 });

  // The item must exist, match the order, and belong to one of the member's owners.
  const { data: item, error: itemErr } = await admin
    .from('live_auction_items')
    .select('id, user_id, store_id')
    .eq('id', itemId)
    .eq('client_idempotency_key', orderId)
    .in('user_id', ownerIds)
    .maybeSingle();
  if (itemErr) return NextResponse.json({ error: itemErr.message }, { status: 500 });
  if (!item) return NextResponse.json({ error: 'That bind no longer exists — refresh the queue' }, { status: 409 });
  const ownerUserId = String(item.user_id);

  // Store scope (skipped for an all-stores member) — synced store first, item store as fallback.
  if (!allStores) {
    const { data: soi, error: soiErr } = await admin
      .from('synced_order_ids')
      .select('store_id')
      .eq('order_id', orderId)
      .eq('user_id', ownerUserId)
      .maybeSingle();
    if (soiErr) return NextResponse.json({ error: soiErr.message }, { status: 500 });
    const store = (soi?.store_id as string | null) ?? (item.store_id ? String(item.store_id) : null);
    if (!store || !storeIds.includes(store)) {
      return NextResponse.json({ error: 'Order not in your scope' }, { status: 403 });
    }
  }

  // Record what they actually saw (units at decision time), for the trail.
  const { data: lineRows, error: lineErr } = await admin
    .from('live_auction_item_skus')
    .select('qty')
    .eq('auction_item_id', itemId)
    .eq('user_id', ownerUserId);
  if (lineErr) return NextResponse.json({ error: lineErr.message }, { status: 500 });
  const units = boundUnits((lineRows ?? []).map((l) => ({ qty: Number(l.qty) || 1 })));

  // ── Which dismissal is this? DERIVED HERE, never taken from the client (migration 141).
  //    keep_multi = the order is legitimate. too_late = it WAS an over-bind but the units are
  //    already committed. The page's row is a snapshot and a box can be packed between render and
  //    click, so the server re-reads the two facts the verdict depends on and the later fact wins.
  const { data: sv, error: svErr } = await admin
    .from('shipment_verifications')
    .select('id')
    .eq('user_id', ownerUserId)
    .contains('order_ids', [orderId])
    .limit(1);
  if (svErr) return NextResponse.json({ error: svErr.message }, { status: 500 });

  const { data: statusRow, error: statusErr } = await admin
    .from('synced_order_ids')
    .select('status')
    .eq('order_id', orderId)
    .eq('user_id', ownerUserId)
    .maybeSingle();
  if (statusErr) return NextResponse.json({ error: statusErr.message }, { status: 500 });

  const decision = dismissVerdict({
    packVerified: (sv ?? []).length > 0,
    status: (statusRow?.status as string | null) ?? null,
  });

  // Idempotent: uq_bind_review_decisions_order_item makes a double-click a no-op, not a 409.
  const { error } = await admin
    .from('bind_review_decisions')
    .upsert({
      order_id: orderId,
      item_id: itemId,
      owner_user_id: ownerUserId,
      actor_user_id: actorId,
      decision,
      units,
      note,
    }, { onConflict: 'order_id,item_id', ignoreDuplicates: true });
  if (error) {
    console.error('[member/audit/dismiss] insert failed order=%s: %s', orderId, error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, order_id: orderId, item_id: itemId, units, decision });
}
