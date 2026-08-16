// Unit proof for the middleware auth hard-timeout wrapper.
//
// ORIGINALLY (fix/middleware-getuser-timeout, production 504 incident 2026-07-31) this guarded
// supabase.auth.getUser() in the middleware at 3.5s. Stage 1 made the middleware a VALIDATOR: it
// verifies the access token locally against a pinned JWKS and never calls getUser(), so the only
// call that can still touch the network is auth-js's fetchJwk() after a signing-key rotation. The
// wrapper is repointed at that leg at 1500ms and no longer aborts (a JWKS GET is an idempotent
// read; aborting a token REFRESH mid-flight was the correctness bug this stage removes).
//
// Every behavioural case from the original file is preserved; only the names
// (getUserWithTimeout → withAuthTimeout, AUTH_GETUSER_TIMEOUT_MS → JWKS_FETCH_TIMEOUT_MS), the
// result shape ({data:{user}} → {data}) and the budget assertion changed.
//
// No app test runner exists, so this transpiles authTimeout.ts at runtime via the repo's
// `typescript` devDep and exercises the REAL withAuthTimeout / JWKS_FETCH_TIMEOUT_MS.
// authTimeout.ts is import-free, so the transpiled module needs nothing resolved from the temp dir.
//
// Scope: the timeout MECHANISM. The downstream redirect DECISION is proven in
// authClassification.test.mjs; the role/confinement decision in claims.test.mjs; and the
// no-network/no-session-load guarantee in getClaimsLocal.test.mjs.
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
const { withAuthTimeout, JWKS_FETCH_TIMEOUT_MS } = await import(
  pathToFileURL(outFile).href
);

// Supabase-shaped result helpers ({ data, error }).
const ok = (value) => async () => ({ data: value, error: null });
const withError = (error) => async () => ({ data: null, error });
const never = () => () => new Promise(() => {}); // resolves/rejects never
const VERCEL_EDGE_LIMIT_MS = 25_000;

// ── Case 1: Successful call — value passes through untouched ──
test('successful call: value passes through, timedOut false', async () => {
  const res = await withAuthTimeout(ok({ id: 'u1' }), { timeoutMs: 200 });
  assert.deepEqual(res.data, { id: 'u1' });
  assert.equal(res.error, null);
  assert.equal(res.timedOut, false);
});

// ── Case 2: Confirmed empty result — null data passes through ──
test('null data with no error passes through, timedOut false', async () => {
  const res = await withAuthTimeout(ok(null), { timeoutMs: 200 });
  assert.equal(res.data, null);
  assert.equal(res.error, null);
  assert.equal(res.timedOut, false);
});

// ── Case 3: Returned error passes through for the caller to classify; NOT a timeout. ──
test('returned auth error passes through unchanged, timedOut false', async () => {
  const sentinel = { name: 'AuthRetryableFetchError', __isAuthError: true };
  const res = await withAuthTimeout(withError(sentinel), { timeoutMs: 200 });
  assert.equal(res.data, null);
  assert.equal(res.error, sentinel); // same reference — not swallowed
  assert.equal(res.timedOut, false);
});

// ── Case 3b: A call that REJECTS (thrown network error) is normalized, never rejects — so the
//    middleware await can't throw and kill the request. ──
test('rejecting call is normalized to { user:null, error }, never throws', async () => {
  const boom = new Error('fetch failed');
  const res = await withAuthTimeout(async () => {
    throw boom;
  }, { timeoutMs: 200 });
  assert.equal(res.data, null);
  assert.equal(res.error, boom);
  assert.equal(res.timedOut, false);
});

// ── Case 4: Call that never resolves — the whole reason this wrapper exists.
//    Must resolve via timeout with timedOut:true and fire the onTimeout hook (observability
//    only; nothing is cancelled). ──
test('never-resolving call resolves via timeout (timedOut:true) and notifies', async () => {
  let aborted = 0;
  const start = performance.now();
  const res = await withAuthTimeout(never(), {
    timeoutMs: 40,
    onTimeout: () => {
      aborted++;
    },
  });
  const elapsed = performance.now() - start;
  assert.equal(res.timedOut, true);
  assert.equal(res.data, null);
  assert.equal(res.error, null);
  assert.equal(aborted, 1, 'onTimeout hook fired exactly once');
  assert.ok(elapsed < 1000, `resolved promptly (${Math.round(elapsed)}ms)`);
});

// ── Case 5: Timeout completes far below Vercel's 25s Edge-Middleware limit ──
test('configured timeout is tight (<=1.5s) and far below Vercel 25s limit', () => {
  // Cut from 3500ms: this now fronts a rare rotation-only path (one GET to a CDN-cached
  // well-known endpoint), not every request.
  assert.ok(
    JWKS_FETCH_TIMEOUT_MS > 0 && JWKS_FETCH_TIMEOUT_MS <= 1500,
    `JWKS_FETCH_TIMEOUT_MS=${JWKS_FETCH_TIMEOUT_MS} must be >0 and <=1500ms`,
  );
  assert.ok(JWKS_FETCH_TIMEOUT_MS < VERCEL_EDGE_LIMIT_MS);
});

test('a hang settles via our race well before the 25s Vercel limit', async () => {
  const start = performance.now();
  const res = await withAuthTimeout(never(), { timeoutMs: 40 });
  const elapsed = performance.now() - start;
  assert.equal(res.timedOut, true);
  assert.ok(elapsed < VERCEL_EDGE_LIMIT_MS, `settled in ${Math.round(elapsed)}ms`);
});

// ── Regression guards ──

// A slow-but-in-time call must NOT be spuriously timed out, and the hook must not fire
// (timer cleared) — otherwise we'd log a phantom timeout on healthy verification.
test('call that resolves before the timeout is not timed out and does not abort', async () => {
  let aborted = 0;
  const slowOk = () =>
    new Promise((resolve) =>
      setTimeout(() => resolve({ data: { id: 'u2' }, error: null }), 10),
    );
  const res = await withAuthTimeout(slowOk, {
    timeoutMs: 200,
    onTimeout: () => {
      aborted++;
    },
  });
  assert.deepEqual(res.data, { id: 'u2' });
  assert.equal(res.timedOut, false);
  assert.equal(aborted, 0, 'onTimeout hook not fired for an in-time call');
});

// A call that rejects AFTER we already timed out must not surface as an
// unhandled rejection (node --test fails the run on unhandled rejections).
test('late rejection after timeout does not cause an unhandled rejection', async () => {
  const lateReject = () =>
    new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 30));
  const res = await withAuthTimeout(lateReject, { timeoutMs: 10 });
  assert.equal(res.timedOut, true);
  // Give the late rejection time to fire; if it were unhandled the run fails.
  await new Promise((r) => setTimeout(r, 60));
});

// onTimeout throwing must not break the timeout path (best-effort notification).
test('onTimeout throwing is swallowed; still resolves timedOut:true', async () => {
  const res = await withAuthTimeout(never(), {
    timeoutMs: 20,
    onTimeout: () => {
      throw new Error('hook blew up');
    },
  });
  assert.equal(res.timedOut, true);
});
