// Round-trip proof for the session-cookie READER against @supabase/ssr's own WRITERS.
//
// The middleware now reads the access token straight out of the cookie instead of calling
// getSession() (which refreshes, and is what made it a second token refresher). That means we
// depend on @supabase/ssr's cookie layout — chunking, the `base64-` prefix, base64url. Rather than
// reimplement any of it, sessionCookie.ts uses the package's exported readers, and this test drives
// the package's exported WRITERS (createChunks / stringToBase64URL) to produce the input. If an
// upstream release changes the format, this fails in CI instead of at the edge, where the symptom
// would be every user silently bounced to /login.
//
// The transpiled module is written under <repo>/node_modules/ so its `@supabase/ssr` import
// resolves normally (unlike the import-free modules, which can live in os.tmpdir()).
//
// Run: node --test src/lib/supabase/sessionCookie.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createChunks, stringToBase64URL, MAX_CHUNK_SIZE } from '@supabase/ssr';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const tmpDir = join(repoRoot, 'node_modules', '.tmp-sessioncookie-test');

const srcPath = join(here, 'sessionCookie.ts');
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
mkdirSync(tmpDir, { recursive: true });
const outFile = join(tmpDir, 'sessionCookie.mjs');
writeFileSync(outFile, outputText);
process.on('exit', () => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

const { readAccessToken, storageKeyForUrl, hasSupabaseAuthCookie } = await import(
  pathToFileURL(outFile).href
);

const KEY = 'sb-dvucodtdojumvplmgjeu-auth-token';
const BASE64_PREFIX = 'base64-';

/** Encode a session exactly the way @supabase/ssr's storage.setItem does, then chunk it. */
function writeSessionCookies(session, key = KEY) {
  const encoded = BASE64_PREFIX + stringToBase64URL(JSON.stringify(session));
  return createChunks(key, encoded).map(({ name, value }) => ({ name, value }));
}

const session = (accessToken, extra = {}) => ({
  access_token: accessToken,
  refresh_token: 'rt-abc',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  expires_in: 3600,
  token_type: 'bearer',
  user: { id: 'u1', email: 'x@example.com', app_metadata: { role: 'station' } },
  ...extra,
});

// ── Storage key derivation ───────────────────────────────────────────────────────────────────

test('storageKeyForUrl derives sb-<ref>-auth-token from the project URL', () => {
  assert.equal(storageKeyForUrl('https://dvucodtdojumvplmgjeu.supabase.co'), KEY);
  assert.equal(storageKeyForUrl('https://abc.supabase.co/'), 'sb-abc-auth-token');
});

test('storageKeyForUrl returns null for an unparseable URL rather than throwing', () => {
  assert.equal(storageKeyForUrl('not a url'), null);
  assert.equal(storageKeyForUrl(''), null);
});

// ── Round trip: their writer → our reader ────────────────────────────────────────────────────

test('reads the access token from a single (unchunked) cookie', async () => {
  const cookies = writeSessionCookies(session('tok-single'));
  assert.equal(cookies.length, 1, 'small session should not chunk');
  assert.equal(await readAccessToken(cookies, KEY), 'tok-single');
});

test('reads the access token from a CHUNKED cookie', async () => {
  // A realistic JWT is ~1KB; pad past MAX_CHUNK_SIZE so the writer genuinely splits.
  const fatToken = 'tok-' + 'x'.repeat(MAX_CHUNK_SIZE * 2);
  const cookies = writeSessionCookies(session(fatToken));
  assert.ok(cookies.length > 1, `expected chunking, got ${cookies.length} cookie(s)`);
  assert.ok(cookies.some((c) => c.name === `${KEY}.0`), 'chunk naming is .0/.1/…');
  assert.equal(await readAccessToken(cookies, KEY), fatToken);
});

test('cookie order does not matter (chunks are reassembled by name)', async () => {
  const fatToken = 'tok-' + 'y'.repeat(MAX_CHUNK_SIZE * 2);
  const cookies = writeSessionCookies(session(fatToken)).reverse();
  assert.equal(await readAccessToken(cookies, KEY), fatToken);
});

test('unrelated cookies alongside the session are ignored', async () => {
  const cookies = [
    { name: 'lensed_active_store', value: 'abc' },
    ...writeSessionCookies(session('tok-mixed')),
    { name: 'lensed_station_mode', value: 'pack' },
  ];
  assert.equal(await readAccessToken(cookies, KEY), 'tok-mixed');
});

// ── Every failure mode returns null, never throws ────────────────────────────────────────────
// A null here means "cannot verify" (ride it out), NOT "signed out" — so a mangled cookie must
// never be able to manufacture a logout by throwing inside middleware.

test('no cookies at all → null', async () => {
  assert.equal(await readAccessToken([], KEY), null);
});

test('a TRUNCATED chunk set → null, no throw', async () => {
  const fatToken = 'tok-' + 'z'.repeat(MAX_CHUNK_SIZE * 2);
  const cookies = writeSessionCookies(session(fatToken));
  assert.equal(await readAccessToken(cookies.slice(0, 1), KEY), null);
});

test('undecodable base64 payload → null, no throw', async () => {
  assert.equal(await readAccessToken([{ name: KEY, value: 'base64-!!!not-base64!!!' }], KEY), null);
});

test('valid base64 that is not JSON → null, no throw', async () => {
  assert.equal(
    await readAccessToken([{ name: KEY, value: BASE64_PREFIX + stringToBase64URL('hello') }], KEY),
    null,
  );
});

test('JSON session with no access_token → null', async () => {
  const cookies = writeSessionCookies({ refresh_token: 'rt', user: { id: 'u' } });
  assert.equal(await readAccessToken(cookies, KEY), null);
});

test('empty-string access_token → null (treated as absent)', async () => {
  const cookies = writeSessionCookies(session(''));
  assert.equal(await readAccessToken(cookies, KEY), null);
});

test('a cookie for a DIFFERENT project ref is not read', async () => {
  const cookies = writeSessionCookies(session('tok-other'), 'sb-otherproject-auth-token');
  assert.equal(await readAccessToken(cookies, KEY), null);
});

// ── Auth-cookie presence detector (distinguishes "signed out" from "cannot verify") ──────────

test('hasSupabaseAuthCookie recognizes base, chunked, and verifier cookies', () => {
  assert.equal(hasSupabaseAuthCookie([{ name: KEY, value: '' }]), true);
  assert.equal(hasSupabaseAuthCookie([{ name: `${KEY}.0`, value: '' }, { name: `${KEY}.1`, value: '' }]), true);
  // Over-matches the transient PKCE verifier — benign, and kept identical to the previous
  // middleware predicate so authClassification.test.mjs stays accurate.
  assert.equal(hasSupabaseAuthCookie([{ name: `${KEY}-code-verifier`, value: '' }]), true);
});

test('hasSupabaseAuthCookie ignores unrelated cookies', () => {
  assert.equal(hasSupabaseAuthCookie([]), false);
  assert.equal(hasSupabaseAuthCookie([{ name: 'lensed_active_store', value: '' }]), false);
  assert.equal(hasSupabaseAuthCookie([{ name: 'lensed_timeclock', value: '1' }]), false);
});
