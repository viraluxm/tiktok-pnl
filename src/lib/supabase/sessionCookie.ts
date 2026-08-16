// Read the stored access token straight out of the request cookies, WITHOUT going through
// supabase.auth.getSession().
//
// WHY THIS EXISTS. getSession() — and getClaims() called with no jwt argument, which delegates to
// it — refreshes the session whenever the access token is within EXPIRY_MARGIN_MS (90s) of expiry,
// and it does so REGARDLESS of `autoRefreshToken: false` (see __loadSession in auth-js: the flag
// governs the background ticker, not the on-demand refresh). Any middleware that calls either one
// is therefore a token REFRESHER racing the browser's own refresher on a rotating refresh token.
// Reading the cookie ourselves and passing the token explicitly to getClaims(token, …) is the only
// way to make the middleware a pure validator.
//
// FORMAT COUPLING, DELIBERATELY MINIMISED. The cookie layout (chunking, the `base64-` prefix,
// base64url encoding) is @supabase/ssr's, so we use ITS OWN exported helpers rather than
// reimplementing them. sessionCookie.test.mjs round-trips through the same package's WRITERS
// (createChunks / stringToBase64URL), so an upstream format change fails in CI instead of at the
// edge.

import { combineChunks, stringFromBase64URL } from '@supabase/ssr';

const BASE64_PREFIX = 'base64-';

/**
 * The auth storage key supabase-js derives for a project: `sb-<project-ref>-auth-token`, where the
 * ref is the first label of the Supabase hostname. Returns null for an unparseable URL so callers
 * can fail transient rather than throw inside middleware.
 */
export function storageKeyForUrl(supabaseUrl: string): string | null {
  try {
    const ref = new URL(supabaseUrl).hostname.split('.')[0];
    return ref ? `sb-${ref}-auth-token` : null;
  } catch {
    return null;
  }
}

/** Minimal shape of what `request.cookies.getAll()` returns. */
export interface CookieLike { name: string; value: string }

/**
 * Reassemble the (possibly chunked) session cookie and pull out the access token.
 *
 * Returns null — never throws — for every failure mode: no cookie, truncated chunks, undecodable
 * base64, non-JSON, or JSON without an access_token. A null here is treated by the caller as
 * "cannot verify", not as "signed out", so a mangled cookie can never manufacture a logout.
 */
export async function readAccessToken(
  cookies: readonly CookieLike[],
  storageKey: string,
): Promise<string | null> {
  try {
    const combined = await combineChunks(storageKey, (chunkName) => {
      const hit = cookies.find((c) => c.name === chunkName);
      return hit ? hit.value : null;
    });
    if (!combined) return null;

    const decoded = combined.startsWith(BASE64_PREFIX)
      ? stringFromBase64URL(combined.slice(BASE64_PREFIX.length))
      : combined;

    const parsed: unknown = JSON.parse(decoded);
    const token = (parsed as { access_token?: unknown } | null)?.access_token;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Does this request carry a Supabase auth cookie at all? Distinguishes "signed out" (no cookie →
 * redirect is correct) from "we could not verify" (cookie present → ride it out). Matches the base
 * and chunked names; over-matches the transient PKCE `-code-verifier` cookie, which is benign
 * (only present mid-OAuth on /auth/*). Kept identical to the previous middleware predicate so
 * authClassification.test.mjs stays accurate.
 */
export function hasSupabaseAuthCookie(cookies: readonly CookieLike[]): boolean {
  return cookies.some((c) => c.name.startsWith('sb-') && c.name.includes('-auth-token'));
}
