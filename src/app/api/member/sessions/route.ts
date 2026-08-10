import { NextResponse } from 'next/server';
import { requireMemberScope } from '@/lib/station/guard';

export const dynamic = 'force-dynamic';

// Window grace on BOTH edges. From the 347 window-mismatch distribution: a 5-minute pad recovers
// ~53 of them (vs ~13 at 60s) while staying entirely clear of the >30min multi-session tail where
// grace could surface the wrong show. Since the member manually picks among candidates, a modest
// pad only adds true-session options near a show's edges — it never auto-binds. Tune here.
const GRACE_MS = 5 * 60 * 1000;

// GET /api/member/sessions?order_id= — candidate live sessions for an unbound capture, so the
// member can pick which one to bind into. Candidates = the owner's sessions whose room
// (tiktok_live_id) matches the capture's room_id AND whose window contains the capture's timestamp,
// store-scoped to the member. Multiple candidates are expected (a room hosts many sessions); the
// member disambiguates. Owner-scoped (service_role), gated on requireMemberScope('binding').
export async function GET(req: Request) {
  const scope = await requireMemberScope('binding');
  if (!scope.ok) return scope.response;
  const { admin, ownerIds, storeIds, allStores } = scope;

  const orderId = (new URL(req.url).searchParams.get('order_id') ?? '').trim();
  if (!orderId) return NextResponse.json({ error: 'order_id required' }, { status: 400 });

  // The capture: its owner, room, and sale time. Scoped to the member's owners.
  const { data: cap, error: capErr } = await admin
    .from('capture_events')
    .select('user_id, room_id, ordered_at, created_at')
    .eq('order_id', orderId)
    .in('user_id', ownerIds)
    .limit(1)
    .maybeSingle();
  if (capErr) return NextResponse.json({ error: capErr.message }, { status: 500 });
  if (!cap || !cap.room_id) return NextResponse.json({ sessions: [] }); // not in scope / no room to match

  const ownerUserId = String(cap.user_id);
  const room = String(cap.room_id);
  const t = Date.parse((cap.ordered_at as string | null) ?? (cap.created_at as string | null) ?? '');

  // Same room, same owner, store-scoped (all-stores members skip the store filter).
  let q = admin
    .from('live_sessions')
    .select('id, started_at, ended_at, created_at, store_id, host_id, channel_handle')
    .eq('user_id', ownerUserId)
    .eq('tiktok_live_id', room);
  if (!allStores) q = q.in('store_id', storeIds);
  const { data: sessions, error: sessErr } = await q;
  if (sessErr) return NextResponse.json({ error: sessErr.message }, { status: 500 });

  // Keep sessions whose window contains the capture's timestamp. Open-ended sessions (no ended_at)
  // are treated as running through now. If the capture has no usable timestamp, we can't window-
  // filter, so every room session is a candidate.
  const inWindow = (sessions ?? []).filter((s) => {
    if (!Number.isFinite(t)) return true;
    const start = Date.parse((s.started_at as string | null) ?? (s.created_at as string | null) ?? '');
    const end = Date.parse((s.ended_at as string | null) ?? '');
    const startOk = !Number.isFinite(start) || t >= start - GRACE_MS;
    const endOk = !Number.isFinite(end) || t <= end + GRACE_MS;
    return startOk && endOk;
  });

  // Resolve host_name from employees where available.
  const hostIds = [...new Set(inWindow.map((s) => s.host_id).filter((h): h is string => !!h))];
  const hostName = new Map<string, string>();
  if (hostIds.length) {
    const { data: emps } = await admin.from('employees').select('id, name').in('id', hostIds);
    for (const e of emps ?? []) hostName.set(String(e.id), String(e.name));
  }

  // Resolve store_id → stores.name so the picker can match the Shows tab's display (which shows the
  // resolved name, with an "Unmapped store" fallback client-side). Same join /api/live/sessions does.
  const storeIdsSeen = [...new Set(inWindow.map((s) => s.store_id).filter((x): x is string => !!x))];
  const storeName = new Map<string, string>();
  if (storeIdsSeen.length) {
    const { data: sts } = await admin.from('stores').select('id, name').in('id', storeIdsSeen);
    for (const st of sts ?? []) storeName.set(String(st.id), String(st.name));
  }

  const result = inWindow.map((s) => ({
    id: String(s.id),
    started_at: (s.started_at as string | null) ?? null,
    ended_at: (s.ended_at as string | null) ?? null,
    host_name: s.host_id ? (hostName.get(String(s.host_id)) ?? null) : null,
    store_id: (s.store_id as string | null) ?? null,
    store_name: s.store_id ? (storeName.get(String(s.store_id)) ?? null) : null,
    channel_handle: (s.channel_handle as string | null) ?? null,
  }));

  return NextResponse.json({ sessions: result });
}
