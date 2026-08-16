import StationSessionRefresher from '@/components/station/StationSessionRefresher';

// Server component. Sibling route group to (app) and (auth). Deliberately has
// NO client-side getUser() gate and NO app chrome (sidebar/nav): station/member
// pages are hard-confined by middleware role confinement, not by a client
// layout, and must render bare. Access control lives in
// src/lib/supabase/middleware.ts (role === 'station' | 'member' allowlist) and in
// each route/page's own server-side getUser() check.
//
// StationSessionRefresher renders NOTHING — it exists solely to keep the access token fresh.
// Required since the middleware became a validator that no longer rotates tokens: /fulfillment
// mounts no Supabase browser client of its own, so without this there is no autoRefresh ticker
// anywhere on the page and the session would lapse ~60 minutes after sign-in, bouncing the
// operator to /login mid-shift. It adopts the EXISTING cookie session; it never signs in and
// never establishes a new one (see the component for why that distinction matters).
export default function StationLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <StationSessionRefresher />
      {children}
    </>
  );
}
