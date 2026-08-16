// Pinned JWKS for local (network-free) access-token verification in the middleware.
//
// WHY PIN. auth-js caches the key set in a module-level global with a 10-minute TTL
// (GoTrueClient JWKS_TTL). At the edge that module scope lives only as long as the V8 isolate,
// and Vercel recycles isolates constantly — so an unpinned setup means a cold
// GET /auth/v1/.well-known/jwks.json in the critical path of a user request, on every new
// isolate. auth-js's fetchJwk() checks the CALLER-SUPPLIED keys FIRST and returns before any
// network call, so pinning removes that leg entirely: on the happy path the middleware performs
// zero network I/O.
//
// PINNING IS A FAST PATH, NOT A LOCK-IN. If Supabase rotates to a new `kid`, the pinned set
// misses, auth-js falls through to its cache and then to the well-known endpoint — bounded by
// JWKS_FETCH_TIMEOUT_MS in ./authTimeout. A miss is logged loudly (see middleware) because a
// rotation is an operational event we want to see in logs, not absorb silently.
//
// ROTATION WITHOUT A DEPLOY: set SUPABASE_JWKS to the JSON from
// https://<ref>.supabase.co/auth/v1/.well-known/jwks.json — either the full `{"keys":[...]}`
// document or a bare array. The hardcoded fallback below is the key that was `in_use` when this
// landed (the legacy HS256 secret is `previously_used`; HS256 tokens cannot be verified locally
// at all and would fall back to a network getUser(), which is exactly what we are removing).
//
// Import-free ON PURPOSE so it can be transpiled and unit-tested standalone.

/**
 * A JWK as `crypto.subtle.importKey('jwk', …)` consumes it. `kty` is narrowed to the key types
 * auth-js accepts so this is assignable to its own JWK type without a cast — a wider `string`
 * would force one, and a cast here would hide a genuinely malformed env value.
 */
export interface PinnedJwk {
  kty: 'EC' | 'RSA' | 'oct';
  crv?: string;
  x?: string;
  y?: string;
  alg?: string;
  kid?: string;
  use?: string;
  /** Required by auth-js's JWK type. Normalized to ['verify'] when a source JWKS omits it. */
  key_ops: string[];
  ext?: boolean;
}

// Project dvucodtdojumvplmgjeu — ES256 / P-256, status `in_use` as of 2026-08-16.
const FALLBACK_KEYS: PinnedJwk[] = [
  {
    kty: 'EC',
    crv: 'P-256',
    x: 'v8Wh5EGVOOKnSSGDfseYdk6481AbUj0w-NgV01jBEBA',
    y: 'zFAtsfT8cscMo1gnygw_GPgfUccZfKmA-ulFNSmpT3Q',
    alg: 'ES256',
    kid: '75378e07-b875-438a-a61e-576c4f5c0c5f',
    use: 'sig',
    key_ops: ['verify'],
    ext: true,
  },
];

/**
 * Parse SUPABASE_JWKS. Accepts `{"keys":[…]}` or a bare `[…]`. Any malformed value falls back to
 * the pinned constant rather than throwing — a bad env var must never take the app down, and a
 * fallback that still verifies the current key is strictly safer than no keys at all.
 */
export function parsePinnedKeys(raw: string | undefined): { keys: PinnedJwk[]; malformed: boolean } {
  if (!raw || !raw.trim()) return { keys: FALLBACK_KEYS, malformed: false };
  try {
    const parsed: unknown = JSON.parse(raw);
    const arr = Array.isArray(parsed)
      ? parsed
      : (parsed as { keys?: unknown })?.keys;
    if (!Array.isArray(arr) || arr.length === 0) return { keys: FALLBACK_KEYS, malformed: true };
    const KTY = ['EC', 'RSA', 'oct'];
    const keys = arr
      .filter((k): k is PinnedJwk =>
        !!k && typeof k === 'object' && KTY.includes((k as { kty?: unknown }).kty as string))
      // A JWKS document may legitimately omit key_ops; we only ever verify with these.
      .map((k) => (Array.isArray(k.key_ops) ? k : { ...k, key_ops: ['verify'] }));
    if (keys.length === 0) return { keys: FALLBACK_KEYS, malformed: true };
    return { keys, malformed: false };
  } catch {
    return { keys: FALLBACK_KEYS, malformed: true };
  }
}

/** The key ids we can verify without any network call. */
export function pinnedKids(keys: PinnedJwk[]): string[] {
  return keys.map((k) => k.kid).filter((k): k is string => typeof k === 'string');
}

/**
 * Decode ONLY the `kid` + `alg` from a JWT header, without verifying anything. Used to log a
 * pinned-key miss (i.e. a rotation) before handing the token to auth-js, which will then have to
 * go to the network. Returns null for anything that is not a well-formed JWT header.
 */
export function headerOf(token: string): { kid?: string; alg?: string } | null {
  try {
    const part = token.split('.')[0];
    if (!part) return null;
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const header: unknown = JSON.parse(json);
    if (!header || typeof header !== 'object') return null;
    const { kid, alg } = header as { kid?: unknown; alg?: unknown };
    return {
      kid: typeof kid === 'string' ? kid : undefined,
      alg: typeof alg === 'string' ? alg : undefined,
    };
  } catch {
    return null;
  }
}
