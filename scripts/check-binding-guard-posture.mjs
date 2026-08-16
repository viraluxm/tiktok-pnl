#!/usr/bin/env node
// CI guard (L3b): pin the database posture that makes the binding flow's ROUTE-LEVEL guards
// sufficient. See docs/investigations/binding-live-session-lockout.md §1.4 and §L3.
//
// /api/member/bind enforces authorization, the room-live lockout, and the out_of_window audit in
// the ROUTE HANDLER. That is only safe because the binding account cannot reach the same writes
// directly through PostgREST. It cannot today — but NOT because of the schema. `authenticated`
// holds full INSERT/UPDATE/DELETE grants on live_auction_items and friends; three separate facts
// are what actually stop it:
//
//   1. RLS is enabled on the write targets with own-row (auth.uid() = user_id) policies, so the
//      binding account can only ever write rows OWNED BY ITSELF — rows no owner-scoped read
//      returns and no show total aggregates.
//   2. The binding account is NOT a store owner, so its auth.uid() is never an owner user_id and
//      the own-row WITH CHECK can never be satisfied for real sales data.
//   3. lensed_log_auction_as (the service-role bind RPC) is NOT granted to authenticated/anon,
//      and the authenticated-callable variants (lensed_log_auction, lensed_unbind) resolve an org
//      via current_user_org() — which is NULL for the binding account, so they raise NO_ORG.
//
// Any one of those quietly changing turns the route guard into a suggestion. This script fails
// loudly if it does. It is READ-ONLY: every statement is a SELECT.
//
// Env: SUPABASE_PROJECT_REF, SUPABASE_ACCESS_TOKEN (a Management-API PAT).

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF;
const PAT = process.env.SUPABASE_ACCESS_TOKEN;
if (!PROJECT_REF || !PAT) {
  console.error('✗ Missing SUPABASE_PROJECT_REF / SUPABASE_ACCESS_TOKEN env.');
  process.exit(2);
}

// Tables the bind RPC writes and that own-row RLS must keep the binding account out of.
const WRITE_TARGETS = ['live_auction_items', 'live_auction_item_skus'];
// Must never become callable by a user session — it takes the owner as a parameter and so
// bypasses auth.uid() entirely.
const SERVICE_ROLE_ONLY_RPCS = ['lensed_log_auction_as'];
// Callable by authenticated on purpose, but only useful WITH an org. The binding account has none.
const ORG_GATED_RPCS = ['lensed_log_auction', 'lensed_unbind'];

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Management API query failed: ${res.status} ${await res.text()}`);
  return res.json();
}

const problems = [];
const note = (s) => console.log(`  ${s}`);

// ── Who are the binding accounts? Resolved by CAPABILITY, not by a hardcoded uid — a second
//    binding account created later is held to the same invariants automatically.
const binders = await sql(`
  select u.id, u.email,
         (select count(*) from public.store_members sm where sm.user_id = u.id and sm.role = 'owner') owner_rows,
         (select count(*) from public.organization_members om where om.user_id = u.id) org_rows
    from auth.users u
   where u.raw_app_meta_data->>'role' = 'member'
     and u.raw_app_meta_data->'scopes' ? 'binding';`);

console.log('\nbinding accounts (role=member, scopes ∋ binding)');
if (!binders.length) {
  problems.push('No binding-scoped member account found. Either the scope was renamed or the '
    + 'account was removed — this check can no longer prove anything and must be updated.');
} else {
  for (const b of binders) {
    note(`${b.email} — owner rows: ${b.owner_rows}, org rows: ${b.org_rows}`);
    // INVARIANT 2: never an owner. If it becomes one, own-row RLS stops being a barrier.
    if (Number(b.owner_rows) > 0) {
      problems.push(`${b.email} is a store OWNER (store_members.role='owner'). Its auth.uid() is `
        + `now an owner user_id, so the own-row RLS WITH CHECK on live_auction_items can be `
        + `satisfied for real sales data — it can bind directly through PostgREST, bypassing the `
        + `route guard entirely (room-live lockout, scope checks, bind_audit).`);
    }
    // INVARIANT 3: no org ⇒ lensed_log_auction / lensed_unbind raise NO_ORG.
    if (Number(b.org_rows) > 0) {
      problems.push(`${b.email} now has an organization_members row. current_user_org() no longer `
        + `returns NULL for it, so ${ORG_GATED_RPCS.join(' / ')} stop raising NO_ORG and become `
        + `callable directly through PostgREST.`);
    }
  }
}

// ── INVARIANT 1: RLS enabled + own-row policies on every write target.
const rls = await sql(`
  select c.relname, c.relrowsecurity
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname in (${WRITE_TARGETS.map((t) => `'${t}'`).join(',')});`);
const pol = await sql(`
  select tablename, cmd, qual, with_check
    from pg_policies
   where schemaname = 'public' and tablename in (${WRITE_TARGETS.map((t) => `'${t}'`).join(',')});`);

console.log('\nwrite targets — RLS + own-row policies');
for (const t of WRITE_TARGETS) {
  const row = rls.find((r) => r.relname === t);
  if (!row) { problems.push(`Table ${t} not found — this check is stale.`); continue; }
  if (row.relrowsecurity !== true) {
    problems.push(`RLS is DISABLED on ${t}. authenticated holds INSERT/UPDATE grants on it, so the `
      + `binding account can write arbitrary rows directly through PostgREST.`);
    continue;
  }
  const mine = pol.filter((p) => p.tablename === t);
  // The INSERT path is the one that matters: it is how a forged bind would be created.
  const ins = mine.find((p) => p.cmd === 'INSERT');
  const ownRow = (s) => typeof s === 'string' && /auth\.uid\(\)\s*=\s*user_id/.test(s);
  if (!ins || !ownRow(ins.with_check)) {
    problems.push(`${t} has RLS enabled but no INSERT policy with an own-row `
      + `(auth.uid() = user_id) WITH CHECK. Found: ${ins ? JSON.stringify(ins.with_check) : 'no INSERT policy'}. `
      + `Without it the binding account can insert rows attributed to the OWNER.`);
  } else {
    note(`${t} — RLS on, INSERT WITH CHECK ${ins.with_check}`);
  }
}

// ── INVARIANT 3a: the service-role-only bind RPC must stay ungranted to user roles.
const rpcs = await sql(`
  select p.proname, coalesce(array_to_string(p.proacl, ' | '), '(default: PUBLIC EXECUTE)') acl
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (${[...SERVICE_ROLE_ONLY_RPCS, ...ORG_GATED_RPCS].map((f) => `'${f}'`).join(',')});`);

console.log('\nRPC grants');
for (const fn of SERVICE_ROLE_ONLY_RPCS) {
  const r = rpcs.find((x) => x.proname === fn);
  if (!r) { problems.push(`RPC ${fn} not found — the bind path changed and this check is stale.`); continue; }
  const grantedToUsers = /(^|\|)\s*(authenticated|anon)=/.test(r.acl) || r.acl.includes('=X/postgres |  =')
    || /(^|\|)\s*=X/.test(r.acl); // a bare `=X/...` entry is PUBLIC
  if (grantedToUsers) {
    problems.push(`RPC ${fn} is EXECUTE-able by a user role (acl: ${r.acl}). It takes the owner as a `
      + `parameter, so a user session calling it directly can bind as the owner, skipping every `
      + `route-level check. It must be granted to service_role/postgres only.`);
  } else {
    note(`${fn} — service-role only ✓  (${r.acl})`);
  }
}
for (const fn of ORG_GATED_RPCS) {
  const r = rpcs.find((x) => x.proname === fn);
  if (!r) { problems.push(`RPC ${fn} not found — this check is stale.`); continue; }
  note(`${fn} — authenticated-callable by design, gated by current_user_org()  (${r.acl})`);
}

// ── Report.
if (problems.length) {
  console.error(`\n✗ Binding-guard posture BROKEN — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}\n`);
  console.error('The route-level guards in src/app/api/member/bind/route.ts are no longer sufficient.');
  console.error('Either restore the posture, or move enforcement into SQL (L3a) before shipping.\n');
  process.exit(1);
}
console.log('\n✓ Binding-guard posture intact — the route-level guard cannot be bypassed via PostgREST.\n');
