import { NextResponse } from 'next/server';
import { requireMemberScope } from '@/lib/station/guard';

export const dynamic = 'force-dynamic';

// POST /api/member/bind — a member (service-role, owner-scoped) retroactively binds an internal SKU
// to an unbound captured order. Mirrors src/app/api/live/sessions/[id]/bind/route.ts, but the owner
// is resolved from the data (never the caller) and the write goes through lensed_log_auction_as
// (the service-role variant that takes the owner explicitly — the plain RPC reads auth.uid(), which
// is NULL under service_role). Gated on requireMemberScope('binding').
export async function POST(req: Request) {
  const scope = await requireMemberScope('binding');
  if (!scope.ok) return scope.response;
  const { admin, ownerIds, storeIds, allStores, actorId } = scope;

  let body: { order_id?: unknown; session_id?: unknown; lines?: unknown; allow_negative?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }

  const orderId = typeof body.order_id === 'string' ? body.order_id.trim() : '';
  const sessionId = typeof body.session_id === 'string' ? body.session_id.trim() : '';
  const allowNegative = body.allow_negative === true;

  // Collapse duplicate SKU lines (sum qty) — one line per distinct SKU, matching the RPC's p_skus.
  const rawLines = Array.isArray(body.lines) ? (body.lines as { sku_id?: unknown; qty?: unknown }[]) : [];
  const byId = new Map<string, number>();
  for (const l of rawLines) {
    const sid = typeof l?.sku_id === 'string' ? l.sku_id.trim() : '';
    if (!sid) continue;
    byId.set(sid, (byId.get(sid) ?? 0) + Math.max(1, Math.trunc(Number(l?.qty) || 1)));
  }
  const pSkus = [...byId.entries()].map(([sku_id, qty]) => ({ sku_id, qty }));
  if (!orderId || !sessionId || pSkus.length === 0) {
    return NextResponse.json({ error: 'order_id, session_id and at least one SKU line required' }, { status: 400 });
  }

  const ownerSet = new Set(ownerIds);
  const storeSet = new Set(storeIds);

  // ── Authorization — ALL must pass before any write. A member must not be able to bind into a
  //    session or SKU they weren't granted. ──

  // 1) The captured order must belong to one of the member's owners. Its user_id IS the owner we
  //    will bind as (the RPC keys the idem row + session on this same user_id).
  const { data: cap, error: capErr } = await admin
    .from('capture_events')
    .select('user_id')
    .eq('order_id', orderId)
    .in('user_id', ownerIds)
    .limit(1)
    .maybeSingle();
  if (capErr) return NextResponse.json({ error: capErr.message }, { status: 500 });
  const ownerUserId = cap?.user_id ? String(cap.user_id) : null;
  if (!ownerUserId || !ownerSet.has(ownerUserId)) {
    return NextResponse.json({ error: 'Order not found in your scope' }, { status: 403 });
  }

  // 2) The session must belong to the SAME owner (so lensed_log_auction_as's (id, user_id) lookup
  //    succeeds) AND to a store the member holds (skipped for an all-stores member).
  const { data: sess, error: sessErr } = await admin
    .from('live_sessions')
    .select('id, user_id, store_id')
    .eq('id', sessionId)
    .maybeSingle();
  if (sessErr) return NextResponse.json({ error: sessErr.message }, { status: 500 });
  if (!sess || String(sess.user_id) !== ownerUserId) {
    return NextResponse.json({ error: 'Session not in your scope' }, { status: 403 });
  }
  if (!allStores) {
    const sStore = sess.store_id ? String(sess.store_id) : null;
    if (!sStore || !storeSet.has(sStore)) {
      return NextResponse.json({ error: 'Session not in your scope' }, { status: 403 });
    }
  }

  // 3) Every SKU must belong to the owner's org. Resolve the owner's org the same way
  //    lensed_log_auction_as does, then confirm each sku_id is in that org's inventory.
  const { data: orgRow, error: orgErr } = await admin
    .from('organization_members')
    .select('org_id')
    .eq('user_id', ownerUserId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (orgErr) return NextResponse.json({ error: orgErr.message }, { status: 500 });
  const orgId = orgRow?.org_id ? String(orgRow.org_id) : null;
  if (!orgId) {
    // Owner has no org → the RPC would raise NO_ORG. Surface it as an owner-resolution fault (500).
    console.error('[member/bind] owner has no org — owner resolution wrong, owner=%s', ownerUserId);
    return NextResponse.json({ error: 'Owner resolution failed (no org)' }, { status: 500 });
  }
  const skuIds = pSkus.map((s) => s.sku_id);
  const { data: okSkus, error: skuErr } = await admin
    .from('inventory_skus')
    .select('id')
    .eq('org_id', orgId)
    .in('id', skuIds);
  if (skuErr) return NextResponse.json({ error: skuErr.message }, { status: 500 });
  const okSet = new Set((okSkus ?? []).map((r) => String(r.id)));
  const missing = skuIds.filter((id) => !okSet.has(id));
  if (missing.length) {
    return NextResponse.json({ error: `SKU not in the owner's inventory: ${missing.join(', ')}` }, { status: 400 });
  }

  // ── Bind. p_owner_user_id = the resolved owner (NOT the caller); p_manual = true (retroactive
  //    binds hit ended/reconciled sessions). Always destructure error. ──
  const { data, error } = await admin.rpc('lensed_log_auction_as', {
    p_owner_user_id: ownerUserId,
    p_session_id: sessionId,
    p_result: 'sold',
    p_skus: pSkus,
    p_idem_key: orderId,
    p_manual: true,
    p_allow_negative: allowNegative,
  });
  if (error) {
    const msg = error.message || '';
    if (msg.includes('OUT_OF_STOCK')) return NextResponse.json({ error: 'Out of stock for that SKU' }, { status: 409 });
    if (msg.includes('SESSION_ENDED')) return NextResponse.json({ error: 'Session ended — manual bind not permitted' }, { status: 409 });
    if (msg.includes('SKU_NOT_FOUND')) return NextResponse.json({ error: 'SKU not found' }, { status: 400 });
    // NO_ORG / NOT_AUTHENTICATED here mean p_owner_user_id resolution is wrong — NOT a client error.
    if (msg.includes('NO_ORG') || msg.includes('NOT_AUTHENTICATED')) {
      console.error('[member/bind] owner-resolution RPC fault:', error.code, msg);
      return NextResponse.json({ error: 'Owner resolution failed' }, { status: 500 });
    }
    console.error('[member/bind] rpc error:', error.code, msg);
    return NextResponse.json({ error: 'Failed to bind' }, { status: 500 });
  }
  const row = Array.isArray(data) ? data[0] : data;
  // replayed=true → the RPC was a no-op (the row already existed). We still audit it, but distinctly
  // from a real bind: the flag rides in the skus jsonb so the trail can tell them apart. action
  // stays 'bind' (the check constraint is unchanged).
  const replayed = row?.replayed ?? false;

  // ── Audit (append-only). The bind already committed; a failure here must NOT be swallowed —
  //    log loudly and flag it, but still report the bind result. ──
  const { error: auditErr } = await admin.from('bind_audit').insert({
    order_id: orderId,
    owner_user_id: ownerUserId,
    actor_user_id: actorId,   // the member's auth id
    action: 'bind',
    session_id: sessionId,
    skus: { lines: pSkus, replayed },
  });
  if (auditErr) {
    console.error('[member/bind] AUDIT INSERT FAILED (bind DID commit) order=%s actor=%s: %s', orderId, actorId, auditErr.message);
  }

  return NextResponse.json({
    ok: true,
    replayed,
    status: row?.status,
    audit_recorded: !auditErr,
  });
}
