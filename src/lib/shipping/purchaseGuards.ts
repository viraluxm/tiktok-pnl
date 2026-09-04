// The checks that stand between a reviewed plan and spending money.
//
// NO IMPORTS — purchaseGuards.test.mjs transpiles this file standalone at runtime.
//
// WHY THESE EXIST AT ALL. TikTok's Create Packages call IS the purchase: it returns a price,
// but by the time that price is readable the label is bought, tracking is issued and there is
// no cancel. So every safeguard has to sit BEFORE the first call — there is no reconsidering
// halfway through, and no endpoint that quotes a run before committing to it.

/**
 * Hard ceiling on the `limit` a single call may ask for.
 *
 * This bounds the INVOCATION, not the plan: a backlog bigger than this is bought in successive
 * calls, each re-verified against TikTok. Chosen from real volume — the Snore test set held
 * 356 boxes and a normal day is that order of magnitude — so one legitimate day fits in one
 * call while the worst a single call can do stays bounded at roughly $1,600 rather than
 * unbounded.
 *
 * It is the backstop, not the primary control. `limit` is required on every call precisely so
 * that the real ceiling is the one the caller names, visible in the request itself.
 */
export const MAX_BOXES_PER_RUN = 400;

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

export interface AuthorizeInput {
  /** LABEL_PURCHASE_ENABLED === '1'. Anything else means log-only. */
  enabled: boolean;
  /** Boxes this run resolved, after removing everything already in the ledger. */
  boxes: number;
  /** The count the caller read on the dry run and is authorising. Null when absent. */
  confirmBoxes: number | null;
  /**
   * REQUIRED ceiling on how many of those boxes this invocation may buy. Null when absent,
   * which is refused — see authorizeRun.
   */
  limit: number | null;
  cap?: number;
}

export type AuthorizeRefusal =
  | 'disabled'
  | 'nothing_to_buy'
  | 'confirm_missing'
  | 'confirm_mismatch'
  | 'limit_missing'
  | 'limit_invalid'
  | 'over_cap';

export type AuthorizeResult =
  | { ok: true; buy: number }
  | { ok: false; code: AuthorizeRefusal; reason: string };

/**
 * Whether a purchase run may proceed, and how many boxes it may buy.
 *
 * TWO INDEPENDENT CHECKS DO THE WORK, AND THEY GUARD DIFFERENT THINGS.
 *
 * `confirmBoxes` guards against a plan that MOVED. The caller passes the box count it saw on
 * the dry run and it must match exactly, so if a show ended, a sync landed, or another run
 * bought something in between, this refuses rather than buying a plan nobody read.
 * "Approximately what I approved" is not good enough when every difference is a paid label.
 *
 * `limit` guards against a plan that is LARGE. It is a separate concern, and confirmBoxes does
 * nothing for it: a caller that reads the dry run and passes its count straight back through —
 * which is exactly what a "Print labels" button would naturally do — is perfectly consistent
 * and would buy the entire backlog in one click. So `limit` is REQUIRED and has no default.
 * A request cannot express "buy everything"; it has to name a number, and that number is
 * bounded by the cap. The worst a single call can do is therefore always visible in the call
 * itself.
 *
 * Because every invocation is bounded by `limit`, a backlog LARGER than the cap is no longer
 * refused outright — it is bought in successive capped runs, each one re-verified against
 * TikTok. The cap now bounds the invocation rather than the plan, which is the thing that
 * actually spends money.
 */
export function authorizeRun(input: AuthorizeInput): AuthorizeResult {
  const cap = input.cap ?? MAX_BOXES_PER_RUN;
  if (!input.enabled) {
    return { ok: false, code: 'disabled', reason: 'LABEL_PURCHASE_ENABLED is not 1 — log-only' };
  }
  if (!Number.isFinite(input.boxes) || input.boxes <= 0) {
    return { ok: false, code: 'nothing_to_buy', reason: 'no boxes left to buy' };
  }
  if (input.confirmBoxes == null) {
    return {
      ok: false, code: 'confirm_missing',
      reason: 'confirm_boxes is required — read the dry run and pass the box count it reports',
    };
  }
  if (input.confirmBoxes !== input.boxes) {
    return {
      ok: false, code: 'confirm_mismatch',
      reason: `plan moved since it was reviewed: confirm_boxes=${input.confirmBoxes} but ${input.boxes} boxes now resolve — re-read the dry run`,
    };
  }
  if (input.limit == null) {
    return {
      ok: false, code: 'limit_missing',
      reason: `limit is required — the most boxes this call may buy (1-${cap}). There is deliberately no default: a request must name its own ceiling rather than inherit "all of them".`,
    };
  }
  if (!Number.isInteger(input.limit) || input.limit < 1) {
    return {
      ok: false, code: 'limit_invalid',
      reason: `limit must be a whole number of at least 1, got ${input.limit}`,
    };
  }
  if (input.limit > cap) {
    return {
      ok: false, code: 'over_cap',
      reason: `limit=${input.limit} exceeds the ${cap}-box ceiling for one call`,
    };
  }
  // A limit above what is left is not an error — it simply buys what there is.
  return { ok: true, buy: Math.min(input.limit, input.boxes) };
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
