import { updateSession } from '@/lib/supabase/middleware';
import type { NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    // Exclude /api/integrations/*, /api/cron/* and /api/auth/* — these run their
    // own auth and must NOT be caught by the session redirect. /api/integrations
    // and /api/cron are service-role / shared-secret, cookieless server-to-server
    // calls (cron carries a Bearer CRON_SECRET, not a session cookie). /api/auth/*
    // (e.g. signup) is a public, unauthenticated endpoint that does its own IP
    // rate-limiting + validation; without this exclusion a session-less signup POST
    // is 307'd to /login before supabase.auth.signUp() ever runs (signup never
    // executes, no confirmation email sent). Note: the email-confirmation callback
    // lives at /auth/callback (NOT /api/auth), so it is unaffected by this.
    // `preview/` excludes /preview/* for the SAME reason as `s/`: it is a public, session-less
    // review page (the Phase 2 UX demo on Vercel Preview), so it must not run updateSession — that
    // would establish/refresh a Supabase auth session on the reviewer's machine and clobber the
    // capture extension's JWT. It also must load without a login on a phone. The route itself is
    // gated to non-production by src/lib/preview/gate.ts, so production 404s it regardless.
    // NOTE: `s/` excludes the public tokenized employee routes (/s/[token]/*). They must NEVER
    // hit updateSession — establishing/refreshing a Supabase auth session on a host machine would
    // clobber the capture extension's JWT (see the auth-session section in CLAUDE.md). `s/` matches
    // only `/s/…` (not /shows, /settings — they have no slash after the `s`).
    // `p/` and `api/host/` exclude the tokenized PRACTICE HOST route and its API, for exactly the
    // same reason. A practice host is now often an audition candidate on their own phone, holding
    // only an opaque per-session token and NO Lensed account; the whole point of that design is
    // that no Supabase auth session is ever established, so updateSession must not run on either.
    // `p/` matches only `/p/…`, so /products, /privacy, /plans are unaffected (no slash after the
    // `p`). api/host/ is cookieless and authenticates purely by the token in its path.
    '/((?!api/integrations|api/cron|api/auth|api/host/|s/|p/|preview/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
