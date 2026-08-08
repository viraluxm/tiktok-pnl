// Server component. Sibling route group to (app) and (auth). Deliberately has
// NO client-side getUser() gate and NO app chrome (sidebar/nav): station/VA
// pages are hard-confined by middleware role confinement, not by a client
// layout, and must render bare. Access control lives in
// src/lib/supabase/middleware.ts (role === 'station' | 'va' allowlist) and in
// each route/page's own server-side getUser() check.
export default function StationLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
