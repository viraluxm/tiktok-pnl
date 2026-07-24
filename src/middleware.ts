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
    '/((?!api/integrations|api/cron|api/auth|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
