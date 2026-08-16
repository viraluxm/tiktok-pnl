// Proof that the middleware's verification path performs NO network call and NO session load.
//
// This is the load-bearing claim of Stage 1. getClaims() called with NO jwt argument delegates to
// getSession(), which refreshes the token (rotating it server-side) whenever it is within
// EXPIRY_MARGIN_MS of expiry — and does so regardless of autoRefreshToken:false. That is what made
// the middleware a second refresher. Passing the token EXPLICITLY, together with a pinned key set,
// must reach neither the network nor storage.
//
// Method: build a REAL supabase-js client whose `fetch` throws on any call and whose auth `storage`
// throws on any read, then verify a genuine ES256-signed JWT through it. If either the fetch or the
// storage is touched, the test fails.
//
// Run: node --test src/lib/supabase/getClaimsLocal.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { webcrypto } from 'node:crypto';

const subtle = webcrypto.subtle;

const b64url = (bytes) =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

const KID = 'test-kid-es256';

/** Mint a real ES256-signed JWT plus the public JWK that verifies it. */
async function mintToken(payload) {
  const { privateKey, publicKey } = await subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const header = { alg: 'ES256', typ: 'JWT', kid: KID };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = await subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  const jwk = await subtle.exportKey('jwk', publicKey);
  return {
    token: `${signingInput}.${b64url(new Uint8Array(sig))}`,
    jwk: { ...jwk, kid: KID, alg: 'ES256', use: 'sig' },
  };
}

/**
 * A client that fails loudly on any network or storage access. Both tripwires are ARMED only after
 * construction, because instantiating the client kicks off initialize() → _recoverAndRefresh(),
 * which legitimately reads storage once. We are testing getClaims, not the constructor.
 */
async function armedClient() {
  const hits = { fetch: [], storage: [] };
  let armed = false;

  const tripFetch = async (input) => {
    if (armed) {
      hits.fetch.push(String(input));
      throw new Error(`NETWORK CALL during local verification: ${String(input)}`);
    }
    throw new Error('offline'); // pre-arm calls just fail harmlessly
  };
  const tripStorage = {
    getItem: (k) => {
      if (armed) {
        hits.storage.push(k);
        throw new Error(`SESSION LOAD during local verification: ${k}`);
      }
      return null;
    },
    setItem: () => {},
    removeItem: () => {},
  };

  const client = createClient('https://example.supabase.co', 'anon-key', {
    auth: {
      storage: tripStorage,
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { fetch: tripFetch },
  });

  // Let the constructor's fire-and-forget initialize() settle before arming.
  await new Promise((r) => setTimeout(r, 50));
  armed = true;
  return { client, hits };
}

const claimsFor = (extra = {}) => ({
  iss: 'https://example.supabase.co/auth/v1',
  sub: '00000000-0000-0000-0000-0000000000aa',
  aud: 'authenticated',
  role: 'authenticated', // POSTGRES role — never the app role
  aal: 'aal1',
  session_id: '11111111-1111-1111-1111-111111111111',
  iat: Math.floor(Date.now() / 1000) - 10,
  exp: Math.floor(Date.now() / 1000) + 3600,
  app_metadata: { role: 'station' },
  ...extra,
});

// ── The core guarantee ───────────────────────────────────────────────────────────────────────

test('getClaims(token, {keys}) verifies with NO network call and NO session load', async () => {
  const { token, jwk } = await mintToken(claimsFor());
  const { client, hits } = await armedClient();

  const { data, error } = await client.auth.getClaims(token, { keys: [jwk] });

  assert.equal(error, null, `verification failed: ${error?.message ?? ''}`);
  assert.ok(data?.claims, 'claims returned');
  assert.deepEqual(hits.fetch, [], 'NO network call may occur on the happy path');
  assert.deepEqual(hits.storage, [], 'NO session load may occur — that is what rotates the token');
});

test('the app role comes from app_metadata, and the postgres role is the decoy', async () => {
  const { token, jwk } = await mintToken(claimsFor());
  const { client } = await armedClient();

  const { data } = await client.auth.getClaims(token, { keys: [jwk] });
  assert.equal(data.claims.role, 'authenticated', 'top-level role is the POSTGRES role');
  assert.equal(data.claims.app_metadata.role, 'station', 'the app role lives in app_metadata');
});

test('a tampered payload fails verification (signature is genuinely checked)', async () => {
  const { token, jwk } = await mintToken(claimsFor());
  const [h, , s] = token.split('.');
  const forged = `${h}.${b64urlJson(claimsFor({ app_metadata: { role: 'admin' } }))}.${s}`;

  const { client, hits } = await armedClient();
  const { data, error } = await client.auth.getClaims(forged, { keys: [jwk] });

  assert.ok(error, 'a forged token must not verify');
  assert.equal(data, null);
  assert.deepEqual(hits.fetch, [], 'rejection must also stay offline');
});

// ── allowExpired: the flag the middleware relies on to avoid a confinement fail-open ──────────

test('an EXPIRED token THROWS by default but is verifiable with allowExpired', async () => {
  const past = Math.floor(Date.now() / 1000) - 120;
  const { token, jwk } = await mintToken(claimsFor({ exp: past, iat: past - 3600 }));
  const { client, hits } = await armedClient();

  // NOTE THE CONTRACT: validateExp throws a PLAIN Error ('JWT has expired'), not an AuthError, so
  // getClaims RETHROWS it instead of returning { error }. Any caller of the strict form must
  // try/catch or it will blow up the request. The middleware sidesteps this entirely: it always
  // passes allowExpired and additionally routes the call through withAuthTimeout, which normalizes
  // a rejection into { data: null, error }.
  await assert.rejects(
    () => client.auth.getClaims(token, { keys: [jwk] }),
    /expired/i,
    'strict verification throws on an expired token',
  );

  const lenient = await client.auth.getClaims(token, { keys: [jwk], allowExpired: true });
  assert.equal(lenient.error, null, 'signature still verifies with allowExpired');
  assert.equal(
    lenient.data.claims.app_metadata.role,
    'station',
    'authentic-but-stale claims still carry the real role → confinement holds',
  );
  assert.deepEqual(hits.fetch, [], 'still offline');
  assert.deepEqual(hits.storage, [], 'still no session load');
});

// ── The regression this whole stage exists to prevent ────────────────────────────────────────

test('REGRESSION GUARD: getClaims() with NO jwt argument DOES load the session', async () => {
  const { client, hits } = await armedClient();

  // No token passed → delegates to getSession() → touches storage (and, with a real session near
  // expiry, would POST /auth/v1/token and rotate). This is exactly the call the middleware must
  // never make. If a future auth-js release changes this, this test flips and we re-evaluate.
  await client.auth.getClaims().catch(() => {});

  assert.ok(
    hits.storage.length > 0,
    'the no-arg form must be shown to load the session — if this stops being true, revisit the middleware design note',
  );
});
