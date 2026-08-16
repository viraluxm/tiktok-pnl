import BadgeAdmin from '@/components/employees/BadgeAdmin';

export const dynamic = 'force-dynamic';

// Owner-only badge administration page. Under the (app) owner shell — the owner session issues and
// revokes badges and enables the kiosk. (The kiosk surface itself is the top-level /kiosk route.)
export default function AdminBadgesPage() {
  return (
    <div className="mx-auto max-w-3xl p-6">
      <BadgeAdmin />
    </div>
  );
}
