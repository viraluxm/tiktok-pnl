// Squish over-bind audit — the shared shape + the server-side re-verification of the flag.
//
// The flag itself is computed in SQL (squish_multibind_audit_as, migration 129). This module holds
// the ONE rule the write routes must re-check for themselves before they touch stock: a client can
// post any order_id it likes, and "unbind then re-bind" is not a write you want to run on an order
// that was never actually over-bound. So /api/member/audit/keep and /dismiss read the order's real
// lines back out of the DB and run them through `flagReason` — the same two conditions the RPC's
// HAVING clause uses — and refuse when they don't hold.
//
// Keep this in lockstep with the HAVING clause in 129. If one changes, both change.

export const SQUISH = 'squish';

export interface AuditLine {
  sku_id: string;
  sku_number: number | null;
  title: string | null;
  qty: number;
  unit_cost_cents: number | null;
  category: string | null;
  thumbnail_url?: string | null;
}

export interface AuditRow {
  order_id: string;
  item_id: string;
  session_id: string | null;
  store_id: string | null;
  bound_at: string;
  ordered_at: string | null;
  units: number;
  line_count: number;
  tiktok_title: string | null;
  buyer_handle: string | null;
  won_price_cents: number | null;
  lot_hint: string | null;
  tiktok_status: string | null;
  tracking_number: string | null;
  // Pack state (migration 135). pack_verified = a shipment_verifications row exists for the order.
  // unpacked = no such row AND the platform still says AWAITING_SHIPMENT/AWAITING_COLLECTION — the
  // ONLY state in which the keep-one correction is right in both the stock and the COGS books.
  pack_verified: boolean;
  unpacked: boolean;
  lines: AuditLine[];
}

// Total physical units bound to the order. This — NOT the number of lines — is the flag: the
// same-item-scanned-twice case is ONE line with qty 2 (is_bundle is false for it).
export function boundUnits(lines: Pick<AuditLine, 'qty'>[]): number {
  return lines.reduce((n, l) => n + (Number(l.qty) || 0), 0);
}

// null  → the order IS a valid audit target (over-bound, all squish): the caller may proceed.
// string → why it is NOT, verbatim enough to return to the client.
export function flagReason(lines: Pick<AuditLine, 'qty' | 'category'>[]): string | null {
  if (!lines.length) return 'Order has no bound SKU lines';
  const units = boundUnits(lines);
  if (units <= 1) return `Order has ${units} unit bound — nothing to correct`;
  // Electronics ARE bundled on purpose, so a bundle containing anything that is not a squish is
  // out of scope. An untagged SKU (category null) is also out of scope: we cannot claim it is a
  // squish, and guessing here would delete a real bundle's lines.
  const offenders = [...new Set(lines.map((l) => l.category).filter((c) => c !== SQUISH))];
  if (offenders.length) {
    const shown = offenders.map((c) => c ?? 'untagged').join(', ');
    return `Not a squish-only order (also: ${shown}) — out of audit scope`;
  }
  return null;
}

// ── The dismiss verdict ─────────────────────────────────────────────────────────────────────────
//
// Two dismissals mean opposite things and must stay countable apart (migration 141):
//   keep_multi  the order is legitimate — they really bought two
//   too_late    it WAS an over-bind, but the units are packed or shipped, so it cannot be corrected
//
// ~424 flagged orders are already gone. Filing those as keep_multi would say "not an error" about
// a real one, and would permanently merge them into the legitimate population — the exact set you
// would need to count for a COGS-only cleanup later.
//
// DERIVED FROM THE DB, NEVER FROM THE CLIENT. The page's row is a snapshot; a box can get packed
// between render and click. Deriving server-side means the later fact wins. Packing only ever moves
// forward, so a row shown as too-late can never become fixable — the only possible drift is a
// "legitimate" claim on a box that has since been packed, and recording too_late there is the more
// truthful of the two.
//
// MIRRORS the `unpacked` expression in migration 140. If that rule changes, change this with it —
// same standing obligation as flagReason above and the HAVING clause.
export const SHIPPED_STATUSES = ['IN_TRANSIT', 'DELIVERED', 'COMPLETED'];

export type DismissVerdict = 'keep_multi' | 'too_late';

export function dismissVerdict(facts: { packVerified: boolean; status: string | null }): DismissVerdict {
  const unpacked = !facts.packVerified && !SHIPPED_STATUSES.includes(facts.status ?? '');
  return unpacked ? 'keep_multi' : 'too_late';
}
