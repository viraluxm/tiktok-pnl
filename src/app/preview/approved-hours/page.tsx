import { notFound } from 'next/navigation';
import { isPreviewRouteAllowed } from '@/lib/preview/gate';
import ApprovedHoursPreview from './ApprovedHoursPreview';

// APPROVED-HOURS ROLE REVIEW ROUTE — the surface this change actually alters.
//
// It renders the REAL DayPeopleModal, PendingConfirmModal and PersonCard against local React
// state, so what is approved here is what ships. There is no fork of the production tile.
//
// ZERO DATABASE PATH: no Supabase client, no API route, no token, no real employee. Confirming
// mutates a useState array through the same approvedMinutesForTeam() gate the write path uses.
//
// NOT AVAILABLE IN PRODUCTION. The gate denies VERCEL_ENV==='production' (and fails closed on
// anything unrecognised), so lensed.io 404s this path even if the branch were merged by accident.
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Approved Hours by role — Preview', robots: { index: false, follow: false } };

export default function PreviewApprovedHoursPage() {
  if (!isPreviewRouteAllowed()) notFound();
  return <ApprovedHoursPreview />;
}
