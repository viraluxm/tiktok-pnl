import { updateSession } from '@/lib/supabase/middleware';
import type { NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    // Exclude /api/integrations/* and /api/cron/* — these are service-role /
    // shared-secret, cookieless server-to-server calls (the latter is Vercel cron,
    // which carries a Bearer CRON_SECRET, not a session cookie). The session
    // redirect must not run on them or it would 307 them to /login before their
    // own auth runs. Each does its own auth.
    '/((?!api/integrations|api/cron|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
