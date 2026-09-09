import PartnerNav from '@/components/partner/PartnerNav';
import LabelsPanel from '@/components/shipping/LabelsPanel';

export const dynamic = 'force-dynamic';

// /partner/labels — the seller buys and prints labels for their OWN orders.
//
// This is a straight reuse of the owner's LabelsPanel, and it is safe for the reason that made it
// worth reusing: every route it calls (/api/shipping/labels/*) filters user_id AND store_id, and
// it resolves "which store" from useStores() — i.e. the caller's own store_members rows — never
// from a parameter it is handed. A partner therefore sees only their own boxes and buys only their
// own labels, with no partner-specific branch anywhere in the flow.
//
// They print, then send the labels to us; we pick from the shelf. That is why this page exists and
// why we never need access to their account.
export default function PartnerLabelsPage() {
  return (
    <div className="min-h-screen bg-tt-bg px-4 py-6 md:px-8">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-lg font-bold text-tt-text mb-1">Labels</h1>
        <p className="text-xs text-tt-muted mb-5">
          Buy and print shipping labels for your own orders, then send them to us to pack.
        </p>
        <PartnerNav active="labels" />
        <LabelsPanel />
      </div>
    </div>
  );
}
