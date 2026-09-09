import { notFound } from 'next/navigation';
import { isPreviewRouteAllowed } from '@/lib/preview/gate';
import PayDetailPreview from './PayDetailPreview';

// PAY PERIOD DETAIL REVIEW ROUTE — hosted on Vercel Preview so the whole thing can be clicked
// through on a phone or a laptop, without a local server and without a login.
//
// It renders the REAL components (PayGrid tiles, PayDetailModal, the statement PDF, and the
// existing ShiftEditorModal) against local React state. There is no fork of the production UI and
// no second copy of the payroll math — buildPayStatement, computePay and buildShiftEditPatch are
// the shipping modules — so what you approve here is what ships.
//
// ZERO DATABASE PATH: this route imports no Supabase client, calls no API route and takes no
// token. Editing a row runs the real patch builder and mutates a useState array; nothing else.
//
// NOT AVAILABLE IN PRODUCTION. The gate denies VERCEL_ENV==='production' (and fails closed on
// anything unrecognised), so lensed.io 404s this path even if the branch were merged by accident.
export const dynamic = 'force-dynamic'; // the gate reads env per request; never prerender/cache

export const metadata = { title: 'Pay Period Detail — Preview', robots: { index: false, follow: false } };

export default function PreviewPayDetailPage() {
  if (!isPreviewRouteAllowed()) notFound();
  return <PayDetailPreview />;
}
