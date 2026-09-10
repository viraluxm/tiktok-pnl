// Stamp app_metadata.org_id onto the sub-user accounts that predate it.
//
// DRY RUN BY DEFAULT. It prints a decision for every auth account and writes nothing unless
// --apply is passed. The plan is computed by the REAL planner (src/lib/org/stampPlan.ts,
// transpiled at runtime and unit-tested in stampPlan.test.mjs), so the dry run and the real run
// plan identically — --apply only decides whether the writes happen.
//
// WHY: sub-user routes resolve the store OWNERS and read as them, and that resolution is bounded
// to one organization. The org is resolved from a ladder whose only unambiguous rung is a stamped
// app_metadata.org_id; the rest are inferences that hold only while exactly one organization
// exists. New accounts are stamped at creation by /api/admin/team. These are the ones already in
// the database.
//
// WHAT IT WILL NOT TOUCH: anything that is not role member/station/timeclock. Not the owner, not
// an admin, not a role-less account. app_metadata travels inside the JWT the capture extension
// holds, so never writing to the owner's account is the property that makes this safe to run at
// all — including during a show.
//
// Each write is a read-modify-write of that ONE user's app_metadata: the existing object is
// spread and org_id added, so role / stores / scopes are preserved.
//
//   dry run:  node scripts/backfill-subuser-org-id.mjs
//   apply:    node scripts/backfill-subuser-org-id.mjs --apply
//
// Credentials: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, from the environment or
// .env.local. The key is never printed.
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import ts from 'typescript';

const APPLY = process.argv.includes('--apply');

// ── credentials ──
function fromEnvFile(name) {
  const path = new URL('../.env.local', import.meta.url);
  if (!existsSync(path)) return undefined;
  const line = readFileSync(path, 'utf8')
    .split('\n')
    .find((l) => l.trim().startsWith(`${name}=`));
  return line?.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
}
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || fromEnvFile('NEXT_PUBLIC_SUPABASE_URL');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || fromEnvFile('SUPABASE_SERVICE_ROLE_KEY');
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('✗ Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (env or .env.local).');
  process.exit(2);
}

// ── the real planner ──
const dir = mkdtempSync(join(tmpdir(), 'stamp-'));
const src = readFileSync(new URL('../src/lib/org/stampPlan.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const planPath = join(dir, 'stampPlan.mjs');
writeFileSync(planPath, outputText);
const { planOrgIdStamp } = await import(pathToFileURL(planPath).href);

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── read: every auth account, and every organization ──
const accounts = [];
for (let page = 1; page <= 50; page++) {
  const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
  if (error) { console.error('✗ listUsers failed:', error.message); process.exit(1); }
  const batch = data?.users ?? [];
  for (const u of batch) {
    accounts.push({
      id: u.id,
      email: u.email ?? null,
      role: u.app_metadata?.role ?? null,
      orgId: u.app_metadata?.org_id ?? null,
    });
  }
  if (batch.length < 200) break;
}

const { data: orgRows, error: orgErr } = await admin.from('organizations').select('id');
if (orgErr) { console.error('✗ organizations read failed:', orgErr.message); process.exit(1); }
const orgIds = (orgRows ?? []).map((r) => String(r.id));

// ── plan ──
const result = planOrgIdStamp(accounts, orgIds);
if (!result.ok) {
  console.error(`✗ ${result.error}`);
  process.exit(1);
}
const { plan } = result;

console.log(`=== SUB-USER org_id BACKFILL — ${APPLY ? 'APPLY' : 'DRY RUN'} ===`);
console.log(`project: ${SUPABASE_URL.replace(/^https:\/\//, '').split('.')[0]}`);
console.log(`organizations: ${orgIds.length} → stamping with ${plan.orgId}`);
console.log(`accounts read: ${accounts.length}\n`);

const pad = (s, n) => String(s ?? '').padEnd(n);
console.log(`${pad('DECISION', 10)} ${pad('ROLE', 11)} ${pad('EMAIL', 46)} REASON`);
for (const a of plan.actions) {
  const decision = a.kind === 'stamp' ? 'STAMP' : 'skip';
  const reason = a.kind === 'stamp' ? `→ org_id=${a.orgId}` : a.reason;
  console.log(`${pad(decision, 10)} ${pad(a.account.role ?? '(none)', 11)} ${pad(a.account.email, 46)} ${reason}`);
}
console.log(`\nto stamp: ${plan.toStamp.length}   left alone: ${plan.actions.length - plan.toStamp.length}`);

if (!plan.toStamp.length) {
  console.log('\nNothing to do.');
  process.exit(0);
}

if (!APPLY) {
  console.log('\nDRY RUN — nothing was written. Re-run with --apply to perform the stamps above.');
  process.exit(0);
}

// ── apply: one read-modify-write per account, preserving the rest of app_metadata ──
console.log('');
let ok = 0;
for (const a of plan.toStamp) {
  const { data: cur, error: readErr } = await admin.auth.admin.getUserById(a.account.id);
  if (readErr || !cur?.user) {
    console.error(`✗ ${a.account.email}: re-read failed: ${readErr?.message ?? 'not found'}`);
    continue;
  }
  // Re-check the role on the FRESH record: the listing above is a snapshot, and this is the guard
  // that must not be trusted to a stale read.
  const freshRole = cur.user.app_metadata?.role ?? null;
  if (freshRole !== a.account.role) {
    console.error(`✗ ${a.account.email}: role changed since planning (${a.account.role} → ${freshRole}) — skipped`);
    continue;
  }
  const nextMeta = { ...(cur.user.app_metadata ?? {}), org_id: a.orgId };
  const { error: updErr } = await admin.auth.admin.updateUserById(a.account.id, { app_metadata: nextMeta });
  if (updErr) {
    console.error(`✗ ${a.account.email}: ${updErr.message}`);
    continue;
  }
  console.log(`✓ ${a.account.email} → org_id=${a.orgId}`);
  ok++;
}

console.log(`\nstamped ${ok}/${plan.toStamp.length}`);
process.exit(ok === plan.toStamp.length ? 0 : 1);
