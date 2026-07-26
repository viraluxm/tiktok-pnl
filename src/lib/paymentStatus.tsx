// Display-only badge for a not_sold auction's payment recovery state.
//
// PRIMARY SOURCE: synced_order_ids.status — TikTok's real, post-sweep order status
// (refreshed by the order sync). We prefer this because capture_events.order_status is
// a WRITE-ONCE snapshot frozen at capture time (the extension never refreshes it), so a
// payment that was "pending" (2) when captured still reads 2 forever even after TikTok
// cancelled or paid it. Reading the synced status tells the truth.
//
// FALLBACK: capture_events.order_status (the frozen snapshot) — used ONLY when the order
// isn't present in synced_order_ids yet (not swept). Tri-state:
//   2 = payment pending, 3 = paid/recovered, 4 = cancelled, null/other = unknown.
//
// This is purely a read; it never flips or writes anything. It's the human-visible
// version of what the retroactive-flip sweep will automate.

// TikTok statuses that mean the money is IN — a not_sold row in one of these is a real
// paid sale sitting mislabeled (needs a flip to sold). Mirrors the PAID set used by the
// reconcile route (src/app/api/live/sessions/[id]/reconcile/route.ts).
const PAID_STATUSES = new Set([
  'AWAITING_SHIPMENT',
  'AWAITING_COLLECTION',
  'IN_TRANSIT',
  'DELIVERED',
  'COMPLETED',
]);
const FAILED_STATUSES = new Set(['CANCELLED', 'UNPAID']);

export interface NotSoldBadge {
  label: string;
  cls: string;        // tailwind classes for the badge span
  prominent: boolean; // draw the eye (recoverable money)
  needsFlip: boolean; // TikTok-confirmed paid but still not_sold → the money-surfacing state
}

// True when a not_sold row is TikTok-confirmed PAID (synced status in the PAID set) → it
// should be flipped to sold. Exported so callers can count "needs flip" without
// re-deriving the badge. Only meaningful for not_sold rows.
export function paidNeedsFlip(syncedStatus: string | null | undefined): boolean {
  return !!syncedStatus && PAID_STATUSES.has(syncedStatus.toUpperCase());
}

const PROMINENT_GREEN =
  'inline-flex items-center rounded-md bg-tt-green/20 px-2 py-0.5 font-semibold text-tt-green ring-1 ring-tt-green/50';
const PROMINENT_AMBER =
  'inline-flex items-center rounded-md bg-amber-500/20 px-2 py-0.5 font-semibold text-amber-300 ring-1 ring-amber-400/50';

export function notSoldBadge(
  syncedStatus: string | null,
  orderStatus: number | null,
  paymentFailed: boolean,
): NotSoldBadge {
  // ── PRIMARY: the truthful, refreshed TikTok status ──
  if (syncedStatus) {
    const s = syncedStatus.toUpperCase();
    if (PAID_STATUSES.has(s)) {
      // Real money on a not_sold row: filled green chip so it can't be missed.
      return { label: 'PAID — needs flip', cls: PROMINENT_GREEN, prominent: true, needsFlip: true };
    }
    if (FAILED_STATUSES.has(s)) {
      return { label: 'Failed', cls: 'text-tt-red', prominent: false, needsFlip: false };
    }
    if (s === 'ON_HOLD') {
      return { label: 'On hold', cls: 'text-amber-400', prominent: false, needsFlip: false };
    }
    // Unrecognized synced status → drop through to the snapshot fallback below.
  }

  // ── FALLBACK: frozen capture snapshot (order not in synced_order_ids, or unknown status) ──
  switch (orderStatus) {
    case 2:
      return { label: 'Pending', cls: 'text-amber-400', prominent: false, needsFlip: false };
    case 3:
      return { label: '⚠ Recovered — needs review', cls: PROMINENT_AMBER, prominent: true, needsFlip: false };
    case 4:
      return { label: 'Failed', cls: 'text-tt-red', prominent: false, needsFlip: false };
    default:
      return paymentFailed
        ? { label: 'Payment failed', cls: 'text-tt-red', prominent: false, needsFlip: false }
        : { label: 'Not sold', cls: 'text-tt-muted', prominent: false, needsFlip: false };
  }
}
