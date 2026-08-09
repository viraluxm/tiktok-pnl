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
    // NOTE: `s/` excludes the public tokenized employee routes (/s/[token]/*). They must NEVER
    // hit updateSession — establishing/refreshing a Supabase auth session on a host machine would
    // clobber the capture extension's JWT (see the auth-session section in CLAUDE.md). `s/` matches
    // only `/s/…` (not /shows, /settings — they have no slash after the `s`).
    '/((?!api/integrations|api/cron|api/auth|s/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
