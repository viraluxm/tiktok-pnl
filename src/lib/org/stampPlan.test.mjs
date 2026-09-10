// The org_id stamp plan: who gets written to, and — more importantly — who never does.
//
// Exercises the REAL stampPlan.ts, transpiled at runtime. Pure, no DB.
//
// The fixture is PRODUCTION as it actually stands (read live 2026-09-09): 11 accounts, one org,
// four managed sub-users, one admin owner, six role-less accounts. So these assertions are about
// the real run, not a hypothetical one.
//
// THE ASSERTION THAT MATTERS is negative: the owner (f5885f7d) is never written to. app_metadata
// travels in the JWT the capture extension holds, so a stamp on that account is the one write
// this script must never make. Mutation-checked by hand: drop the isStampable() guard and
// "the owner is NEVER stamped" goes red.
//
// Run:  TZ=UTC node src/lib/org/stampPlan.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'stampplan-'));
const srcPath = fileURLToPath(new URL('./stampPlan.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const modPath = join(dir, 'stampPlan.mjs');
writeFileSync(modPath, outputText);
const { planOrgIdStamp, isStampable, STAMPABLE_ROLES } = await import(pathToFileURL(modPath).href);

const ORG = '6deb8558-7cd3-4ff5-8522-63071f9882ff';
const OWNER = 'f5885f7d-5841-457c-b66f-a5aa2916db46';

// Production, as read live on 2026-09-09.
const PROD = [
  { id: 'ff24b128', email: 'fulfillment+…@lensed.internal', role: null, orgId: null },
  { id: '9da36836', email: 'carterjamesgolden@gmail.com', role: null, orgId: null },
  { id: 'ef92b213', email: 'admin@toysfordeals.com', role: null, orgId: null },
  { id: 'a67dacf5', email: 'viewtrack-integration@lensed.internal', role: null, orgId: null },
  { id: '6df39718', email: 'tiktok@toysfordeals.com', role: null, orgId: null },
  { id: '666002d5', email: 'girinoy505@aghism.com', role: null, orgId: null },
  { id: OWNER, email: 'alvarojr300@gmail.com', role: 'admin', orgId: null },
  { id: '481db435', email: 'test@viralux.media', role: 'member', orgId: null },
  { id: '364324e7', email: 'test2@viralux.media', role: 'member', orgId: null },
  { id: 'c547f68f', email: 'fulfillment@viralux.media', role: 'station', orgId: null },
  { id: '11b48173', email: 'kiosk1@viralux.media', role: 'timeclock', orgId: null },
];

let passed = 0;
const results = [];
const t = (name, fn) => {
  try { fn(); passed++; results.push(['ok', name]); }
  catch (e) { results.push(['FAIL', name, e.message]); }
};

const plan = (accounts = PROD, orgs = [ORG]) => {
  const r = planOrgIdStamp(accounts, orgs);
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  return r.plan;
};

t('isStampable: exactly the three managed sub-user roles', () => {
  assert.deepEqual([...STAMPABLE_ROLES], ['member', 'station', 'timeclock']);
  for (const r of STAMPABLE_ROLES) assert.equal(isStampable(r), true);
  for (const r of ['admin', 'owner', 'partner', 'Station', '']) assert.equal(isStampable(r), false, r);
  assert.equal(isStampable(null), false);
});

t('THE OWNER IS NEVER STAMPED', () => {
  const p = plan();
  assert.equal(p.toStamp.some((a) => a.account.id === OWNER), false,
    "app_metadata rides in the JWT the capture extension holds — this account must not be written");
  const ownerAction = p.actions.find((a) => a.account.id === OWNER);
  assert.equal(ownerAction.kind, 'skip');
  assert.equal(ownerAction.reason, 'not-a-sub-user');
});

t('no role-less account is stamped either', () => {
  const p = plan();
  const roleless = PROD.filter((a) => a.role === null).map((a) => a.id);
  for (const id of roleless) {
    assert.equal(p.toStamp.some((a) => a.account.id === id), false, id);
  }
});

t('production plan: exactly the 4 managed sub-users, stamped with the sole org', () => {
  const p = plan();
  assert.deepEqual(
    p.toStamp.map((a) => a.account.email).sort(),
    ['fulfillment@viralux.media', 'kiosk1@viralux.media', 'test2@viralux.media', 'test@viralux.media'],
  );
  assert.equal(p.toStamp.length, 4);
  for (const a of p.toStamp) assert.equal(a.orgId, ORG);
  assert.equal(p.actions.length, PROD.length, 'every account gets a decision, not just the writes');
});

t('idempotent: a second run stamps nothing', () => {
  const after = PROD.map((a) => (isStampable(a.role) ? { ...a, orgId: ORG } : a));
  const p = plan(after);
  assert.equal(p.toStamp.length, 0);
  const stamped = p.actions.filter((a) => a.kind === 'skip' && a.reason === 'already-stamped');
  assert.equal(stamped.length, 4);
});

t('a sub-user already stamped with a DIFFERENT org is left alone, not corrected', () => {
  const accounts = [{ id: 'x', email: 'x@y.z', role: 'station', orgId: 'some-other-org' }];
  const p = plan(accounts);
  assert.equal(p.toStamp.length, 0, 'moving an account between tenants is not a script decision');
});

t('refuses when TWO organizations exist — the exact moment guessing becomes a leak', () => {
  const r = planOrgIdStamp(PROD, [ORG, 'org-second']);
  assert.equal(r.ok, false);
  assert.match(r.error, /refusing to guess/);
  assert.match(r.error, /org-second/);
});

t('refuses when NO organization exists', () => {
  const r = planOrgIdStamp(PROD, []);
  assert.equal(r.ok, false);
  assert.match(r.error, /no organizations/);
});

t('duplicate org ids in the input are one org, not two', () => {
  const p = plan(PROD, [ORG, ORG]);
  assert.equal(p.orgId, ORG);
});

for (const [status, name, err] of results) {
  console.log(`${status === 'ok' ? '✓' : '✗'} ${name}${err ? ` — ${err}` : ''}`);
}
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
