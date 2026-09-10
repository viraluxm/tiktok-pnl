// Org-bounded data scope: the ladder in scope.ts, and the org bound on resolveOwnerIds.
//
// Exercises the REAL scope.ts and the REAL station/guard.ts, transpiled at runtime — the repo's
// .test.mjs pattern. Only 'server-only', next/server and the Supabase clients are stubbed
// (environment). The fake client RECORDS every filter, so the tests assert the PREDICATE, not
// just the outcome.
//
// THE POINT: before this change, owner resolution had no org filter, so it returned every store
// owner in the DATABASE. With one tenant that is invisible. "second org: station sees ONLY its
// own org's owner" and "declared store from another org is DROPPED" are the two tests that FAIL
// if the org bound is removed — checked by hand: delete the `.eq('org_id', orgId)` store lookup
// in resolveOwnerIds and both must go red.
//
// Run:  TZ=UTC node src/lib/org/scope.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'orgscope-'));
const write = (name, src) => { const p = join(dir, name); writeFileSync(p, src); return pathToFileURL(p).href; };
function transpile(srcRel, outName, rewrites = {}) {
  const srcPath = fileURLToPath(new URL(srcRel, import.meta.url));
  let { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  for (const [from, to] of Object.entries(rewrites)) outputText = outputText.split(from).join(to);
  return write(outName, outputText);
}

// ── stubs: environment only ──
const serverOnly = write('serverOnly.mjs', 'export {};\n');
const nextServer = write('nextServer.mjs',
  'export const NextResponse = { json: (body, init) => ({ body, status: init?.status ?? 200 }) };\n');
const serverClientStub = write('serverClient.mjs',
  'export async function createClient(){ return { auth: { getUser: async () => ({ data: { user: globalThis.__USER } }) } }; }\n');
const adminStub = write('adminClient.mjs', 'export function createAdminClient(){ return globalThis.__DB; }\n');

const scopeUrl = transpile('./scope.ts', 'scope.mjs', { "'server-only'": `'${serverOnly}'` });
const guardUrl = transpile('../station/guard.ts', 'guard.mjs', {
  "'next/server'": `'${nextServer}'`,
  "'@/lib/supabase/server'": `'${serverClientStub}'`,
  "'@/lib/supabase/admin'": `'${adminStub}'`,
  "'@/lib/org/scope'": `'${scopeUrl}'`,
});

const { orgIdFromMetadata, declaredStoreIds, orgIdFromStoreRows, soleOrgId, resolveScopeOrgId } =
  await import(scopeUrl);
const { resolveOwnerIds, requireStationScope } = await import(guardUrl);

// ── fake Supabase: returns fixture rows per table, records every filter ──
// `tables` is { [name]: rows }. Each query records { table, eq: {...}, in: {...}, limit } so a
// test can assert what the code ASKED for, not only what it got back.
function fakeDb(tables) {
  const queries = [];
  const client = {
    queries,
    from(table) {
      const q = { table, eq: {}, in: {}, not: [], limit: null };
      queries.push(q);
      const rows = () => {
        let out = tables[table] ?? [];
        for (const [col, val] of Object.entries(q.eq)) out = out.filter((r) => String(r[col]) === String(val));
        for (const [col, vals] of Object.entries(q.in)) out = out.filter((r) => vals.map(String).includes(String(r[col])));
        return q.limit == null ? out : out.slice(0, q.limit);
      };
      const chain = {
        select() { return chain; },
        eq(col, val) { q.eq[col] = val; return chain; },
        in(col, vals) { q.in[col] = vals; return chain; },
        order() { return chain; },
        limit(n) { q.limit = n; return chain; },
        maybeSingle() { const r = rows(); return Promise.resolve({ data: r[0] ?? null, error: null }); },
        then(resolve, reject) { return Promise.resolve({ data: rows(), error: null }).then(resolve, reject); },
      };
      return chain;
    },
  };
  return client;
}

// ── fixtures: TWO organizations, each with its own store + owner ──
const ORG_A = 'org-aaaa';
const ORG_B = 'org-bbbb';
const OWNER_A = 'user-owner-a';
const OWNER_B = 'user-owner-b';
const STORE_A1 = 'store-a1';
const STORE_A2 = 'store-a2';
const STORE_B1 = 'store-b1';

const twoOrgTables = () => ({
  organizations: [{ id: ORG_A }, { id: ORG_B }],
  organization_members: [
    { org_id: ORG_A, user_id: OWNER_A, created_at: '2026-01-01' },
    { org_id: ORG_B, user_id: OWNER_B, created_at: '2026-01-02' },
  ],
  stores: [
    { id: STORE_A1, org_id: ORG_A },
    { id: STORE_A2, org_id: ORG_A },
    { id: STORE_B1, org_id: ORG_B },
  ],
  store_members: [
    { store_id: STORE_A1, user_id: OWNER_A, role: 'owner' },
    { store_id: STORE_A2, user_id: OWNER_A, role: 'owner' },
    { store_id: STORE_B1, user_id: OWNER_B, role: 'owner' },
  ],
});

// One org — production as it stands today, where this whole change must be a no-op.
const oneOrgTables = () => {
  const t = twoOrgTables();
  t.organizations = [{ id: ORG_A }];
  t.organization_members = t.organization_members.filter((r) => r.org_id === ORG_A);
  t.stores = t.stores.filter((r) => r.org_id === ORG_A);
  t.store_members = t.store_members.filter((r) => r.store_id !== STORE_B1);
  return t;
};

let passed = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); passed++; results.push(['ok', name]); }
  catch (e) { results.push(['FAIL', name, e.message]); }
}

// ── pure helpers ──
await t('orgIdFromMetadata: trims, ignores empty and non-strings', () => {
  assert.equal(orgIdFromMetadata({ org_id: '  org-x ' }), 'org-x');
  assert.equal(orgIdFromMetadata({ org_id: '' }), null);
  assert.equal(orgIdFromMetadata({ org_id: 123 }), null);
  assert.equal(orgIdFromMetadata(null), null);
  assert.equal(orgIdFromMetadata(undefined), null);
});

await t("declaredStoreIds: drops the '*' sentinel, dedups, trims", () => {
  assert.deepEqual(declaredStoreIds({ stores: ['a', 'a', ' b ', '*', ''] }), ['a', 'b']);
  assert.deepEqual(declaredStoreIds({ stores: '*' }), []);
  assert.deepEqual(declaredStoreIds({}), []);
});

await t('orgIdFromStoreRows: one org resolves, two orgs REFUSE, none falls through', () => {
  assert.deepEqual(orgIdFromStoreRows([{ org_id: ORG_A }, { org_id: ORG_A }]),
    { ok: true, orgId: ORG_A, source: 'assigned_stores' });
  const spanning = orgIdFromStoreRows([{ org_id: ORG_A }, { org_id: ORG_B }]);
  assert.equal(spanning.ok, false);
  assert.match(spanning.error, /span 2 organizations/);
  assert.equal(orgIdFromStoreRows([]), null);
});

await t('soleOrgId: 1 resolves, 0 fails, 2+ fails telling you to stamp org_id', () => {
  assert.deepEqual(soleOrgId([{ id: ORG_A }]), { ok: true, orgId: ORG_A, source: 'sole_org' });
  assert.equal(soleOrgId([]).ok, false);
  const many = soleOrgId([{ id: ORG_A }, { id: ORG_B }]);
  assert.equal(many.ok, false);
  assert.match(many.error, /app_metadata\.org_id/);
});

// ── the ladder ──
await t('ladder 1: a stamped org_id wins and costs NO queries', async () => {
  const db = fakeDb(twoOrgTables());
  const got = await resolveScopeOrgId(db, { id: 'u1', app_metadata: { org_id: ORG_B } });
  assert.deepEqual(got, { ok: true, orgId: ORG_B, source: 'app_metadata' });
  assert.equal(db.queries.length, 0, 'a stamped org must not be re-derived');
});

await t('ladder 2: an org membership resolves the org', async () => {
  const db = fakeDb(twoOrgTables());
  const got = await resolveScopeOrgId(db, { id: OWNER_B, app_metadata: {} });
  assert.deepEqual(got, { ok: true, orgId: ORG_B, source: 'organization_members' });
});

await t('ladder 3: assigned stores name the org (no membership row needed)', async () => {
  const db = fakeDb(twoOrgTables());
  const got = await resolveScopeOrgId(db, { id: 'member-1', app_metadata: { stores: [STORE_A2] } });
  assert.deepEqual(got, { ok: true, orgId: ORG_A, source: 'assigned_stores' });
});

await t('ladder 3: stores spanning two orgs is REFUSED, not narrowed to one', async () => {
  const db = fakeDb(twoOrgTables());
  const got = await resolveScopeOrgId(db, { id: 'member-1', app_metadata: { stores: [STORE_A1, STORE_B1] } });
  assert.equal(got.ok, false);
});

await t('ladder 4: with ONE org, an unassigned account falls back to it (today, in prod)', async () => {
  const db = fakeDb(oneOrgTables());
  const got = await resolveScopeOrgId(db, { id: 'station-1', app_metadata: { role: 'station' } });
  assert.deepEqual(got, { ok: true, orgId: ORG_A, source: 'sole_org' });
});

await t('THE TRIPWIRE: with TWO orgs, an unassigned account FAILS CLOSED', async () => {
  const db = fakeDb(twoOrgTables());
  const got = await resolveScopeOrgId(db, { id: 'station-1', app_metadata: { role: 'station' } });
  assert.equal(got.ok, false, 'guessing an org here would be a cross-tenant read');
  assert.match(got.error, /app_metadata\.org_id/);
});

// ── the org bound on resolveOwnerIds ──
await t('resolveOwnerIds: unfiltered means every store IN THE ORG — and no other', async () => {
  const db = fakeDb(twoOrgTables());
  const got = await resolveOwnerIds(db, ORG_A);
  assert.deepEqual(got.ownerIds, [OWNER_A]);
  assert.deepEqual(got.storeIds.sort(), [STORE_A1, STORE_A2].sort());
  // PREDICATE: the store_members read is bounded by an explicit store_id list, never open-ended.
  const sm = db.queries.find((q) => q.table === 'store_members');
  assert.equal(sm.eq.role, 'owner');
  assert.deepEqual([...sm.in.store_id].sort(), [STORE_A1, STORE_A2].sort());
});

await t('resolveOwnerIds: a declared store from ANOTHER org is DROPPED, not trusted', async () => {
  const db = fakeDb(twoOrgTables());
  const got = await resolveOwnerIds(db, ORG_A, { storeIds: [STORE_A1, STORE_B1] });
  assert.deepEqual(got.ownerIds, [OWNER_A], "org B's owner must not appear");
  const sm = db.queries.find((q) => q.table === 'store_members');
  assert.deepEqual(sm.in.store_id, [STORE_A1], 'the foreign store id must never reach the query');
});

await t('resolveOwnerIds: no store in the org resolves to an empty set, not an open query', async () => {
  const db = fakeDb(twoOrgTables());
  const got = await resolveOwnerIds(db, 'org-with-no-stores');
  assert.deepEqual(got, { ok: true, ownerIds: [], storeIds: [] });
  assert.equal(db.queries.some((q) => q.table === 'store_members'), false);
});

// ── end to end: the station guard ──
await t('station guard: with TWO orgs, a station sees ONLY its own org\'s owner', async () => {
  globalThis.__DB = fakeDb(twoOrgTables());
  globalThis.__USER = { id: 'station-a', app_metadata: { role: 'station', org_id: ORG_A } };
  const scope = await requireStationScope();
  assert.equal(scope.ok, true);
  assert.deepEqual(scope.ownerIds, [OWNER_A], "the other tenant's owner must not be in scope");
});

await t('station guard: an unresolvable org is a 500, never an empty-but-ok scope', async () => {
  globalThis.__DB = fakeDb(twoOrgTables());
  globalThis.__USER = { id: 'station-x', app_metadata: { role: 'station' } };
  const scope = await requireStationScope();
  assert.equal(scope.ok, false);
  assert.equal(scope.response.status, 500);
});

await t('station guard: unchanged behaviour on a single-org database', async () => {
  globalThis.__DB = fakeDb(oneOrgTables());
  globalThis.__USER = { id: 'station-a', app_metadata: { role: 'station' } };
  const scope = await requireStationScope();
  assert.equal(scope.ok, true);
  assert.deepEqual(scope.ownerIds, [OWNER_A]);
});

for (const [status, name, err] of results) {
  console.log(`${status === 'ok' ? '✓' : '✗'} ${name}${err ? ` — ${err}` : ''}`);
}
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
