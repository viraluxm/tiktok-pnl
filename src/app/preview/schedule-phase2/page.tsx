import { notFound } from 'next/navigation';
import { isPreviewRouteAllowed } from '@/lib/preview/gate';
import Phase2Preview from './Phase2Preview';

// PHASE 2 REVIEW ROUTE — hosted on Vercel Preview so the whole UX can be clicked through on a
// phone or a laptop without a local server and without a login.
//
// It renders the REAL Phase 2 components (My Schedule rows, TeamSchedule, DropShiftButton,
// CancelOfferButton, PickUpShiftButton, PickupRequestsPanel) against local React state via the
// `onPreview` seams those components expose. There is no fork of the production UI, so what you
// approve here is what ships.
//
// ZERO DATABASE PATH: this route imports no Supabase client, calls no API route, and takes no
// token. Every button mutates a useState object and nothing else.
//
// NOT AVAILABLE IN PRODUCTION. The gate denies VERCEL_ENV==='production' (and fails closed on
// anything unrecognised), so lensed.io 404s this path even if the branch were merged by accident.
// src/lib/preview/gate.test.mjs pins that.
export const dynamic = 'force-dynamic';   // the gate reads env per request; never prerender/cache

export const metadata = { title: 'Schedule Phase 2 — Preview', robots: { index: false, follow: false } };

export default function PreviewSchedulePhase2Page() {
  if (!isPreviewRouteAllowed()) notFound();
  return <Phase2Preview />;
}
