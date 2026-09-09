// Unit proof for the middleware's role + confinement decisions (Stage 1: middleware validates,
// does not refresh).
//
// Unlike authClassification.test.mjs — which mirrors predicates by hand — this transpiles the REAL
// src/lib/supabase/claims.ts at runtime and exercises it directly, so it cannot drift. claims.ts is
// import-free on purpose so the transpiled module needs nothing resolved from the temp directory.
//
// THE HEADLINE CASE: a Supabase access token has BOTH `role` (the POSTGRES role, always
// 'authenticated') and `app_metadata.role` (our app role). Reading the former would give every
// signed-in user role='authenticated', which is neither undefined nor 'admin', so it lands in the
// fail-closed catch-all and locks EVERY user out of the app. That must fail here, in CI.
//
// Run: node --test src/lib/supabase/claims.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./claims.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'claims-')), 'claims.mjs');
writeFileSync(outFile, outputText);
const {
  appRoleFromClaims,
  confinementFor,
  isPathAllowed,
  isExpired,
  memberConfinement,
  roleHomeFor,
  STATION_CONFINEMENT,
  TIMECLOCK_CONFINEMENT,
  PARTNER_CONFINEMENT,
} = await import(pathToFileURL(outFile).href);

// A realistic Supabase access-token claim set for each account shape.
const ownerClaims = { role: 'authenticated', sub: 'u-owner', exp: 9e9, app_metadata: { provider: 'email' } };
const adminClaims = { role: 'authenticated', sub: 'u-admin', exp: 9e9, app_metadata: { role: 'admin' } };
const stationClaims = { role: 'authenticated', sub: 'u-stn', exp: 9e9, app_metadata: { role: 'station' } };
const timeclockClaims = { role: 'authenticated', sub: 'u-tc', exp: 9e9, app_metadata: { role: 'timeclock' } };
const memberClaims = (scopes) => ({ role: 'authenticated', sub: 'u-mem', exp: 9e9, app_metadata: { role: 'member', scopes } });
const partnerClaims = { role: 'authenticated', sub: 'u-partner', exp: 9e9, app_metadata: { role: 'partner' } };

// ── THE LOCKOUT GUARD ────────────────────────────────────────────────────────────────────────
// If anyone ever wires claims.role instead of claims.app_metadata.role, these fail.

test('LOCKOUT GUARD: the POSTGRES role claim never becomes the app role', () => {
  // Every one of these tokens carries role:'authenticated' at the top level.
  assert.equal(appRoleFromClaims(ownerClaims), undefined, 'owner has no app role → unconfined');
  assert.equal(appRoleFromClaims(adminClaims), 'admin');
  assert.equal(appRoleFromClaims(stationClaims), 'station');
  assert.equal(appRoleFromClaims(timeclockClaims), 'timeclock');
  assert.equal(appRoleFromClaims(memberClaims(['binding'])), 'member');
});

test('LOCKOUT GUARD: an owner token (role:authenticated, no app_metadata.role) is UNCONFINED', () => {
  const role = appRoleFromClaims(ownerClaims);
  assert.equal(role, undefined);
  assert.equal(confinementFor(role, undefined), undefined, 'undefined confinement = full access');
});

test("LOCKOUT GUARD: 'authenticated' as an app role would fail CLOSED, not open", () => {
  // Proves the catch-all is fail-closed: if the bug ever ships, users are locked OUT (an outage),
  // never granted extra reach (a breach). Both are bad; only one is a security incident.
  const c = confinementFor('authenticated', undefined);
  assert.deepEqual(c, { home: '/login', allow: [] });
  assert.equal(isPathAllowed('/dashboard', c), false);
  assert.equal(isPathAllowed('/api/live/sessions', c), false);
});

test('LOCKOUT GUARD: reading the wrong claim would confine every account shape', () => {
  // Simulate the mistake explicitly — every token's top-level role is identical.
  for (const claims of [ownerClaims, adminClaims, stationClaims, timeclockClaims, memberClaims(['binding'])]) {
    assert.equal(claims.role, 'authenticated');
    const wrong = confinementFor(claims.role, claims.app_metadata?.scopes);
    assert.deepEqual(wrong, { home: '/login', allow: [] }, 'the mistake confines everyone');
  }
});

// ── Confinement tables ───────────────────────────────────────────────────────────────────────

test('station reaches only /fulfillment + /api/station', () => {
  const c = confinementFor('station', undefined);
  assert.deepEqual(c, STATION_CONFINEMENT);
  assert.equal(isPathAllowed('/fulfillment', c), true);
  assert.equal(isPathAllowed('/api/station/scan', c), true);
  assert.equal(isPathAllowed('/dashboard', c), false);
  assert.equal(isPathAllowed('/api/shipping/confirm', c), false);
  assert.equal(isPathAllowed('/kiosk', c), false);
});

test('timeclock reaches only /kiosk + /api/kiosk', () => {
  const c = confinementFor('timeclock', undefined);
  assert.deepEqual(c, TIMECLOCK_CONFINEMENT);
  assert.equal(isPathAllowed('/kiosk', c), true);
  assert.equal(isPathAllowed('/api/kiosk/scan', c), true);
  assert.equal(isPathAllowed('/dashboard', c), false);
  assert.equal(isPathAllowed('/fulfillment', c), false);
});

test('member reach is the UNION over recognized scopes', () => {
  const c = confinementFor('member', ['binding', 'inventory']);
  assert.equal(isPathAllowed('/team/binding', c), true);
  assert.equal(isPathAllowed('/team/inventory', c), true);
  assert.equal(isPathAllowed('/api/member/bind', c), true);
  assert.equal(isPathAllowed('/api/member/inventory', c), true);
  assert.equal(isPathAllowed('/api/team', c), false, '/api/team is deliberately unreachable');
  assert.equal(isPathAllowed('/dashboard', c), false);
});

test('the audit queue rides the binding scope — and ONLY the binding scope', () => {
  const binder = confinementFor('member', ['binding']);
  assert.equal(isPathAllowed('/team/audit', binder), true);
  assert.equal(isPathAllowed('/api/member/audit', binder), true);
  // /keep and /dismiss are children, reached through the startsWith match — not listed separately.
  assert.equal(isPathAllowed('/api/member/audit/keep', binder), true);
  assert.equal(isPathAllowed('/api/member/audit/dismiss', binder), true);
  // Home must still be the BINDING page: memberConfinement takes element [0], so inserting
  // '/team/audit' anywhere but second would silently move where a binder lands after sign-in.
  assert.equal(binder.home, '/team/binding');

  // An inventory-only member gains nothing: the audit routes UNBIND orders and move stock.
  const stocker = confinementFor('member', ['inventory']);
  assert.equal(isPathAllowed('/team/audit', stocker), false);
  assert.equal(isPathAllowed('/api/member/audit', stocker), false);
  assert.equal(isPathAllowed('/api/member/audit/keep', stocker), false);
});

test('the out-of-stock lookup rides the binding scope too', () => {
  const binder = confinementFor('member', ['binding']);
  assert.equal(isPathAllowed('/team/oos', binder), true);
  assert.equal(isPathAllowed('/api/member/oos', binder), true);
  // Read-only, but still scope-gated: it names what a customer bought, box by box.
  const stocker = confinementFor('member', ['inventory']);
  assert.equal(isPathAllowed('/team/oos', stocker), false);
  assert.equal(isPathAllowed('/api/member/oos', stocker), false);
  // And the station's own allowlist must not have quietly gained a /team page.
  const station = confinementFor('station', []);
  assert.equal(isPathAllowed('/team/oos', station), false);
});

test('member with an UNKNOWN scope contributes nothing (fail closed) and lands on no-access', () => {
  const c = confinementFor('member', ['payroll']);
  assert.deepEqual(c.allow, []);
  assert.equal(c.home, '/team/no-access');
  assert.equal(isPathAllowed('/team/no-access', c), true, 'home is always reachable → no loop');
  assert.equal(isPathAllowed('/team/binding', c), false);
});

test('member with no scopes at all lands on no-access with an empty allowlist', () => {
  assert.deepEqual(memberConfinement(undefined), { home: '/team/no-access', allow: [] });
  assert.deepEqual(memberConfinement([]), { home: '/team/no-access', allow: [] });
});

test('a typo role is confined, not unconfined', () => {
  const c = confinementFor('statoin', undefined);
  assert.deepEqual(c, { home: '/login', allow: [] });
});

test('prefix matching does not leak to sibling paths', () => {
  const c = confinementFor('station', undefined);
  assert.equal(isPathAllowed('/fulfillment', c), true);
  assert.equal(isPathAllowed('/fulfillment/x', c), true);
  assert.equal(isPathAllowed('/fulfillment-admin', c), false, 'must not match a sibling prefix');
  assert.equal(isPathAllowed('/api/stationary', c), false);
});

// ── roleHome ─────────────────────────────────────────────────────────────────────────────────

test('roleHomeFor maps each role to its landing page', () => {
  assert.equal(roleHomeFor(undefined, undefined), '/dashboard');
  assert.equal(roleHomeFor('admin', undefined), '/dashboard');
  assert.equal(roleHomeFor('station', undefined), '/fulfillment');
  assert.equal(roleHomeFor('timeclock', undefined), '/kiosk');
  assert.equal(roleHomeFor('member', ['inventory']), '/team/inventory');
  assert.equal(roleHomeFor('member', ['nope']), '/team/no-access');
});

// ── Freshness (decided by us, not by the JWT library) ────────────────────────────────────────

test('isExpired compares exp (seconds) against now (ms)', () => {
  const now = 1_700_000_000_000; // ms
  assert.equal(isExpired({ exp: 1_700_000_060 }, now), false, '60s in the future → fresh');
  assert.equal(isExpired({ exp: 1_699_999_940 }, now), true, '60s in the past → expired');
  assert.equal(isExpired({ exp: 1_700_000_000 }, now), true, 'exactly now → expired');
});

test('missing or malformed exp is treated as expired (fail closed on freshness)', () => {
  assert.equal(isExpired({}, Date.now()), true);
  assert.equal(isExpired(null, Date.now()), true);
  assert.equal(isExpired({ exp: 'soon' }, Date.now()), true);
});

// ── The confinement fail-OPEN this stage closes ──────────────────────────────────────────────

test('an EXPIRED-but-authentic station token still yields the station role (no fail-open)', () => {
  // The middleware verifies with allowExpired and decides freshness itself, precisely so a lapsed
  // station token keeps its confinement instead of presenting as role-less (= unconfined).
  const expiredStation = { ...stationClaims, exp: 1 };
  assert.equal(isExpired(expiredStation, Date.now()), true, 'stale…');
  assert.equal(appRoleFromClaims(expiredStation), 'station', '…but still confined');
  assert.equal(isPathAllowed('/dashboard', confinementFor('station', undefined)), false);
});

// ── partner ──────────────────────────────────────────────────────────────────────────────────
// An external seller: their own shop and their own data, reached through a short allowlist of
// routes that are already scoped to the CALLER. The negative assertions are the point.

test('partner is CONFINED, and lands on /partner', () => {
  assert.equal(appRoleFromClaims(partnerClaims), 'partner');
  const c = confinementFor('partner', undefined);
  assert.deepEqual(c, PARTNER_CONFINEMENT);
  assert.equal(c.home, '/partner');
  assert.equal(roleHomeFor('partner', undefined), '/partner');
});

test('partner reaches their own shop pages, shared inventory and label buying', () => {
  const c = confinementFor('partner', undefined);
  for (const p of [
    '/partner',
    '/partner/inventory',
    '/partner/labels',
    '/api/partner/inventory',
    '/api/stores',
    '/api/stores/active',
    '/api/tiktok/auth',
    '/api/tiktok/status',
    '/api/tiktok/sync',
    '/api/shipping/labels/scopes',
    '/api/shipping/labels/dry-run',
    '/api/shipping/labels/authorize',
    '/api/shipping/labels/purchase',
    '/api/shipping/labels/pdf',
  ]) assert.equal(isPathAllowed(p, c), true, p);
});

test('partner can finish the OAuth handshake for their own shop', () => {
  const c = confinementFor('partner', undefined);
  // The confinement check runs BEFORE the OAuth-callback allowance in the middleware, so without
  // this entry a partner could never connect a shop at all.
  assert.equal(isPathAllowed('/auth/tiktok/callback', c), true);
});

test('partner NEVER reaches our dashboard, payroll, admin, assistant or owner-scoped routes', () => {
  const c = confinementFor('partner', undefined);
  for (const p of [
    '/dashboard',
    '/dashboard/time-clock',
    '/entries',
    '/products',
    '/account',
    '/admin/team',
    '/admin/channels',
    '/fulfillment',
    '/kiosk',
    '/team/binding',
    '/api/chat',
    '/api/labor',
    '/api/team/fulfillment-performance',
    '/api/admin/team',
    '/api/admin/reports',
    '/api/member/inventory',
    '/api/station/scan',
    '/api/kiosk/scan',
    '/api/pnl/by-show',
    '/api/employees',
    '/api/shows',
  ]) assert.equal(isPathAllowed(p, c), false, p);
});

test('partner cannot WRITE our shared catalog, and cannot delete their order history', () => {
  const c = confinementFor('partner', undefined);
  // /api/inventory/* is org-scoped AND writable — a partner editing our catalog is a write we
  // never want. They read the catalog through /api/partner/inventory instead.
  assert.equal(isPathAllowed('/api/inventory/skus', c), false);
  assert.equal(isPathAllowed('/api/inventory/skus/abc/batches', c), false);
  // Disconnect DELETES that store's synced orders — the record of what they sold from our stock.
  assert.equal(isPathAllowed('/api/tiktok/disconnect', c), false);
});

test('partner prefix matching does not leak to sibling paths', () => {
  const c = confinementFor('partner', undefined);
  // '/partner' must not match '/partnership…', and '/api/stores' must not match '/api/storesX'.
  assert.equal(isPathAllowed('/partnership', c), false);
  assert.equal(isPathAllowed('/partner-admin', c), false);
  assert.equal(isPathAllowed('/api/storesecret', c), false);
  assert.equal(isPathAllowed('/api/partnerx', c), false);
});

test('an EXPIRED-but-authentic partner token still yields the partner role (no fail-open)', () => {
  const stale = { ...partnerClaims, exp: 1 };
  assert.equal(isExpired(stale, Date.now()), true);
  assert.equal(appRoleFromClaims(stale), 'partner');
  assert.equal(confinementFor(appRoleFromClaims(stale), undefined).home, '/partner');
});

test('partner does not widen the other roles', () => {
  // A regression guard: adding a role must not add reach anywhere else.
  assert.equal(isPathAllowed('/partner', STATION_CONFINEMENT), false);
  assert.equal(isPathAllowed('/partner', TIMECLOCK_CONFINEMENT), false);
  assert.equal(isPathAllowed('/partner', memberConfinement(['binding', 'inventory'])), false);
  assert.equal(isPathAllowed('/api/partner/inventory', memberConfinement(['inventory'])), false);
});
