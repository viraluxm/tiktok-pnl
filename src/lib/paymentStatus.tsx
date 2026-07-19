// Display-only badge for a not_sold auction's payment recovery state.
//
// TikTok's capture_events.order_status is a read-only tri-state:
//   2 = payment pending — the buyer may still pay (recoverable window)
//   3 = paid — the order actually went through; if the auction is still not_sold this
//       is RECOVERED-BUT-UNFLIPPED (real revenue sitting mislabeled → the actionable one)
//   4 = cancelled — permanent failure
//   null/other = unknown → fall back to the existing not_sold / payment_failed label
//
// This is purely a read of order_status; it never flips or writes anything. It's the
// human-visible version of what the future auto-recovery sweep will automate.

export interface NotSoldBadge {
  label: string;
  cls: string;       // tailwind classes for the badge span
  prominent: boolean; // order_status=3 → draw the eye (recoverable money)
}

export function notSoldBadge(orderStatus: number | null, paymentFailed: boolean): NotSoldBadge {
  switch (orderStatus) {
    case 2:
      return { label: 'Pending', cls: 'text-amber-400', prominent: false };
    case 3:
      return {
        label: '⚠ Recovered — needs review',
        // Prominent: filled amber chip + ring + bold, so a paid-but-unflipped order
        // can't be missed in a long list of "Not sold" rows.
        cls: 'inline-flex items-center rounded-md bg-amber-500/20 px-2 py-0.5 font-semibold text-amber-300 ring-1 ring-amber-400/50',
        prominent: true,
      };
    case 4:
      return { label: 'Failed', cls: 'text-tt-red', prominent: false };
    default:
      // Unknown order_status → keep the pre-existing wording/color.
      return paymentFailed
        ? { label: 'Payment failed', cls: 'text-tt-red', prominent: false }
        : { label: 'Not sold', cls: 'text-tt-muted', prominent: false };
  }
}
