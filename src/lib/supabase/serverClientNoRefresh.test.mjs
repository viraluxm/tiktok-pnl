// Stage 2 proof: the server-side read/verify client CANNOT refresh a token or write a cookie.
//
// WHY THIS FILE EXISTS. ~127 API-route call sites share the client from ./server.ts. While that
// client was cookie-backed, every one of them was a token refresher racing the browser on a
// rotating refresh token, and — worse — wrote whatever session it had loaded back into the
// browser's cookie when it responded, clobbering a newer one. That is what made the logout loop
// self-sustaining: signing in again did not clear it.
//
// "It does not refresh" has to be a property of the CONSTRUCTION, not of how carefully callers
// invoke it, so this asserts it behaviourally against a fetch tripwire: a getUser() on an EXPIRED
// token must produce exactly one GET /user and ZERO POST /token. A cookie/storage adapter
// reintroduced into createBearerClient fails this test, which is the regression that matters.
//
// Run: node --test src/lib/supabase/serverClientNoRefresh.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const tmpDir = join(repoRoot, 'node_modules', '.tmp-server-client-test');

const SUPABASE_URL = 'https://dvucodtdojumvplmgjeu.supabase.co';
const ANON = 'test-anon-key';

/** An access token that expired an hour ago — the exact input that used to trigger a rotation. */
const EXPIRED_TOKEN = (() => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'u1', exp: now - 3600, iat: now - 7200 })}.sig`;
})();

let createBearerClient;
let requests = [];
let realFetch;

before(async () => {
  mkdirSync(tmpDir, { recursive: true });
  for (const name of ['sessionCookie', 'server']) {
    const { outputText } = ts.transpileModule(readFileSync(join(here, `${name}.ts`), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    writeFileSync(
      join(tmpDir, `${name}.mjs`),
      outputText
        .replace(/from '\.\/(\w+)'/g, "from './$1.mjs'")
        // next/headers is only reached by createClient(), which these tests do not call; the
        // import still has to resolve from a plain node process.
        .replace(/from 'next\/headers'/g, "from 'next/headers.js'"),
    );
  }
  ({ createBearerClient } = await import(pathToFileURL(join(tmpDir, 'server.mjs')).href));

  realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input?.url ?? input);
    requests.push({ url, method: init?.method ?? input?.method ?? 'GET', headers: init?.headers ?? {} });
    // Answer /user so auth-js takes its normal success path rather than an error path.
    return new Response(JSON.stringify({ id: 'u1', aud: 'authenticated' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
});

after(() => {
  if (realFetch) globalThis.fetch = realFetch;
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const tokenCalls = () => requests.filter((r) => r.url.includes('/auth/v1/token'));
const userCalls = () => requests.filter((r) => r.url.includes('/auth/v1/user'));

test('an EXPIRED token never triggers a refresh', async () => {
  requests = [];
  const supabase = createBearerClient(SUPABASE_URL, ANON, EXPIRED_TOKEN);
  await supabase.auth.getUser();

  assert.equal(tokenCalls().length, 0,
    `client rotated the token — POST /token must never happen here: ${JSON.stringify(tokenCalls())}`);
  assert.equal(userCalls().length, 1,
    `expected exactly one network validation of the token, got ${userCalls().length}`);
});

test('the presented token is what gets validated (RLS scopes to the caller)', async () => {
  requests = [];
  const supabase = createBearerClient(SUPABASE_URL, ANON, EXPIRED_TOKEN);
  await supabase.auth.getUser();

  const sent = userCalls()[0];
  const headers = new Headers(sent.headers);
  assert.equal(headers.get('authorization'), `Bearer ${EXPIRED_TOKEN}`,
    'the cookie access token must be forwarded as the Authorization header');
});

test('no token at all makes no network call and yields no user', async () => {
  requests = [];
  const supabase = createBearerClient(SUPABASE_URL, ANON, null);
  const { data, error } = await supabase.auth.getUser();

  assert.equal(data.user, null, 'a request with no auth cookie must not resolve a user');
  assert.ok(error, 'getUser must report the missing session so callers 401');
  assert.equal(requests.length, 0,
    `a signed-out request must not hit the network: ${JSON.stringify(requests)}`);
});

test('the client holds no session to rotate or write back', async () => {
  requests = [];
  const supabase = createBearerClient(SUPABASE_URL, ANON, EXPIRED_TOKEN);
  const { data } = await supabase.auth.getSession();

  assert.equal(data.session, null,
    'persistSession:false must leave no session — a session here is a refreshable, writable one');
  assert.equal(tokenCalls().length, 0, 'getSession must not rotate either');
});

test('only the session-establishing routes may write auth cookies', () => {
  const appDir = join(repoRoot, 'src', 'app');
  const allowed = new Set([
    join(appDir, '(auth)', 'auth', 'callback', 'route.ts'),
    join(appDir, 'api', 'auth', 'login', 'route.ts'),
    join(appDir, 'api', 'auth', 'signup', 'route.ts'),
  ]);

  const { execSync } = require$('node:child_process');
  const hits = execSync(
    `grep -rl "createAuthFlowClient" ${JSON.stringify(appDir)} || true`,
    { encoding: 'utf8' },
  ).split('\n').filter(Boolean);

  for (const f of hits) {
    assert.ok(allowed.has(f),
      `${f} uses the cookie-writing client; only the three session-establishing routes may. ` +
      `A second cookie writer reintroduces the stale-cookie clobber.`);
  }
  assert.equal(hits.length, allowed.size,
    `expected all ${allowed.size} session-establishing routes to use createAuthFlowClient, found ${hits.length}`);
});

// node:test runs ESM; `require` is not defined, so reach for it explicitly.
import { createRequire } from 'node:module';
const require$ = createRequire(import.meta.url);
