// End-to-end routing proof for the REAL middleware (Stage 1: validates, does not refresh).
//
// Drives updateSession() with real NextRequest objects carrying a real, locally-signed ES256
// session cookie, and asserts the routing outcome for every account shape. This exercises the
// whole path — cookie chunk reassembly, getClaims signature verification against the pinned key
// set, freshness, role extraction, confinement — with no server and no live Supabase.
//
// The signing key is generated per-run and pinned via SUPABASE_JWKS, so this needs no credentials
// and touches no live project.
//
// A `fetch` tripwire is installed globally: if the middleware performs ANY network call on the
// happy path, these tests fail. That is the core Stage 1 guarantee, asserted here against the
// actual middleware rather than against auth-js in isolation.
//
// Run: node --test src/lib/supabase/middlewareRouting.test.mjs

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';
import { createChunks, stringToBase64URL } from '@supabase/ssr';

const subtle = webcrypto.subtle;
const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const tmpDir = join(repoRoot, 'node_modules', '.tmp-mw-routing-test');

const SUPABASE_URL = 'https://dvucodtdojumvplmgjeu.supabase.co';
const COOKIE_KEY = 'sb-dvucodtdojumvplmgjeu-auth-token';
const KID = 'stage1-routing-test';

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const j = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));

let privateKey;
let updateSession;
let NextRequest;
/** Every network call the middleware attempts, across all tests. */
const networkCalls = [];

before(async () => {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  privateKey = kp.privateKey;
  const pub = { ...(await subtle.exportKey('jwk', kp.publicKey)), kid: KID, alg: 'ES256', use: 'sig' };

  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
  process.env.SUPABASE_JWKS = JSON.stringify({ keys: [pub] });

  // Tripwire: record (and fail) any outbound request.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    networkCalls.push(String(input?.url ?? input));
    return realFetch(input, init);
  };

  // Transpile the real middleware + its deps under node_modules so bare imports resolve.
  mkdirSync(tmpDir, { recursive: true });
  for (const name of ['authTimeout', 'jwks', 'sessionCookie', 'claims', 'middleware']) {
    const { outputText } = ts.transpileModule(readFileSync(join(here, `${name}.ts`), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    const rewritten = outputText
      // Relative sibling imports keep working because all five land in the same directory.
      .replace(/from '\.\/(\w+)'/g, "from './$1.mjs'")
      // Next's package exports map is not matched from a bare .mjs outside the app graph; the
      // file entry point resolves fine and is the same module.
      .replace(/from 'next\/server'/g, "from 'next/server.js'");
    writeFileSync(join(tmpDir, `${name}.mjs`), rewritten);
  }
  ({ updateSession } = await import(pathToFileURL(join(tmpDir, 'middleware.mjs')).href));
  // 'next/server.js' rather than 'next/server': Next's exports map is keyed for the app graph and
  // does not resolve from a plain node --test process. Same module, explicit file entry point.
  ({ NextRequest } = await import('next/server.js'));
});

process.on('exit', () => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

async function mint(app_metadata, expDelta = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', typ: 'JWT', kid: KID };
  const payload = {
    iss: `${SUPABASE_URL}/auth/v1`, sub: '00000000-0000-0000-0000-00000000000a', aud: 'authenticated',
    role: 'authenticated', aal: 'aal1', session_id: '22222222-2222-2222-2222-222222222222',
    iat: now - 10, exp: now + expDelta, email: 't@example.com', app_metadata, user_metadata: {},
  };
  const input = `${j(header)}.${j(payload)}`;
  const sig = await subtle.sign({ name: 'ECDSA', hash: { name: 'SHA-256' } }, privateKey, new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

/** Build the session cookie exactly as @supabase/ssr writes it. */
function sessionCookies(accessToken) {
  const session = {
    access_token: accessToken, refresh_token: 'rt-test', token_type: 'bearer',
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: '00000000-0000-0000-0000-00000000000a' },
  };
  return createChunks(COOKIE_KEY, 'base64-' + stringToBase64URL(JSON.stringify(session)));
}

async function go(path, { token, extraCookies = [] } = {}) {
  const req = new NextRequest(new Request(`https://lensed.io${path}`));
  for (const c of token ? sessionCookies(token) : []) req.cookies.set(c.name, c.value);
  for (const c of extraCookies) req.cookies.set(c.name, c.value);
  const res = await updateSession(req);
  return {
    status: res.status,
    location: res.headers.get('location') ? new URL(res.headers.get('location')).pathname : null,
  };
}

// ── Signed out: definitive redirect ──────────────────────────────────────────────────────────

test('no cookie → /dashboard and /fulfillment both redirect to /login', async () => {
  assert.deepEqual(await go('/dashboard'), { status: 307, location: '/login' });
  assert.deepEqual(await go('/fulfillment'), { status: 307, location: '/login' });
});

test('no cookie → /login and / render (no redirect loop)', async () => {
  assert.equal((await go('/login')).location, null);
  assert.equal((await go('/')).location, null);
});

// ── Owner / admin: unconfined ────────────────────────────────────────────────────────────────

test('owner token (role:authenticated, no app_metadata.role) reaches /dashboard', async () => {
  const token = await mint({ provider: 'email' });
  assert.equal((await go('/dashboard', { token })).location, null, 'owner must NOT be confined');
  assert.equal((await go('/fulfillment', { token })).location, null, 'owner retains station access');
  assert.equal((await go('/team/binding', { token })).location, null);
});

test('signed-in owner on /login is bounced to /dashboard', async () => {
  const token = await mint({ provider: 'email' });
  assert.deepEqual(await go('/login', { token }), { status: 307, location: '/dashboard' });
});

// ── Station confinement ──────────────────────────────────────────────────────────────────────

test('station token reaches /fulfillment and /api/station only', async () => {
  const token = await mint({ role: 'station' });
  assert.equal((await go('/fulfillment', { token })).location, null);
  assert.equal((await go('/api/station/scan', { token })).status, 200);
  assert.deepEqual(await go('/dashboard', { token }), { status: 307, location: '/fulfillment' });
  assert.equal((await go('/api/shipping/confirm', { token })).status, 403, 'foreign API → hard 403');
});

test('station on /login is bounced to its own home, not /dashboard', async () => {
  const token = await mint({ role: 'station' });
  assert.deepEqual(await go('/login', { token }), { status: 307, location: '/fulfillment' });
});

// ── Member scope-derived confinement ─────────────────────────────────────────────────────────

test('member with binding scope reaches its page + API, nothing else', async () => {
  const token = await mint({ role: 'member', scopes: ['binding'] });
  assert.equal((await go('/team/binding', { token })).location, null);
  assert.equal((await go('/api/member/bind', { token })).status, 200);
  assert.deepEqual(await go('/team/inventory', { token }), { status: 307, location: '/team/binding' });
  assert.equal((await go('/api/member/inventory', { token })).status, 403);
});

test('member with no recognized scope lands on /team/no-access without looping', async () => {
  const token = await mint({ role: 'member', scopes: ['payroll'] });
  assert.deepEqual(await go('/dashboard', { token }), { status: 307, location: '/team/no-access' });
  assert.equal((await go('/team/no-access', { token })).location, null, 'home always reachable');
});

// ── THE FAIL-OPEN THIS STAGE CLOSES ──────────────────────────────────────────────────────────

test('EXPIRED station token stays CONFINED and is NOT bounced to /login', async () => {
  const token = await mint({ role: 'station' }, -600);
  // Authentic-but-stale claims still carry role=station → confinement holds…
  assert.deepEqual(await go('/dashboard', { token }), { status: 307, location: '/fulfillment' });
  // …and the operator is NOT logged out while the browser client refreshes.
  assert.equal((await go('/fulfillment', { token })).location, null, 'must not redirect to /login');
});

test('EXPIRED owner token renders the shell rather than manufacturing a logout', async () => {
  const token = await mint({ provider: 'email' }, -600);
  assert.equal((await go('/dashboard', { token })).location, null);
});

// ── Forged / malformed tokens are still definitive ───────────────────────────────────────────

test('a token signed by the WRONG key is a definitive redirect to /login', async () => {
  const good = await mint({ role: 'station' });
  const [h, p] = good.split('.');
  const forged = `${h}.${p}.${b64url(new Uint8Array(64))}`; // valid shape, bogus signature
  assert.deepEqual(await go('/dashboard', { token: forged }), { status: 307, location: '/login' });
});

test('a garbage cookie value is a definitive redirect, never a crash', async () => {
  const res = await go('/dashboard', { extraCookies: [{ name: COOKIE_KEY, value: 'base64-@@@garbage' }] });
  assert.deepEqual(res, { status: 307, location: '/login' });
});

// ── Hint cookie must survive a redirect (the reason the copy loop stays) ─────────────────────

test('timeclock token is confined to /kiosk and the hint cookie rides the redirect', async () => {
  const token = await mint({ role: 'timeclock' });
  const req = new NextRequest(new Request('https://lensed.io/dashboard'));
  for (const c of sessionCookies(token)) req.cookies.set(c.name, c.value);
  const res = await updateSession(req);
  assert.equal(res.status, 307);
  assert.equal(new URL(res.headers.get('location')).pathname, '/kiosk');
  assert.ok(res.cookies.get('lensed_timeclock'), 'lensed_timeclock must survive redirectTo()');
});

// ── The Stage 1 guarantee, asserted against the real middleware ──────────────────────────────

test('NO network call was made across every case above', () => {
  assert.deepEqual(
    networkCalls, [],
    `middleware must verify locally; it called: ${networkCalls.join(', ')}`,
  );
});
