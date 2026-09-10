import { notFound } from 'next/navigation';
import { isPreviewRouteAllowed } from '@/lib/preview/gate';
import PortalPreview from './PortalPreview';

// EMPLOYEE PORTAL REVIEW ROUTE — the redesigned /s/[token] app, clickable on a phone or a laptop
// with no login and no employee token.
//
// It renders the REAL portal (PortalApp and every screen, sheet and flow under
// src/components/portal) against an in-memory world through the PortalClient seam the app already
// has. There is no fork of the production UI: what you approve here is what ships.
//
// ZERO DATABASE PATH: this route imports no Supabase client, calls no API route, takes no token.
// Every button mutates a useState object. noWrites.test.mjs asserts that structurally.
//
// NOT AVAILABLE IN PRODUCTION: isPreviewRouteAllowed denies VERCEL_ENV==='production' and fails
// closed on anything unrecognised (src/lib/preview/gate.test.mjs pins that).
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Employee Portal — Preview', robots: { index: false, follow: false } };

export default function PreviewEmployeePortalPage() {
  if (!isPreviewRouteAllowed()) notFound();
  return <PortalPreview />;
}
