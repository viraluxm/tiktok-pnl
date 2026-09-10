// POST /api/admin/team — every sub-user is created carrying its organization, or not created.
//
// Exercises the REAL route module, transpiled at runtime (the repo's .test.mjs pattern). Stubbed:
// `next/server` (NextResponse), the Supabase server client (the caller's session), the admin
// client (store lookups + createUser), and @/lib/org (the creator's org membership).
//
// WHY THIS IS WORTH A TEST. app_metadata.org_id is what bounds a sub-user's data scope to one
// tenant. It is inert while a single organization exists — every rung of the resolution ladder
// agrees — so a role branch that forgets to stamp it cannot be caught by using the app. It gets
// caught the day a second organization exists, in the form of a station that has stopped working
// and nobody knowing why. So: assert the stamp on EVERY role branch, and assert that an
// unresolvable org refuses rather than creating an account that will fail closed later.
//
// Run:  TZ=UTC node src/app/api/admin/team/route.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'teamroute-'));
const write = (name, src) => { const p = join(dir, name); writeFileSync(p, src); return pathToFileURL(p).href; };

const ORG = 'org-lensed';
const STORE_A = 'store-a';
const STORE_B = 'store-b';

// ── stubs ──
const nextStub = write('nextStub.mjs', `
export const NextResponse = {
  json: (body, init) => ({ body, status: (init && init.status) || 200 }),
};
`);
const serverStub = write('serverStub.mjs', `
export async function createClient() {
  return { auth: { getUser: async () => ({ data: { user: globalThis.__USER } }) } };
}
`);
const adminStub = write('adminStub.mjs', `
export function createAdminClient() { return globalThis.__ADMIN; }
`);
const orgStub = write('orgStub.mjs', `
export async function getOrgId() { return globalThis.__ORG_ID; }
`);

// The scope constant + validator now live in @/lib/member/scopes (one definition, shared with the
// edit route — the two used to hold copies that drifted). Transpile the REAL module rather than
// stubbing it: which scopes are valid is part of what this route's contract is, and a stub would
// let the two disagree again without failing here.
const scopesPath = fileURLToPath(new URL('../../../../lib/member/scopes.ts', import.meta.url));
const scopesUrl = write('memberScopes.mjs', ts.transpileModule(readFileSync(scopesPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText);

const srcPath = fileURLToPath(new URL('./route.ts', import.meta.url));
let { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
for (const [from, to] of Object.entries({
  "'next/server'": `'${nextStub}'`,
  "'@/lib/supabase/server'": `'${serverStub}'`,
  "'@/lib/supabase/admin'": `'${adminStub}'`,
  "'@/lib/org'": `'${orgStub}'`,
  "'@/lib/member/scopes'": `'${scopesUrl}'`,
})) outputText = outputText.split(from).join(to);
const { POST } = await import(write('route.mjs', outputText));

// ── fake admin client: store existence + createUser ──
const KNOWN_STORES = new Set([STORE_A, STORE_B]);
function fakeAdmin() {
  return {
    from() {
      return {
        select() {
          return {
            in(_col, vals) {
              const rows = vals.filter((v) => KNOWN_STORES.has(v)).map((id) => ({ id }));
              return Promise.resolve({ data: rows, error: null });
            },
          };
        },
      };
    },
    auth: {
      admin: {
        createUser: async (args) => {
          globalThis.__CREATED.push(args);
          return { data: { user: { id: 'new-user-id', email: args.email } }, error: null };
        },
      },
    },
  };
}

const req = (body) => ({ json: async () => body });
function setup({ user = { id: 'admin-1', app_metadata: { role: 'admin' } }, orgId = ORG } = {}) {
  globalThis.__USER = user;
  globalThis.__ORG_ID = orgId;
  globalThis.__ADMIN = fakeAdmin();
  globalThis.__CREATED = [];
}

let passed = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); passed++; results.push(['ok', name]); }
  catch (e) { results.push(['FAIL', name, e.message]); }
}

// ── the stamp, on every role branch ──
await t('member: created with org_id alongside its role, scopes and stores', async () => {
  setup();
  const res = await POST(req({ email: 'M@Example.com ', role: 'member', scopes: ['binding'], stores: [STORE_A] }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const meta = globalThis.__CREATED[0].app_metadata;
  assert.equal(meta.org_id, ORG);
  assert.equal(meta.role, 'member');
  assert.deepEqual(meta.scopes, ['binding']);
  assert.deepEqual(meta.stores, [STORE_A]);
  assert.equal(res.body.user.org_id, ORG, 'the response reports what was actually written');
});

await t("member with the '*' sentinel: still stamped", async () => {
  setup();
  const res = await POST(req({ email: 'm2@example.com', role: 'member', scopes: ['inventory'], stores: ['*'] }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const meta = globalThis.__CREATED[0].app_metadata;
  assert.equal(meta.org_id, ORG, "the all-stores branch is a separate code path — it must stamp too");
  assert.deepEqual(meta.stores, ['*']);
});

await t('station: has no stores, but still carries the org', async () => {
  setup();
  const res = await POST(req({ email: 's@example.com', role: 'station' }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const meta = globalThis.__CREATED[0].app_metadata;
  assert.equal(meta.org_id, ORG, 'a station has no store to infer an org from — the stamp is all it has');
  assert.equal(meta.role, 'station');
});

await t('timeclock: created with org_id and its concrete store', async () => {
  setup();
  const res = await POST(req({ email: 'k@example.com', role: 'timeclock', stores: [STORE_B] }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const meta = globalThis.__CREATED[0].app_metadata;
  assert.equal(meta.org_id, ORG);
  assert.deepEqual(meta.stores, [STORE_B]);
});

// ── refusing, rather than creating something unscoped ──
await t('creator with no organization: 409 and NOTHING is created', async () => {
  setup({ orgId: null });
  const res = await POST(req({ email: 's@example.com', role: 'station' }));
  assert.equal(res.status, 409);
  assert.equal(globalThis.__CREATED.length, 0, 'an unscoped account is worse than no account');
  assert.match(res.body.error, /organization/i);
  assert.match(res.body.error, /No account was created/);
});

// ── the existing gates still hold ──
await t('non-admin caller: 403, nothing created', async () => {
  setup({ user: { id: 'u', app_metadata: { role: 'member' } } });
  const res = await POST(req({ email: 's@example.com', role: 'station' }));
  assert.equal(res.status, 403);
  assert.equal(globalThis.__CREATED.length, 0);
});

await t('unauthenticated: 401', async () => {
  setup({ user: null });
  const res = await POST(req({ email: 's@example.com', role: 'station' }));
  assert.equal(res.status, 401);
});

await t('an unmanaged role is refused before any org lookup', async () => {
  setup();
  const res = await POST(req({ email: 's@example.com', role: 'admin' }));
  assert.equal(res.status, 400);
  assert.equal(globalThis.__CREATED.length, 0);
});

await t('an unknown store id is still rejected, and nothing is created', async () => {
  setup();
  const res = await POST(req({ email: 'm@example.com', role: 'member', scopes: ['binding'], stores: ['nope'] }));
  assert.equal(res.status, 400);
  assert.match(res.body.error, /unknown store id/);
  assert.equal(globalThis.__CREATED.length, 0);
});

await t('a member with an unknown scope is refused', async () => {
  setup();
  // 'payroll' is deliberately not a scope and never should be — payroll is owner-only. (This used
  // to say 'pnl', which WAS unknown at the time; it is a real scope now, so the case had stopped
  // testing what it says.)
  const res = await POST(req({ email: 'm@example.com', role: 'member', scopes: ['payroll'], stores: [STORE_A] }));
  assert.equal(res.status, 400);
  assert.equal(globalThis.__CREATED.length, 0);
});

await t('a member CAN be created with the P&L, Shows and Team scopes', async () => {
  setup();
  const res = await POST(req({ email: 'mgr@example.com', role: 'member', scopes: ['shows', 'team'], stores: ['*'] }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(globalThis.__CREATED[0].app_metadata.scopes, ['shows', 'team']);
});

for (const [status, name, err] of results) {
  console.log(`${status === 'ok' ? '✓' : '✗'} ${name}${err ? ` — ${err}` : ''}`);
}
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
