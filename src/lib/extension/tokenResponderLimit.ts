// Rate-limiting policy for the web app's "pull" token responder (see useExtensionAuth).
//
// THE PROBLEM. The responder answers every `LENSED_REQUEST_TOKEN` postMessage by calling
// supabase.auth.getSession(), with no dedupe, no cooldown and no ceiling. getSession() REFRESHES
// whenever the access token is within EXPIRY_MARGIN_MS (90s) of expiry, so a caller that asks in a
// loop drives unbounded token minting. Any script running on the page can send that message — it
// is same-origin postMessage, not an authenticated channel.
//
// This is not hypothetical: one owner session rotated 99 refresh tokens in 15 minutes on
// 2026-08-16 (a strictly linear chain, i.e. one client asking over and over), against a shared
// per-IP Supabase budget of 150 token refreshes per 5 minutes for the whole warehouse. A 429 there
// is non-retryable in auth-js, so it destroys the session and signs the device out.
//
// THE POLICY, in two independent layers:
//   1. Cooldown — repeat requests inside COOLDOWN_MS are answered from the last token we already
//      handed out. Collapses a hot loop into at most one mint per 5s.
//   2. Ceiling  — at most MAX_MINTS_PER_WINDOW mints per rolling minute. The cooldown alone caps
//      the rate at 12/min; the ceiling is the backstop for request patterns that dodge it, and the
//      thing that makes the bound explicit rather than emergent.
//
// Pure and import-free so it is unit-testable without a DOM.

export const COOLDOWN_MS = 5_000;
export const WINDOW_MS = 60_000;
/** Deliberately far above legitimate use: the extension pulls once per 401, and its own recovery
 *  alarm runs at 1/min. Anything approaching this is a loop, not a workload. */
export const MAX_MINTS_PER_WINDOW = 10;

export interface LimiterState {
  /** When the currently cached token was minted. -Infinity = nothing cached yet. */
  cachedAt: number;
  /** Start of the current rolling window. */
  windowStart: number;
  /** Mints performed inside the current window. */
  count: number;
}

export const initialState = (): LimiterState => ({
  cachedAt: Number.NEGATIVE_INFINITY,
  windowStart: Number.NEGATIVE_INFINITY,
  count: 0,
});

export type Decision =
  /** Answer from cache — no getSession(), so no possible refresh. */
  | { action: 'serve-cached' }
  /** Mint: call getSession() and cache the result. */
  | { action: 'mint' }
  /** Over the ceiling. Do NOT mint. Answer from cache if we have one, else answer null. */
  | { action: 'throttled'; mintsInWindow: number };

/**
 * `hasCached` matters because a cooldown is only serviceable when there is something to serve;
 * the very first request in a session must mint even though no time has passed.
 */
export function decide(state: LimiterState, nowMs: number, hasCached: boolean): Decision {
  if (hasCached && nowMs - state.cachedAt < COOLDOWN_MS) return { action: 'serve-cached' };

  const inWindow = nowMs - state.windowStart < WINDOW_MS;
  const count = inWindow ? state.count : 0;
  if (count >= MAX_MINTS_PER_WINDOW) return { action: 'throttled', mintsInWindow: count };

  return { action: 'mint' };
}

/** Advance the state after a mint actually happened. Rolls the window when it has elapsed. */
export function afterMint(state: LimiterState, nowMs: number): LimiterState {
  const inWindow = nowMs - state.windowStart < WINDOW_MS;
  return {
    cachedAt: nowMs,
    windowStart: inWindow ? state.windowStart : nowMs,
    count: (inWindow ? state.count : 0) + 1,
  };
}

/**
 * Refresh the cache timestamp when a token arrives from somewhere other than a pull — i.e. the
 * push path (onAuthStateChange). Keeps the cooldown serving the NEWEST token rather than a stale
 * one, and costs no mint because the SDK produced it for its own reasons.
 */
export function afterPush(state: LimiterState, nowMs: number): LimiterState {
  return { ...state, cachedAt: nowMs };
}
