// The Team page's contract for an EXTERNAL SELLER: listed and revokable, never creatable.
//
// Exercises the REAL /api/admin/team GET+POST and /api/admin/team/[id] PATCH, transpiled at
// runtime. Stubbed: next/server, the Supabase server client (the caller's session) and the admin
// client (a recording auth-admin double). No database.
//
// WHY THIS IS WORTH A TEST. The property is a pair of opposites that are easy to get backwards:
// a seller MUST appear in the Team table (otherwise the account exists with no representation
// anywhere in the app, and revoking access means the Supabase dashboard) and MUST NOT be creatable
// there (they need an organization_members row and no store_members row — a role picker cannot
// express that, it can only get it wrong). Both directions are asserted.
//
// It also pins the two UI/API mismatches this change fixed: a listed role whose Disable button
// 403'd (timeclock), and the rule that an owner/admin can never be disabled from this endpoint.
//
// Run:  TZ=UTC node src/app/api/admin/team/sellerLifecycle.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'teamseller-'));
const write = (name, src) => { const p = join(dir, name); writeFileSync(p, src); return pathToFileURL(p).href; };
function transpile(srcRel, outName, rewrites = {}) {
  const srcPath = fileURLToPath(new URL(srcRel, import.meta.url));
  let { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  for (const [from, to] of Object.entries(rewrites)) outputText = outputText.split(from).join(to);
  return write(outName, outputText);
}

const nextStub = write('nextStub.mjs',
  'export const NextResponse = { json: (body, init) => ({ body, status: (init && init.status) || 200 }) };\n');
const serverStub = write('serverStub.mjs',
  'export async function createClient(){ return { auth: { getUser: async () => ({ data: { user: globalThis.__USER } }) } }; }\n');
const adminStub = write('adminStub.mjs', 'export function createAdminClient(){ return globalThis.__ADMIN; }\n');
const orgStub = write('orgStub.mjs', 'export async function getOrgId(){ return globalThis.__ORG ?? "org-1"; }\n');

const rewrites = {
  "'next/server'": `'${nextStub}'`,
  "'@/lib/supabase/server'": `'${serverStub}'`,
  "'@/lib/supabase/admin'": `'${adminStub}'`,
  "'@/lib/org'": `'${orgStub}'`,
};
const { GET, POST } = await import(transpile('./route.ts', 'route.mjs', rewrites));
const { PATCH } = await import(transpile('./[id]/route.ts', 'idRoute.mjs', rewrites));

// ── the account population, one of every shape ──
const USERS = [
  { id: 'u-mem', email: 'member@x.com', app_metadata: { role: 'member', scopes: ['binding'], stores: ['*'] } },
  { id: 'u-stn', email: 'station@x.com', app_metadata: { role: 'station' } },
  { id: 'u-kiosk', email: 'kiosk@x.com', app_metadata: { role: 'timeclock', stores: ['store-a'] } },
  { id: 'u-seller', email: 'seller@x.com', app_metadata: { role: 'seller', org_id: 'org-1' } },
  { id: 'u-admin', email: 'boss@x.com', app_metadata: { role: 'admin' } },
  { id: 'u-none', email: 'nobody@x.com', app_metadata: {} },
];

function fakeAdmin() {
  const updates = [];
  return {
    updates,
    // Store-existence lookup: echo back whatever ids were asked for, so validation passes.
    from() {
      const chain = {
        select: () => chain,
        in: (_col, vals) => Promise.resolve({ data: vals.map((id) => ({ id })), error: null }),
      };
      return chain;
    },
    auth: {
      admin: {
        listUsers: async () => ({ data: { users: USERS }, error: null }),
        getUserById: async (id) => {
          const u = USERS.find((x) => x.id === id);
          return { data: u ? { user: u } : null, error: null };
        },
        updateUserById: async (id, patch) => { updates.push({ id, patch }); return { error: null }; },
        createUser: async (args) => { globalThis.__CREATED.push(args); return { data: { user: { id: 'new', email: args.email } }, error: null }; },
      },
    },
  };
}
const owner = { id: 'u-admin', app_metadata: { role: 'admin' } };
function setup(user = owner) {
  globalThis.__USER = user;
  globalThis.__ADMIN = fakeAdmin();
  globalThis.__CREATED = [];
}
const req = (body) => ({ json: async () => body });
const params = (id) => ({ params: Promise.resolve({ id }) });

let passed = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); passed++; results.push(['ok', name]); }
  catch (e) { results.push(['FAIL', name, e.message]); }
}

// ── LISTED: a seller must be visible ──
await t('a seller IS listed in the Team table', async () => {
  setup();
  const res = await GET();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const seller = res.body.members.find((m) => m.id === 'u-seller');
  assert.ok(seller, 'without this the account exists with no representation anywhere in the app');
  assert.equal(seller.role, 'seller');
});

await t('the sub-user roles are still listed', async () => {
  setup();
  const res = await GET();
  const ids = res.body.members.map((m) => m.id);
  for (const id of ['u-mem', 'u-stn', 'u-kiosk']) assert.ok(ids.includes(id), id);
});

await t('an owner/admin and a role-less account are NEVER listed', async () => {
  setup();
  const res = await GET();
  const ids = res.body.members.map((m) => m.id);
  assert.equal(ids.includes('u-admin'), false);
  assert.equal(ids.includes('u-none'), false);
});

// ── NOT CREATABLE: the role picker must not be able to make one ──
await t('POST REFUSES role "seller" — provisioning goes through the script', async () => {
  setup();
  const res = await POST(req({ email: 'new@x.com', role: 'seller' }));
  assert.equal(res.status, 400);
  assert.equal(globalThis.__CREATED.length, 0, 'a seller also needs an org membership; this route writes none');
});

await t('POST still creates the sub-user roles', async () => {
  setup();
  const res = await POST(req({ email: 'new@x.com', role: 'station' }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(globalThis.__CREATED[0].app_metadata.role, 'station');
});

// ── REVOKABLE: one click cuts off access ──
await t('a seller can be DISABLED — this is the revoke path', async () => {
  setup();
  const res = await PATCH(req({ action: 'disable' }), params('u-seller'));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(globalThis.__ADMIN.updates.length, 1);
  assert.ok(globalThis.__ADMIN.updates[0].patch.ban_duration, 'a ban revokes refresh tokens and blocks sign-in');
});

await t('a disabled seller can be re-enabled', async () => {
  setup();
  const res = await PATCH(req({ action: 'enable' }), params('u-seller'));
  assert.equal(res.status, 200);
  assert.equal(globalThis.__ADMIN.updates[0].patch.ban_duration, 'none');
});

await t("a seller's password can be reset", async () => {
  setup();
  const res = await PATCH(req({ action: 'reset_password' }), params('u-seller'));
  assert.equal(res.status, 200);
  assert.ok(res.body.password, 'returned once, like the create flow');
});

await t('FIXED: a timeclock kiosk can be disabled (its button used to 403)', async () => {
  setup();
  const res = await PATCH(req({ action: 'disable' }), params('u-kiosk'));
  assert.equal(res.status, 200, 'the Team table listed it with a Disable button the API refused');
});

// ── a seller has no scopes, and an owner can never be touched ──
await t('set_scopes is refused for a seller (scopes are a member concept)', async () => {
  setup();
  const res = await PATCH(req({ action: 'set_scopes', scopes: ['binding'] }), params('u-seller'));
  assert.equal(res.status, 400);
  assert.equal(globalThis.__ADMIN.updates.length, 0);
});

for (const [label, id] of [['an owner/admin', 'u-admin'], ['a role-less account', 'u-none']]) {
  await t(`${label} can NEVER be disabled here`, async () => {
    setup();
    const res = await PATCH(req({ action: 'disable' }), params(id));
    assert.equal(res.status, 403);
    assert.equal(globalThis.__ADMIN.updates.length, 0);
  });
}

await t('a non-admin caller cannot list or manage anyone', async () => {
  setup({ id: 'u-mem', app_metadata: { role: 'member' } });
  assert.equal((await GET()).status, 403);
  assert.equal((await PATCH(req({ action: 'disable' }), params('u-seller'))).status, 403);
});

for (const [status, name, err] of results) {
  console.log(`${status === 'ok' ? '✓' : '✗'} ${name}${err ? ` — ${err}` : ''}`);
}
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
