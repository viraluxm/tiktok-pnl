// Provision ONE external seller (role='seller').
//
// DRY RUN BY DEFAULT. It prints exactly what it would do and writes nothing unless --apply.
//
//   dry run:  node scripts/create-seller.mjs --email seller@example.com
//   apply:    node scripts/create-seller.mjs --email seller@example.com --apply
//
// WHY A SCRIPT AND NOT THE TEAM UI. Provisioning a seller is not the same shape as adding a
// sub-user: it needs an auth account AND an organization_members row, because org membership is
// what grants shared-inventory access through the is_org_member RLS on inventory_skus /
// sku_batches / products / product_costs. It is also rare — a couple of people, ever — so it does
// not earn a role in the Team picker, where every extra option is a way to create the wrong
// account by accident.
//
// WHAT IT DOES (two writes, in this order):
//   1. auth user, app_metadata = { role: 'seller', org_id }  → middleware confines them to
//      /seller/* (SELLER_CONFINEMENT); the password is printed ONCE and never stored by us.
//   2. organization_members(org_id, user_id, role='member')    → shared inventory becomes readable.
// If step 2 fails, step 1 is rolled back, so a half-provisioned account is never left behind.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//   • No store, and no store_members row. The seller connects their OWN shop through the normal
//     OAuth flow (/api/tiktok/auth?new=1), which creates the store and makes them its owner. A
//     store we created for them would sit in OUR org and be the wrong shape entirely.
//   • Nothing to our own account, our stores, or any existing user.
import { readFileSync, existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const emailArg = args[args.indexOf('--email') + 1];
const email = args.includes('--email') && emailArg && !emailArg.startsWith('--')
  ? emailArg.trim().toLowerCase()
  : null;
const orgArg = args.includes('--org') ? args[args.indexOf('--org') + 1] : null;

if (!email || !email.includes('@')) {
  console.error('✗ Usage: node scripts/create-seller.mjs --email seller@example.com [--org <org_id>] [--apply]');
  process.exit(2);
}

function fromEnvFile(name) {
  const path = new URL('../.env.local', import.meta.url);
  if (!existsSync(path)) return undefined;
  const line = readFileSync(path, 'utf8').split('\n').find((l) => l.trim().startsWith(`${name}=`));
  return line?.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
}
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || fromEnvFile('NEXT_PUBLIC_SUPABASE_URL');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || fromEnvFile('SUPABASE_SERVICE_ROLE_KEY');
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('✗ Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (env or .env.local).');
  process.exit(2);
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── resolve the org whose inventory they will sell from ──
const { data: orgRows, error: orgErr } = await admin.from('organizations').select('id, name');
if (orgErr) { console.error('✗ organizations read failed:', orgErr.message); process.exit(1); }
const orgs = orgRows ?? [];
let orgId = orgArg ?? null;
if (!orgId) {
  if (orgs.length !== 1) {
    console.error(
      `✗ ${orgs.length} organizations exist — pass --org <org_id> to say which inventory this ` +
      `seller sells from. Refusing to guess.\n  ${orgs.map((o) => `${o.id}  ${o.name}`).join('\n  ')}`,
    );
    process.exit(1);
  }
  orgId = String(orgs[0].id);
} else if (!orgs.some((o) => String(o.id) === orgId)) {
  console.error(`✗ org ${orgId} does not exist.`);
  process.exit(1);
}
const orgName = orgs.find((o) => String(o.id) === orgId)?.name ?? '(unknown)';

// ── refuse to touch an existing account ──
// A seller is a NEW tenant. Re-pointing an existing account at role='seller' would silently
// change what an already-signed-in person can reach, so that is a decision to make by hand.
let existing = null;
for (let page = 1; page <= 50; page++) {
  const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
  if (error) { console.error('✗ listUsers failed:', error.message); process.exit(1); }
  const batch = data?.users ?? [];
  existing = batch.find((u) => (u.email ?? '').toLowerCase() === email) ?? existing;
  if (batch.length < 200) break;
}
if (existing) {
  console.error(
    `✗ ${email} already exists (id ${existing.id}, role ${existing.app_metadata?.role ?? '(none)'}).\n` +
    '  Refusing to change an existing account into a seller — do that deliberately, by hand.',
  );
  process.exit(1);
}

const appMetadata = { role: 'seller', org_id: orgId };

console.log(`=== CREATE SELLER — ${APPLY ? 'APPLY' : 'DRY RUN'} ===`);
console.log(`project:  ${SUPABASE_URL.replace(/^https:\/\//, '').split('.')[0]}`);
console.log(`email:    ${email}`);
console.log(`org:      ${orgId}  (${orgName})`);
console.log(`metadata: ${JSON.stringify(appMetadata)}`);
console.log('');
console.log('WOULD DO:');
console.log(`  1. create auth user ${email} with app_metadata ${JSON.stringify(appMetadata)}`);
console.log(`  2. insert organization_members(org_id=${orgId}, user_id=<new>, role='member')`);
console.log('');
console.log('THEY WILL REACH:  /seller, /seller/inventory, /seller/labels');
console.log('THEY WILL NOT:    /dashboard, Team/payroll, /admin/*, the assistant, or any');
console.log('                  owner-scoped route (see SELLER_CONFINEMENT in src/lib/supabase/claims.ts)');
console.log('NEXT, BY THEM:    connect their own shop at /api/tiktok/auth?new=1 — we create no store');

if (!APPLY) {
  console.log('\nDRY RUN — nothing was written. Re-run with --apply.');
  process.exit(0);
}

// ── 1. the auth account ──
const password = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString('base64url');
const { data: created, error: createErr } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  app_metadata: appMetadata,
});
if (createErr || !created?.user) {
  console.error('✗ createUser failed:', createErr?.message ?? 'no user returned');
  process.exit(1);
}
const userId = created.user.id;
console.log(`\n✓ created auth user ${userId}`);

// ── 2. org membership = shared inventory access. Roll back the account if this fails, so we never
//      leave a seller who can sign in and see an empty shelf with no idea why.
const { error: memErr } = await admin
  .from('organization_members')
  .insert({ org_id: orgId, user_id: userId, role: 'member' });
if (memErr) {
  console.error('✗ organization_members insert failed:', memErr.message);
  const { error: delErr } = await admin.auth.admin.deleteUser(userId);
  if (delErr) {
    console.error(`✗ ROLLBACK FAILED — auth user ${userId} was left behind. Delete it by hand.`);
    process.exit(1);
  }
  console.error('  rolled back: the auth user was deleted. Nothing was left behind.');
  process.exit(1);
}
console.log(`✓ added to organization ${orgId} — shared inventory is readable`);

console.log('\n───────────────────────────────────────────────');
console.log('PASSWORD (shown once, not stored — send it over a private channel):');
console.log(`  ${password}`);
console.log('───────────────────────────────────────────────');
console.log('Tell them to sign in and connect their shop from "My shop".');
