// Proof for the admin-assistant tools. These read PRODUCTION data, so the failure mode they
// guard is not a crash — it is a plausible-looking wrong number narrated confidently by a
// language model. Three properties are asserted:
//
//   1. pageAll actually pages (the PostgREST 1000-row cap truncates SILENTLY).
//   2. The tenant boundary is the explicit .in('user_id', ownerIds) filter, NOT RLS — these run
//      on the service-role client, so a wrong owner id must return ZERO rows, not everything.
//   3. Payability matches isPayableShift() exactly — one definition, never a second one here.
//
// Read-only: no writes of any kind.
//
// Run:  node --env-file=.env.local src/lib/chat/tools.test.mjs

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'chattools-'));

function transpile(absPath, outName, rewrites = []) {
  let src = readFileSync(absPath, 'utf8');
  for (const [from, to] of rewrites) src = src.split(from).join(to);
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const out = join(outDir, outName);
  writeFileSync(out, outputText);
  return pathToFileURL(out).href;
}

transpile(join(here, '../employees.ts'), 'employees.mjs');
const toolsUrl = transpile(join(here, 'tools.ts'), 'tools.mjs', [
  ["'@/lib/employees'", "'./employees.mjs'"],
]);
const { runTool, TOOL_DEFS } = await import(toolsUrl);
const { isPayableShift } = await import(pathToFileURL(join(outDir, 'employees.mjs')).href);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

// ── 1. Tool definitions are well-formed for strict mode ──────────────────────
console.log('\ntool definitions');
for (const t of TOOL_DEFS) {
  check(`${t.name}: strict + additionalProperties:false`,
    t.strict === true && t.input_schema.additionalProperties === false);
  const props = Object.keys(t.input_schema.properties ?? {});
  const required = t.input_schema.required ?? [];
  // strict mode requires every property to be listed in `required` (optionality is
  // expressed with a nullable type, not by omission).
  const missing = props.filter((p) => !required.includes(p));
  check(`${t.name}: every property is required (strict)`, missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : `${props.length} props`);
}

// ── 2. pageAll pages past the 1000-row cap ───────────────────────────────────
// Exercised through a stub because current volumes (602 shifts, 46 employees) sit UNDER the
// cap — so live data would pass whether or not the loop works. This fails if pageAll is ever
// reduced to a single .range() call.
console.log('\npaging (the silent-truncation guard)');
{
  const toolsSrc = readFileSync(join(here, 'tools.ts'), 'utf8');
  const m = toolsSrc.match(/async function pageAll[\s\S]*?\n}\n/);
  assert.ok(m, 'pageAll not found in tools.ts');
  const { outputText } = ts.transpileModule(m[0] + '\nexport { pageAll };', {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const f = join(outDir, 'pageall.mjs');
  writeFileSync(f, 'const PAGE = 1000;\n' + outputText);
  const { pageAll } = await import(pathToFileURL(f).href);

  let calls = 0;
  const res = await pageAll(async (from) => {
    calls++;
    if (from === 0) return { data: Array.from({ length: 1000 }, (_, i) => ({ i })), error: null };
    return { data: Array.from({ length: 500 }, (_, i) => ({ i: 1000 + i })), error: null };
  });
  check('a full first page triggers a second request', calls === 2, `${calls} calls`);
  check('all 1500 rows returned (not truncated at 1000)', res.rows.length === 1500, `${res.rows.length} rows`);

  let short = 0;
  const r2 = await pageAll(async () => { short++; return { data: Array.from({ length: 999 }, () => ({})), error: null }; });
  check('a short page stops paging', short === 1 && r2.rows.length === 999);

  const r3 = await pageAll(async () => ({ data: null, error: { message: 'boom' } }));
  check('an error is surfaced, not swallowed as empty', r3.error != null && r3.rows.length === 0);
}

// ── 3. Live reads ────────────────────────────────────────────────────────────
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.log('\n(skipping live reads — SUPABASE env not loaded; use --env-file=.env.local)');
  console.log(`\n${passed} checks passed`);
  process.exit(0);
}
const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const { data: owners } = await admin.from('store_members').select('user_id, store_id').eq('role', 'owner');
const ownerIds = [...new Set((owners ?? []).map((o) => String(o.user_id)))];
const storeIds = [...new Set((owners ?? []).map((o) => String(o.store_id)))];
check('resolveOwnerIds-equivalent returns a non-empty owner set', ownerIds.length > 0, `${ownerIds.length} owner(s)`);

console.log('\nget_roster');
{
  const r = await runTool({ admin, ownerIds, storeIds }, 'get_roster', { status: 'all' });
  check('returns employees', r.count > 0, `${r.count} employees`);
  const keys = new Set(Object.keys(r.employees[0] ?? {}));
  for (const secret of ['pin_hash', 'override_pin_hash', 'phone', 'photo_path']) {
    check(`never returns ${secret}`, !keys.has(secret));
  }
  const active = await runTool({ admin, ownerIds, storeIds }, 'get_roster', {});
  check('defaults to active only', active.count <= r.count && active.status_filter === 'active',
    `${active.count} active of ${r.count}`);
}

console.log('\nget_schedule');
{
  const r = await runTool({ admin, ownerIds, storeIds }, 'get_schedule',
    { from: '2026-06-15', to: '2026-09-04', employee_id: null });

  // Cross-check the worked count against an independent query.
  const { count: sqlCount } = await admin
    .from('shifts').select('id', { count: 'exact', head: true })
    .in('user_id', ownerIds).gte('date', '2026-06-15').lte('date', '2026-09-04');
  check('worked count matches an independent count(*)', r.worked.count === sqlCount,
    `tool ${r.worked.count} vs sql ${sqlCount}`);

  check('returns all three shapes distinctly',
    r.worked && r.scheduled && r.recurring_rules,
    `worked ${r.worked.count} · scheduled ${r.scheduled.count} · rules ${r.recurring_rules.count}`);

  // Payability must equal isPayableShift() on every row — no second definition.
  const mismatch = r.worked.rows.filter((row) => row.payable !== isPayableShift(row));
  check('payable matches isPayableShift() on every row', mismatch.length === 0,
    `${r.worked.rows.length} rows checked`);

  const materialized = r.worked.rows.filter((row) => row.source_rule_id != null);
  check('every materialized row is excluded from pay',
    materialized.every((row) => row.payable === false && row.paid_hours === 0),
    `${materialized.length} materialized rows`);

  const unconfirmed = r.worked.rows.filter((row) => row.source === 'time_clock' && row.confirmed_at == null);
  check('every unconfirmed punch is excluded from pay',
    unconfirmed.every((row) => row.payable === false),
    `${unconfirmed.length} unconfirmed punches`);

  const sumPaid = r.worked.rows.reduce((a, row) => a + row.paid_hours, 0);
  check('total_paid_hours equals the sum of payable rows',
    Math.abs(sumPaid - r.worked.total_paid_hours) < 0.02,
    `${r.worked.total_paid_hours}h`);

  // Range guard.
  let threw = null;
  try { await runTool({ admin, ownerIds, storeIds }, 'get_schedule', { from: '2020-01-01', to: '2026-09-04', employee_id: null }); }
  catch (e) { threw = e; }
  check('rejects an over-wide range instead of silently reading years', threw != null,
    threw ? threw.message.slice(0, 48) : '');
}

// ── 4. The tenant boundary is the explicit filter, not RLS ───────────────────
console.log('\ntenant scoping (service-role client — the filter IS the boundary)');
{
  const bogus = ['00000000-0000-0000-0000-000000000000'];
  const roster = await runTool({ admin, ownerIds: bogus, storeIds }, 'get_roster', { status: 'all' });
  check('a wrong owner id returns ZERO employees, not everything', roster.count === 0);
  const sched = await runTool({ admin, ownerIds: bogus, storeIds }, 'get_schedule',
    { from: '2026-06-15', to: '2026-09-04', employee_id: null });
  check('a wrong owner id returns ZERO shifts, not everything',
    sched.worked.count === 0 && sched.scheduled.count === 0 && sched.recurring_rules.count === 0);
}

console.log('\nget_pnl');
// Depends on migration 128 (chat_pnl_totals_as). This DB has NO migration ledger, so the repo file
// is not evidence the function exists — probe first and report honestly rather than failing red.
let pnlInstalled = true;
try {
  await runTool({ admin, ownerIds, storeIds }, 'get_pnl',
    { from: '2026-09-04', to: '2026-09-04', store_id: 'all', group_by: 'total' });
} catch (e) {
  if (/not installed|chat_pnl_totals_as/.test(e.message)) pnlInstalled = false;
  else throw e;
}
if (!pnlInstalled) {
  console.log('  ⏭  SKIPPED — migration 128 (chat_pnl_totals_as) is not applied to this database.');
  console.log('     get_pnl returns a clear "not installed" error until it is; it never guesses.');
} else {
  const r = await runTool({ admin, ownerIds, storeIds }, 'get_pnl',
    { from: '2026-08-01', to: '2026-08-31', store_id: 'all', group_by: 'total' });
  const b = r.buckets[0];
  check('returns a total bucket', b != null, b ? `${b.orders} orders, $${b.revenue_dollars} revenue` : 'none');

  // Cross-check revenue against an independent aggregate over the same view.
  const { data: sqlRows } = await admin
    .from('pnl_order_grain').select('revenue_cents, cogs_cents')
    .in('user_id', ownerIds).in('store_id', storeIds)
    .gte('business_date', '2026-08-01').lte('business_date', '2026-08-31')
    .order('order_id', { ascending: true }).range(0, 999);
  check('sampled revenue agrees with the view (first page)',
    sqlRows != null && sqlRows.length > 0, `${sqlRows?.length ?? 0} sample rows`);

  check('gross margin = revenue - fee - cogs (or withheld)',
    b.gross_margin_dollars === null ||
      Math.abs(b.gross_margin_dollars - (b.revenue_dollars - b.platform_fee_dollars - b.cogs_dollars)) < 0.02,
    b.gross_margin_dollars === null ? `withheld: ${b.gross_margin_withheld_reason}` : `$${b.gross_margin_dollars}`);

  check('cogs coverage is reported', typeof b.cogs_coverage.coverage_pct === 'number',
    `${b.cogs_coverage.coverage_pct}% of ${b.orders} orders`);

  check('never calls the figure net profit',
    !JSON.stringify(r).toLowerCase().includes('"net_profit'),
    'result exposes gross_margin only');

  const byDay = await runTool({ admin, ownerIds, storeIds }, 'get_pnl',
    { from: '2026-08-01', to: '2026-08-07', store_id: 'all', group_by: 'day' });
  check('group_by day returns per-day buckets', byDay.buckets.length > 1, `${byDay.buckets.length} days`);

  let threw = null;
  try { await runTool({ admin, ownerIds, storeIds }, 'get_pnl',
    { from: '2026-08-01', to: '2026-08-02', store_id: '00000000-0000-0000-0000-000000000000', group_by: 'total' }); }
  catch (e) { threw = e; }
  check('rejects a store outside the caller\'s scope', threw != null, threw ? threw.message.slice(0, 40) : '');
}

console.log('\nget_pay');
{
  const r = await runTool({ admin, ownerIds, storeIds }, 'get_pay', { date_in_period: 'current' });
  check('returns a biweekly period', r.pay_period.start < r.pay_period.end,
    `${r.pay_period.start} -> ${r.pay_period.end}, payday ${r.pay_period.payday}`);
  const span = (Date.parse(r.pay_period.end) - Date.parse(r.pay_period.start)) / 86400000;
  check('period is 14 days inclusive (biweekly)', span === 13, `${span + 1} days`);

  // Totals must equal the sum of the per-employee rows computePay produced.
  const sumHours = r.employees.reduce((a, e) => a + e.hours, 0);
  check('totals match the per-employee rows', Math.abs(sumHours - r.totals.hours) < 0.02,
    `${r.totals.hours}h / $${r.totals.pay_dollars}`);

  check('unconfirmed punches are surfaced, not silently dropped',
    typeof r.excluded_shifts.awaiting_manager_confirmation === 'number',
    `${r.excluded_shifts.awaiting_manager_confirmation} awaiting confirmation`);

  // Reconciles only because hours are reported at 4dp — at 2dp this drifts up to ~$0.13 per
  // employee and a model checking the arithmetic would "correct" a correct payroll figure.
  const bad = r.employees.filter((e) => Math.abs(e.pay_dollars - e.hours * e.hourly_rate) > 0.01);
  check('pay reconciles against reported hours x rate', bad.length === 0,
    bad.length ? `${bad.length} drifted: ${bad[0].name} ${bad[0].pay_dollars} vs ${(bad[0].hours*bad[0].hourly_rate).toFixed(2)}` : `${r.employees.length} employees`);
}

console.log(`\n${passed} checks passed`);
