import CaptureRelay from '@/components/extension/CaptureRelay';
import StationSessionRefresher from '@/components/station/StationSessionRefresher';

// Server component. Sibling route group to (app), (auth) and (station) — for the external-seller
// (role='seller') pages.
//
// ─── WHY THIS GROUP EXISTS ───
// To keep an external seller out of (app): our dashboard, our numbers, Team, payroll, admin and
// the assistant. It mounts no ChatWidget — the assistant answers owner-scoped payroll and P&L
// questions.
//
// ─── THE RELAY, AND WHY IT IS HERE NOW ───
// This layout originally refused to mount the relay at all. The reason was real: a seller owns a
// store, so the eligibility check passes them, and a seller signing into lensed.io in the Chrome
// profile running OUR capture extension would have replaced its JWT with theirs — captures
// writing under their user_id, accepted by own-row RLS, invisible to us.
//
// But the seller runs the capture extension too — that is how their sales deplete the shared
// stock — and an unrelayed extension never gets a token, so it never captures, so nothing
// depletes. Withholding the relay here did not avoid the problem; it moved it.
//
// What actually resolves it is per-profile capture binding (@/lib/extension/captureBinding): a
// browser profile captures as exactly one account. The seller's own machine binds to them and
// works; a warehouse machine stays bound to the owner and REFUSES their session, visibly. So the
// gate is no longer "which route group are you in", which never was the real question.
//
// Access control is middleware role confinement (SELLER_CONFINEMENT in src/lib/supabase/claims.ts)
// plus each route's own server-side check (requireSellerScope) — never this layout. There is no
// client-side getUser() gate here, matching (station).
//
// StationSessionRefresher renders NOTHING; it keeps the access token fresh. Required for the same
// reason as in (station): the middleware validates but no longer rotates tokens, so without an
// autoRefresh ticker on the page the session would lapse ~60 minutes after sign-in and bounce the
// seller to /login mid-show. It adopts the existing cookie session and never establishes one.
export default function SellerLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <StationSessionRefresher />
      {children}
      <CaptureRelay />
    </>
  );
}
