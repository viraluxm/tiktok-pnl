// Where the Phase 2 preview route is allowed to exist.
//
// WHY NODE_ENV IS NOT ENOUGH: a Vercel Preview deployment is a PRODUCTION Next.js build, so
// NODE_ENV === 'production' there just as it does on lensed.io. Gating on NODE_ENV alone would
// either 404 the preview (useless) or expose the route on the live domain (unacceptable). Vercel
// distinguishes them with VERCEL_ENV: 'production' | 'preview' | 'development'.
//
// The rule, stated as a whitelist rather than a blacklist — an unknown value must DENY, so a
// future Vercel change or a missing variable in a production-like host can never open the route:
//   VERCEL_ENV 'preview'      → allowed  (the PR deployment the reviewer clicks through)
//   VERCEL_ENV 'development'  → allowed  (`vercel dev`)
//   VERCEL_ENV 'production'   → DENIED   (lensed.io, even if this branch were merged by accident)
//   VERCEL_ENV unset          → allowed ONLY when NODE_ENV is not 'production', i.e. a local
//                               `npm run dev`. A production build with no VERCEL_ENV — a
//                               self-hosted deploy, say — is DENIED.
export function isPreviewRouteAllowed(
  env: { VERCEL_ENV?: string; NODE_ENV?: string } = process.env as { VERCEL_ENV?: string; NODE_ENV?: string },
): boolean {
  const vercel = env.VERCEL_ENV;
  if (vercel === 'production') return false;
  if (vercel === 'preview' || vercel === 'development') return true;
  if (vercel != null && vercel !== '') return false;   // unknown value → deny
  return env.NODE_ENV !== 'production';                 // no VERCEL_ENV → local dev only
}
