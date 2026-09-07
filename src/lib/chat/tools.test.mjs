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
transpile(join(here, '../shipping/pickerPerformance.ts'), 'pickerPerformance.mjs');
const toolsUrl = transpile(join(here, 'tools.ts'), 'tools.mjs', [
  ["'@/lib/employees'", "'./employees.mjs'"],
  ["'@/lib/shipping/pickerPerformance'", "'./pickerPerformance.mjs'"],
]);
const { runTool, TOOL_DEFS, toolsFor, TOOL_SCOPES } = await import(toolsUrl);
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
  console.log('\nscope gating');
{
  check('every tool declares a scope', TOOL_DEFS.every((t) => TOOL_SCOPES[t.name]),
    TOOL_DEFS.map((t) => `${t.name}:${TOOL_SCOPES[t.name]}`).join(' '));
  check('admin ("all") sees every tool', toolsFor('all').length === TOOL_DEFS.length,
    `${TOOL_DEFS.length} tools`);
  const teamOnly = toolsFor(['team']).map((t) => t.name).sort();
  check('a team-only member sees only team tools',
    teamOnly.join(',') === 'get_fulfillment,get_pay,get_roster,get_schedule', teamOnly.join(','));
  check('an unknown scope grants nothing (fail closed)', toolsFor(['nonsense']).length === 0);
  check('no scope at all grants nothing', toolsFor([]).length === 0);

  // The offered list is a hint; the boundary is the server-side re-check.
  let denied = null;
  try { await runTool({ admin, ownerIds, storeIds }, 'get_pnl', { from: '2026-09-04', to: '2026-09-04', store_id: 'all', group_by: 'total' }, ['team']); }
  catch (e) { denied = e; }
  check('calling an out-of-scope tool is refused server-side even if requested',
    denied != null && /not permitted/.test(denied.message), denied ? denied.message.slice(0, 52) : 'NOT DENIED');
}

console.log('\nget_shows / get_inventory / get_sku_performance');
{
  const sh = await runTool({ admin, ownerIds, storeIds }, 'get_shows', { from: '2026-08-25', to: '2026-09-05' });
  check('get_shows returns sessions', sh.count >= 0, `${sh.count} shows`);
  check('get_shows never calls it net profit', !JSON.stringify(sh).includes('net_profit'), 'margin_dollars only');

  const inv = await runTool({ admin, ownerIds, storeIds }, 'get_inventory', { needs_reorder_only: false });
  check('get_inventory returns skus', inv.total_skus > 0, `${inv.total_skus} skus, ${inv.needs_reorder_count} need reorder`);
  // Scan the DATA ROWS, not the whole payload — the payload includes an explanatory note that
  // legitimately contains the word "revenue", and matching on that is a false positive.
  const moneyKeys = [...new Set(inv.skus.flatMap((x) => Object.keys(x)))]
    .filter((k) => /revenue|cogs|cost|price|margin|profit/i.test(k));
  check('get_inventory rows carry NO revenue or cost field', moneyKeys.length === 0,
    moneyKeys.length ? `LEAKED: ${moneyKeys.join(', ')}` : `${Object.keys(inv.skus[0] ?? {}).length} stock-only fields`);
  const only = await runTool({ admin, ownerIds, storeIds }, 'get_inventory', { needs_reorder_only: true });
  check('needs_reorder_only narrows the list', only.returned <= inv.returned,
    `${only.returned} of ${inv.total_skus}`);

  const perf = await runTool({ admin, ownerIds, storeIds }, 'get_sku_performance', { from: '2026-08-01', to: '2026-08-31', limit: 5 });
  check('get_sku_performance ranks by revenue and honours limit',
    perf.skus.length <= 5 && perf.skus.every((x, i, a) => i === 0 || a[i-1].revenue_dollars >= x.revenue_dollars),
    `top ${perf.skus.length} of ${perf.total_skus}`);
}

console.log('\nget_fulfillment');
{
  // Pick a day that actually has boxes so the shape is exercised on real data.
  let day = null, r = null;
  for (const d of ['2026-09-04', '2026-09-03', '2026-09-02', '2026-08-31']) {
    const attempt = await runTool({ admin, ownerIds, storeIds }, 'get_fulfillment', { date: d });
    if (attempt.summary.boxes_completed > 0) { day = d; r = attempt; break; }
  }
  check('found a fulfillment day with boxes', r != null, day ?? 'none in the sampled days');

  check('fulfillment day is the 04:00 window, not midnight',
    r.fulfillment_day.window.includes('04:00'), r.fulfillment_day.window);

  // THE load-bearing assertion: no pick_started_at-derived field may reach the model. A field
  // named orders_per_active_hour would be quoted as a rate regardless of any description.
  const banned = ['orders_per_active_hour', 'avg_pick_ms', 'active_pick_ms', 'median_gap_ms', 'sessions', 'valid_duration_count'];
  const blob = JSON.stringify(r);
  const leaked = banned.filter((k) => blob.includes(k));
  check('no pick_started_at-derived rate field is exposed', leaked.length === 0,
    leaked.length ? `LEAKED: ${leaked.join(', ')}` : `${banned.length} invalid fields stripped`);

  check('a wall-clock rate is provided instead',
    r.pickers.every((p) => 'boxes_per_wall_clock_hour' in p),
    `${r.pickers.length} pickers, ${r.summary.boxes_completed} boxes`);

  const rated = r.pickers.filter((p) => p.boxes_per_wall_clock_hour != null);
  check('wall-clock rates are physically plausible (< 200 boxes/h)',
    rated.every((p) => p.boxes_per_wall_clock_hour < 200),
    rated.length ? `max ${Math.max(...rated.map((p) => p.boxes_per_wall_clock_hour))}/h over ${rated.length} pickers` : 'none rated');

  check('the set-aside blind spot is declared',
    r.caveats.some((c) => /set-aside/i.test(c)), `${r.caveats.length} caveats`);
}

console.log('\nget_orders');
{
  const t0 = Date.now();
  const sum = await runTool({ admin, ownerIds, storeIds }, 'get_orders',
    { order_id: 'none', from: '2026-08-29', to: '2026-09-05', status: 'all', limit: 5 });
  const secs = (Date.now() - t0) / 1000;
  check('summary returns counts by status', sum.total_orders_in_range > 0,
    `${sum.total_orders_in_range} orders in range, ${secs.toFixed(1)}s`);
  check('summary is fast enough for a chat turn (< 20s)', secs < 20, `${secs.toFixed(1)}s`);

  const summed = Object.values(sum.counts_by_status).reduce((a, b) => a + b, 0);
  check('counts_by_status sums to the total', summed === sum.total_orders_in_range,
    `${summed} vs ${sum.total_orders_in_range}`);

  check('sample is capped and labelled as a sample', sum.sample.returned <= 5 && /SAMPLE|sample/i.test(sum.sample.note),
    `${sum.sample.returned} returned`);
  check('never dumps the full order set', sum.sample.returned < sum.total_orders_in_range,
    `${sum.sample.returned} of ${sum.total_orders_in_range}`);

  const st = await runTool({ admin, ownerIds, storeIds }, 'get_orders',
    { order_id: 'none', from: '2026-08-29', to: '2026-09-05', status: 'AWAITING_SHIPMENT', limit: 5 });
  check('status filter narrows the sample',
    st.sample.orders.every((o) => o.status === 'AWAITING_SHIPMENT'),
    `${st.sample.returned} awaiting shipment of ${st.counts_by_status.AWAITING_SHIPMENT}`);

  // Round-trip: an id from the sample must resolve in lookup mode.
  const anyId = sum.sample.orders[0]?.order_id;
  const one = await runTool({ admin, ownerIds, storeIds }, 'get_orders',
    { order_id: String(anyId), from: '', to: '', status: 'all', limit: 1 });
  check('lookup finds a known order', one.found === true && one.mode === 'lookup',
    `${anyId} -> ${one.line_count} line(s)`);

  const missing = await runTool({ admin, ownerIds, storeIds }, 'get_orders',
    { order_id: 'NOT-A-REAL-ORDER-ID', from: '', to: '', status: 'all', limit: 1 });
  check('an unknown order says not found rather than guessing',
    missing.found === false && /do not guess/i.test(missing.note), 'found:false with a no-guess note');

  check('tracking caveats are declared', sum.caveats.length >= 3 &&
    sum.caveats.some((c) => /stale/i.test(c)) && sum.caveats.some((c) => /capture_events/i.test(c)),
    `${sum.caveats.length} caveats`);
}

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

  // Internal consistency: the 'total' bucket must equal the sum of the per-day buckets. This is a
  // real cross-check of the SQL grouping and it costs one extra aggregate.
  //
  // NOT cross-checked by paging pnl_order_grain directly — that is the exact path migration 128
  // exists to replace (19.4s for one day, 383.1s for a month). A paged read of a month here
  // silently returned ZERO rows rather than erroring, which is the same class of silent-failure
  // this suite is meant to catch: a check that quietly reads nothing proves nothing.
  const days = await runTool({ admin, ownerIds, storeIds }, 'get_pnl',
    { from: '2026-08-01', to: '2026-08-31', store_id: 'all', group_by: 'day' });
  const dayRevenue = days.buckets.reduce((a, x) => a + x.revenue_dollars, 0);
  const dayOrders = days.buckets.reduce((a, x) => a + x.orders, 0);
  check('per-day buckets sum to the total bucket',
    Math.abs(dayRevenue - b.revenue_dollars) < 0.05 && dayOrders === b.orders,
    `${days.buckets.length} days -> $${dayRevenue.toFixed(2)} / ${dayOrders} orders`);

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

console.log('\nscope gating');
{
  check('every tool declares a scope', TOOL_DEFS.every((t) => TOOL_SCOPES[t.name]),
    TOOL_DEFS.map((t) => `${t.name}:${TOOL_SCOPES[t.name]}`).join(' '));
  check('admin ("all") sees every tool', toolsFor('all').length === TOOL_DEFS.length,
    `${TOOL_DEFS.length} tools`);
  const teamOnly = toolsFor(['team']).map((t) => t.name).sort();
  check('a team-only member sees only team tools',
    teamOnly.join(',') === 'get_fulfillment,get_pay,get_roster,get_schedule', teamOnly.join(','));
  check('an unknown scope grants nothing (fail closed)', toolsFor(['nonsense']).length === 0);
  check('no scope at all grants nothing', toolsFor([]).length === 0);

  // The offered list is a hint; the boundary is the server-side re-check.
  let denied = null;
  try { await runTool({ admin, ownerIds, storeIds }, 'get_pnl', { from: '2026-09-04', to: '2026-09-04', store_id: 'all', group_by: 'total' }, ['team']); }
  catch (e) { denied = e; }
  check('calling an out-of-scope tool is refused server-side even if requested',
    denied != null && /not permitted/.test(denied.message), denied ? denied.message.slice(0, 52) : 'NOT DENIED');
}

console.log('\nget_shows / get_inventory / get_sku_performance');
{
  const sh = await runTool({ admin, ownerIds, storeIds }, 'get_shows', { from: '2026-08-25', to: '2026-09-05' });
  check('get_shows returns sessions', sh.count >= 0, `${sh.count} shows`);
  check('get_shows never calls it net profit', !JSON.stringify(sh).includes('net_profit'), 'margin_dollars only');

  const inv = await runTool({ admin, ownerIds, storeIds }, 'get_inventory', { needs_reorder_only: false });
  check('get_inventory returns skus', inv.total_skus > 0, `${inv.total_skus} skus, ${inv.needs_reorder_count} need reorder`);
  // Scan the DATA ROWS, not the whole payload — the payload includes an explanatory note that
  // legitimately contains the word "revenue", and matching on that is a false positive.
  const moneyKeys = [...new Set(inv.skus.flatMap((x) => Object.keys(x)))]
    .filter((k) => /revenue|cogs|cost|price|margin|profit/i.test(k));
  check('get_inventory rows carry NO revenue or cost field', moneyKeys.length === 0,
    moneyKeys.length ? `LEAKED: ${moneyKeys.join(', ')}` : `${Object.keys(inv.skus[0] ?? {}).length} stock-only fields`);
  const only = await runTool({ admin, ownerIds, storeIds }, 'get_inventory', { needs_reorder_only: true });
  check('needs_reorder_only narrows the list', only.returned <= inv.returned,
    `${only.returned} of ${inv.total_skus}`);

  const perf = await runTool({ admin, ownerIds, storeIds }, 'get_sku_performance', { from: '2026-08-01', to: '2026-08-31', limit: 5 });
  check('get_sku_performance ranks by revenue and honours limit',
    perf.skus.length <= 5 && perf.skus.every((x, i, a) => i === 0 || a[i-1].revenue_dollars >= x.revenue_dollars),
    `top ${perf.skus.length} of ${perf.total_skus}`);
}

console.log('\nget_fulfillment');
{
  // Pick a day that actually has boxes so the shape is exercised on real data.
  let day = null, r = null;
  for (const d of ['2026-09-04', '2026-09-03', '2026-09-02', '2026-08-31']) {
    const attempt = await runTool({ admin, ownerIds, storeIds }, 'get_fulfillment', { date: d });
    if (attempt.summary.boxes_completed > 0) { day = d; r = attempt; break; }
  }
  check('found a fulfillment day with boxes', r != null, day ?? 'none in the sampled days');

  check('fulfillment day is the 04:00 window, not midnight',
    r.fulfillment_day.window.includes('04:00'), r.fulfillment_day.window);

  // THE load-bearing assertion: no pick_started_at-derived field may reach the model. A field
  // named orders_per_active_hour would be quoted as a rate regardless of any description.
  const banned = ['orders_per_active_hour', 'avg_pick_ms', 'active_pick_ms', 'median_gap_ms', 'sessions', 'valid_duration_count'];
  const blob = JSON.stringify(r);
  const leaked = banned.filter((k) => blob.includes(k));
  check('no pick_started_at-derived rate field is exposed', leaked.length === 0,
    leaked.length ? `LEAKED: ${leaked.join(', ')}` : `${banned.length} invalid fields stripped`);

  check('a wall-clock rate is provided instead',
    r.pickers.every((p) => 'boxes_per_wall_clock_hour' in p),
    `${r.pickers.length} pickers, ${r.summary.boxes_completed} boxes`);

  const rated = r.pickers.filter((p) => p.boxes_per_wall_clock_hour != null);
  check('wall-clock rates are physically plausible (< 200 boxes/h)',
    rated.every((p) => p.boxes_per_wall_clock_hour < 200),
    rated.length ? `max ${Math.max(...rated.map((p) => p.boxes_per_wall_clock_hour))}/h over ${rated.length} pickers` : 'none rated');

  check('the set-aside blind spot is declared',
    r.caveats.some((c) => /set-aside/i.test(c)), `${r.caveats.length} caveats`);
}

console.log('\nget_orders');
{
  const t0 = Date.now();
  const sum = await runTool({ admin, ownerIds, storeIds }, 'get_orders',
    { order_id: 'none', from: '2026-08-29', to: '2026-09-05', status: 'all', limit: 5 });
  const secs = (Date.now() - t0) / 1000;
  check('summary returns counts by status', sum.total_orders_in_range > 0,
    `${sum.total_orders_in_range} orders in range, ${secs.toFixed(1)}s`);
  check('summary is fast enough for a chat turn (< 20s)', secs < 20, `${secs.toFixed(1)}s`);

  const summed = Object.values(sum.counts_by_status).reduce((a, b) => a + b, 0);
  check('counts_by_status sums to the total', summed === sum.total_orders_in_range,
    `${summed} vs ${sum.total_orders_in_range}`);

  check('sample is capped and labelled as a sample', sum.sample.returned <= 5 && /SAMPLE|sample/i.test(sum.sample.note),
    `${sum.sample.returned} returned`);
  check('never dumps the full order set', sum.sample.returned < sum.total_orders_in_range,
    `${sum.sample.returned} of ${sum.total_orders_in_range}`);

  const st = await runTool({ admin, ownerIds, storeIds }, 'get_orders',
    { order_id: 'none', from: '2026-08-29', to: '2026-09-05', status: 'AWAITING_SHIPMENT', limit: 5 });
  check('status filter narrows the sample',
    st.sample.orders.every((o) => o.status === 'AWAITING_SHIPMENT'),
    `${st.sample.returned} awaiting shipment of ${st.counts_by_status.AWAITING_SHIPMENT}`);

  // Round-trip: an id from the sample must resolve in lookup mode.
  const anyId = sum.sample.orders[0]?.order_id;
  const one = await runTool({ admin, ownerIds, storeIds }, 'get_orders',
    { order_id: String(anyId), from: '', to: '', status: 'all', limit: 1 });
  check('lookup finds a known order', one.found === true && one.mode === 'lookup',
    `${anyId} -> ${one.line_count} line(s)`);

  const missing = await runTool({ admin, ownerIds, storeIds }, 'get_orders',
    { order_id: 'NOT-A-REAL-ORDER-ID', from: '', to: '', status: 'all', limit: 1 });
  check('an unknown order says not found rather than guessing',
    missing.found === false && /do not guess/i.test(missing.note), 'found:false with a no-guess note');

  check('tracking caveats are declared', sum.caveats.length >= 3 &&
    sum.caveats.some((c) => /stale/i.test(c)) && sum.caveats.some((c) => /capture_events/i.test(c)),
    `${sum.caveats.length} caveats`);
}

console.log(`\n${passed} checks passed`);
