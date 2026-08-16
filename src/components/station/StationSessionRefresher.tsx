'use client';

import { useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';

/**
 * Keeps the station/member session's access token fresh. Renders nothing.
 *
 * WHY THIS IS REQUIRED. Until the middleware became a validator it was the ONLY thing refreshing
 * a session on this route: /fulfillment mounts no Supabase browser client of its own (the
 * (station) layout is deliberately bare — no app chrome, no client auth gate), so there was no
 * autoRefresh ticker anywhere on the page. With the middleware no longer rotating, nothing would
 * refresh the station token and it would lapse 60 minutes after sign-in, at which point the
 * operator gets bounced to /login mid-shift — every hour, by construction.
 *
 * WHAT IT DOES. Instantiating the browser client ADOPTS the session already present in cookies and
 * starts auth-js's own autoRefreshToken ticker (30s tick, refreshes inside a 90s expiry margin).
 * That ticker, plus auth-js's visibilitychange handler, is what keeps a screen that sits open for
 * a whole shift alive.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never calls signIn/signUp and never establishes a NEW
 * session — it only adopts the existing one. That distinction matters: per CLAUDE.md, anything
 * that ESTABLISHES a different Supabase session on a host machine replaces the capture
 * extension's JWT via onMessageExternal and silently misattributes captures. Adopting an existing
 * cookie session creates no new session and pushes nothing to the extension (that relay lives in
 * useExtensionAuth, which is mounted only in the (app) tree and is NOT used here).
 *
 * The client is a module-level singleton in @supabase/ssr, so mounting this alongside any other
 * consumer (e.g. MemberNav on /team/*) yields ONE client and ONE refresher — never two racing.
 */
export default function StationSessionRefresher() {
  useEffect(() => {
    // Adopt the cookie session; this starts the autoRefresh ticker for the life of the page.
    createClient();
  }, []);

  return null;
}
