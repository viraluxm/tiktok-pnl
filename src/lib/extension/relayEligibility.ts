// May the currently signed-in user's session be relayed to the capture extension?
//
// THE PROBLEM. useExtensionAuth pushes session.access_token to the extension on mount and on
// every auth state change, with no check on WHO is signed in. The extension writes capture_events
// directly to PostgREST under the user_id in that JWT, protected by own-row RLS. So if anyone who
// is not the capture owner signs into lensed.io in the Chrome profile running the extension —
// an admin partner, most plausibly — the extension's JWT is replaced with theirs and captures
// start writing under THEIR user_id. RLS accepts every row (they are legitimately that user's own
// rows), nothing errors anywhere, and the captures simply never appear on the owner's dashboard.
// That is the shape of the 2026-07-22 incident, which orphaned 383 orders.
//
// Counter-intuitively, promoting someone to role='admin' makes this WORSE: admin is unconfined in
// middleware, so they reach /dashboard, which is in the (app) route group, which is the only place
// the relay hook is mounted. The roles that are safe today (station, member, timeclock) are safe
// only because middleware confines them to (station), whose layout does not mount it.
//
// THE RULE. Relay only for a user who OWNS a store — the identity captures are supposed to be
// written under. Anyone else gets no token at all, so the extension shows a reconnect state and
// capture stops VISIBLY, instead of continuing to write under the wrong identity INVISIBLY.
//
// FAIL CLOSED. Anything we cannot resolve to a definitive "yes" is treated as no. A withheld relay
// is recoverable in one reload; a wrongly-relayed token is silent data loss that is only noticed
// days later. Note the asymmetry in what counts as definitive: `eligible: false` and a 403 are
// answers, while a 5xx or a network failure is not — those stay 'unknown' so a caller can retry
// before giving up.
//
// Pure and import-free (fetch is injected) so it is unit-testable without a DOM.

export const RELAY_ELIGIBILITY_PATH = '/api/ext/relay-eligible';

export type Eligibility =
  /** Confirmed store owner — relay. */
  | 'eligible'
  /** Confirmed NOT a store owner (or not signed in, or confined by middleware) — never relay. */
  | 'ineligible'
  /** No answer: server error, network failure, unparseable body. Also never relays, but a caller
   *  may retry, because unlike 'ineligible' this is not an answer about the user. */
  | 'unknown';

/** The single place that decides. 'unknown' is not a maybe — it withholds, exactly like a no. */
export function mayRelay(e: Eligibility): boolean {
  return e === 'eligible';
}

type FetchLike = (input: string, init?: { cache?: RequestCache }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

/** One probe. Never throws — a thrown fetch is 'unknown'. */
export async function probeRelayEligibility(
  fetchImpl: FetchLike,
  path: string = RELAY_ELIGIBILITY_PATH,
): Promise<Eligibility> {
  let res;
  try {
    res = await fetchImpl(path, { cache: 'no-store' });
  } catch {
    return 'unknown';
  }
  // 403 is middleware confinement — a definitive "this account may not have this". Every other
  // non-OK status is a failure to answer, not an answer.
  if (!res.ok) return res.status === 403 ? 'ineligible' : 'unknown';
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return 'unknown';
  }
  const eligible = (body as { eligible?: unknown } | null)?.eligible;
  if (eligible === true) return 'eligible';
  if (eligible === false) return 'ineligible';
  return 'unknown'; // a 200 whose shape we don't recognise is not a yes
}

export interface ResolveOpts {
  /** Extra attempts after the first, used ONLY for 'unknown'. A definitive answer never retries. */
  retries?: number;
  /** Backoff before attempt n (1-indexed). */
  delayMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
  path?: string;
}

/**
 * Probe, retrying only while the answer is 'unknown'. Retries exist so a cold edge or a blip does
 * not stop capture on the owner's own machine; they never soften a definitive 'ineligible'.
 */
export async function resolveRelayEligibility(
  fetchImpl: FetchLike,
  opts: ResolveOpts = {},
): Promise<Eligibility> {
  const retries = opts.retries ?? 2;
  const delayMs = opts.delayMs ?? ((attempt: number) => 400 * attempt);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let result: Eligibility = 'unknown';
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(delayMs(attempt));
    result = await probeRelayEligibility(fetchImpl, opts.path);
    if (result !== 'unknown') return result;
  }
  return result;
}
