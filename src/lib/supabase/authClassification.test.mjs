// Dependency-free tests (Node's built-in `node:test`, matching extension/test/*.test.mjs).
// Run: `node --test src/lib/supabase/authClassification.test.mjs`
//
// Scope: the auth-error CLASSIFICATION + transient-tolerance DECISION the
// middleware redirect depends on — including the hard-timeout term added for the
// 2026-07-31 production 504 incident (a hung getUser() is treated as transient,
// not a logout). Node 20 in this repo cannot import the .ts source directly (no
// type stripping / no persistent transpiler), so the pure predicates below are
// mirrored from src/lib/supabase/middleware.ts and MUST be kept in sync with it.
// The timeout MECHANISM itself (getUserWithTimeout) is transpiled and exercised
// directly in authTimeout.test.mjs. The classification primitive is exercised
// against the REAL @supabase/supabase-js error classes, so it also guards against
// an upstream change to how these errors are classified.
//
// NOT covered here (require @testing-library/react + jsdom + a runner, i.e. broad new
// test infra not added without approval): the UserMenu/layout component navigation
// behavior and the middleware NextResponse cookie-copy branches. See the PR report for
// the runtime/static proof standing in for those.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAuthRetryableFetchError,
  AuthRetryableFetchError,
  AuthApiError,
  AuthSessionMissingError,
} from '@supabase/supabase-js';

// ── Mirrors of the pure predicates in src/lib/supabase/middleware.ts (keep in sync) ──
// `transientAuthFailure` now also treats a hard-timeout (timedOut) on the auth
// call as transient — see src/lib/supabase/authTimeout.ts and the middleware.
// The `timedOut` param defaults to false so the classification-only cases below
// read unchanged.
const hasSupabaseAuthCookie = (cookies) =>
  cookies.some((c) => c.name.startsWith('sb-') && c.name.includes('-auth-token'));
const isTransientAuthFailure = (user, hasAuthCookie, error, timedOut = false) =>
  !user && hasAuthCookie && (timedOut || isAuthRetryableFetchError(error));

// ── Classification primitive (real supabase-js error classes) ──
test('AuthRetryableFetchError classifies as transient (ride it out)', () => {
  assert.equal(isAuthRetryableFetchError(new AuthRetryableFetchError('network', 0)), true);
});

test('AuthApiError (invalid/revoked/reused token) is NOT transient → redirect', () => {
  assert.equal(isAuthRetryableFetchError(new AuthApiError('invalid JWT', 401, 'bad_jwt')), false);
  assert.equal(
    isAuthRetryableFetchError(new AuthApiError('Invalid Refresh Token: Already Used', 400, 'refresh_token_already_used')),
    false,
  );
});

test('AuthSessionMissingError is NOT transient → redirect', () => {
  assert.equal(isAuthRetryableFetchError(new AuthSessionMissingError()), false);
});

test('null / undefined / plain Error are NOT transient → redirect', () => {
  assert.equal(isAuthRetryableFetchError(null), false);
  assert.equal(isAuthRetryableFetchError(undefined), false);
  assert.equal(isAuthRetryableFetchError(new Error('boom')), false);
});

// ── Auth-cookie detector: recognizes base AND chunked cookies ──
test('hasSupabaseAuthCookie recognizes base, chunked, and verifier auth cookies', () => {
  assert.equal(hasSupabaseAuthCookie([{ name: 'sb-dvucodtdojumvplmgjeu-auth-token' }]), true);
  assert.equal(
    hasSupabaseAuthCookie([
      { name: 'sb-dvucodtdojumvplmgjeu-auth-token.0' },
      { name: 'sb-dvucodtdojumvplmgjeu-auth-token.1' },
    ]),
    true,
  );
  // Over-matches the transient PKCE verifier cookie — benign (only present mid-OAuth on /auth/*).
  assert.equal(hasSupabaseAuthCookie([{ name: 'sb-dvucodtdojumvplmgjeu-auth-token-code-verifier' }]), true);
});

test('hasSupabaseAuthCookie ignores unrelated cookies', () => {
  assert.equal(hasSupabaseAuthCookie([]), false);
  assert.equal(hasSupabaseAuthCookie([{ name: 'lensed_active_store' }, { name: 'other' }]), false);
});

// ── Combined middleware decision: suppress redirect ONLY on a transient failure with a cookie ──
test('transient failure WITH auth cookie and no user → suppress redirect', () => {
  assert.equal(isTransientAuthFailure(null, true, new AuthRetryableFetchError('network', 0)), true);
});

test('missing / invalid / revoked session (with cookie) → do NOT suppress (redirect)', () => {
  assert.equal(isTransientAuthFailure(null, true, new AuthSessionMissingError()), false);
  assert.equal(isTransientAuthFailure(null, true, new AuthApiError('invalid', 401, 'bad_jwt')), false);
  assert.equal(
    isTransientAuthFailure(null, true, new AuthApiError('reused', 400, 'refresh_token_already_used')),
    false,
  );
});

test('no auth cookie (genuinely signed out) → do NOT suppress even if error looks retryable', () => {
  assert.equal(isTransientAuthFailure(null, false, new AuthRetryableFetchError('network', 0)), false);
});

test('authenticated user present → not a suppression case', () => {
  assert.equal(isTransientAuthFailure({ id: 'u1' }, true, null), false);
});

// ── Hard-timeout term (2026-07-31 incident): a hung getUser() that trips the
//    middleware timeout is transient — ride it out exactly like a retryable
//    fetch error, never a forced logout. ──
test('timeout WITH auth cookie and no user → suppress redirect (ride it out)', () => {
  // timedOut=true, no returned error object at all (the call never resolved).
  assert.equal(isTransientAuthFailure(null, true, null, true), true);
});

test('timeout withOUT an auth cookie (no session to preserve) → do NOT suppress → redirect', () => {
  assert.equal(isTransientAuthFailure(null, false, null, true), false);
});

test('timeout is irrelevant once a user is present → not a suppression case', () => {
  assert.equal(isTransientAuthFailure({ id: 'u1' }, true, null, true), false);
});

test('confirmed missing session that did NOT time out still redirects', () => {
  // No timeout, no retryable error → definitive signed-out → redirect.
  assert.equal(isTransientAuthFailure(null, true, new AuthSessionMissingError(), false), false);
});
