// GET /api/seller/inventory — the only route that shows an external seller our data.
//
// Exercises the REAL route and the REAL requireSellerScope, transpiled at runtime. Stubbed:
// next/server, the Supabase server client (session + a recording query builder), and @/lib/org.
//
// The fake client RECORDS every filter, so these assert the PREDICATE. Two things must hold no
// matter what: the role gate, and that the org filter is written into the query rather than left
// to RLS. Mutation-checked by hand — delete `.eq('org_id', orgId)` and "scopes the read to the
// caller's own org" goes red.
//
// Run:  TZ=UTC node src/app/api/seller/inventory/route.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'sellerinv-'));
const write = (name, src) => { const p = join(dir, name); writeFileSync(p, src); return pathToFileURL(p).href; };
function transpile(srcRel, outName, rewrites = {}) {
  const srcPath = fileURLToPath(new URL(srcRel, import.meta.url));
  let { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  for (const [from, to] of Object.entries(rewrites)) outputText = outputText.split(from).join(to);
  return write(outName, outputText);
}

const serverOnly = write('serverOnly.mjs', 'export {};\n');
const nextStub = write('nextStub.mjs',
  'export const NextResponse = { json: (body, init) => ({ body, status: (init && init.status) || 200 }) };\n');
const clientStub = write('clientStub.mjs',
  'export async function createClient(){ return globalThis.__DB; }\n');
const orgStub = write('orgStub.mjs', 'export async function getOrgId(){ return globalThis.__MEMBER_ORG; }\n');

const guardUrl = transpile('../../../../lib/seller/guard.ts', 'guard.mjs', {
  "'server-only'": `'${serverOnly}'`,
  "'next/server'": `'${nextStub}'`,
  "'@/lib/supabase/server'": `'${clientStub}'`,
  "'@/lib/org'": `'${orgStub}'`,
});
const { GET } = await import(transpile('./route.ts', 'route.mjs', {
  "'next/server'": `'${nextStub}'`,
  "'@/lib/seller/guard'": `'${guardUrl}'`,
}));

const ORG_A = 'org-a';
const ORG_B = 'org-b';
const SKUS = [
  { id: 's1', org_id: ORG_A, sku_number: 1, title: 'Ours A', is_active: true, unit_cost_cents: 300, qty_on_hand: 5 },
  { id: 's2', org_id: ORG_A, sku_number: 2, title: 'Ours B', is_active: false, unit_cost_cents: 400, qty_on_hand: 1 },
  { id: 's3', org_id: ORG_B, sku_number: 9, title: 'Someone else', is_active: true, unit_cost_cents: 900, qty_on_hand: 7 },
];

// Recording query builder. Applies the recorded eq() filters, so the response reflects the
// PREDICATE the route actually wrote.
function fakeDb(user) {
  const queries = [];
  return {
    queries,
    auth: { getUser: async () => ({ data: { user } }) },
    from(table) {
      const q = { table, eq: {} };
      queries.push(q);
      const rows = () => {
        let out = SKUS;
        for (const [c, v] of Object.entries(q.eq)) out = out.filter((r) => String(r[c]) === String(v));
        return out;
      };
      const chain = {
        select() { return chain; },
        eq(c, v) { q.eq[c] = v; return chain; },
        order() { return Promise.resolve({ data: rows(), error: null }); },
        then(res, rej) { return Promise.resolve({ data: rows(), error: null }).then(res, rej); },
      };
      return chain;
    },
  };
}
const seller = (extra = {}) => ({ id: 'u-seller', app_metadata: { role: 'seller', ...extra } });

let passed = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); passed++; results.push(['ok', name]); }
  catch (e) { results.push(['FAIL', name, e.message]); }
}

await t('scopes the read to the CALLER\'S OWN org, written into the query', async () => {
  globalThis.__DB = fakeDb(seller({ org_id: ORG_A }));
  globalThis.__MEMBER_ORG = null;
  const res = await GET();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const q = globalThis.__DB.queries.find((x) => x.table === 'inventory_skus');
  assert.equal(q.eq.org_id, ORG_A, 'the org filter must not be left to RLS alone');
  assert.deepEqual(res.body.skus.map((s) => s.id), ['s1'], 'another org\'s SKU must never come back');
});

await t('inactive SKUs are not offered for sale', async () => {
  globalThis.__DB = fakeDb(seller({ org_id: ORG_A }));
  const res = await GET();
  assert.equal(res.body.skus.some((s) => s.id === 's2'), false);
});

await t('falls back to the org membership when app_metadata.org_id is unstamped', async () => {
  globalThis.__DB = fakeDb(seller());
  globalThis.__MEMBER_ORG = ORG_A;
  const res = await GET();
  assert.equal(res.status, 200);
  assert.equal(globalThis.__DB.queries.find((x) => x.table === 'inventory_skus').eq.org_id, ORG_A);
});

await t('a stamped org_id WINS over the membership', async () => {
  globalThis.__DB = fakeDb(seller({ org_id: ORG_B }));
  globalThis.__MEMBER_ORG = ORG_A;
  await GET();
  assert.equal(globalThis.__DB.queries.find((x) => x.table === 'inventory_skus').eq.org_id, ORG_B);
});

await t('a seller with NO org is a 500, never an empty shelf', async () => {
  globalThis.__DB = fakeDb(seller());
  globalThis.__MEMBER_ORG = null;
  const res = await GET();
  assert.equal(res.status, 500);
  assert.match(res.body.error, /unresolved/);
});

// ── the role gate: the second gate, after middleware confinement ──
for (const [label, user] of [
  ['an owner (no app_metadata.role)', { id: 'u-owner', app_metadata: {} }],
  ['an admin', { id: 'u-admin', app_metadata: { role: 'admin' } }],
  ['a station', { id: 'u-stn', app_metadata: { role: 'station' } }],
  ['a member', { id: 'u-mem', app_metadata: { role: 'member', scopes: ['inventory'] } }],
  ['a timeclock kiosk', { id: 'u-tc', app_metadata: { role: 'timeclock' } }],
]) {
  await t(`${label} is 403 on the seller route`, async () => {
    globalThis.__DB = fakeDb(user);
    globalThis.__MEMBER_ORG = ORG_A;
    const res = await GET();
    assert.equal(res.status, 403);
    assert.equal(globalThis.__DB.queries.some((x) => x.table === 'inventory_skus'), false, 'no read may run');
  });
}

await t('unauthenticated is 401', async () => {
  globalThis.__DB = fakeDb(null);
  const res = await GET();
  assert.equal(res.status, 401);
});

await t('the route exposes no write verb', async () => {
  const mod = await import(transpile('./route.ts', 'route2.mjs', {
    "'next/server'": `'${nextStub}'`,
    "'@/lib/seller/guard'": `'${guardUrl}'`,
  }));
  for (const verb of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    assert.equal(mod[verb], undefined, `${verb} must not exist — a seller never edits our catalog`);
  }
});

for (const [status, name, err] of results) {
  console.log(`${status === 'ok' ? '✓' : '✗'} ${name}${err ? ` — ${err}` : ''}`);
}
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
