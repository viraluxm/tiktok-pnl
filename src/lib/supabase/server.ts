import { createServerClient } from '@supabase/ssr';
import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { readAccessToken, storageKeyForUrl } from './sessionCookie';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// STAGE 2: THE SERVER VALIDATES. IT DOES NOT REFRESH.
//
// Stage 1 (5095a199) stopped the MIDDLEWARE from being a second token refresher. It did not touch
// this file, and this file backs ~127 `auth.getUser()` call sites across the API routes — so every
// one of them was still a refresher, and a dashboard load fires many of them at once.
//
// Two distinct failures came out of that, both observed in prod:
//
//   1. THE ROTATION RACE. getUser() loads the cookie session and, when the access token is within
//      EXPIRY_MARGIN_MS (90s) of expiry, calls /auth/v1/token to ROTATE it — regardless of
//      `autoRefreshToken: false`, which governs only the background ticker (see ./sessionCookie).
//      N route handlers plus the browser all rotating one refresh token, against a 60s reuse
//      interval, means somebody loses and gets 400 refresh_token_already_used. auth-js classes
//      that as non-retryable, destroys the session and emits SIGNED_OUT.
//
//   2. THE STALE-COOKIE CLOBBER, which is what made it unrecoverable. A route handler that loaded
//      session S1 writes S1 back through setAll when it responds. If the user re-authenticates
//      while that request is in flight, the late response overwrites the browser's fresh S2 cookie
//      with the dead S1 — so signing in again did not clear the fault, and the next validation
//      failed all over again. That is the loop operators experienced as "it keeps logging us out".
//
// The fix is to make "this cannot refresh" ARCHITECTURAL rather than a matter of how we call it:
// the read/verify client below is built with NO cookie adapter and NO persisted session, so there
// is no session for it to load, rotate, or write back. The access token is read from the cookie
// ourselves and passed as an explicit Authorization header, which
//   • lets auth.getUser() validate it over the network (revocation stays instant — this is still
//     the real security boundary, unlike the middleware's local verification), and
//   • scopes PostgREST/RLS to that user exactly as the cookie session did.
//
// The browser is now the ONLY refresher, which is the single-refresher model CLAUDE.md already
// requires of the capture extension.
//
// CONSEQUENCE — AN EXPIRED TOKEN IS A 401, NOT A SILENT REFRESH. The browser refreshes on its own
// 30s ticker (90s before expiry) and again on visibilitychange, so the cookie is normally fresh;
// a request that loses that narrow race gets one failed fetch, which React Query retries. No
// client path turns a 401 into a sign-out. Do NOT "fix" that by refreshing here — a refresh whose
// result is not persisted to the browser's cookie rotates the token out from under it and causes
// failure 1 above, which is strictly worse than a retry.
// ─────────────────────────────────────────────────────────────────────────────────────────────

function supabaseConfig() {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co',
    key: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder-key',
  };
}

/**
 * The read/verify client, as a pure function of its inputs so the "cannot refresh" property is
 * directly testable without a Next request context (see serverClientNoRefresh.test.mjs).
 *
 * `persistSession: false` leaves auth-js with an in-memory store and no session, so getUser()
 * cannot reach __loadSession's refresh branch. A null token yields a client with no Authorization
 * header at all: getUser() then returns AuthSessionMissingError and callers 401, which is the
 * same answer the cookie-backed client gave for a signed-out request.
 */
export function createBearerClient(
  url: string,
  key: string,
  accessToken: string | null,
): SupabaseClient {
  return createSupabaseClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {},
  });
}

/**
 * The client for every route that READS identity or data. Validates over the network, scopes RLS
 * to the caller, and can neither rotate a token nor write a cookie.
 */
export async function createClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  const { url, key } = supabaseConfig();

  const storageKey = storageKeyForUrl(url);
  const accessToken = storageKey ? await readAccessToken(cookieStore.getAll(), storageKey) : null;

  return createBearerClient(url, key, accessToken);
}

/**
 * The ONLY client permitted to write auth cookies, for the three routes that ESTABLISH a session:
 * the OAuth callback (exchangeCodeForSession), and the login / signup endpoints. Everything else
 * must use createClient() above — a second cookie writer is the clobber described at the top.
 *
 * Establishing a session is not the rotation race: it mints a new token family rather than
 * rotating an existing one, and its write is the authoritative one the browser should adopt.
 */
export async function createAuthFlowClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  const { url, key } = supabaseConfig();

  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // This can be ignored in Server Components
        }
      },
    },
  });
}
