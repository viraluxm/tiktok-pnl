import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// GET /api/live/auction-performance?store=<store_id|all>&days=21
//
// TEAM-WIDE auction performance over a rolling window (default last 21 days by
// lai.closed_at). READ-ONLY: this route only SELECTs — no writes, no migrations.
//
// The realized win price lives in capture_events, NOT in live_auction_items
// (sold_price_cents is a dead column). This is the proven join, 100% coverage:
//
//   select
//     lai.id,
//     lai.store_id,
//     sum(s.unit_cost_cents_snapshot * s.qty)     as break_even_cents,
//     sum(s.unit_cost_cents_snapshot * s.qty) * 3 as asp_goal_cents,
//     ce.selling_price_cents                       as final_price_cents
//   from live_auction_items lai
//   join live_auction_item_skus s on s.auction_item_id = lai.id
//   join capture_events ce
//     on ce.order_id = lai.client_idempotency_key
//    and ce.user_id  = lai.user_id
//   where lai.status = 'sold'
//     and lai.closed_at >= now() - (:days || ' days')::interval
//     and (:store = 'all' or lai.store_id = :store)
//   group by lai.id, lai.store_id, ce.selling_price_cents;
//
// then classify each auction (HIT / BELOW / THIN) and aggregate. We do the
// per-auction classification FIRST and the aggregate SECOND, keyed by
// `groupKey`. Today groupKey is always 'team' (host_id is not populated). When
// live_sessions.host_id lands, joining lai→live_sessions and setting
// groupKey = host_id turns this into a per-host rollup with no other change.
//
// RLS note: this uses the user-scoped server client, so ce.user_id = lai.user_id
// is guaranteed (both tables are already filtered to auth.uid()). Consistent with
// every other analytics surface in the app — the card shows what the signed-in
// user is authorized to see, scoped by store.

// Store baselines for the Below-break-even reference line. These are the anchors
// established from the historical window — store-relative, NOT one global number.
const BELOW_BE_BASELINE: Record<string, number> = {
  '1d71a4c9-16b1-45f2-858e-64b41c548e9e': 0.12, // Snore
  'afd1c76e-1d92-4c7d-9edf-0468ae7aa3df': 0.08, // lots of steals
  all: 0.10,
};

const PAGE = 1000; // Supabase PostgREST per-request row cap.

type SkuRow = { unit_cost_cents_snapshot: number | null; qty: number | null };
type AuctionRow = {
  id: string;
  store_id: string | null;
  client_idempotency_key: string | null;
  closed_at: string | null;
  live_auction_item_skus: SkuRow[] | null;
};

// One classified auction. `groupKey` is the future aggregate key (host_id); it is
// 'team' until host attribution exists.
type PerAuction = {
  groupKey: string;
  breakEven: number;
  aspGoal: number;
  finalPrice: number;
};

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function pct(n: number, d: number): number {
  return d === 0 ? 0 : n / d;
}

export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const store = url.searchParams.get('store') || 'all';
  const daysParam = Number(url.searchParams.get('days'));
  const days = Number.isFinite(daysParam) && daysParam > 0 && daysParam <= 365 ? Math.floor(daysParam) : 21;

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const cutoffIso = cutoff.toISOString();
  // Captures (the order) land at ~auction-close time; a small back-buffer avoids
  // dropping a match at the window edge.
  const capCutoffIso = new Date(cutoff.getTime() - 24 * 60 * 60 * 1000).toISOString();

  // ── Fetch sold auctions in the window, with their SKU cost snapshots embedded
  //    (one round-trip per page via the FK relationship). Paginated past the 1k cap.
  const auctions: AuctionRow[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase
      .from('live_auction_items')
      .select('id, store_id, client_idempotency_key, closed_at, live_auction_item_skus(unit_cost_cents_snapshot, qty)')
      .eq('status', 'sold')
      .gte('closed_at', cutoffIso)
      .order('closed_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (store !== 'all') q = q.eq('store_id', store);
    const { data, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const rows = (data ?? []) as unknown as AuctionRow[];
    auctions.push(...rows);
    if (rows.length < PAGE) break;
  }

  // ── Realized win price by order id. RLS scopes capture_events to this user, so
  //    order_id alone is the key (== the (order_id, user_id) pair in the SQL).
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

  // ── STEP 1: per-auction classification (the future per-host unit of work). An
  //    auction only counts once it has a realized-price match.
  const perAuction: PerAuction[] = [];
  let unmatched = 0;
  for (const a of auctions) {
    const key = a.client_idempotency_key ? String(a.client_idempotency_key) : null;
    const finalPrice = key != null ? priceByOrder.get(key) : undefined;
    if (finalPrice == null) { unmatched++; continue; }
    const breakEven = (a.live_auction_item_skus ?? []).reduce(
      (sum, s) => sum + (Number(s.unit_cost_cents_snapshot) || 0) * (Number(s.qty) || 1),
      0,
    );
    perAuction.push({ groupKey: 'team', breakEven, aspGoal: breakEven * 3, finalPrice });
  }

  // ── STEP 2: aggregate. Keyed by groupKey so a future GROUP BY host_id is a
  //    one-line change (group the array by groupKey and run this per bucket).
  const rows = perAuction; // == perAuction.filter(p => p.groupKey === 'team')
  const n = rows.length;
  const hits = rows.filter((r) => r.finalPrice >= r.aspGoal).length;
  const belowBE = rows.filter((r) => r.finalPrice < r.breakEven).length;
  const thin = rows.filter((r) => r.finalPrice >= r.breakEven && r.finalPrice < r.aspGoal).length;
  const finals = rows.map((r) => r.finalPrice);
  const goalRatios = rows.filter((r) => r.aspGoal > 0).map((r) => r.finalPrice / r.aspGoal);

  const baseline = BELOW_BE_BASELINE[store] ?? BELOW_BE_BASELINE.all;

  return NextResponse.json({
    store,
    days,
    window_start: cutoffIso,
    sample_size: n,
    unmatched, // auctions in-window with no realized-price match (expected ~0)
    asp_hit_rate: pct(hits, n),
    below_breakeven_rate: pct(belowBE, n),
    thin_margin_rate: pct(thin, n),
    counts: { asp_hit: hits, below_breakeven: belowBE, thin_margin: thin },
    median_final_price_cents: median(finals),
    median_pct_of_goal: median(goalRatios),
    below_breakeven_baseline: baseline,
  });
}
