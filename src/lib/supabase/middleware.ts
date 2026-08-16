import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';
import { JWKS_FETCH_TIMEOUT_MS, withAuthTimeout } from './authTimeout';
import { headerOf, parsePinnedKeys, pinnedKids, type PinnedJwk } from './jwks';
import { hasSupabaseAuthCookie, readAccessToken, storageKeyForUrl } from './sessionCookie';
import {
  appRoleFromClaims,
  confinementFor,
  isExpired,
  isPathAllowed,
  memberConfinement,
  roleHomeFor,
  type AuthClaims,
} from './claims';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE MIDDLEWARE VALIDATES. IT DOES NOT REFRESH.
//
// It used to call supabase.auth.getUser(), which loads the session and — when the access token is
// within 90s of expiry — calls /auth/v1/token to ROTATE it. That made every edge invocation a
// second token refresher racing the browser's own, on a rotating refresh token with a 60s reuse
// interval. The loser of that race gets 400 refresh_token_already_used, which auth-js classifies
// as non-retryable, destroys the session, and emits SIGNED_OUT → the operator is bounced to
// /login mid-shift for no reason. (Observed in prod: sessions created in a browser whose
// auth.sessions.user_agent had been overwritten to 'Vercel Edge Functions' — i.e. last refreshed
// by this file.)
//
// Now: read the access token from the cookie, verify its SIGNATURE locally against a pinned JWKS,
// read the role from the claims. Zero network I/O on the happy path, and nothing is rotated.
//
// CONSEQUENCE — REVOCATION IS NOT INSTANT HERE. A locally-verified JWT is accepted until its own
// `exp`, so a server-side revocation (or an app_metadata role/scope change) takes up to jwt_exp
// (3600s) to affect ROUTING. That is safe only because this file gates no data: every API route
// re-checks getUser() over the network and RLS enforces auth.uid(). Do NOT build a middleware
// decision here that needs real-time revocation. See CLAUDE.md.
// ─────────────────────────────────────────────────────────────────────────────────────────────

// ─── THE VERIFIER CLIENT IS DELIBERATELY COOKIE-LESS AND STORAGE-LESS ───
// We pass the access token to getClaims() explicitly, so this client needs no cookie access at
// all. Giving it none makes "this cannot refresh" ARCHITECTURAL rather than a property of how we
// happen to call it: with persistSession:false there is no cookie-backed session for it to load,
// rotate, or clear.
//
// It also removes a real failure mode. createServerClient()'s cookie adapter makes the
// constructor kick off initialize() → _recoverAndRefresh() → storage.getItem(), which on a
// MALFORMED auth cookie throws asynchronously, outside any try/catch we control, as an
// UNHANDLED REJECTION (verified: `base64-@@@garbage` in the auth cookie reproduces it by
// construction alone). That is pre-existing behavior — the previous middleware built the same
// client — but there is no reason to keep carrying it.
//
// Cookie handling for the RESPONSE (the lensed_timeclock hint and the redirect copy loop) stays
// explicit below; it never needed the Supabase client.
//
// Hoisted to module scope: the client is stateless here, so one per isolate rather than one per
// request. Safe precisely because it holds no session.
let verifierClient: SupabaseClient | null = null;
function getVerifier(url: string, key: string): SupabaseClient {
  if (!verifierClient) {
    verifierClient = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return verifierClient;
}

/** Verified claims plus how much we trust them right now. */
interface Verified {
  claims: AuthClaims | null;
  /** Signature verified AND not past `exp`. */
  fresh: boolean;
  /** We could not verify for an INFRASTRUCTURE reason (rotation + unreachable JWKS, timeout). */
  unverifiable: boolean;
}

async function verifyAccessToken(
  supabase: SupabaseClient,
  token: string,
  keys: PinnedJwk[],
): Promise<Verified> {
  // Log a pinned-key MISS before handing over — that means the signing key rotated and auth-js is
  // about to go to the network. This is an operational event we want visible in logs, not
  // absorbed silently.
  const header = headerOf(token);
  if (header?.kid && !pinnedKids(keys).includes(header.kid)) {
    console.warn(
      `[middleware] JWKS pinned-key MISS: token kid=${header.kid} alg=${header.alg ?? '?'} not in pinned set ` +
        `[${pinnedKids(keys).join(', ')}] — falling back to a network fetch. Update SUPABASE_JWKS.`,
    );
  }

  // Two reasons this call is wrapped rather than awaited directly:
  //   1. getClaims can THROW rather than return { error } — validateExp raises a plain Error
  //      ('JWT has expired'), which is not an AuthError and so is rethrown. An unhandled throw
  //      here would 500 every request. withAuthTimeout normalizes any rejection to
  //      { data: null, error }. (We also pass allowExpired, so that particular throw cannot fire.)
  //   2. It bounds the one remaining network leg — a JWKS fetch after a key rotation.
  //
  // allowExpired: we verify the SIGNATURE here and decide freshness ourselves (below), so that an
  // expired-but-authentic token still yields a trustworthy role. Without this, a station whose
  // token lapsed would present as role-less and fall into the UNCONFINED branch — a confinement
  // fail-OPEN. Authentic-but-stale claims are strictly better evidence than the hint cookies.
  const { data, error, timedOut } = await withAuthTimeout<{ claims: AuthClaims }>(
    async () => {
      const res = await supabase.auth.getClaims(token, { keys, allowExpired: true });
      return { data: res.data as { claims: AuthClaims } | null, error: res.error };
    },
    {
      timeoutMs: JWKS_FETCH_TIMEOUT_MS,
      onTimeout: () =>
        console.warn('[middleware] JWKS fetch exceeded timeout — treating as transient, NOT a logout'),
    },
  );

  if (timedOut) return { claims: null, fresh: false, unverifiable: true };

  if (error || !data?.claims) {
    // A network/fetch failure while chasing a rotated key is infrastructure; a bad signature is
    // not. isAuthRetryableFetchError would only cover the former, and getClaims surfaces a JWKS
    // fetch failure as a thrown/returned request error, so treat a MISSING pinned key as the
    // infrastructure case and everything else as definitive.
    const pinnedMiss = !!header?.kid && !pinnedKids(keys).includes(header.kid);
    return { claims: null, fresh: false, unverifiable: pinnedMiss };
  }

  const claims = data.claims;
  return { claims, fresh: !isExpired(claims, Date.now()), unverifiable: false };
}

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // If Supabase is not configured, skip auth checks
  if (!supabaseUrl || !supabaseKey || supabaseUrl.includes('your_supabase')) {
    return supabaseResponse;
  }

  const supabase = getVerifier(supabaseUrl, supabaseKey);

  // Cookie STAGING, kept explicit now that the Supabase client no longer owns a cookie adapter.
  // This is the `setAll` behavior, preserved: stage onto the request (so downstream sees it) and
  // rebuild supabaseResponse so the value is emitted. Nothing in this file rotates any more, so
  // the only current caller is the lensed_timeclock hint below — but a future code path that DOES
  // write an auth cookie must not silently drop it, which is the same class of bug as the
  // aborted-refresh discard this change removes.
  const stageCookie = (
    name: string,
    value: string,
    options: Parameters<typeof supabaseResponse.cookies.set>[2],
  ) => {
    request.cookies.set(name, value);
    supabaseResponse = NextResponse.next({ request });
    supabaseResponse.cookies.set(name, value, options);
  };

  const allCookies = request.cookies.getAll();
  const hasAuthCookie = hasSupabaseAuthCookie(allCookies);

  const { keys, malformed } = parsePinnedKeys(process.env.SUPABASE_JWKS);
  if (malformed) {
    console.error('[middleware] SUPABASE_JWKS is set but unparseable — using the pinned fallback key set');
  }

  const storageKey = storageKeyForUrl(supabaseUrl);
  const accessToken = storageKey ? await readAccessToken(allCookies, storageKey) : null;

  const verified: Verified = accessToken
    ? await verifyAccessToken(supabase, accessToken, keys)
    : { claims: null, fresh: false, unverifiable: false };

  // "Authenticated" for routing purposes = signature verified AND not expired.
  const authenticated = !!verified.claims && verified.fresh;

  // Ride out anything that is not a definitive signed-out:
  //   • authentic claims that merely EXPIRED — the browser client refreshes on its own timer and
  //     on visibilitychange; bouncing here would manufacture the logout we are trying to prevent;
  //   • a JWKS timeout / rotation we could not chase.
  // A missing cookie, or a token whose SIGNATURE does not verify, is still a definitive redirect.
  const transientAuthFailure =
    !authenticated && hasAuthCookie && (verified.unverifiable || (!!verified.claims && !verified.fresh));

  // Build a redirect that preserves any cookies staged on supabaseResponse. Auth no longer stages
  // any — but the lensed_timeclock confinement hint below DOES, and dropping it across a redirect
  // would silently un-confine an unattended kiosk on the next auth blip. Keep this loop.
  const redirectTo = (pathname: string) => {
    const url = request.nextUrl.clone();
    url.pathname = pathname;
    const redirect = NextResponse.redirect(url);
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      redirect.cookies.set(cookie);
    });
    return redirect;
  };

  // ---------------------------------------------------------------------------
  // Role confinement (station / member / timeclock). Roles are set in Supabase via
  // app_metadata.role and are hard-confined to a tiny allowlist: they can reach ONLY their own
  // pages + API namespace, nothing else. Owner/admin sessions (role undefined or 'admin') are NOT
  // confined and retain full access, including /fulfillment and /team.
  //
  // This branch runs BEFORE the OAuth-callback whitelist and the auth-page bounce below, so a
  // confined session cannot slip through either.
  //
  // ROLE SOURCE — read the full note in ./claims: the app role is `claims.app_metadata.role`.
  // `claims.role` is the POSTGRES role ('authenticated') and reading it here would confine every
  // user in the app.
  //
  // The hint cookies below remain as a last resort for the case where we hold NO claims at all
  // (unverifiable token). With allowExpired verification they are rarely reached, since an
  // expired-but-authentic token still carries the real role.
  const hasStationCookie = allCookies.some((c) => c.name === 'lensed_station');
  const hasTimeclockCookie = allCookies.some((c) => c.name === 'lensed_timeclock');

  const claimsRole = appRoleFromClaims(verified.claims);
  const role =
    claimsRole ??
    (transientAuthFailure && hasStationCookie ? 'station'
      : transientAuthFailure && hasTimeclockCookie ? 'timeclock'
        : undefined);
  const scopes = verified.claims?.app_metadata?.scopes;
  const roleHome = roleHomeFor(role, scopes);

  // Set the confinement HINT cookie for a CONFIRMED timeclock session, so a later blip that
  // leaves us with no claims at all still keeps the kiosk confined. It grants nothing on its own
  // — the read path ANDs it with transientAuthFailure.
  if (authenticated && claimsRole === 'timeclock') {
    stageCookie('lensed_timeclock', '1', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
  }

  const confinement = confinementFor(role, scopes);
  if (confinement) {
    const path = request.nextUrl.pathname;
    if (isPathAllowed(path, confinement)) {
      // Confined session on one of its own paths — nothing else to enforce. Return here so the
      // !authenticated /login redirect below never fires for a role riding out a transient
      // failure on an allowed path.
      return supabaseResponse;
    }
    // Non-allowlisted: hard 403 for API, bounce to role home for pages. This also covers root '/'.
    if (path.startsWith('/api/')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    return redirectTo(confinement.home);
  }

  // OAuth callbacks under /auth must reach their route handlers
  const isOAuthCallback = request.nextUrl.pathname.startsWith('/auth/tiktok/callback');

  const isAuthPage =
    !isOAuthCallback && (
      request.nextUrl.pathname.startsWith('/login') ||
      request.nextUrl.pathname.startsWith('/signup') ||
      request.nextUrl.pathname.startsWith('/auth')
    );

  // Not logged in and trying to access a protected route — but ride out a transient failure
  // instead of manufacturing a logout.
  if (!authenticated && !transientAuthFailure && !isAuthPage && request.nextUrl.pathname !== '/') {
    return redirectTo('/login');
  }

  // Logged in and trying to access auth pages. Confined roles are already handled above, so
  // roleHome is /dashboard for owner/admin — but keep it role-aware for correctness.
  if (authenticated && isAuthPage) {
    return redirectTo(roleHome);
  }

  // Root path shows landing page for everyone (no redirect)

  return supabaseResponse;
}

// Re-exported so callers/tests can reach the confinement tables from one place.
export { memberConfinement };
