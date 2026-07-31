// Hard timeout wrapper for the Edge-Middleware Supabase auth call.
//
// Why this exists (production incident, 2026-07-31): when Supabase Auth
// intermittently hangs or returns 504, supabase-js retries the fetch
// internally. On a protected route the middleware then `await`s getUser() long
// enough to hit Vercel's 25s Edge-Middleware initial-response limit, so EVERY
// protected request (e.g. /dashboard) returns MIDDLEWARE_INVOCATION_TIMEOUT /
// 504. The existing AuthRetryableFetchError fallback only helps when getUser()
// *returns* an error before that 25s kill — a true hang never returns, so the
// fallback never runs and the request is killed instead.
//
// This bounds the wait with a race against a hard timeout far below the 25s
// limit. On timeout the caller treats the result exactly like a transient auth
// failure (ride it out — do NOT sign out and do NOT redirect an existing user).
//
// Kept import-free on purpose so it can be unit-tested by transpiling this .ts
// at runtime (see authTimeout.test.mjs) without needing to resolve any package
// from the temp directory the transpiled module is imported from.

/**
 * Hard cap (ms) on how long middleware waits for Supabase auth before giving up
 * and applying the transient-failure fallback. Chosen in the 3–5s band: high
 * enough to ride out a normal (even once-retried) auth call, yet far below
 * Vercel's 25s Edge-Middleware initial-response limit so the invocation is
 * never killed.
 */
export const AUTH_GETUSER_TIMEOUT_MS = 3500;

/** A Supabase-style getUser() call: resolves with a user (or null) + error. */
export type GetUserLike<TUser> = () => Promise<{
  data: { user: TUser | null };
  error: unknown;
}>;

export interface GetUserTimeoutResult<TUser> {
  data: { user: TUser | null };
  error: unknown;
  /** True iff the call did not settle within timeoutMs (hang / very slow auth). */
  timedOut: boolean;
}

/**
 * Race a Supabase-style getUser() against a hard timeout.
 *
 * Behavior:
 * - Resolves as soon as getUser() settles, passing its result through unchanged
 *   with `timedOut: false` — success and returned-error paths are untouched.
 * - If getUser() rejects, the rejection is normalized to
 *   `{ data: { user: null }, error, timedOut: false }` so this function never
 *   rejects, and a late settlement (e.g. an aborted fetch that rejects after we
 *   already timed out) can never surface as an unhandled rejection.
 * - If neither happens within `timeoutMs`, resolves
 *   `{ data: { user: null }, error: null, timedOut: true }` and invokes
 *   `onTimeout()` (used by the caller to abort the in-flight fetch).
 */
export async function getUserWithTimeout<TUser>(
  getUser: GetUserLike<TUser>,
  {
    timeoutMs = AUTH_GETUSER_TIMEOUT_MS,
    onTimeout,
  }: { timeoutMs?: number; onTimeout?: () => void } = {},
): Promise<GetUserTimeoutResult<TUser>> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<GetUserTimeoutResult<TUser>>((resolve) => {
    timer = setTimeout(() => {
      // Best-effort cancel of the in-flight request; must never throw.
      try {
        onTimeout?.();
      } catch {
        /* ignore abort errors */
      }
      resolve({ data: { user: null }, error: null, timedOut: true });
    }, timeoutMs);
  });

  // Normalize so this branch never rejects (see doc comment). Both `.then`
  // handlers and Promise.race attach handlers, so a late settlement is always
  // handled and never becomes an unhandled rejection.
  const call: Promise<GetUserTimeoutResult<TUser>> = getUser().then(
    (res) => ({
      data: { user: res?.data?.user ?? null },
      error: res?.error ?? null,
      timedOut: false,
    }),
    (error) => ({ data: { user: null }, error, timedOut: false }),
  );

  try {
    return await Promise.race([call, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
