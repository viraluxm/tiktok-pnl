import { createServerClient } from '@supabase/ssr';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';
import { getUserWithTimeout } from './authTimeout';

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // If Supabase is not configured, skip auth checks
  if (!supabaseUrl || !supabaseKey || supabaseUrl.includes('your_supabase')) {
    return supabaseResponse;
  }

  // Abort the in-flight Supabase auth request if it blows past the hard timeout
  // applied below, so a hung call is actively cancelled instead of being left to
  // run against Vercel's 25s Edge-Middleware limit. Wired through the client's
  // own `fetch` so the AbortController reaches the ACTUAL network request that
  // supabase-js makes (and every internal retry it makes on the same signal).
  const authAbort = new AbortController();

  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value)
        );
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options)
        );
      },
    },
    global: {
      fetch: (input, init) =>
        fetch(input, { ...init, signal: authAbort.signal }),
    },
  });

  // Bound the auth call with a hard timeout (see ./authTimeout). Supabase Auth
  // intermittently hangs / returns 504 and supabase-js retries internally;
  // without this cap the middleware runs until Vercel's 25s Edge limit and every
  // protected route 504s (MIDDLEWARE_INVOCATION_TIMEOUT). A timeout surfaces as
  // `timedOut` and is treated as a transient failure below — never a forced
  // logout.
  const {
    data: { user },
    error,
    timedOut,
  } = await getUserWithTimeout(() => supabase.auth.getUser(), {
    onTimeout: () => authAbort.abort(),
  });

  // A refresh/validation call that fails for a TRANSIENT reason (network blip,
  // Supabase 5xx, cold edge) returns { user: null, error } even though the
  // session is still valid. A call that HANGS past our hard timeout (timedOut)
  // is the same class of event — Supabase Auth is momentarily unavailable — and
  // is treated identically. Treat both as "still logged in" for the page shell:
  // redirecting to /login here would log the user out on a temporary glitch.
  // This does NOT weaken data protection — every API route re-checks getUser()
  // and RLS enforces auth.uid(), so a briefly-null shell exposes nothing. A
  // genuinely missing/invalid session (no auth cookie, or a definitive
  // AuthApiError such as an invalid refresh token) still redirects below.
  const hasAuthCookie = request.cookies
    .getAll()
    .some((c) => c.name.startsWith('sb-') && c.name.includes('-auth-token'));
  const transientAuthFailure =
    !user && hasAuthCookie && (timedOut || isAuthRetryableFetchError(error));

  // Build a redirect that preserves any refreshed/rotated auth cookies Supabase
  // wrote onto supabaseResponse. Without this, a token refresh that coincides
  // with a redirect discards the new cookies (the classic @supabase/ssr footgun)
  // and strands the browser on a consumed refresh token. Only sb-* cookies are
  // ever written to supabaseResponse, so this never touches the active-store or
  // OAuth-verifier cookies (those are set by route handlers via next/headers).
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
  // Role confinement (station / member). These roles are set in Supabase via
  // app_metadata.role and are hard-confined to a tiny allowlist: they can reach
  // ONLY their own pages + API namespace, nothing else. Owner/admin sessions
  // (role undefined or 'admin') are NOT confined and retain full access,
  // including /fulfillment and /team.
  //
  // This branch runs BEFORE the OAuth-callback whitelist and the auth-page
  // bounce below, so a confined session cannot slip through either: e.g. a
  // station user hitting /auth/tiktok/callback or /login is bounced to its role
  // home rather than reaching the callback handler or the /dashboard bounce.
  //
  // Transient-auth fallback: if Supabase Auth briefly returns no user but a
  // `lensed_station` cookie is present, treat the session as station and apply
  // the station allowlist — otherwise a token-refresh blip would drop a station
  // out of confinement (and the /login redirect below would log it out).
  // Station reach is a fixed allowlist. Member reach is SCOPE-DERIVED from app_metadata.scopes:
  // each scope maps 1:1 to its /team page + the owner-scoped /api/member/* routes THAT page uses,
  // and a member's allowlist is the UNION over the scopes it holds. The shared binding-flow routes
  // (catalog/sessions/unbound/bind) live under the 'binding' scope that uses them; 'inventory' adds
  // only its own page + /api/member/inventory. A scope this map doesn't know contributes nothing
  // (fail closed). NOTE: '/api/team' (self-scoped fulfillment-performance) is deliberately NOT
  // reachable — member data comes only from owner-scoped /api/member/*.
  const STATION_CONFINEMENT = { home: '/fulfillment', allow: ['/fulfillment', '/api/station'] };
  // The badge time-clock kiosk account (app_metadata.role='timeclock'). THIS is the security
  // boundary for the kiosk login: it is confined to the kiosk page and its API namespace ONLY —
  // '/kiosk' plus '/api/kiosk/*' and nothing else. It can never reach the dashboard, employees data,
  // or any other owner surface. Each /api/kiosk/* route additionally re-checks the role via
  // requireTimeclockScope and runs service-role, owner-from-app_metadata (never client input).
  const TIMECLOCK_CONFINEMENT = { home: '/kiosk', allow: ['/kiosk', '/api/kiosk'] };
  const MEMBER_SCOPE_PATHS: Record<string, string[]> = {
    binding: ['/team/binding', '/api/member/unbound', '/api/member/sessions', '/api/member/bind', '/api/member/catalog'],
    inventory: ['/team/inventory', '/api/member/inventory'],
  };
  const memberConfinement = (rawScopes: unknown): { home: string; allow: string[] } => {
    const scopes = Array.isArray(rawScopes) ? rawScopes.map(String) : [];
    const allow = [...new Set(scopes.flatMap((s) => MEMBER_SCOPE_PATHS[s] ?? []))];
    const first = scopes.find((s) => MEMBER_SCOPE_PATHS[s]); // home = first RECOGNIZED scope's page
    // A member with no recognized scope gets an EMPTY allowlist and is sent to the static
    // "no areas assigned" page. Home is ALWAYS reachable (the `path === confinement.home` check
    // below), so this page renders even with an empty allowlist and never loops — unlike '/login',
    // which would bounce them straight back into the sign-in they just completed. It makes no data
    // reads and no API calls.
    return { home: first ? MEMBER_SCOPE_PATHS[first][0] : '/team/no-access', allow };
  };

  // `lensed_station` is a confinement HINT only — never an authentication
  // signal, and it must never gate data access. We honour it solely to keep an
  // already-authenticated station confined while Supabase Auth briefly cannot
  // return the user object, so it is ANDed with transientAuthFailure (sb-* auth
  // cookie present + retryable/timeout error) — our evidence that a real
  // session exists. A lensed_station cookie WITHOUT that session evidence is
  // ignored: it grants nothing and never widens or unlocks access.
  const hasStationCookie = request.cookies
    .getAll()
    .some((c) => c.name === 'lensed_station');
  // Mirror of the station hint for the badge/QR kiosk: an unattended wall tablet must stay confined
  // during a transient auth blip (user momentarily null) instead of resolving to an UNCONFINED
  // session that can reach /dashboard. Hint only, ANDed with transientAuthFailure — grants nothing
  // without sb-* session evidence.
  const hasTimeclockCookie = request.cookies
    .getAll()
    .some((c) => c.name === 'lensed_timeclock');
  const role =
    (user?.app_metadata?.role as string | undefined) ??
    (transientAuthFailure && hasStationCookie ? 'station'
      : transientAuthFailure && hasTimeclockCookie ? 'timeclock'
      : undefined);
  const roleHome =
    role === 'station' ? '/fulfillment'
      : role === 'member' ? memberConfinement(user?.app_metadata?.scopes).home
      : role === 'timeclock' ? '/kiosk'
      : '/dashboard';

  // Set the confinement HINT cookie for a CONFIRMED timeclock session (user present, role from
  // app_metadata), so a later transient auth blip keeps the kiosk confined via hasTimeclockCookie
  // above. It grants nothing on its own — the read path ANDs it with transientAuthFailure. (NOTE:
  // lensed_station has no setter — dormant since #137; this adds one for timeclock. Station should
  // get the same, tracked separately.)
  if (user && (user.app_metadata?.role as string | undefined) === 'timeclock') {
    supabaseResponse.cookies.set('lensed_timeclock', '1', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
  }

  // Fail closed: only an unset role or 'admin' is unconfined. ANY other value —
  // including a typo like 'statoin', or a member holding no recognized scope — is
  // a confined role with an EMPTY (or scope-limited) allowlist, never full access.
  // A new role/scope must be added above to gain any reach.
  const confinement: { home: string; allow: string[] } | undefined =
    role === undefined || role === 'admin'
      ? undefined
      : role === 'station'
        ? STATION_CONFINEMENT
        : role === 'member'
          ? memberConfinement(user?.app_metadata?.scopes)
          : role === 'timeclock'
            ? TIMECLOCK_CONFINEMENT
            : { home: '/login', allow: [] as string[] };
  if (confinement) {
    const path = request.nextUrl.pathname;
    // A confined role can always reach its own home, so the page redirect below
    // never loops when the home path isn't otherwise in the allowlist.
    const allowed =
      path === confinement.home ||
      confinement.allow.some((p) => path === p || path.startsWith(p + '/'));
    if (allowed) {
      // Confined session on one of its own paths — nothing else to enforce.
      // Return here so the !user /login redirect below never fires for a
      // station riding out a transient auth failure on an allowed path.
      return supabaseResponse;
    }
    // Non-allowlisted: hard 403 for API, bounce to role home for pages. This
    // also covers root '/' (not in any allowlist → redirect to role home).
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

  // Not logged in and trying to access protected route — but ride out a
  // transient auth-endpoint failure instead of manufacturing a logout.
  if (!user && !transientAuthFailure && !isAuthPage && request.nextUrl.pathname !== '/') {
    return redirectTo('/login');
  }

  // Logged in and trying to access auth pages. Confined roles are already
  // handled above (station/member never reach here), so roleHome is /dashboard for
  // owner/admin — but keep it role-aware for correctness.
  if (user && isAuthPage) {
    return redirectTo(roleHome);
  }

  // Root path shows landing page for everyone (no redirect)

  return supabaseResponse;
}
