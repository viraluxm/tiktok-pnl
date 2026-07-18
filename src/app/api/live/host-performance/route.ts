import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// GET /api/live/host-performance
//
// Per-HOST auction performance, grouped by host_id, for the Team > Roster badges.
// READ-ONLY: SELECT only — no writes to auction/capture data.
//
// Attribution works only since migration 056 (live_sessions.host_id -> employees.id).
// Auctions whose session has a NULL host_id (all history before 056) are EXCLUDED —
// they are attributed to no one. On first ship this returns ~0 attributed auctions
// for every host, which the UI renders as "No data yet" (expected, not an error).
//
// Canonical grouped query this route mirrors (two rolling windows in one pass):
//
//   with attributed as (
//     select ls.host_id, lai.closed_at,
//            sum(s.unit_cost_cents_snapshot * s.qty)     as break_even_cents,
//            sum(s.unit_cost_cents_snapshot * s.qty) * 3 as asp_goal_cents,
//            ce.selling_price_cents                       as final_price
//     from live_auction_items lai
//     join live_sessions ls
//       on ls.id = lai.session_id and ls.host_id is not null      -- attribution gate
//     join live_auction_item_skus s on s.auction_item_id = lai.id
//     join capture_events ce
//       on ce.order_id = lai.client_idempotency_key and ce.user_id = lai.user_id
//     where lai.status = 'sold' and lai.closed_at >= now() - interval '14 days'
//     group by ls.host_id, lai.closed_at, ce.selling_price_cents
//   )
//   select host_id,
//     count(*) filter (where closed_at >= now() - interval '7 days')                              as asp7_n,
//     count(*) filter (where closed_at >= now() - interval '7 days' and final_price >= asp_goal_cents) as asp7_hits,
//     count(*)                                                                                    as be14_n,
//     count(*) filter (where final_price < break_even_cents)                                      as be14_below
//   from attributed group by host_id;
//
// The 14-day fetch is the superset; the 7-day ASP window is a filter within it.
// Thresholds + the MIN_AUCTIONS guard live in the client badge (display concern).
//
// RLS note: user-scoped server client, so ce.user_id = lai.user_id is implicit
// (both tables filtered to auth.uid()). Consistent with the auction-performance card.

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

// Per-host tallies for the two windows.
type HostAgg = { asp7_n: number; asp7_hits: number; be14_n: number; be14_below: number };

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const now = Date.now();
  const be14Cutoff = new Date(now - BE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const asp7CutoffMs = now - ASP_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  // Captures land at ~close time; small back-buffer avoids dropping edge matches.
  const capCutoffIso = new Date(be14Cutoff.getTime() - 24 * 60 * 60 * 1000).toISOString();

  // ── Attributed sold auctions in the 14d superset window: inner-join the session
  //    and require a non-null host_id, embed the SKU cost snapshots. Paginated.
  const auctions: AuctionRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('live_auction_items')
      .select('closed_at, client_idempotency_key, live_sessions!inner(host_id), live_auction_item_skus(unit_cost_cents_snapshot, qty)')
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

  // ── Realized win price by order id (RLS scopes to this user, so order_id is the key).
  const priceByOrder = new Map<string, number>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('capture_events')
      .select('order_id, selling_price_cents')
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

  // ── Group by host_id, tallying both windows in one pass. An auction counts only
  //    once it has a realized-price match.
  const byHost = new Map<string, HostAgg>();
  for (const a of auctions) {
    const hostId = a.live_sessions?.host_id;
    const key = a.client_idempotency_key ? String(a.client_idempotency_key) : null;
    if (!hostId || key == null) continue;
    const finalPrice = priceByOrder.get(key);
    if (finalPrice == null) continue;

    const breakEven = (a.live_auction_item_skus ?? []).reduce(
      (sum, s) => sum + (Number(s.unit_cost_cents_snapshot) || 0) * (Number(s.qty) || 1),
      0,
    );
    const aspGoal = breakEven * 3;
    const inAsp7 = a.closed_at != null && new Date(a.closed_at).getTime() >= asp7CutoffMs;

    const agg = byHost.get(hostId) ?? { asp7_n: 0, asp7_hits: 0, be14_n: 0, be14_below: 0 };
    agg.be14_n += 1;
    if (finalPrice < breakEven) agg.be14_below += 1;
    if (inAsp7) {
      agg.asp7_n += 1;
      if (finalPrice >= aspGoal) agg.asp7_hits += 1;
    }
    byHost.set(hostId, agg);
  }

  const hosts: Record<string, HostAgg> = {};
  for (const [k, v] of byHost) hosts[k] = v;

  return NextResponse.json({
    asp_window_days: ASP_WINDOW_DAYS,
    be_window_days: BE_WINDOW_DAYS,
    hosts, // keyed by employees.id; absent host => no attributed auctions yet
  });
}
