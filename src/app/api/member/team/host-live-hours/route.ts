import { NextResponse } from 'next/server';
import { requireMemberScope } from '@/lib/station/guard';

export const dynamic = 'force-dynamic';

// GET /api/member/team/host-live-hours — owner-scoped rebuild of /api/schedule/host-live-hours for
// the member 'team' scope. Returns raw live-session intervals (the client computes per-host live
// hours). Read-only, no pay, no cost.
export async function GET() {
  const scope = await requireMemberScope('team');
  if (!scope.ok) return scope.response;
  const { admin, ownerIds } = scope;

  const { data, error } = await admin
    .from('live_sessions')
    .select('host_id, status, started_at, ended_at, end_source')
    .in('user_id', ownerIds);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ sessions: data ?? [] });
}
