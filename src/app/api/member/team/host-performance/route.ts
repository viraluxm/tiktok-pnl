import { NextResponse } from 'next/server';
import { requireMemberScope } from '@/lib/station/guard';
import { ASP_GOAL_MULTIPLIER } from '@/lib/asp';

export const dynamic = 'force-dynamic';

// Owner-scoped, READ-ONLY rebuild of /api/live/host-performance for the member 'team' scope.
//
// COUNTS ONLY. The break-even and asp-goal thresholds are derived from unit_cost_cents_snapshot
// SERVER-SIDE (to classify each auction), but they are NEVER emitted — the response carries only
// asp7_n / asp7_hits / be14_n / be14_below per host, byte-identical to the owner route's shape. No
// cost, no breakEven, no aspGoal leaves this route. Owner-scoped via .in('user_id', ownerIds)
// (the owner route relied on RLS auth.uid(), which is empty for a confined member).
const PAGE = 1000;
const ASP_WINDOW_DAYS = 7;
const BE_WINDOW_DAYS = 14;

type SkuRow = { unit_cost_cents_snapshot: number | null; qty: number | null };
type AuctionRow = {
  closed_at: string | null;
  client_idempotency_key: string | null;
  live_sessions: { host_id: string | null } | null;
  live_auction_item_skus: SkuRow[] | null;
};
type HostAgg = { asp7_n: number; asp7_hits: number; be14_n: number; be14_below: number };

export async function GET() {
  const scope = await requireMemberScope('team');
  if (!scope.ok) return scope.response;
  const { admin, ownerIds } = scope;

  const now = Date.now();
  const be14Cutoff = new Date(now - BE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const asp7CutoffMs = now - ASP_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const capCutoffIso = new Date(be14Cutoff.getTime() - 24 * 60 * 60 * 1000).toISOString();

  // Attributed sold auctions in the 14d superset window (inner-join session, require host_id).
  const auctions: AuctionRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from('live_auction_items')
      .select('closed_at, client_idempotency_key, live_sessions!inner(host_id), live_auction_item_skus(unit_cost_cents_snapshot, qty)')
      .in('user_id', ownerIds)
      .eq('status', 'sold')
      .gte('closed_at', be14Cutoff.toISOString())
      .not('live_sessions.host_id', 'is', null)
      .order('closed_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const rows = (data ?? []) as unknown as AuctionRow[];
    auctions.push(...rows);
    if (rows.length < PAGE) break;
  }

  // Realized win price by order id.
  const priceByOrder = new Map<string, number>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from('capture_events')
      .select('order_id, selling_price_cents')
      .in('user_id', ownerIds)
      .gte('created_at', capCutoffIso)
      .range(from, from + PAGE - 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const rows = (data ?? []) as { order_id: string | null; selling_price_cents: number | null }[];
    for (const r of rows) {
      if (r.order_id != null && r.selling_price_cents != null && !priceByOrder.has(String(r.order_id))) {
        priceByOrder.set(String(r.order_id), r.selling_price_cents);
      }
    }
    if (rows.length < PAGE) break;
  }

  const byHost = new Map<string, HostAgg>();
  for (const a of auctions) {
    const hostId = a.live_sessions?.host_id;
    const key = a.client_idempotency_key ? String(a.client_idempotency_key) : null;
    if (!hostId || key == null) continue;
    const finalPrice = priceByOrder.get(key);
    if (finalPrice == null) continue;

    // Cost-derived thresholds — used ONLY to classify; never emitted.
    const breakEven = (a.live_auction_item_skus ?? []).reduce(
      (sum, s) => sum + (Number(s.unit_cost_cents_snapshot) || 0) * (Number(s.qty) || 1), 0);
    const aspGoal = breakEven * ASP_GOAL_MULTIPLIER;
    const inAsp7 = a.closed_at != null && new Date(a.closed_at).getTime() >= asp7CutoffMs;

    const agg = byHost.get(hostId) ?? { asp7_n: 0, asp7_hits: 0, be14_n: 0, be14_below: 0 };
    agg.be14_n += 1;
    if (finalPrice < breakEven) agg.be14_below += 1;
    if (inAsp7) { agg.asp7_n += 1; if (finalPrice >= aspGoal) agg.asp7_hits += 1; }
    byHost.set(hostId, agg);
  }

  const hosts: Record<string, HostAgg> = {};
  for (const [k, v] of byHost) hosts[k] = v;
  return NextResponse.json({ asp_window_days: ASP_WINDOW_DAYS, be_window_days: BE_WINDOW_DAYS, hosts });
}
