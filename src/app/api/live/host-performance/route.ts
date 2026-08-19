import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { ASP_GOAL_MULTIPLIER } from '@/lib/asp';

export const dynamic = 'force-dynamic';

// GET /api/live/host-performance
//
// Per-HOST auction performance, grouped by employees.id, for the Team > Roster badges.
// READ-ONLY: a single SELECT via the pnl_host_performance RPC (migration 109).
//
// ── WHY THIS IS AN RPC NOW ────────────────────────────────────────────────────────────────
// The previous implementation windowed on live_auction_items.closed_at. lensed_log_auction
// rewrites closed_at to now() on BOTH the retroactive-bind INSERT and the not_sold→sold
// paid-flip UPDATE, so a lot sold during a show can carry a closed_at days later — measured:
// 6.1% of sold auctions drift >1h, 4.1% >24h, worst case 18.3 days.
//
// The drift is not noise, it is BIASED: retro-bound rows clear the 4× ASP goal at 1.6–2.4× a
// host's true rate, so the old badges systematically flattered. Measured before/after on
// production data — four hosts' entire 7-day ASP samples were retro-bound rows:
//     Tiegan  56.1% → no data (187 → 0 auctions)
//     Allison 60.0% → no data ( 20 → 0)
//     Bailey  28.6% → no data ( 77 → 0)
//     Lily    28.0% → 18.4%   (347 → 158)
// Every material move was downward. Nobody was being under-credited.
//
// The fix could not be applied in place: the old route filtered auctions through PostgREST and
// then joined realized prices from a SEPARATE capture_events fetch in JS, so the window
// predicate could not live on the capture side where the correct anchor lives. The RPC inverts
// the drive direction — it starts from capture_events and windows on
// coalesce(ordered_at, created_at), the same anchor pnl_show_hourly and pnl_show_host_segments
// use. See supabase/migrations/109_pnl_host_performance.sql.
//
// Also fixed by the move: the RPC uses the canonical
// coalesce(unit_cost_cents_snapshot, inventory_skus.unit_cost_cents, 0) cost chain. Summing the
// raw snapshot column drops 147 of 72,285 sold SKU lines, which deflates break-even and
// inflates ASP-hit — the same direction of error as the closed_at drift.
//
// ── CONTRACT ──────────────────────────────────────────────────────────────────────────────
// Response shape is UNCHANGED and must stay so: { asp_window_days, be_window_days,
// hosts: { [employees.id]: { asp7_n, asp7_hits, be14_n, be14_below } } }. Consumers are
// src/hooks/useHostPerformance.ts → HostPerformanceBadges / EmployeesTab. Field names keep
// their 7/14 suffixes even though the windows are now parameters, because renaming them is a
// client change and this commit is deliberately server-only and revertable on its own.
//
// Thresholds and the MIN_AUCTIONS guard stay in the client badge (display concern).
//
// NOTE: /api/member/team/host-performance still carries the old closed_at logic. It reads
// owner-scoped via the admin client, so converting it needs a service-role `_as` twin of
// pnl_host_performance that 109 deliberately does not ship yet. Until then the station Team
// page shows the OLD, flattering numbers while this page shows corrected ones — a known and
// temporary divergence.

const ASP_WINDOW_DAYS = 7;
const BE_WINDOW_DAYS = 14;

type HostAgg = { asp7_n: number; asp7_hits: number; be14_n: number; be14_below: number };

// One row per host from the RPC. Counts arrive as bigint, which PostgREST serializes as string.
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
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // SECURITY INVOKER on the RPC, so RLS on capture_events / live_auction_items / live_sessions
  // scopes every row to this caller — the same guarantee the old paginated reads relied on.
  //
  // ASP_GOAL_MULTIPLIER is passed IN rather than hardcoded in SQL so src/lib/asp.ts stays the
  // single source of truth for the goal multiple (see that file's header: "there are no
  // hardcoded multipliers left").
  // rpc-grants: pnl_host_performance
  const { data, error } = await supabase.rpc('pnl_host_performance', {
    p_asp_window_days: ASP_WINDOW_DAYS,
    p_be_window_days: BE_WINDOW_DAYS,
    p_asp_goal_multiplier: ASP_GOAL_MULTIPLIER,
  });

  if (error) {
    console.error('[live/host-performance] rpc error:', error);
    return NextResponse.json({ error: 'Failed to load host performance' }, { status: 500 });
  }

  const hosts: Record<string, HostAgg> = {};
  for (const r of (data ?? []) as RpcRow[]) {
    if (!r.host_id) continue; // the RPC gates on host_id IS NOT NULL; belt-and-braces
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
