import { NextResponse } from 'next/server';
import { requireMemberScope } from '@/lib/station/guard';
import { ASP_GOAL_MULTIPLIER } from '@/lib/asp';

export const dynamic = 'force-dynamic';

// Owner-scoped, READ-ONLY host performance for the member 'team' scope.
// DEPENDS ON MIGRATION 111. Deploying before that DDL lands 500s the station Team page.
//
// COUNTS ONLY. Break-even and the ASP goal are computed inside the RPC purely to classify each
// auction and are NEVER returned — the response carries only asp7_n / asp7_hits / be14_n /
// be14_below per host, byte-identical to the owner route's shape. Under the previous
// implementation that contract depended on this route remembering not to emit the cost figures
// it had computed; now it holds by construction, because the RPC does not return them at all.
//
// ── WHY THIS CHANGED ──────────────────────────────────────────────────────────────────────
// This route windowed on live_auction_items.closed_at, which lensed_log_auction rewrites to
// now() on both the retroactive-bind INSERT and the not_sold→sold paid-flip UPDATE. 6.1% of
// sold auctions drift >1h past their real sale, 4.1% >24h, worst case 18.3 days — and the drift
// is BIASED, because retro-bound rows clear the 4× ASP goal at 1.6–2.4× a host's true rate.
//
// /api/live/host-performance moved to the corrected anchor in migration 109. Leaving this route
// on closed_at meant the SAME metric read materially differently on two pages (Tiegan 56.1%
// here vs 36.8% there), which is worse than one consistently wrong number: whoever spotted it
// would reasonably conclude the corrected value was the broken one. So both move together.
//
// pnl_host_performance_as is the service-role owner-scoped twin: this route runs through
// requireMemberScope('team') with createAdminClient() and an explicit ownerIds array, where
// auth.uid() is empty for a confined member, so the SECURITY INVOKER function 109 ships would
// return nothing. Same pattern as pnl_show_hourly_as / lensed_log_auction_as.

const ASP_WINDOW_DAYS = 7;
const BE_WINDOW_DAYS = 14;

type HostAgg = { asp7_n: number; asp7_hits: number; be14_n: number; be14_below: number };

// bigint counts arrive from PostgREST as strings.
type RpcRow = {
  host_id: string | null;
  asp_n: number | string | null;
  asp_hits: number | string | null;
  be_n: number | string | null;
  be_below: number | string | null;
};

const num = (v: number | string | null | undefined): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n as number) ? (n as number) : 0;
};

export async function GET() {
  const scope = await requireMemberScope('team');
  if (!scope.ok) return scope.response;
  const { admin, ownerIds } = scope;

  // Owner scope is asserted explicitly — the RPC bypasses RLS, so this array IS the boundary.
  // rpc-grants: pnl_host_performance_as
  const { data, error } = await admin.rpc('pnl_host_performance_as', {
    p_owner_user_ids: ownerIds,
    p_asp_window_days: ASP_WINDOW_DAYS,
    p_be_window_days: BE_WINDOW_DAYS,
    p_asp_goal_multiplier: ASP_GOAL_MULTIPLIER,
  });

  if (error) {
    console.error('[member/team/host-performance] rpc error:', error);
    return NextResponse.json({ error: 'Failed to load host performance' }, { status: 500 });
  }

  const hosts: Record<string, HostAgg> = {};
  for (const r of (data ?? []) as RpcRow[]) {
    if (!r.host_id) continue;
    hosts[String(r.host_id)] = {
      asp7_n: num(r.asp_n),
      asp7_hits: num(r.asp_hits),
      be14_n: num(r.be_n),
      be14_below: num(r.be_below),
    };
  }

  return NextResponse.json({
    asp_window_days: ASP_WINDOW_DAYS,
    be_window_days: BE_WINDOW_DAYS,
    hosts, // keyed by employees.id; a host with no attributed auctions is absent
  });
}
