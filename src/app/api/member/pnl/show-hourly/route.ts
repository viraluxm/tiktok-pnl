import { NextResponse } from 'next/server';
import { requireMemberScope } from '@/lib/station/guard';

export const dynamic = 'force-dynamic';

const TZ = 'America/Los_Angeles'; // server-fixed business tz (see CLAUDE.md) — never a UTC offset

// GET /api/member/pnl/show-hourly?session_id= — owner-scoped hourly P&L for one show.
//
// CRITICAL ownership gate BEFORE the RPC: pnl_show_hourly_as filters its sales CTE by owner, so a
// foreign session_id would simply return ZERO rows — indistinguishable from a real quiet show. So
// we explicitly 403 unless the session belongs to an owner (live_sessions.user_id ∈ ownerIds) AND,
// for a store-restricted member, its store_id ∈ scope.storeIds. Only then do we call the RPC.
export async function GET(req: Request) {
  const scope = await requireMemberScope('pnl');
  if (!scope.ok) return scope.response;
  const { admin, ownerIds, storeIds, allStores } = scope;

  const sessionId = new URL(req.url).searchParams.get('session_id')?.trim();
  if (!sessionId) return NextResponse.json({ error: 'session_id required' }, { status: 400 });

  const { data: sess, error: sErr } = await admin
    .from('live_sessions')
    .select('user_id, store_id')
    .eq('id', sessionId)
    .maybeSingle();
  if (sErr) return NextResponse.json({ error: sErr.message }, { status: 500 });
  const ownedByOwner = !!sess && ownerIds.includes(String(sess.user_id));
  const inStoreScope = allStores || (!!sess?.store_id && storeIds.includes(String(sess.store_id)));
  if (!ownedByOwner || !inStoreScope) {
    return NextResponse.json({ error: 'session not in scope' }, { status: 403 });
  }

  const { data, error } = await admin.rpc('pnl_show_hourly_as', {
    p_owner_user_ids: ownerIds,
    p_session_id: sessionId,
    p_tz: TZ,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rows: data ?? [] });
}
