import SellerNav from '@/components/seller/SellerNav';
import SellerShop from '@/components/seller/SellerShop';

export const dynamic = 'force-dynamic';

// /seller — an external seller's home. Their shop, their connection state, their sync.
//
// Nothing on this page reads our data. The store list comes from the caller's own store_members
// rows and the sync acts on their own tiktok_connections; see SellerShop.
export default function SellerHomePage() {
  return (
    <div className="min-h-screen bg-tt-bg px-4 py-6 md:px-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-lg font-bold text-tt-text mb-1">My shop</h1>
        <p className="text-xs text-tt-muted mb-5">
          Your shop, your orders, your labels. Sell from the shared inventory, print your labels here,
          and send them over for us to pack.
        </p>
        <SellerNav active="shop" />
        <SellerShop />
      </div>
    </div>
  );
}
