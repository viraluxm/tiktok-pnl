#!/usr/bin/env node
// CI guard: every RPC the app calls from a USER session must have EXECUTE for `authenticated`.
// Catches the "built + deployed + silently 500s on first use" class (e.g. a CREATE FUNCTION
// applied without a matching GRANT).
//
// How it detects app-callable RPCs in src/:
//   • literal:  supabase.rpc('fn_name', ...)              → collected directly
//   • dynamic:  supabase.rpc(expr, ...)                    → REQUIRES a `// rpc-grants: a, b`
//     annotation somewhere in the same file listing every function the expression can resolve
//     to. An UN-annotated dynamic call FAILS the check — the blind spot is never silent.
//
// Service-role-only RPCs (invoked ONLY via createAdminClient, intentionally ungranted) are in
// SERVICE_ROLE_ONLY; the check asserts they EXIST and stay UNGRANTED (drift both directions).
//
// Grants are read from the LIVE database via the Supabase Management API, so this also catches
// grants applied straight through the Management API (bypassing PRs) — as long as any PR runs.
//
// Env: SUPABASE_PROJECT_REF, SUPABASE_ACCESS_TOKEN (a Management-API PAT).

import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src');

// Functions called ONLY via createAdminClient() (service role bypasses grants). They must stay
// ungranted. Keep this list tiny and reviewed; add here when you add a service-role-only RPC.
const SERVICE_ROLE_ONLY = new Set([
  'lensed_add_batch_admin', 'lensed_void_batch',
  // Service-role-only `_as` variants, invoked ONLY via createAdminClient in member routes (owner
  // passed explicitly; revoked from authenticated by 084/087). Were unregistered → the check was
  // already red on main before the kiosk PR.
  'lensed_log_auction_as', 'pnl_reorder_by_sku_as',
  // Badge/QR kiosk RPCs — service-role only (091/092/095), called via createAdminClient in
  // /api/kiosk/* and the QR scan path. Never granted to anon/authenticated.
  'lensed_kiosk_scan', 'lensed_kiosk_start_break', 'lensed_kiosk_clock_out', 'lensed_kiosk_manual_punch_as',
  // Reconcile cron RPC — called via admin.rpc() (service_role, CRON_SECRET-gated); app-COLLECTED,
  // so it must be listed here or the check would demand an `authenticated` grant it must not have.
  'lensed_reconcile_time_clock',
  // Auto-ender segment close (108) — bypasses auth.uid() and takes the owner explicitly, so a
  // grant to `authenticated` would let any signed-in user close another owner's segments.
  // Called ONLY via createAdminClient from the CRON_SECRET-gated auto-ender.
  'close_session_host_segment_as',
  // Owner-scoped host-performance twin (111) — bypasses RLS, caller asserts p_owner_user_ids.
  // Called ONLY via createAdminClient from /api/member/team/host-performance.
  'pnl_host_performance_as',
  // Dashboard COGS aggregate (116) — reads pnl_order_grain, which reads synced_order_ids. That
  // table has RLS DISABLED while `authenticated` holds SELECT, so an `authenticated` grant would
  // make this a cross-tenant read of any owner's COGS. Called ONLY via createAdminClient from
  // /api/tiktok/product-stats.
  'lensed_product_stats_cogs_as',
]);

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF;
const PAT = process.env.SUPABASE_ACCESS_TOKEN;
if (!PROJECT_REF || !PAT) {
  console.error('✗ Missing SUPABASE_PROJECT_REF / SUPABASE_ACCESS_TOKEN env.');
  process.exit(2);
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

const RPC_RE = /\.rpc\(\s*([^,)\s]+)/g;
const ANNOT_RE = /rpc-grants:\s*([a-zA-Z0-9_,\s]+)/g;
const LIT_RE = /^['"]([a-z_][a-z0-9_]*)['"]$/;

const appNames = new Set(); // app-callable RPC function names to verify
const problems = [];

for (const file of walk(SRC)) {
  const text = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);
  const annotated = new Set();
  for (const a of text.matchAll(ANNOT_RE)) {
    a[1].split(',').map((s) => s.trim()).filter(Boolean).forEach((n) => annotated.add(n));
  }
  for (const m of text.matchAll(RPC_RE)) {
    const arg = m[1];
    const lit = arg.match(LIT_RE);
    if (lit) {
      appNames.add(lit[1]);
    } else if (annotated.size > 0) {
      annotated.forEach((n) => appNames.add(n)); // dynamic call, but declared
    } else {
      problems.push(`${rel}: dynamic \`.rpc(${arg})\` with no \`// rpc-grants: ...\` annotation — cannot verify its grants`);
    }
  }
}

// Never verify service-role-only names as if they were app-callable.
const toVerify = [...appNames].filter((n) => !SERVICE_ROLE_ONLY.has(n)).sort();
const allChecked = [...new Set([...toVerify, ...SERVICE_ROLE_ONLY])];

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Management API query failed: ${res.status} ${await res.text()}`);
  return res.json();
}

const list = allChecked.map((n) => `'${n}'`).join(',');
const rows = await sql(`
  select p.proname,
         bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE')) as auth_exec,
         bool_or(has_function_privilege('anon', p.oid, 'EXECUTE')) as anon_exec,
         count(*) as overloads
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in (${list})
  group by p.proname;
`);
const byName = new Map(rows.map((r) => [r.proname, r]));

for (const name of toVerify) {
  const r = byName.get(name);
  if (!r) problems.push(`app calls \`${name}\` but no such function exists in public (typo, or applied to a different schema/DB?)`);
  else if (r.auth_exec !== true) problems.push(`app-callable \`${name}\` is MISSING \`GRANT EXECUTE ... TO authenticated\` → silent 500 on first use`);
}
for (const name of SERVICE_ROLE_ONLY) {
  const r = byName.get(name);
  if (!r) { problems.push(`SERVICE_ROLE_ONLY \`${name}\` no longer exists — update SERVICE_ROLE_ONLY`); continue; }
  // Must stay ungranted to BOTH user-facing roles. `anon` is the unauthenticated path — an anon
  // EXECUTE grant is an out-of-repo drift (Management API/dashboard) that PRs never see, so assert
  // it independently of `authenticated`, or it slips through silently (as it did for the batch RPCs).
  if (r.auth_exec === true) problems.push(`SERVICE_ROLE_ONLY \`${name}\` is GRANTED to authenticated — either revoke it, or move it out of SERVICE_ROLE_ONLY if it's now app-callable`);
  if (r.anon_exec === true) problems.push(`SERVICE_ROLE_ONLY \`${name}\` is GRANTED to anon (UNAUTHENTICATED) — revoke it: \`revoke execute on function public.${name}(...) from anon;\``);
}

if (problems.length) {
  console.error(`✗ RPC grant check failed (${problems.length}):`);
  for (const p of problems) console.error('  • ' + p);
  process.exit(1);
}
console.log(`✓ RPC grant check passed — ${toVerify.length} app-callable RPCs granted, ${SERVICE_ROLE_ONLY.size} service-role-only kept ungranted.`);
console.log('  app-callable: ' + toVerify.join(', '));
