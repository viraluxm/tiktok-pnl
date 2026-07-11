import { createServerClient } from '@supabase/ssr';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // If Supabase is not configured, skip auth checks
  if (!supabaseUrl || !supabaseKey || supabaseUrl.includes('your_supabase')) {
    return supabaseResponse;
  }

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
  });

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  // A refresh/validation call that fails for a TRANSIENT reason (network blip,
  // Supabase 5xx, cold edge) returns { user: null, error } even though the
  // session is still valid. Treat that as "still logged in" for the page shell:
  // redirecting to /login here would log the user out on a temporary glitch.
  // This does NOT weaken data protection — every API route re-checks getUser()
  // and RLS enforces auth.uid(), so a briefly-null shell exposes nothing. A
  // genuinely missing/invalid session (no auth cookie, or a definitive
  // AuthApiError such as an invalid refresh token) still redirects below.
  const hasAuthCookie = request.cookies
    .getAll()
    .some((c) => c.name.startsWith('sb-') && c.name.includes('-auth-token'));
  const transientAuthFailure =
    !user && hasAuthCookie && isAuthRetryableFetchError(error);

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

  // Logged in and trying to access auth pages
  if (user && isAuthPage) {
    return redirectTo('/dashboard');
  }

  // Root path shows landing page for everyone (no redirect)

  return supabaseResponse;
}
