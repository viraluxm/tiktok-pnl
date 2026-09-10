import SellerNav from '@/components/seller/SellerNav';
import SellerInventory from '@/components/seller/SellerInventory';

export const dynamic = 'force-dynamic';

// /seller/inventory — the shared catalog the seller sells from. Read-only.
//
// This is the ONE thing on the seller side that shows our data, and it is the point of the
// arrangement. Quantities are the real shared stock (their sale depletes the same batches ours
// does), so what they see here is what is actually on the shelf.
export default function SellerInventoryPage() {
  return (
    <div className="min-h-screen bg-tt-bg px-4 py-6 md:px-8">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-lg font-bold text-tt-text mb-1">Inventory</h1>
        <p className="text-xs text-tt-muted mb-5">
          Shared stock you can sell. Quantities are live — what you see is what is on the shelf.
        </p>
        <SellerNav active="inventory" />
        <SellerInventory />
      </div>
    </div>
  );
}
