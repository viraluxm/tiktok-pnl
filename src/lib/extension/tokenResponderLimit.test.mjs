// Unit proof for the pull-responder rate limit (useExtensionAuth).
//
// Transpiles the REAL src/lib/extension/tokenResponderLimit.ts at runtime (import-free, so nothing
// needs to resolve from the temp dir) and drives the policy directly with an injected clock.
//
// What this is defending: getSession() refreshes inside the 90s expiry margin, so an unbounded
// responder mints tokens without limit — against a per-IP Supabase budget of 150 refreshes per
// 5 minutes shared by the whole warehouse, where a 429 is non-retryable and signs the device out.
// Observed 2026-08-16: one session, 99 refresh tokens in 15 minutes, linear chain.
//
// Run: node --test src/lib/extension/tokenResponderLimit.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./tokenResponderLimit.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'tokenlimit-')), 'limit.mjs');
writeFileSync(outFile, outputText);
const {
  decide, afterMint, afterPush, initialState,
  COOLDOWN_MS, WINDOW_MS, MAX_MINTS_PER_WINDOW,
} = await import(pathToFileURL(outFile).href);

/** Replay a sequence of request times through the policy; returns the actions taken. */
function replay(times, { startCached = false, t0 = 1_000_000 } = {}) {
  let state = initialState();
  let hasCached = startCached;
  if (startCached) state = afterPush(state, t0);
  const actions = [];
  for (const t of times) {
    const d = decide(state, t, hasCached);
    actions.push(d.action);
    if (d.action === 'mint') {
      state = afterMint(state, t);
      hasCached = true;
    }
  }
  return { actions, state };
}

// ── Cooldown ─────────────────────────────────────────────────────────────────────────────────

test('the first request always mints, even with no time elapsed', () => {
  const { actions } = replay([1_000_000]);
  assert.deepEqual(actions, ['mint']);
});

test('a hot loop inside the cooldown collapses to ONE mint', () => {
  // 50 requests, 100ms apart — the shape of the observed runaway.
  const t0 = 1_000_000;
  const times = Array.from({ length: 50 }, (_, i) => t0 + i * 100);
  const { actions } = replay(times);
  assert.equal(actions.filter((a) => a === 'mint').length, 1, 'exactly one mint');
  assert.equal(actions.filter((a) => a === 'serve-cached').length, 49);
});

test('a request just past the cooldown mints again', () => {
  const t0 = 1_000_000;
  const { actions } = replay([t0, t0 + COOLDOWN_MS + 1]);
  assert.deepEqual(actions, ['mint', 'mint']);
});

test('a request exactly at the cooldown boundary mints (boundary is exclusive)', () => {
  const t0 = 1_000_000;
  const { actions } = replay([t0, t0 + COOLDOWN_MS]);
  assert.deepEqual(actions, ['mint', 'mint']);
});

test('cooldown only applies when there IS something cached', () => {
  // No cache yet → must mint rather than serve nothing.
  const state = initialState();
  assert.equal(decide(state, 1_000_000, false).action, 'mint');
});

// ── Ceiling ──────────────────────────────────────────────────────────────────────────────────

test('the per-minute ceiling caps minting even when every request dodges the cooldown', () => {
  const t0 = 1_000_000;
  // One request every 5.1s for 2 minutes — each clears the cooldown, so only the ceiling binds.
  const times = Array.from({ length: 24 }, (_, i) => t0 + i * (COOLDOWN_MS + 100));
  const { actions } = replay(times);
  const mints = actions.filter((a) => a === 'mint').length;
  const throttled = actions.filter((a) => a === 'throttled').length;
  assert.ok(throttled > 0, 'ceiling engaged');
  assert.ok(mints <= MAX_MINTS_PER_WINDOW * 3, `mints bounded (${mints})`);
});

test('exactly MAX_MINTS_PER_WINDOW mints are allowed, then throttle', () => {
  const t0 = 1_000_000;
  // Just past the cooldown, so only the ceiling can bind. Fit as many as the window allows.
  const step = COOLDOWN_MS + 1;
  const n = Math.floor((WINDOW_MS - 1) / step) + 1;
  const times = Array.from({ length: n }, (_, i) => t0 + i * step);
  assert.ok(times[times.length - 1] - t0 < WINDOW_MS, 'test stays inside one window');

  const { actions } = replay(times);
  assert.equal(actions.filter((a) => a === 'mint').length, MAX_MINTS_PER_WINDOW);
  assert.equal(actions.filter((a) => a === 'throttled').length, n - MAX_MINTS_PER_WINDOW);
});

test('the two limits overlap by design — the cooldown alone already caps the rate', () => {
  // Spacing requests by COOLDOWN_MS caps them at WINDOW_MS/COOLDOWN_MS = 12 per minute, so the
  // ceiling of 10 bites only slightly earlier. That redundancy is deliberate: the cooldown is the
  // behavioural limit (it collapses loops), the ceiling is the EXPLICIT bound that survives a
  // future change to the cooldown, and it is what the loud log is keyed to.
  const maxByCooldown = Math.floor(WINDOW_MS / COOLDOWN_MS);
  assert.ok(
    MAX_MINTS_PER_WINDOW <= maxByCooldown,
    `ceiling (${MAX_MINTS_PER_WINDOW}) must not be looser than the cooldown implies (${maxByCooldown})`,
  );
});

test('throttled decisions report the observed count, for the loud log', () => {
  let state = initialState();
  const t0 = 1_000_000;
  const step = COOLDOWN_MS + 100;
  for (let i = 0; i < MAX_MINTS_PER_WINDOW; i++) state = afterMint(state, t0 + i * step);
  const d = decide(state, t0 + MAX_MINTS_PER_WINDOW * step, true);
  assert.equal(d.action, 'throttled');
  assert.equal(d.mintsInWindow, MAX_MINTS_PER_WINDOW);
});

test('the window rolls: minting resumes after WINDOW_MS', () => {
  let state = initialState();
  const t0 = 1_000_000;
  const step = COOLDOWN_MS + 100;
  for (let i = 0; i < MAX_MINTS_PER_WINDOW; i++) state = afterMint(state, t0 + i * step);
  assert.equal(decide(state, t0 + MAX_MINTS_PER_WINDOW * step, true).action, 'throttled');
  // Past the window, the count resets.
  assert.equal(decide(state, t0 + WINDOW_MS + 1, true).action, 'mint');
});

// ── Push interaction ─────────────────────────────────────────────────────────────────────────

test('a push (TOKEN_REFRESHED) refreshes the cache without consuming the ceiling', () => {
  let state = initialState();
  const t0 = 1_000_000;
  state = afterMint(state, t0);
  const countBefore = state.count;

  state = afterPush(state, t0 + 3000);
  assert.equal(state.count, countBefore, 'push does not consume budget');
  // …and it re-arms the cooldown from the push time, so the newest token is served.
  assert.equal(decide(state, t0 + 4000, true).action, 'serve-cached');
});

test('after a push the cooldown is measured from the PUSH, not the last mint', () => {
  let state = initialState();
  const t0 = 1_000_000;
  state = afterMint(state, t0);
  state = afterPush(state, t0 + 4_000);
  // t0+6000 is past the cooldown from the mint, but not from the push.
  assert.equal(decide(state, t0 + 6_000, true).action, 'serve-cached');
});

// ── Sanity on the constants ──────────────────────────────────────────────────────────────────

test('constants are bounded and sane relative to real usage', () => {
  assert.equal(COOLDOWN_MS, 5_000);
  assert.equal(WINDOW_MS, 60_000);
  // Well above legitimate use (the extension pulls once per 401; its recovery alarm is 1/min)…
  assert.ok(MAX_MINTS_PER_WINDOW >= 5);
  // …and far below the per-IP Supabase refresh budget shared by the whole warehouse (150/5min).
  assert.ok(MAX_MINTS_PER_WINDOW <= 30);
});
