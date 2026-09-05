// The checks that stand between a reviewed plan and spending money.
//
// NO IMPORTS — purchaseGuards.test.mjs transpiles this file standalone at runtime.
//
// WHY THESE EXIST AT ALL. TikTok's Create Packages call IS the purchase: it returns a price,
// but by the time that price is readable the label is bought, tracking is issued and there is
// no cancel. So every safeguard has to sit BEFORE the first call — there is no reconsidering
// halfway through, and no endpoint that quotes a run before committing to it.

/**
 * Sanity ceiling on one authorised manifest.
 *
 * NOT the primary control any more. The controls that matter are SCOPE (a day or named shows,
 * so a run means a definite set of work) and the confirm count (so the set was reviewed). This
 * is the backstop against a scope that resolved to something absurd — a bug, or a store whose
 * backlog was never bought down.
 *
 * 1,500 sits well above real volume: the busiest fulfilment day in the 8 days to 2026-09-04 was
 * 863 boxes, and a normal day is 474-600. A legitimate day therefore always fits in one
 * authorisation, which is the point — the operator asked not to split a day across runs.
 */
export const MAX_MANIFEST_BOXES = 1500;

/**
 * Fallback unit price when the ledger holds no prior purchases, in USD.
 *
 * From the one-box test on Snore 2026-09-03: $4.10, USPS Ground Advantage, 0.44 lb default
 * weight. Only ever used to size an ESTIMATE for a human to sanity-check; nothing is decided
 * from it.
 */
export const FALLBACK_UNIT_PRICE = 4.1;

/** How many recent purchases the average is drawn from. */
export const PRICE_SAMPLE_SIZE = 200;

export interface SpendEstimate {
  boxes: number;
  avg_unit_price: number;
  estimated_total: number;
  currency: string;
  /** 'ledger' once real purchases exist, 'fallback' before that. */
  basis: 'ledger' | 'fallback';
  samples: number;
}

/**
 * Estimate what a run will cost.
 *
 * Deliberately called an estimate everywhere it surfaces. The true total is only knowable
 * after buying, so presenting this as a quote would be a lie that costs money — a run whose
 * real total came in 30% high would still have been bought in full.
 */
export function summarizeSpend(prices: number[], boxes: number): SpendEstimate {
  const clean = prices.filter((p) => Number.isFinite(p) && p > 0);
  const avg = clean.length
    ? clean.reduce((a, b) => a + b, 0) / clean.length
    : FALLBACK_UNIT_PRICE;
  return {
    boxes,
    avg_unit_price: Math.round(avg * 100) / 100,
    estimated_total: Math.round(avg * boxes * 100) / 100,
    currency: 'USD',
    basis: clean.length ? 'ledger' : 'fallback',
    samples: clean.length,
  };
}

/**
 * What to do when a run contains boxes with no SKU on file.
 *
 * There is deliberately no default. Unbound is usually a TIMING state, not a permanent one —
 * the team binds shortly after a show — so the right answer is normally to wait and re-run,
 * and a job that quietly picked one for you would either skip orders silently or buy labels
 * nobody can pick from. Both are worse than being asked.
 */
export type UnboundPolicy = 'skip' | 'include';

export interface AuthorizeInput {
  /** LABEL_PURCHASE_ENABLED === '1'. Anything else means log-only. */
  enabled: boolean;
  /** Boxes this scope resolved, after removing everything already in the ledger. */
  boxes: number;
  /** The count the caller read on the dry run and is authorising. Null when absent. */
  confirmBoxes: number | null;
  /** Boxes in this run with no SKU on file. */
  unboundCount: number;
  /** What to do about them. Null when the caller has not said, which is refused if any exist. */
  unboundPolicy: UnboundPolicy | null;
  cap?: number;
}

export type AuthorizeRefusal =
  | 'disabled'
  | 'nothing_to_buy'
  | 'confirm_missing'
  | 'confirm_mismatch'
  | 'unbound_present'
  | 'over_cap';

export type AuthorizeResult =
  | { ok: true; buy: number }
  | { ok: false; code: AuthorizeRefusal; reason: string };

/**
 * Whether a manifest may be authorised, and how many boxes it covers.
 *
 * THIS IS THE ONLY GATE, and it runs ONCE per run rather than once per call. Authorising writes
 * the whole manifest to the ledger as claimed rows and buys nothing; the purchase route then
 * drains those rows mechanically. That split exists because a fulfilment day is 474-863 boxes
 * and cannot be bought inside one request — but the operator asked not to split a day across
 * several approvals, and re-approving between chunks is exactly that.
 *
 * `confirmBoxes` guards a plan that MOVED: the caller passes the count it saw on the dry run and
 * it must match exactly, so if a show ended or a sync landed in between, this refuses rather
 * than authorising a set nobody read. It replaces the old per-call `limit` as the thing standing
 * between a click and a large purchase — the limit is gone because SCOPE now bounds the run, and
 * a limit on top would have forced the multiple batches the operator specifically ruled out.
 */
export function authorizeRun(input: AuthorizeInput): AuthorizeResult {
  const cap = input.cap ?? MAX_MANIFEST_BOXES;
  if (!input.enabled) {
    return { ok: false, code: 'disabled', reason: 'LABEL_PURCHASE_ENABLED is not 1 — log-only' };
  }
  if (!Number.isFinite(input.boxes) || input.boxes <= 0) {
    return { ok: false, code: 'nothing_to_buy', reason: 'no boxes left to buy' };
  }
  if (input.confirmBoxes == null) {
    return {
      ok: false, code: 'confirm_missing',
      reason: 'confirm_boxes is required — read the check and pass the box count it reports',
    };
  }
  if (input.confirmBoxes !== input.boxes) {
    return {
      ok: false, code: 'confirm_mismatch',
      reason: `plan moved since it was reviewed: confirm_boxes=${input.confirmBoxes} but ${input.boxes} boxes now resolve — check again`,
    };
  }
  // Asked before the cap, because the answer changes how many boxes the run contains.
  if (input.unboundCount > 0 && input.unboundPolicy == null) {
    return {
      ok: false, code: 'unbound_present',
      reason: `${input.unboundCount} box(es) in this batch have no SKU on file. Wait for them to be bound and check again, or pass unbound=skip to buy the rest, or unbound=include to buy them too (their labels tell the picker nothing and must be looked up by hand).`,
    };
  }
  if (input.boxes > cap) {
    return {
      ok: false, code: 'over_cap',
      reason: `${input.boxes} boxes exceeds the ${cap}-box ceiling for one run — narrow the scope to a single day or fewer shows`,
    };
  }
  return { ok: true, buy: input.boxes };
}

/**
 * TikTok's price strings are not plain numbers — the one-box test returned "$4.10". Parse
 * defensively and return null rather than a wrong number: a bad parse silently poisons the
 * average that every later estimate is built on.
 */
export function parsePrice(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null;
  if (typeof raw !== 'string') return null;
  const m = /-?\d+(?:\.\d+)?/.exec(raw.replace(/,/g, ''));
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Rolling spend, so a run is judged against what the last week and month actually cost. */
export interface SpendWindows {
  run_total: number;
  last_7d: { labels: number; spent: number };
  last_30d: { labels: number; spent: number };
  currency: string;
}

/**
 * Total what the ledger says was spent over the trailing windows.
 *
 * Rows with a null price are COUNTED as labels but contribute 0 to spend — those are the
 * "already purchased at TikTok" rows, where a label exists but was bought outside Lensed and
 * its price was never ours to see. Dropping them would undercount the labels; inventing a price
 * would overstate the spend.
 */
export function summarizeLedgerSpend(
  rows: Array<{ price_amount: unknown; purchased_at: unknown }>,
  nowMs: number,
  runTotal = 0,
): SpendWindows {
  const win = (days: number) => {
    const from = nowMs - days * 86_400_000;
    let labels = 0, spent = 0;
    for (const r of rows) {
      const t = Date.parse(String(r.purchased_at ?? ''));
      if (!Number.isFinite(t) || t < from || t > nowMs) continue;
      labels++;
      const p = Number(r.price_amount);
      if (Number.isFinite(p) && p > 0) spent += p;
    }
    return { labels, spent: Math.round(spent * 100) / 100 };
  };
  return {
    run_total: Math.round(runTotal * 100) / 100,
    last_7d: win(7),
    last_30d: win(30),
    currency: 'USD',
  };
}

/** Read the ledger and total the trailing windows. */
/* eslint-disable @typescript-eslint/no-explicit-any */
export async function readSpendWindows(
  admin: any, userId: string, storeId: string, runTotal = 0,
): Promise<SpendWindows> {
  const { data } = await admin
    .from('shipping_label_purchases')
    .select('price_amount, purchased_at')
    .eq('user_id', userId).eq('store_id', storeId).eq('status', 'purchased')
    .gte('purchased_at', new Date(Date.now() - 30 * 86_400_000).toISOString());
  return summarizeLedgerSpend(data ?? [], Date.now(), runTotal);
}


/** One observed purchase: how many orders the box held, and what its label cost. */
export interface PricePoint { orders: number; price: number }

export interface SizedEstimate {
  boxes: number;
  total: number;
  /** Observed spread, not a confidence interval: the cheapest and dearest this mix has cost. */
  low: number;
  high: number;
  currency: string;
  /** 'history' when every box size had prior sales, 'nearest' when some borrowed a neighbour. */
  basis: 'history' | 'nearest' | 'fallback';
  samples: number;
}

/**
 * Estimate a run from the SIZE of each box, not a flat average.
 *
 * A flat average cannot work here. Measured over the first 21 real purchases, price tracks how
 * many orders a box holds with a correlation of 0.853: a single-order box is about $4.01 and a
 * 20-order combine is $11.45. The Wednesday test run was all large combines, so a $4.24 average
 * built mostly from single-item labels under-predicted $107.65 by 69%.
 *
 * A size with no history borrows the NEAREST size that has some, which is deliberately
 * non-parametric: with 21 points a fitted line would look more authoritative than the data
 * supports, and the observed min and max of a real neighbouring bucket are honest numbers. With
 * no history at all it falls back to the flat measured price.
 *
 * The result carries a RANGE because a single number invites being read as a quote, and there is
 * no quote: Create Packages charges when it is called.
 */
export function estimateForSizes(history: PricePoint[], sizes: number[]): SizedEstimate {
  const clean = history.filter(
    (h) => Number.isFinite(h.price) && h.price > 0 && Number.isFinite(h.orders) && h.orders > 0,
  );
  if (!sizes.length) {
    return { boxes: 0, total: 0, low: 0, high: 0, currency: 'USD', basis: 'fallback', samples: clean.length };
  }

  const buckets = new Map<number, number[]>();
  for (const h of clean) {
    const arr = buckets.get(h.orders) ?? [];
    arr.push(h.price);
    buckets.set(h.orders, arr);
  }

  const stat = (prices: number[]) => ({
    mean: prices.reduce((a, b) => a + b, 0) / prices.length,
    min: Math.min(...prices),
    max: Math.max(...prices),
  });

  let borrowed = false;
  const pick = (size: number) => {
    const exact = buckets.get(size);
    if (exact) return stat(exact);
    if (!buckets.size) return { mean: FALLBACK_UNIT_PRICE, min: FALLBACK_UNIT_PRICE, max: FALLBACK_UNIT_PRICE };
    borrowed = true;
    // Nearest populated size; ties go to the LARGER one, which errs toward over-estimating
    // rather than surprising someone with a bigger bill than the button promised.
    let best = [...buckets.keys()][0];
    for (const k of buckets.keys()) {
      const d = Math.abs(k - size), bd = Math.abs(best - size);
      if (d < bd || (d === bd && k > best)) best = k;
    }
    return stat(buckets.get(best) as number[]);
  };

  let total = 0, low = 0, high = 0;
  for (const size of sizes) {
    const st = pick(size);
    total += st.mean; low += st.min; high += st.max;
  }
  const r = (n: number) => Math.round(n * 100) / 100;
  return {
    boxes: sizes.length,
    total: r(total), low: r(low), high: r(high),
    currency: 'USD',
    basis: !clean.length ? 'fallback' : borrowed ? 'nearest' : 'history',
    samples: clean.length,
  };
}

/** Read the size/price history and estimate a run from its actual box sizes. */
/* eslint-disable @typescript-eslint/no-explicit-any */
export async function estimateSizedSpend(
  admin: any, userId: string, storeId: string, sizes: number[],
): Promise<SizedEstimate> {
  const { data } = await admin
    .from('shipping_label_purchases')
    .select('price_amount, order_ids')
    .eq('user_id', userId).eq('store_id', storeId).eq('status', 'purchased')
    .not('price_amount', 'is', null)
    .order('purchased_at', { ascending: false })
    .limit(PRICE_SAMPLE_SIZE);
  const history: PricePoint[] = (data ?? []).map((r: { price_amount: unknown; order_ids: unknown }) => ({
    orders: Array.isArray(r.order_ids) ? r.order_ids.length : 1,
    price: Number(r.price_amount),
  }));
  return estimateForSizes(history, sizes);
}

/**
 * Read recent prices out of the ledger and size the run.
 *
 * `admin` is untyped so this file can stay import-free and be unit-tested standalone.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export async function estimateSpend(
  admin: any, userId: string, storeId: string, boxes: number,
): Promise<SpendEstimate> {
  const { data } = await admin
    .from('shipping_label_purchases')
    .select('price_amount')
    .eq('user_id', userId).eq('store_id', storeId).eq('status', 'purchased')
    .not('price_amount', 'is', null)
    .order('purchased_at', { ascending: false })
    .limit(PRICE_SAMPLE_SIZE);
  return summarizeSpend((data ?? []).map((r: { price_amount: unknown }) => Number(r.price_amount)), boxes);
}
