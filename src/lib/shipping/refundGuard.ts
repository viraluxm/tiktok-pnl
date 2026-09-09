/**
 * Whether a refund or cancellation on an order means DO NOT SHIP IT.
 *
 * Why this exists: on 2026-09-08 a picker held a Snore label for a 6-order box from 2026-08-14.
 * The parcel was never dispatched, TikTok refunded the buyer, and the orders closed as COMPLETED
 * with "Refund issued". Nothing in Lensed knew — `parseOrder` captures no refund signal at all —
 * so the only reason it was not packed and shipped is that COMPLETED happens to be in
 * DO_NOT_PACK. Had the same refund landed while the order sat in AWAITING_COLLECTION, the box
 * would have gone out: goods shipped for an order already paid back to the buyer.
 *
 * THE ASYMMETRY DECIDES THE DEFAULT. Holding a box that should have shipped costs a scan and a
 * second look. Shipping a box that was refunded costs the goods and the postage, and cannot be
 * undone. So the rule is: BLOCK UNLESS TIKTOK SAYS THE REQUEST FAILED.
 *
 * That default also means a status string nobody anticipated blocks rather than ships, which is
 * the safe direction for an enum we do not control and cannot enumerate exhaustively. Every
 * decision keeps the raw status so a wrong call is visible in the data rather than silent.
 *
 * No imports: unit-testable without a DB or a DOM.
 */

/** Which endpoint a record came from. Cancellations and returns use different status vocabularies. */
export type RefundKind = 'cancellation' | 'return';

/**
 * Fragments that mean the request DIED and the order therefore stands.
 *
 * Drawn from the vocabulary already handled in /api/tiktok/returns:
 * RETURN_OR_REFUND_REQUEST_WAITING_FOR_SELLER_TO_PROCESS, AWAITING_BUYER_SHIP,
 * SELLER_RECEIVE_AND_CHECK_ITEM, and the CANCELLATION_REQUEST_* family.
 *
 * REJECT / DECLINE / FAIL — the seller or platform refused it; the order is live again.
 * CANCEL_CANCEL, REQUEST_CANCEL, WITHDRAW — the *request itself* was withdrawn, not the order.
 *   This is the one genuinely ambiguous shape: "CANCELLATION_REQUEST_CANCELLED" reads as both
 *   "the order was cancelled" and "the cancellation was cancelled". TikTok means the latter, and
 *   getting it wrong the other way would block real work forever, so it is matched narrowly —
 *   only where CANCEL is immediately qualified by another CANCEL/WITHDRAW token.
 */
const REQUEST_DIED = [
  'REJECT',
  'DECLIN',
  'FAIL',
  'WITHDRAW',
  'CANCEL_CANCEL',
  'REQUEST_CANCEL',
  'CANCELLATION_CANCEL',
];

/**
 * Whether this refund/cancellation record should stop the box being packed.
 *
 * Returns true for completed refunds AND for in-flight ones. An in-flight refund is deliberately
 * blocking: a box shipped while a refund is pending usually becomes a refund anyway, and the
 * parcel is gone.
 */
export function blocksPacking(status: string | null | undefined): boolean {
  const s = String(status ?? '').toUpperCase().replace(/[\s-]+/g, '_');
  if (!s) return true;                                  // unknown state: hold, do not ship
  for (const dead of REQUEST_DIED) if (s.includes(dead)) return false;
  return true;
}

/** A per-order exclusion as the scanner reports it. */
export interface ExcludedLike { order_id: string; reason: string }

/** Reason string stamped on an order held back by this guard. Matched by the UI, so it is a constant. */
export const REASON_CANCELED = 'CANCELED';

/**
 * The headline for a box with nothing left to pack.
 *
 * A picker needs to know WHICH kind of dead box this is, because the action differs: a cancelled
 * order is finished and the label is rubbish, while "already shipped" means go looking for a
 * duplicate. The generic "every order is do-not-pack (cancelled / on-hold / already shipped)"
 * made the picker read six statuses to work out which.
 */
export function packBlockHeadline(excluded: ExcludedLike[]): { title: string; detail: string } {
  const reasons = new Set(excluded.map((e) => String(e.reason ?? '').toUpperCase()));

  const allCanceled = reasons.size > 0
    && [...reasons].every((r) => r === REASON_CANCELED || r === 'CANCELLED' || r === 'CANCELED');
  if (allCanceled) {
    return {
      title: 'ORDER CANCELED, NO NEED TO PACK',
      detail: 'Refunded or cancelled on TikTok. Bin the label — nothing ships for this box.',
    };
  }

  // Mixed, or some other do-not-pack reason. Name what is actually there instead of listing
  // every status the system knows about.
  const shown = [...reasons].slice(0, 3).join(', ');
  return {
    title: 'Nothing to pack',
    detail: `Every order in this box is do-not-pack (${shown}). Set the label aside.`,
  };
}
