// A scope is only real in THREE places at once. This asserts they agree.
//
// A member capability scope has to be registered in:
//   1. KNOWN_MEMBER_SCOPES  (@/lib/member/scopes)          — so it can be granted
//   2. MEMBER_SCOPE_PATHS   (@/lib/supabase/claims)         — so it reaches anything
//   3. SCOPE_OPTIONS        (the /admin/team page)          — so an admin can tick it
//
// They drifted. `pnl`, `shows` and `team` were offered in the UI, accepted by the EDIT route,
// rejected by the CREATE route, and absent from the middleware allowlist — so the pages and APIs
// they gate shipped and then sat unreachable. Both server copies of the constant carried a comment
// promising they were "kept in lockstep". Nothing checked, so nothing was.
//
// claims.ts is deliberately IMPORT-FREE (the middleware runs at the edge, and claims.test.mjs
// transpiles it standalone), so it cannot import the shared constant. This test is what keeps the
// two honest instead — in BOTH directions, because each direction is a different bug:
//   • scope with no paths  → the account signs in fine and can reach nothing
//   • paths with no scope  → dead allowlist entries nobody can hold, i.e. reach that looks granted
//
// Run:  TZ=UTC node src/lib/member/scopes.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'scopes-'));
function transpile(srcRel, outName) {
  const srcPath = fileURLToPath(new URL(srcRel, import.meta.url));
  const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const out = join(dir, outName);
  writeFileSync(out, outputText);
  return pathToFileURL(out).href;
}

const { KNOWN_MEMBER_SCOPES, validMemberScopes } = await import(transpile('./scopes.ts', 'scopes.mjs'));
const { MEMBER_SCOPE_PATHS, memberConfinement, isPathAllowed } =
  await import(transpile('../supabase/claims.ts', 'claims.mjs'));

// The UI's list, read from source — it is a plain literal in a client component, and the point is
// that it must not be able to offer a scope the server rejects.
const uiSrc = readFileSync(fileURLToPath(new URL('../../app/(app)/admin/team/page.tsx', import.meta.url)), 'utf8');
const uiBlock = uiSrc.slice(uiSrc.indexOf('const SCOPE_OPTIONS'), uiSrc.indexOf('const SCOPE_LABEL'));
const uiScopes = [...uiBlock.matchAll(/value:\s*'([a-z]+)'/g)].map((m) => m[1]);

let passed = 0;
const results = [];
const t = (name, fn) => {
  try { fn(); passed++; results.push(['ok', name]); }
  catch (e) { results.push(['FAIL', name, e.message]); }
};

const sorted = (a) => [...a].sort();

// ── the three-way agreement ──
t('every grantable scope has middleware reach', () => {
  for (const s of KNOWN_MEMBER_SCOPES) {
    assert.ok(
      Array.isArray(MEMBER_SCOPE_PATHS[s]) && MEMBER_SCOPE_PATHS[s].length > 0,
      `scope '${s}' can be granted but reaches nothing — its holder lands on /team/no-access`,
    );
  }
});

t('every middleware scope can actually be granted', () => {
  for (const s of Object.keys(MEMBER_SCOPE_PATHS)) {
    assert.ok(
      KNOWN_MEMBER_SCOPES.includes(s),
      `MEMBER_SCOPE_PATHS['${s}'] is reach nobody can hold — remove it or add it to KNOWN_MEMBER_SCOPES`,
    );
  }
});

t('the Team UI offers EXACTLY the grantable scopes', () => {
  assert.deepEqual(sorted(uiScopes), sorted(KNOWN_MEMBER_SCOPES),
    'a checkbox the server rejects is a form that fails on submit; a missing one is a scope nobody can assign');
});

t('the three scopes that were dead are now live', () => {
  for (const s of ['pnl', 'shows', 'team']) {
    assert.ok(KNOWN_MEMBER_SCOPES.includes(s), `${s} must be grantable`);
    assert.ok(MEMBER_SCOPE_PATHS[s]?.length, `${s} must have reach`);
  }
});

// ── each scope's home must be a page, and reach must include what that page calls ──
t("every scope's home is a /team page, not an API", () => {
  for (const [s, paths] of Object.entries(MEMBER_SCOPE_PATHS)) {
    assert.ok(paths[0].startsWith('/team/'),
      `MEMBER_SCOPE_PATHS['${s}'][0] is the scope's HOME and must be a page — got ${paths[0]}`);
  }
});

t('pnl reaches its page and all three P&L endpoints', () => {
  const c = memberConfinement(['pnl']);
  assert.equal(c.home, '/team/pnl');
  for (const p of ['/team/pnl', '/api/member/pnl/by-show', '/api/member/pnl/show-hourly', '/api/member/pnl/by-period'])
    assert.equal(isPathAllowed(p, c), true, p);
});

t('shows reaches its page, the list, and the per-show children', () => {
  const c = memberConfinement(['shows']);
  assert.equal(c.home, '/team/shows');
  for (const p of ['/team/shows', '/api/member/shows', '/api/member/shows/abc/board', '/api/member/shows/abc/duration', '/api/member/shows/abc/coverage'])
    assert.equal(isPathAllowed(p, c), true, p);
});

t('team reaches /team/staff and the five routes that page calls', () => {
  const c = memberConfinement(['team']);
  assert.equal(c.home, '/team/staff');
  for (const p of [
    '/team/staff',
    '/api/member/team/roster',
    '/api/member/team/host-performance',
    '/api/member/team/host-live-hours',
    '/api/member/team/shifts',
    '/api/member/team/attendance',
  ]) assert.equal(isPathAllowed(p, c), true, p);
});

// ── the new scopes must not have widened anything else ──
t('the new scopes grant NO payroll, admin or owner surface', () => {
  const c = memberConfinement(['pnl', 'shows', 'team']);
  for (const p of [
    '/dashboard', '/admin/team', '/account', '/entries', '/products',
    '/api/labor',                       // payroll: hours x rate
    '/api/team/fulfillment-performance',// the OWNER's self-scoped twin, deliberately unreachable
    '/api/admin/team', '/api/chat', '/api/employees', '/api/pnl/by-show',
    '/api/station/scan', '/api/kiosk/scan', '/api/seller/inventory',
  ]) assert.equal(isPathAllowed(p, c), false, p);
});

t('one scope does not leak into another', () => {
  assert.equal(isPathAllowed('/team/staff', memberConfinement(['pnl'])), false);
  assert.equal(isPathAllowed('/api/member/team/roster', memberConfinement(['shows'])), false);
  assert.equal(isPathAllowed('/api/member/pnl/by-show', memberConfinement(['team'])), false);
  assert.equal(isPathAllowed('/api/member/inventory', memberConfinement(['shows'])), false);
});

t('prefix matching does not leak to sibling paths', () => {
  const c = memberConfinement(['team']);
  assert.equal(isPathAllowed('/api/member/teamsecret', c), false);
  assert.equal(isPathAllowed('/team/staffing', c), false);
});

// ── the shared validator still fails closed ──
t('validMemberScopes accepts the five, rejects anything else', () => {
  assert.deepEqual(validMemberScopes(['pnl', 'shows', 'team']), ['pnl', 'shows', 'team']);
  assert.deepEqual(validMemberScopes([...KNOWN_MEMBER_SCOPES]), [...KNOWN_MEMBER_SCOPES]);
  assert.equal(validMemberScopes(['pnl', 'nope']), null, 'one bad entry rejects the whole request');
  assert.equal(validMemberScopes([]), null);
  assert.equal(validMemberScopes('pnl'), null);
  assert.equal(validMemberScopes(['PNL']), null, 'scopes are case-sensitive');
  assert.deepEqual(validMemberScopes([' pnl ', 'pnl']), ['pnl'], 'trimmed and de-duplicated');
});

for (const [status, name, err] of results) {
  console.log(`${status === 'ok' ? '✓' : '✗'} ${name}${err ? ` — ${err}` : ''}`);
}
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
