// Which boxes are safe to buy a label for, before any of them cost money.
//
// NO IMPORTS — candidateGate.test.mjs transpiles this file standalone at runtime.
//
// THE HARM BEING PREVENTED. Buying a label locks an order into its own parcel. If TikTok later
// combines it with a sibling, that combine cannot happen: you ship two parcels where one would
// have done, pay twice, and the buyer gets two boxes. So a box is only safe once its combine
// group has stopped growing.
//
// WHY AN AGE FLOOR RATHER THAN "IS A SHOW LIVE". The previous rule looked each candidate up in
// live_auction_items to see whether it belonged to a running session. That has a hole: an order
// from the show happening right now has no auction-item row until it is captured and bound, so
// it is INVISIBLE to the lookup. Measured 2026-09-04 with five sessions heartbeating, 68 such
// orders (52 boxes) sailed straight through, caught only by an unrelated "no SKUs bound"
// exclusion — luck, not design, and it would evaporate the moment those orders were bound.
//
// Group growth is a property of the ORDER'S AGE, not of session bookkeeping, and a young order
// is young whether or not anyone captured it. Measured over 7,651 real multi-order groups on
// Snore: median span 14 minutes, p90 1.7h, p95 2.9h, p99 5.9h, max 23.9h — 91.8% fully formed
// within 2h and 99.1% within 6h. So an age floor closes the hole completely and is calibrated
// to what the data actually does.
//
// THE UNIT IS THE BOX, NOT THE ORDER. A group is only settled when its YOUNGEST member is old
// enough; gating per order would buy a label for the old half of a group that is still growing,
// which is precisely the split shipment above.

/**
 * How old every order in a box must be before its label may be bought, in hours.
 *
 * 6 sits just past the measured p99 group span of 5.9h, so ~99% of groups are provably finished
 * forming. The residual ~1% costs one extra label when it happens; waiting for the 23.9h
 * maximum would stall a whole day's fulfilment to avoid it, which is the worse trade for an
 * operation that ships daily.
 */
export const MIN_ORDER_AGE_HOURS = 6;

/** A box as the gate sees it: its orders and when each was created. */
export interface GateBox {
  group_key: string;
  orders: Array<{ order_id: string; order_created_at: string | null }>;
}

export type GateVerdict = { ok: true } | { ok: false; reason: string };

/** Parse to epoch ms, or null if absent/unparseable. */
function createdMs(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * Whether every order in a box is old enough that its combine group has settled.
 *
 * An order with NO usable creation time is treated as TOO YOUNG, not as old. That is the
 * direction that costs nothing when wrong: refusing to buy is recoverable, buying a label for
 * a group still forming is not. It is also reported distinctly, so a systematic gap in
 * order_created_at shows up as a named exclusion rather than as a silently shrinking plan.
 */
export function gateByAge(
  box: GateBox,
  nowMs: number,
  minAgeHours: number = MIN_ORDER_AGE_HOURS,
): GateVerdict {
  if (!box.orders.length) return { ok: false, reason: 'box has no orders' };
  const cutoff = nowMs - minAgeHours * 3_600_000;

  const undated = box.orders.filter((o) => createdMs(o.order_created_at) === null);
  if (undated.length) {
    return {
      ok: false,
      reason: `no usable order date on ${undated.length} of ${box.orders.length} order(s) — cannot prove the box has settled`,
    };
  }

  // The youngest member decides: the group is still open until its newest order has aged out.
  const youngest = Math.max(...box.orders.map((o) => createdMs(o.order_created_at) as number));
  if (youngest > cutoff) {
    // A future date means clock skew somewhere. Still held back — it is certainly not aged —
    // but say so plainly rather than reporting a negative age at a human.
    if (youngest > nowMs) {
      return { ok: false, reason: 'newest order is dated in the future — cannot prove the box has settled' };
    }
    const ageH = (nowMs - youngest) / 3_600_000;
    return {
      ok: false,
      reason: `newest order is ${ageH.toFixed(1)}h old, under the ${minAgeHours}h floor — group may still be combining`,
    };
  }
  return { ok: true };
}

/**
 * Whether every order in a box is confirmed still awaiting shipment.
 *
 * A PARTIAL BOX IS REFUSED OUTRIGHT. If one order in a combine group has already moved on, the
 * old code kept the remaining orders and bought a label covering only those — a ship_type 3
 * call naming a subset of the group. What TikTok does with that is untested, and the plausible
 * outcomes are all bad: a rejected call, or a package covering fewer orders than the parcel
 * actually contains. Refusing the box costs one manual look; guessing costs a mis-shipped
 * parcel and a label that has to be voided.
 */
export function gateByVerifiedStatus(
  box: GateBox,
  statusByOrder: Map<string, string>,
): GateVerdict {
  const bad: string[] = [];
  for (const o of box.orders) {
    const s = statusByOrder.get(o.order_id);
    if (s !== 'AWAITING_SHIPMENT') bad.push(`${o.order_id}=${s ?? 'not found'}`);
  }
  if (!bad.length) return { ok: true };
  if (bad.length === box.orders.length) {
    return { ok: false, reason: `TikTok says ${bad.map((b) => b.split('=')[1]).join(', ')}` };
  }
  return {
    ok: false,
    reason: `partial box — ${bad.length} of ${box.orders.length} orders have moved on (${bad.join(', ')}); refusing to label a subset of a combine group`,
  };
}

/** Group flat candidate rows into boxes. The group id, or the order alone. */
export function groupIntoBoxes(
  rows: Array<{ order_id: string; auto_combine_group_id: string | null; order_created_at: string | null }>,
): GateBox[] {
  const byKey = new Map<string, GateBox>();
  for (const r of rows) {
    const key = r.auto_combine_group_id ?? `order:${r.order_id}`;
    const box = byKey.get(key);
    const entry = { order_id: r.order_id, order_created_at: r.order_created_at };
    if (box) box.orders.push(entry);
    else byKey.set(key, { group_key: key, orders: [entry] });
  }
  // Stable order so two runs over unchanged data plan identically.
  for (const b of byKey.values()) b.orders.sort((a, z) => a.order_id.localeCompare(z.order_id));
  return [...byKey.values()].sort((a, z) => a.group_key.localeCompare(z.group_key));
}
