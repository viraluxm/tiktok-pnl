import { NextResponse } from 'next/server';
import { requireMemberScope } from '@/lib/station/guard';
import { captureInWindow } from '@/lib/member/sessionWindow';

export const dynamic = 'force-dynamic';

// GET /api/member/sessions?order_id= — candidate live sessions for an unbound capture, so the
// member can pick which one to bind into. Candidates = the owner's sessions whose room
// (tiktok_live_id) matches the capture's room_id AND whose window contains the capture's timestamp,
// store-scoped to the member. Multiple candidates are expected (a room hosts many sessions); the
// member disambiguates. Owner-scoped (service_role), gated on requireMemberScope('binding').
//
// ROOM-ONLY FALLBACK: when NO room session's window contains the capture (the ~294 window-mismatch
// rows), we fall back to offering every room session, each marked `in_window: false`, so the member
// can pick by room. We NEVER mix: if any in-window candidate exists, only those are returned (all
// `in_window: true`). Binding into an out-of-window session mis-attributes that session's show-level
// totals — the flag lets the UI caution, and /api/member/bind records it in the audit trail.
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

  // Keep sessions whose window contains the capture's timestamp (± grace). Open-ended sessions (no
  // ended_at) run through now; a capture with no usable timestamp matches every room session.
  const inWindow = (sessions ?? []).filter((s) => captureInWindow(t, s));

  // Candidate set: prefer in-window sessions. Only when NONE are in-window do we fall back to the
  // full room set (marked out-of-window below). Never mixed — an in-window match always wins.
  const usingFallback = inWindow.length === 0;
  const candidates = usingFallback ? (sessions ?? []) : inWindow;

  // Resolve host_name from employees where available.
  const hostIds = [...new Set(candidates.map((s) => s.host_id).filter((h): h is string => !!h))];
  const hostName = new Map<string, string>();
  if (hostIds.length) {
    const { data: emps } = await admin.from('employees').select('id, name').in('id', hostIds);
    for (const e of emps ?? []) hostName.set(String(e.id), String(e.name));
  }

  // Resolve store_id → stores.name so the picker can match the Shows tab's display (which shows the
  // resolved name, with an "Unmapped store" fallback client-side). Same join /api/live/sessions does.
  const storeIdsSeen = [...new Set(candidates.map((s) => s.store_id).filter((x): x is string => !!x))];
  const storeName = new Map<string, string>();
  if (storeIdsSeen.length) {
    const { data: sts } = await admin.from('stores').select('id, name').in('id', storeIdsSeen);
    for (const st of sts ?? []) storeName.set(String(st.id), String(st.name));
  }

  // Per-session auction spread + bound count, in ONE grouped query (no N+1): fetch the candidate
  // sessions' auction rows once and aggregate in-process. The lot # (seller_sku_hint on the unbound
  // row) matched against seq_min..seq_max is the member's precise disambiguator when picking by room.
  const candIds = candidates.map((s) => String(s.id));
  const seqMin = new Map<string, number>();
  const seqMax = new Map<string, number>();
  const boundCount = new Map<string, number>();
  if (candIds.length) {
    const { data: items, error: itemErr } = await admin
      .from('live_auction_items')
      .select('session_id, sequence, status')
      .in('session_id', candIds)
      .eq('user_id', ownerUserId); // owner-scoping explicit here, not merely implied by candIds' source
    if (itemErr) return NextResponse.json({ error: itemErr.message }, { status: 500 });
    for (const it of items ?? []) {
      const sid = String(it.session_id);
      const seq = it.sequence as number | null;
      if (typeof seq === 'number') {
        const lo = seqMin.get(sid);
        const hi = seqMax.get(sid);
        if (lo === undefined || seq < lo) seqMin.set(sid, seq);
        if (hi === undefined || seq > hi) seqMax.set(sid, seq);
      }
      if (it.status === 'sold') boundCount.set(sid, (boundCount.get(sid) ?? 0) + 1);
    }
  }

  const result = candidates.map((s) => {
    const id = String(s.id);
    return {
      id,
      started_at: (s.started_at as string | null) ?? null,
      ended_at: (s.ended_at as string | null) ?? null,
      host_name: s.host_id ? (hostName.get(String(s.host_id)) ?? null) : null,
      store_id: (s.store_id as string | null) ?? null,
      store_name: s.store_id ? (storeName.get(String(s.store_id)) ?? null) : null,
      channel_handle: (s.channel_handle as string | null) ?? null,
      seq_min: seqMin.get(id) ?? null,
      seq_max: seqMax.get(id) ?? null,
      bound_count: boundCount.get(id) ?? 0,
      in_window: !usingFallback, // fallback rows are, by construction, all out-of-window
    };
  });

  return NextResponse.json({ sessions: result, in_window: !usingFallback });
}
