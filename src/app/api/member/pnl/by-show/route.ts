import { NextResponse } from 'next/server';
import { requireMemberScope } from '@/lib/station/guard';

export const dynamic = 'force-dynamic';

const TZ = 'America/Los_Angeles'; // server-fixed business tz (see CLAUDE.md) — never a UTC offset

// GET /api/member/pnl/by-show?from=&to= — owner-scoped per-show P&L for the member 'pnl' scope.
// Calls pnl_by_show_as (089) with the resolved owner ids, NEVER the caller. Gross-margin only:
// net = gmv × 0.94 − cogs (a 6% platform fee), no labor/ads.
export async function GET(req: Request) {
  const scope = await requireMemberScope('pnl');
  if (!scope.ok) return scope.response;
  const { admin, ownerIds } = scope;

  const url = new URL(req.url);
  const p_from = url.searchParams.get('from') || null;
  const p_to = url.searchParams.get('to') || null;

  const { data, error } = await admin.rpc('pnl_by_show_as', {
    p_owner_user_ids: ownerIds,
    p_from,
    p_to,
    p_tz: TZ,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rows: data ?? [] });
}
