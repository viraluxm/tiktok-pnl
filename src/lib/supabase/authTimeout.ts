// Hard timeout wrapper for the ONE remaining network leg in the Supabase auth path at the edge:
// the JWKS cold-miss fetch.
//
// HISTORY. This file was written for a production incident (2026-07-31) in which Supabase Auth
// intermittently hung or 504'd; the middleware `await`ed getUser() long enough to hit Vercel's 25s
// Edge-Middleware limit, so EVERY protected request returned MIDDLEWARE_INVOCATION_TIMEOUT. It
// bounded that wait at 3.5s and aborted the in-flight request.
//
// WHY IT CHANGED. The middleware no longer calls getUser() and no longer refreshes: it verifies
// the access token locally against a pinned JWKS (see ./jwks). Local verification is
// decodeJWT + crypto.subtle.verify — no network, sub-millisecond — so the old 3.5s budget was
// guarding nothing on the happy path. The only call that can still touch the network is
// auth-js's fetchJwk() after a signing-key ROTATION, when the pinned key set misses.
//
// TWO DELIBERATE CHANGES FROM THE OLD SHAPE:
//  1. Budget cut 3500 → 1500ms. A single GET to a CDN-cached well-known endpoint does not need
//     three and a half seconds, and this now sits in front of a rare path, not every request.
//  2. NO abort. The old version aborted the in-flight fetch, which was a correctness bug: if that
//     request was a token REFRESH, GoTrue had already rotated and committed by the time we
//     cancelled reading the response, stranding the browser on a consumed refresh token. A JWKS
//     GET is an idempotent read that mutates no state, so letting a late one complete is harmless
//     — we simply stop waiting for it. The `onTimeout` hook is kept for observability (logging),
//     NOT for cancellation.
//
// Kept import-free on purpose so it can be unit-tested by transpiling this .ts at runtime (see
// authTimeout.test.mjs) without needing to resolve any package from the temp directory.

/**
 * Hard cap (ms) on how long the middleware waits for a JWKS fetch before giving up and applying
 * the transient-failure fallback (render the shell; never redirect to /login because a key
 * endpoint was slow). Far below Vercel's 25s Edge-Middleware limit, and only ever reached on a
 * signing-key rotation.
 */
export const JWKS_FETCH_TIMEOUT_MS = 1500;

/** A call that resolves with a value and/or an error, Supabase-style. */
export type TimedCall<T> = () => Promise<{ data: T | null; error: unknown }>;

export interface TimeoutResult<T> {
  data: T | null;
  error: unknown;
  /** True iff the call did not settle within timeoutMs. */
  timedOut: boolean;
}

/**
 * Race a Supabase-style call against a hard timeout.
 *
 * Behavior:
 * - Resolves as soon as the call settles, passing its result through unchanged with
 *   `timedOut: false` — success and returned-error paths are untouched.
 * - If the call rejects, the rejection is normalized to `{ data: null, error, timedOut: false }`
 *   so this function never rejects, and a late settlement can never surface as an unhandled
 *   rejection.
 * - If neither happens within `timeoutMs`, resolves `{ data: null, error: null, timedOut: true }`
 *   and invokes `onTimeout()` (observability only — nothing is cancelled).
 */
export async function withAuthTimeout<T>(
  call: TimedCall<T>,
  {
    timeoutMs = JWKS_FETCH_TIMEOUT_MS,
    onTimeout,
  }: { timeoutMs?: number; onTimeout?: () => void } = {},
): Promise<TimeoutResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<TimeoutResult<T>>((resolve) => {
    timer = setTimeout(() => {
      // Best-effort notification; must never throw.
      try {
        onTimeout?.();
      } catch {
        /* ignore */
      }
      resolve({ data: null, error: null, timedOut: true });
    }, timeoutMs);
  });

  // Normalize so this branch never rejects (see doc comment). Both `.then` handlers and
  // Promise.race attach handlers, so a late settlement is always handled.
  const settled: Promise<TimeoutResult<T>> = call().then(
    (res) => ({ data: res?.data ?? null, error: res?.error ?? null, timedOut: false }),
    (error) => ({ data: null, error, timedOut: false }),
  );

  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
