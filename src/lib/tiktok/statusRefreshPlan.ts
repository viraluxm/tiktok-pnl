// Which open orders to re-check a status for, and in what order.
//
// NO IMPORTS — statusRefreshPlan.test.mjs transpiles this file standalone at runtime.
//
// THE BUG THIS REPLACES. The status phase selected open orders `order_created_at ascending`
// with `limit(CALL_CAP_STATUS * CHUNK)` — the OLDEST 6,000. Snore has 13,014 open orders, so
// everything ranked 6,001+ by age was never refreshed at all. Not eventually: never, because
// every run selected the same oldest 6,000. Today's orders are the newest, so they sat
// permanently in the blind spot while the oldest 6,000 were re-polled every 30 minutes.
//
// Measured 2026-09-03: of 100 orders Lensed believed were AWAITING_SHIPMENT, TikTok said 38
// had already moved to AWAITING_COLLECTION. Meanwhile 160 sampled AWAITING_COLLECTION orders
// spanning 2 days to 7 weeks old came back AWAITING_COLLECTION every single time — the old end
// of the queue genuinely does not change, and the whole budget was being spent there.
//
// THE FIX IS NOT SIMPLY "NEWEST FIRST". That would invert the blind spot and leave the old
// tail permanently unchecked instead — and "these never change" is an observation from one
// sample, not a guarantee. A parcel can be collected, returned or cancelled at any age.
//
// So the budget is SPLIT: most of it to the newest orders, where transitions actually happen,
// and a deliberate slice to the oldest, so nothing is ever permanently invisible. Slow
// coverage of the tail is acceptable; zero coverage is not.

/** An open order, as the refresh phase reads it. */
export interface OpenOrder {
  order_id: string;
  /** ISO timestamp, or null for rows that predate the column being populated. */
  order_created_at: string | null;
}

export interface RefreshPlanOptions {
  /** getOrderById ids per call. */
  chunk: number;
  /** Calls spent on the newest open orders. */
  recentCalls: number;
  /** Calls spent on the oldest, so the tail is never permanently skipped. */
  backlogCalls: number;
}

export interface RefreshPlan {
  /** Order ids to re-check, already in the order they should be requested. */
  ids: string[];
  /** How many came from the recent half — for the run's log line. */
  recentCount: number;
  /** How many came from the backlog half. */
  backlogCount: number;
  /** Open orders this run will NOT reach. Non-zero is expected and fine; it should be logged. */
  skipped: number;
}

/**
 * Sort key. Orders with no `order_created_at` sort as OLDEST rather than being dropped: they
 * are legacy rows, and silently excluding them would recreate a blind spot of exactly the kind
 * this function exists to remove.
 */
function createdMs(o: OpenOrder): number {
  if (!o.order_created_at) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(o.order_created_at);
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

/**
 * Plan a status-refresh run: newest orders first, then a slice of the oldest.
 *
 * Never returns a duplicate id — on a store small enough that both halves overlap, the recent
 * half wins and the backlog half yields whatever is left. Spending two calls on the same order
 * in one run is pure waste.
 */
export function planStatusRefresh(open: OpenOrder[], opts: RefreshPlanOptions): RefreshPlan {
  const { chunk, recentCalls, backlogCalls } = opts;
  const recentBudget = Math.max(0, recentCalls) * Math.max(0, chunk);
  const backlogBudget = Math.max(0, backlogCalls) * Math.max(0, chunk);

  // DEDUPE FIRST. The caller assembles this list from two reads — newest-end and oldest-end —
  // and on any store smaller than the combined budget those reads return the SAME rows twice.
  // Deduplicating only between the halves (below) was not enough: the duplicates were already
  // inside the recent half, so a batch went to getOrderById containing the same id twice and
  // TikTok rejected the whole call with 98001004 "Wrong order id".
  //
  // That killed the status phase outright on Lux viral (11 open orders, 22 planned) and partway
  // through Toysfordeals (2,981 open, 3,981 planned), while the two stores large enough for the
  // halves not to overlap ran clean. `planned` exceeding the open total is the signature.
  const seen = new Set<string>();
  const unique: OpenOrder[] = [];
  for (const o of open) {
    if (seen.has(o.order_id)) continue;
    seen.add(o.order_id);
    unique.push(o);
  }

  // Newest first. Ties broken by order_id so a run is deterministic and two runs over
  // unchanged data request the same thing — which makes the logs comparable.
  const newestFirst = unique
    .slice()
    .sort((a, b) => createdMs(b) - createdMs(a) || a.order_id.localeCompare(b.order_id));

  const recent = newestFirst.slice(0, recentBudget);
  const taken = new Set(recent.map((o) => o.order_id));

  // The oldest end, skipping anything the recent half already claimed.
  const backlog: OpenOrder[] = [];
  for (let i = newestFirst.length - 1; i >= 0 && backlog.length < backlogBudget; i--) {
    const o = newestFirst[i];
    if (taken.has(o.order_id)) continue;
    taken.add(o.order_id);
    backlog.push(o);
  }

  return {
    ids: [...recent.map((o) => o.order_id), ...backlog.map((o) => o.order_id)],
    recentCount: recent.length,
    backlogCount: backlog.length,
    skipped: Math.max(0, unique.length - recent.length - backlog.length),
  };
}
