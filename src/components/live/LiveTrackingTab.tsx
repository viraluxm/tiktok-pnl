'use client';

/**
 * LiveTrackingTab — foundation placeholder.
 *
 * This will become the host-facing TikTok Live auction logging area:
 * fast shortcut-key SKU selection, current-selection panel, auction-number
 * tracker, Sold / Not Sold / Canceled / Manual states, cost snapshots, and
 * the live sold log. It does NOT depend on the TikTok API — the live session
 * log is the host's source of truth for what was auctioned.
 */
export default function LiveTrackingTab() {
  return (
    <div className="flex flex-col items-center justify-center text-center py-20 px-6 rounded-2xl border border-tt-border bg-tt-card">
      <span className="mb-4 inline-flex items-center gap-2 rounded-full border border-tt-border bg-tt-card-hover px-3 py-1 text-xs font-medium text-tt-cyan">
        <span className="w-1.5 h-1.5 rounded-full bg-tt-cyan animate-pulse" />
        Coming soon
      </span>

      <h2 className="text-xl font-semibold text-tt-text">Live Tracking</h2>

      <p className="mt-3 max-w-md text-sm leading-relaxed text-tt-muted">
        This is where you&apos;ll log every auction during a TikTok Live, in order — pick a
        SKU by shortcut, set quantity and expected price, and mark each item
        Sold, Not Sold, Canceled, or Manual.
      </p>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-tt-muted">
        Your live session log becomes the source of truth for what was auctioned.
        TikTok order, payout, and refund data will reconcile against it later.
      </p>
    </div>
  );
}
