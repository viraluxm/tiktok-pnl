// Unit proof for the middleware Supabase-auth hard-timeout wrapper
// (fix/middleware-getuser-timeout — production 504 incident, 2026-07-31).
//
// No app test runner exists, so this transpiles authTimeout.ts at runtime via
// the repo's `typescript` devDep (matching src/lib/inventory/filterSkus.test.mjs
// and src/lib/training/session.test.mjs) and exercises the REAL
// getUserWithTimeout / AUTH_GETUSER_TIMEOUT_MS. authTimeout.ts is import-free,
// so the transpiled module needs nothing resolved from the temp dir.
//
// Scope: the timeout MECHANISM (what getUserWithTimeout returns for each auth
// outcome, and that it fires far below Vercel's 25s Edge-Middleware limit). The
// downstream redirect DECISION that consumes { user, error, timedOut } — i.e.
// "a timeout is treated as a transient failure, not a logout" — is proven with
// the real @supabase error classes in authClassification.test.mjs.
//
// Run: node --test src/lib/supabase/authTimeout.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./authTimeout.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'authtimeout-')), 'authTimeout.mjs');
writeFileSync(outFile, outputText);
const { getUserWithTimeout, AUTH_GETUSER_TIMEOUT_MS } = await import(
  pathToFileURL(outFile).href
);

// Supabase-shaped getUser() result helpers.
const ok = (user) => async () => ({ data: { user }, error: null });
const withError = (error) => async () => ({ data: { user: null }, error });
const never = () => () => new Promise(() => {}); // resolves/rejects never
const VERCEL_EDGE_LIMIT_MS = 25_000;

// ── Case 1: Successful authenticated request — user passes through untouched ──
test('successful getUser: user passes through, timedOut false', async () => {
  const res = await getUserWithTimeout(ok({ id: 'u1' }), { timeoutMs: 200 });
  assert.deepEqual(res.data.user, { id: 'u1' });
  assert.equal(res.error, null);
  assert.equal(res.timedOut, false);
});

// ── Case 2: Confirmed unauthenticated request — null user passes through ──
test('confirmed signed-out getUser (null user, no error): passes through, timedOut false', async () => {
  const res = await getUserWithTimeout(ok(null), { timeoutMs: 200 });
  assert.equal(res.data.user, null);
  assert.equal(res.error, null);
  assert.equal(res.timedOut, false);
});

// ── Case 3: Retryable Supabase Auth failure — error passes through for the
//    caller to classify; NOT reported as a timeout. ──
test('returned auth error passes through unchanged, timedOut false', async () => {
  const sentinel = { name: 'AuthRetryableFetchError', __isAuthError: true };
  const res = await getUserWithTimeout(withError(sentinel), { timeoutMs: 200 });
  assert.equal(res.data.user, null);
  assert.equal(res.error, sentinel); // same reference — not swallowed
  assert.equal(res.timedOut, false);
});

// ── Case 3b: getUser that REJECTS (thrown network error) is normalized, never
//    rejects — so the middleware await can't throw and kill the request. ──
test('rejecting getUser is normalized to { user:null, error }, never throws', async () => {
  const boom = new Error('fetch failed');
  const res = await getUserWithTimeout(async () => {
    throw boom;
  }, { timeoutMs: 200 });
  assert.equal(res.data.user, null);
  assert.equal(res.error, boom);
  assert.equal(res.timedOut, false);
});

// ── Case 4: Auth call that never resolves — the whole reason this fix exists.
//    Must resolve via timeout with timedOut:true and fire the abort hook. ──
test('never-resolving getUser resolves via timeout (timedOut:true) and aborts', async () => {
  let aborted = 0;
  const start = performance.now();
  const res = await getUserWithTimeout(never(), {
    timeoutMs: 40,
    onTimeout: () => {
      aborted++;
    },
  });
  const elapsed = performance.now() - start;
  assert.equal(res.timedOut, true);
  assert.equal(res.data.user, null);
  assert.equal(res.error, null);
  assert.equal(aborted, 1, 'onTimeout (abort) fired exactly once');
  assert.ok(elapsed < 1000, `resolved promptly (${Math.round(elapsed)}ms)`);
});

// ── Case 5: Timeout completes far below Vercel's 25s Edge-Middleware limit ──
test('configured timeout is in the 3–5s band and far below Vercel 25s limit', () => {
  assert.ok(
    AUTH_GETUSER_TIMEOUT_MS >= 3000 && AUTH_GETUSER_TIMEOUT_MS <= 5000,
    `AUTH_GETUSER_TIMEOUT_MS=${AUTH_GETUSER_TIMEOUT_MS} must be 3000–5000ms`,
  );
  assert.ok(AUTH_GETUSER_TIMEOUT_MS < VERCEL_EDGE_LIMIT_MS);
});

test('a hang settles via our race well before the 25s Vercel limit', async () => {
  const start = performance.now();
  const res = await getUserWithTimeout(never(), { timeoutMs: 40 });
  const elapsed = performance.now() - start;
  assert.equal(res.timedOut, true);
  assert.ok(elapsed < VERCEL_EDGE_LIMIT_MS, `settled in ${Math.round(elapsed)}ms`);
});

// ── Regression guards ──

// A slow-but-in-time call must NOT be spuriously timed out, and the abort hook
// must not fire (timer cleared) — otherwise we'd cancel healthy auth.
test('call that resolves before the timeout is not timed out and does not abort', async () => {
  let aborted = 0;
  const slowOk = () =>
    new Promise((resolve) =>
      setTimeout(() => resolve({ data: { user: { id: 'u2' } }, error: null }), 10),
    );
  const res = await getUserWithTimeout(slowOk, {
    timeoutMs: 200,
    onTimeout: () => {
      aborted++;
    },
  });
  assert.deepEqual(res.data.user, { id: 'u2' });
  assert.equal(res.timedOut, false);
  assert.equal(aborted, 0, 'abort hook not fired for an in-time call');
});

// A getUser that rejects AFTER we already timed out must not surface as an
// unhandled rejection (node --test fails the run on unhandled rejections).
test('late rejection after timeout does not cause an unhandled rejection', async () => {
  const lateReject = () =>
    new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 30));
  const res = await getUserWithTimeout(lateReject, { timeoutMs: 10 });
  assert.equal(res.timedOut, true);
  // Give the late rejection time to fire; if it were unhandled the run fails.
  await new Promise((r) => setTimeout(r, 60));
});

// onTimeout throwing must not break the timeout path (best-effort abort).
test('onTimeout throwing is swallowed; still resolves timedOut:true', async () => {
  const res = await getUserWithTimeout(never(), {
    timeoutMs: 20,
    onTimeout: () => {
      throw new Error('abort blew up');
    },
  });
  assert.equal(res.timedOut, true);
});
