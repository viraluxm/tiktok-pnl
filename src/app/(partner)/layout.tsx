import StationSessionRefresher from '@/components/station/StationSessionRefresher';

// Server component. Sibling route group to (app), (auth) and (station) — for the external-seller
// (role='partner') pages.
//
// ─── WHY THIS GROUP EXISTS AT ALL ───
// It deliberately does NOT call useExtensionAuth. That hook lives in (app)/layout.tsx and hands
// the signed-in session to the capture extension; a partner legitimately owns a store, so the
// relay's eligibility guard passes them, and a partner signing into lensed.io in the Chrome
// profile running our capture extension would silently replace its JWT with theirs — captures
// would then write under their user_id, accepted by own-row RLS, invisible to us. Keeping partner
// pages out of (app) is what makes that impossible rather than merely unlikely. It is the same
// reason (station) does not mount it. DO NOT add the relay here.
//
// It also mounts no ChatWidget: the assistant answers owner-scoped payroll and P&L questions.
//
// Access control is middleware role confinement (PARTNER_CONFINEMENT in src/lib/supabase/claims.ts)
// plus each route's own server-side check (requirePartnerScope) — never this layout. There is no
// client-side getUser() gate here, matching (station).
//
// StationSessionRefresher renders NOTHING; it keeps the access token fresh. Required for the same
// reason as in (station): the middleware validates but no longer rotates tokens, so without an
// autoRefresh ticker on the page the session would lapse ~60 minutes after sign-in and bounce the
// seller to /login mid-show. It adopts the existing cookie session and never establishes one.
export default function PartnerLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <StationSessionRefresher />
      {children}
    </>
  );
}
