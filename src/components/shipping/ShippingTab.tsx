'use client';

/**
 * ShippingTab — foundation placeholder.
 *
 * This will become the post-live reconciliation + P&L area: TikTok orders,
 * finance/payouts, and returns synced in after the stream and matched against
 * the logged live-auction rows (by seller SKU + paid time + quantity + price)
 * to produce the final per-auction P&L. No sync or reconciliation logic yet.
 */
export default function ShippingTab() {
  return (
    <div className="flex flex-col items-center justify-center text-center py-20 px-6 rounded-2xl border border-tt-border bg-tt-card">
      <span className="mb-4 inline-flex items-center gap-2 rounded-full border border-tt-border bg-tt-card-hover px-3 py-1 text-xs font-medium text-tt-cyan">
        Coming soon
      </span>

      <h2 className="text-xl font-semibold text-tt-text">Shipping</h2>

      <p className="mt-3 max-w-md text-sm leading-relaxed text-tt-muted">
        After the live, TikTok order, payout, refund, and settlement data will sync
        in here and reconcile against your logged auction rows.
      </p>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-tt-muted">
        The result is the final P&amp;L: auction #, SKUs, order ID, cost, payout,
        profit, ROI, margin, units, and canceled/refunded status.
      </p>
    </div>
  );
}
