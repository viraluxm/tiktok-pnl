import { NextResponse } from 'next/server';
import { requireMemberScope } from '@/lib/station/guard';
import { flagReason, boundUnits, type AuditLine } from '@/lib/member/multibind';

export const dynamic = 'force-dynamic';

// POST /api/member/audit/keep — resolve ONE row of the squish over-bind queue: the member says
// which of the bound SKUs was the real item, and this collapses the order down to that one unit.
//
// HOW IT WORKS. Two existing, proven RPCs in sequence — no new stock arithmetic anywhere:
//   1. lensed_unbind_as   → restocks every bound line (fresh FIFO layer at its snapshot cost) and
//                           deletes the live_auction_items / _skus rows
//   2. lensed_log_auction_as → re-binds the kept SKU alone, qty 1, into the SAME session, with the
//                           order id as the idempotency key (p_manual: true — these sessions have
//                           ended)
// rpc-grants: lensed_unbind_as, lensed_log_auction_as
//
// NOT ATOMIC, AND THAT IS THE ONE THING TO KNOW. Two RPCs are two transactions. If step 2 fails,
// step 1 has already committed and the order is left UNBOUND — recoverable (it reappears in the
// binding queue, and its stock is back) but NOT silently: the response says so in those words and
// the failure is logged loudly. Both steps write bind_audit, so the trail shows exactly how far it
// got.
//
// WHY NOT DELETE THE EXTRA LINE INSTEAD. A "drop one line" write would be a brand-new stock path
// with its own FIFO restock logic, invented for this feature and exercised nowhere else. Reusing
// unbind+rebind means the money-moving code here is code that has already been running in prod.
//
// EVERY AUTHORIZATION CHECK RUNS BEFORE ANY WRITE, and the flag is re-verified from the DB — a
// client cannot talk this route into unbinding an order that was never over-bound.
export async function POST(req: Request) {
  const scope = await requireMemberScope('binding');
  if (!scope.ok) return scope.response;
  const { admin, ownerIds, storeIds, allStores, actorId } = scope;

  let body: { order_id?: unknown; item_id?: unknown; keep_sku_id?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }

  const orderId = typeof body.order_id === 'string' ? body.order_id.trim() : '';
  const itemId = typeof body.item_id === 'string' ? body.item_id.trim() : '';
  const keepSkuId = typeof body.keep_sku_id === 'string' ? body.keep_sku_id.trim() : '';
  if (!orderId || !itemId || !keepSkuId) {
    return NextResponse.json({ error: 'order_id, item_id and keep_sku_id required' }, { status: 400 });
  }

  // ── 1. The auction item must exist, match the order, and belong to one of the member's owners.
  //    item_id is required (not just order_id) so a stale queue row cannot correct a DIFFERENT
  //    bind than the one the member was looking at.
  const { data: item, error: itemErr } = await admin
    .from('live_auction_items')
    .select('id, user_id, session_id, store_id, status, client_idempotency_key')
    .eq('id', itemId)
    .eq('client_idempotency_key', orderId)
    .in('user_id', ownerIds)
    .maybeSingle();
  if (itemErr) return NextResponse.json({ error: itemErr.message }, { status: 500 });
  if (!item) {
    return NextResponse.json({ error: 'That bind no longer exists — refresh the queue' }, { status: 409 });
  }
  const ownerUserId = String(item.user_id);
  const sessionId = item.session_id ? String(item.session_id) : null;
  // No session → nothing to re-bind INTO, so refuse before unbinding rather than stranding the
  // order. (Not observed in prod; the column is populated on every flagged row.)
  if (!sessionId) {
    console.error('[member/audit/keep] item has no session_id — refusing order=%s item=%s', orderId, itemId);
    return NextResponse.json({ error: 'This bind has no live session — correct it from the show board' }, { status: 409 });
  }

  // ── 2. Store scope (skipped for an all-stores member). synced_order_ids.store_id FIRST: the
  //    item's own store_id is stamped at insert and never retro-filled, so it is often NULL.
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

  // ── 3. Read the REAL lines back and re-verify the flag. Never trust the client's view of it.
  const { data: lineRows, error: lineErr } = await admin
    .from('live_auction_item_skus')
    .select('inventory_sku_id, qty, unit_cost_cents_snapshot, sku_number_snapshot, title_snapshot')
    .eq('auction_item_id', itemId)
    .eq('user_id', ownerUserId);
  if (lineErr) return NextResponse.json({ error: lineErr.message }, { status: 500 });

  const skuIds = [...new Set((lineRows ?? []).map((l) => String(l.inventory_sku_id)))];
  const { data: skuRows, error: skuErr } = await admin
    .from('inventory_skus')
    .select('id, category')
    .in('id', skuIds);
  if (skuErr) return NextResponse.json({ error: skuErr.message }, { status: 500 });
  const categoryBySku = new Map((skuRows ?? []).map((s) => [String(s.id), (s.category as string | null) ?? null]));

  const lines: AuditLine[] = (lineRows ?? []).map((l) => ({
    sku_id: String(l.inventory_sku_id),
    sku_number: (l.sku_number_snapshot as number | null) ?? null,
    title: (l.title_snapshot as string | null) ?? null,
    qty: Number(l.qty) || 1,
    unit_cost_cents: (l.unit_cost_cents_snapshot as number | null) ?? null,
    category: categoryBySku.get(String(l.inventory_sku_id)) ?? null,
  }));

  const reason = flagReason(lines);
  if (reason) return NextResponse.json({ error: reason }, { status: 409 });

  // ── 4. The kept SKU must be one the order actually had bound. This route COLLAPSES an
  //    over-bind; it is not a general re-bind (that is /api/member/bind).
  if (!lines.some((l) => l.sku_id === keepSkuId)) {
    return NextResponse.json({ error: 'That SKU is not bound to this order' }, { status: 400 });
  }

  const unitsBefore = boundUnits(lines);
  const auditPayload = {
    reason: 'squish_multibind',
    units_before: unitsBefore,
    kept_sku_id: keepSkuId,
    lines: lines.map((l) => ({ sku_id: l.sku_id, sku_number: l.sku_number, qty: l.qty })),
  };

  // ── 5. UNBIND (restocks every line, deletes the item). Idempotent on the order key.
  const { data: unbindData, error: unbindErr } = await admin.rpc('lensed_unbind_as', {
    p_owner_user_id: ownerUserId,
    p_order_id: orderId,
  });
  if (unbindErr) {
    console.error('[member/audit/keep] unbind failed order=%s: %s %s', orderId, unbindErr.code, unbindErr.message);
    return NextResponse.json({ error: `Unbind failed: ${unbindErr.message}` }, { status: 500 });
  }
  const unbindRow = Array.isArray(unbindData) ? unbindData[0] : unbindData;
  if (!unbindRow?.unbound) {
    // The item vanished between step 1 and here — another member corrected it concurrently. Do NOT
    // bind: we would be re-binding on top of whatever they decided.
    return NextResponse.json({ error: 'Already corrected by someone else — refresh the queue' }, { status: 409 });
  }
  const { error: unbindAuditErr } = await admin.from('bind_audit').insert({
    order_id: orderId, owner_user_id: ownerUserId, actor_user_id: actorId,
    action: 'unbind', session_id: sessionId, skus: auditPayload,
  });
  if (unbindAuditErr) {
    console.error('[member/audit/keep] AUDIT INSERT FAILED (unbind DID commit) order=%s: %s', orderId, unbindAuditErr.message);
  }

  // ── 6. RE-BIND the kept SKU alone, qty 1.
  //    allow_negative starts FALSE. On OUT_OF_STOCK we retry with TRUE — and that is deliberate:
  //    step 5 restocks qty_on_hand always, but only adds a FIFO layer when the line's snapshot
  //    cost is known, so a null-cost line (2 of 1,200 in the live queue) can leave the FIFO draw
  //    with nothing to take. Refusing there would strand the order unbound to protect a number
  //    that was already drawn before we touched it. The retry records short_at_bind, which is the
  //    truth: that SKU has no stock.
  const pSkus = [{ sku_id: keepSkuId, qty: 1 }];
  const rebind = async (allowNegative: boolean) => admin.rpc('lensed_log_auction_as', {
    p_owner_user_id: ownerUserId,
    p_session_id: sessionId,
    p_result: 'sold',
    p_skus: pSkus,
    p_idem_key: orderId,
    p_manual: true,
    p_allow_negative: allowNegative,
  });

  let wentNegative = false;
  let { data: bindData, error: bindErr } = await rebind(false);
  if (bindErr && (bindErr.message || '').includes('OUT_OF_STOCK')) {
    console.warn('[member/audit/keep] rebind out of stock, retrying allow_negative order=%s sku=%s', orderId, keepSkuId);
    wentNegative = true;
    ({ data: bindData, error: bindErr } = await rebind(true));
  }
  if (bindErr) {
    // The unbind is COMMITTED. Say so plainly — the order is unbound, not lost.
    console.error('[member/audit/keep] REBIND FAILED AFTER UNBIND — order=%s is now UNBOUND: %s %s',
      orderId, bindErr.code, bindErr.message);
    return NextResponse.json({
      error: `Unbound the order, but re-binding failed: ${bindErr.message}. The order is now UNBOUND — bind it from the Binding queue.`,
      unbound: true,
      rebound: false,
      restocked_units: unbindRow?.restocked_units ?? 0,
    }, { status: 500 });
  }

  const bindRow = Array.isArray(bindData) ? bindData[0] : bindData;
  const { error: bindAuditErr } = await admin.from('bind_audit').insert({
    order_id: orderId, owner_user_id: ownerUserId, actor_user_id: actorId,
    action: 'bind', session_id: sessionId,
    skus: { ...auditPayload, lines: pSkus, allow_negative: wentNegative, replayed: bindRow?.replayed ?? false },
  });
  if (bindAuditErr) {
    console.error('[member/audit/keep] AUDIT INSERT FAILED (rebind DID commit) order=%s: %s', orderId, bindAuditErr.message);
  }

  return NextResponse.json({
    ok: true,
    order_id: orderId,
    kept_sku_id: keepSkuId,
    units_before: unitsBefore,
    restocked_units: unbindRow?.restocked_units ?? 0,
    allow_negative: wentNegative,
    audit_recorded: !unbindAuditErr && !bindAuditErr,
  });
}
