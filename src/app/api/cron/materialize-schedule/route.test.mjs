// GET /api/cron/materialize-schedule — WHO IS TOLD WHAT.
//
// This job is global by design and must stay that way for the cron. But the same handler also
// accepts an authenticated admin — one tenant's admin — and it used to hand that caller the raw
// global output. TWO disclosures rode in one JSON body:
//   • reconcile      — other accounts' shift_instances ids, attendance_events ids, pending count
//   • result.sample  — up to 10 planned rows carrying another account's user_id, employee_id,
//                      shift_rule_id, store_id and shift times
// plus global aggregate counts (rules_processed / candidates / inserted / skipped_*).
//
// Exercises the REAL route module, transpiled at runtime. The materializer and reconciliation are
// stubbed so each caller's OUTPUT SHAPE is what is asserted, and the reconcile stub RECORDS the
// ownerId it was handed — which is the actual fix.
//
// Run:  TZ=UTC node src/app/api/cron/materialize-schedule/route.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'cronroute-'));
const write = (n, s) => { const p = join(dir, n); writeFileSync(p, s); return pathToFileURL(p).href; };

const nextStub = write('next.mjs', `
export const NextResponse = { json: (b, i) => ({ body: b, status: (i && i.status) || 200 }) };
`);
const supaStub = write('supa.mjs', `
export async function createClient() {
  return { auth: { getUser: async () => ({ data: { user: globalThis.__USER } }) } };
}
`);
// The materializer's REAL return shape, carrying a foreign tenant in `sample`.
const matStub = write('mat.mjs', `
export async function runForwardMaterializer(opts) {
  globalThis.__MAT.push(opts);
  return {
    today: '2026-09-10',
    window: { from: '2026-09-11', to: '2026-10-08' },
    rules_processed: 42, candidates: 300, to_insert_count: 12, inserted: 12,
    skipped_by_guard: 3, skipped_by_conflict: 5,
    sample: [
      { user_id: 'owner-OTHER', employee_id: 'emp-OTHER', shift_rule_id: 'rule-OTHER',
        store_id: 'store-OTHER', shift_date: '2026-09-11', starts_at: 'x', ends_at: 'y' },
    ],
  };
}
`);
const recStub = write('rec.mjs', `
export async function reconcileClaims(ownerId) {
  globalThis.__REC.push(ownerId);
  if (globalThis.__REC_THROWS) throw new Error('reconcile exploded');
  return ownerId
    ? { claimed_without_event: ['inst-MINE'], event_without_claimed_instance: [], pending_claims: 1, global: false }
    : { claimed_without_event: ['inst-MINE', 'inst-OTHER'], event_without_claimed_instance: ['ev-OTHER'], pending_claims: 9, global: true };
}
`);

const srcPath = fileURLToPath(new URL('./route.ts', import.meta.url));
let { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
for (const [f, t] of Object.entries({
  "'next/server'": `'${nextStub}'`,
  "'@/lib/supabase/server'": `'${supaStub}'`,
  "'@/lib/schedule/materializeForward'": `'${matStub}'`,
  "'@/lib/schedule/reconcile'": `'${recStub}'`,
})) outputText = outputText.split(f).join(t);
const { GET } = await import(write('route.mjs', outputText));

let passed = 0;
const check = (n, c, e = '') => { assert.ok(c, `FAIL: ${n} ${e}`); console.log(`  ✓ ${n}${e ? ` — ${e}` : ''}`); passed++; };
const eq = (n, a, b) => check(n, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} == ${JSON.stringify(b)}`);

const SECRET = 'cron-secret-value';
const ADMIN_A = { id: 'owner-A', app_metadata: { role: 'admin' } };
const ADMIN_B = { id: 'owner-B', app_metadata: { role: 'admin' } };
const req = (hdr) => ({ url: 'https://x/api/cron/materialize-schedule', headers: { get: (k) => (k.toLowerCase() === 'authorization' ? hdr ?? null : null) } });
const setup = (user, { secret = SECRET, throws = false } = {}) => {
  globalThis.__USER = user; globalThis.__REC = []; globalThis.__MAT = [];
  globalThis.__REC_THROWS = throws;
  if (secret === null) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = secret;
};
const quiet = () => { const l = console.log, w = console.warn, e = console.error;
  console.log = console.warn = console.error = () => {}; return () => { console.log = l; console.warn = w; console.error = e; }; };

console.log('\n1. CRON caller — the global backstop is preserved EXACTLY');
{
  setup(null); const un = quiet();
  const r = await GET(req(`Bearer ${SECRET}`));
  un();
  eq('200', r.status, 200);
  eq('reconcileClaims called with NO ownerId → global sweep', globalThis.__REC, [undefined]);
  eq('the sweep reports itself as global', r.body.reconcile.global, true);
  eq('cron still receives the full global reconciliation', r.body.reconcile.claimed_without_event, ['inst-MINE', 'inst-OTHER']);
  eq('and the global pending count', r.body.reconcile.pending_claims, 9);
  check('cron still receives the full materializer detail', Array.isArray(r.body.sample) && r.body.sample.length === 1);
  eq('including the global aggregate counts', [r.body.rules_processed, r.body.inserted, r.body.skipped_by_guard], [42, 12, 3]);
  check('no detail_withheld marker for cron', r.body.detail_withheld === undefined);
  eq('the materializer still ran', globalThis.__MAT.length, 1);
}

console.log('\n2. ADMIN caller — reconciliation is scoped to their OWN account');
{
  setup(ADMIN_A); const un = quiet();
  const r = await GET(req(null));
  un();
  eq('200', r.status, 200);
  eq('reconcileClaims called with THEIR uid', globalThis.__REC, ['owner-A']);
  eq('the result is marked non-global', r.body.reconcile.global, false);
  eq('they get their OWN drift ids', r.body.reconcile.claimed_without_event, ['inst-MINE']);
  eq('and their OWN pending count', r.body.reconcile.pending_claims, 1);
}

console.log('\n3. ADMIN caller — NO cross-tenant data in the body, from either source');
{
  setup(ADMIN_A); const un = quiet();
  const r = await GET(req(null));
  un();
  const body = JSON.stringify(r.body);
  for (const leak of ['owner-OTHER', 'emp-OTHER', 'rule-OTHER', 'store-OTHER', 'inst-OTHER', 'ev-OTHER']) {
    check(`no "${leak}" anywhere in the response`, !body.includes(leak));
  }
  check('result.sample is withheld entirely', r.body.sample === undefined);
  check('global aggregate counts are withheld', r.body.rules_processed === undefined && r.body.candidates === undefined
    && r.body.inserted === undefined && r.body.to_insert_count === undefined
    && r.body.skipped_by_guard === undefined && r.body.skipped_by_conflict === undefined);
  eq('the shape difference is stated, not silent', r.body.detail_withheld, 'global');
  eq('non-identifying run facts are still returned', [r.body.mode, r.body.today, r.body.window.from], ['log_only', '2026-09-10', '2026-09-11']);
  check('and reconcile is present (scoped), so the call is still useful', r.body.reconcile !== null);
}

console.log('\n4. the two admins are isolated from each other, symmetrically');
{
  setup(ADMIN_B); const un = quiet();
  const r = await GET(req(null));
  un();
  eq('admin B scopes to B', globalThis.__REC, ['owner-B']);
  check('admin B receives no A/global identifiers', !JSON.stringify(r.body).includes('inst-OTHER') && !JSON.stringify(r.body).includes('owner-OTHER'));
  check('admin B cannot see the global pending total', r.body.reconcile.pending_claims === 1);
}

console.log('\n5. an admin cannot promote themselves to the cron path');
{
  setup(ADMIN_A); const un = quiet();
  const r = await GET(req('Bearer wrong-secret'));   // bad secret falls through to the session
  un();
  eq('a wrong bearer does NOT grant the global path', globalThis.__REC, ['owner-A']);
  check('still no foreign ids', !JSON.stringify(r.body).includes('OTHER'));
  eq('and detail stays withheld', r.body.detail_withheld, 'global');
}

console.log('\n6. invalid auth is still refused');
{
  setup(null); const un = quiet();
  eq('no session, no secret → 401', (await GET(req(null))).status, 401);
  eq('wrong secret, no session → 401', (await GET(req('Bearer nope'))).status, 401);
  un();
  setup({ id: 'u', app_metadata: { role: 'timeclock' } }); const un2 = quiet();
  eq('confined kiosk role → 401', (await GET(req(null))).status, 401);
  setup({ id: 'u', app_metadata: {} });
  eq('owner without admin role → 401', (await GET(req(null))).status, 401);
  un2();
  check('and none of those reached the materializer or reconcile', globalThis.__MAT.length === 0 && globalThis.__REC.length === 0);
}
{
  // CRON_SECRET unset must not let a bare "Bearer undefined" through.
  setup(null, { secret: null }); const un = quiet();
  eq('unset CRON_SECRET → no bearer can authorise', (await GET(req('Bearer undefined'))).status, 401);
  un();
  process.env.CRON_SECRET = SECRET;
}

console.log('\n7. reconcile failure stays non-fatal, and still leaks nothing');
{
  setup(ADMIN_A, { throws: true }); const un = quiet();
  const r = await GET(req(null));
  un();
  eq('the run still succeeds', r.status, 200);
  eq('reconcile is null rather than a raw error', r.body.reconcile, null);
  check('no foreign data in the fallback path either', !JSON.stringify(r.body).includes('OTHER'));
  setup(null, { throws: true }); const un2 = quiet();
  const c = await GET(req(`Bearer ${SECRET}`));
  un2();
  eq('cron also survives a reconcile failure', [c.status, c.body.reconcile], [200, null]);
}

console.log('\n8. NO new writes were introduced — the route only reads and reports');
{
  setup(ADMIN_A); const un = quiet();
  await GET(req(null));
  un();
  eq('the materializer is invoked exactly once, with the same write flag as before', globalThis.__MAT.length, 1);
  check('write mode still comes from the env flag, not from who called', typeof globalThis.__MAT[0].write === 'boolean');
  const src = readFileSync(srcPath, 'utf8');
  check('the route itself performs no DB write', !/\.(insert|update|upsert|delete)\(/.test(src));
  check('and never touches payroll tables', !/from\('(shifts|employee_time_entries|employee_time_breaks)'\)/.test(src));
}

console.log(`\n${passed} checks passed`);
