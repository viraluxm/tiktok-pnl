import { notFound } from 'next/navigation';
import { isPreviewRouteAllowed } from '@/lib/preview/gate';
import ShiftsDayPreview from './ShiftsDayPreview';

// SHIFTS DAY + CONFIRM QUEUE REVIEW ROUTE — the surface the calendarModel fix actually changed.
//
// It renders the REAL DayPeopleModal and PendingConfirmModal against local React state, so what is
// approved here is what ships. There is no fork of the production UI and no second copy of the
// day model — buildCalendarDays is the shipping module.
//
// ZERO DATABASE PATH: no Supabase client, no API route, no token. Confirming mutates a useState
// array; nothing else.
//
// NOT AVAILABLE IN PRODUCTION. The gate denies VERCEL_ENV==='production' (and fails closed on
// anything unrecognised), so lensed.io 404s this path even if the branch were merged by accident.
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Shifts Day — Preview', robots: { index: false, follow: false } };

export default function PreviewShiftsDayPage() {
  if (!isPreviewRouteAllowed()) notFound();
  return <ShiftsDayPreview />;
}
