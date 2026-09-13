import { notFound } from 'next/navigation';
import { isPreviewRouteAllowed } from '@/lib/preview/gate';
import CapacityPreview from './CapacityPreview';

// MANAGER STAFFING-CAPACITY REVIEW ROUTE (migration 156).
//
// Renders the REAL StaffingCapacityPanel and ShiftRequestsPanel against an in-memory world, at the
// scale the business actually runs — ten Live Host setups — so the numbers in the brief
// (4/10, 8/10, 10/10 fully staffed, a custom capacity of 7, and an over-capacity day) can be
// checked visually without touching a database.
//
// ZERO DATABASE PATH: the panel is given its preview props, which disable its query and route every
// edit through a pure world transition. noWrites.test.mjs asserts that seam structurally.
//
// NOT AVAILABLE IN PRODUCTION: isPreviewRouteAllowed denies VERCEL_ENV==='production' and fails
// closed on anything unrecognised.
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Staffing Capacity Preview', robots: { index: false, follow: false } };

export default function PreviewStaffingCapacityPage() {
  if (!isPreviewRouteAllowed()) notFound();
  return <CapacityPreview />;
}
