// Proof for the status-refresh ordering. The bug being replaced left orders ranked 6,001+ by
// age PERMANENTLY unrefreshed, so the tests that matter most are the ones asserting that no
// part of the open set is unreachable.
// Run:  node src/lib/tiktok/statusRefreshPlan.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./statusRefreshPlan.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'srp-')), 'plan.mjs');
writeFileSync(outFile, outputText);
const { planStatusRefresh } = await import(pathToFileURL(outFile).href);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

const DAY = 86_400_000;
const T0 = Date.parse('2026-09-03T00:00:00Z');
/** `n` open orders, o0 the OLDEST and o{n-1} the newest, one day apart. */
const openSet = (n) => Array.from({ length: n }, (_, i) => ({
  order_id: `o${i}`,
  order_created_at: new Date(T0 - (n - 1 - i) * DAY).toISOString(),
}));

const OPTS = { chunk: 50, recentCalls: 100, backlogCalls: 20 };

console.log('\nNewest orders are reached');
{
  // The exact production shape: 13,014 open orders, 6,000 reachable per run.
  const plan = planStatusRefresh(openSet(13014), OPTS);
  check('the newest order is in the plan', plan.ids.includes('o13013'));
  check('and it is requested FIRST', plan.ids[0] === 'o13013', plan.ids[0]);
  // The regression: under oldest-first + limit(6000), o13013 was never reachable at all.
  const recentIds = plan.ids.slice(0, plan.recentCount);
  check('the newest 5,000 are all in the recent half',
    Array.from({ length: 5000 }, (_, k) => `o${13013 - k}`).every((id) => recentIds.includes(id)));
}
{
  const plan = planStatusRefresh(openSet(13014), OPTS);
  check('recent half fills its budget', plan.recentCount === 5000, String(plan.recentCount));
  check('backlog half fills its budget', plan.backlogCount === 1000, String(plan.backlogCount));
  check('total matches the call budget', plan.ids.length === 6000, String(plan.ids.length));
  check('the unreachable remainder is reported, not hidden',
    plan.skipped === 13014 - 6000, String(plan.skipped));
}

console.log('\nThe old tail is never permanently invisible');
{
  const plan = planStatusRefresh(openSet(13014), OPTS);
  check('the OLDEST order is also in the plan', plan.ids.includes('o0'));
  const backlogIds = plan.ids.slice(plan.recentCount);
  check('…via the backlog half, not the recent one', backlogIds.includes('o0'));
  check('the backlog half starts at the very oldest', backlogIds[0] === 'o0', backlogIds[0]);
  // Inverting to newest-only would have been just as broken, in the other direction.
  check('a newest-only plan would NOT reach the oldest — which is why the split exists',
    !planStatusRefresh(openSet(13014), { ...OPTS, backlogCalls: 0 }).ids.includes('o0'));
}

console.log('\nNo wasted calls');
{
  const plan = planStatusRefresh(openSet(13014), OPTS);
  check('no id appears twice', new Set(plan.ids).size === plan.ids.length);
}
{
  // A small store where both halves would overlap. Every order should appear exactly once.
  const plan = planStatusRefresh(openSet(30), OPTS);
  check('a small store is fully covered', plan.ids.length === 30, String(plan.ids.length));
  check('…with no duplicates', new Set(plan.ids).size === 30);
  check('…and nothing skipped', plan.skipped === 0);
  check('the recent half claims everything, the backlog adds nothing',
    plan.recentCount === 30 && plan.backlogCount === 0,
    `${plan.recentCount}/${plan.backlogCount}`);
}
{
  const plan = planStatusRefresh([], OPTS);
  check('an empty open set plans nothing', plan.ids.length === 0 && plan.skipped === 0);
}

console.log('\nLegacy rows with no date');
{
  // Rows predating order_created_at must be REACHABLE, not silently dropped — excluding them
  // would recreate a blind spot of exactly the kind this function removes.
  const set = [
    { order_id: 'legacy1', order_created_at: null },
    { order_id: 'legacy2', order_created_at: null },
    ...openSet(10),
  ];
  const plan = planStatusRefresh(set, { chunk: 5, recentCalls: 1, backlogCalls: 1 });
  check('null-dated rows are treated as OLDEST, so the backlog half finds them',
    plan.ids.includes('legacy1') || plan.ids.includes('legacy2'),
    plan.ids.join(','));
  const full = planStatusRefresh(set, OPTS);
  check('with budget to spare, every null-dated row is included',
    full.ids.includes('legacy1') && full.ids.includes('legacy2'));
  check('an unparseable date does not crash or vanish',
    planStatusRefresh([{ order_id: 'bad', order_created_at: 'not-a-date' }], OPTS)
      .ids.includes('bad'));
}

console.log('\nDeterminism');
{
  const set = openSet(500);
  const a = planStatusRefresh(set, OPTS).ids.join(',');
  const b = planStatusRefresh(set.slice().reverse(), OPTS).ids.join(',');
  check('input order does not change the plan', a === b);
}
{
  // Same-timestamp orders must still order deterministically, so two runs over unchanged data
  // request the same thing and the logs stay comparable.
  const same = ['b', 'a', 'c'].map((id) => ({ order_id: id, order_created_at: new Date(T0).toISOString() }));
  const plan = planStatusRefresh(same, { chunk: 3, recentCalls: 1, backlogCalls: 0 });
  check('ties break on order_id', plan.ids.join(',') === 'a,b,c', plan.ids.join(','));
}
{
  const plan = planStatusRefresh(openSet(100), { chunk: 0, recentCalls: 0, backlogCalls: 0 });
  check('a zero budget plans nothing rather than everything',
    plan.ids.length === 0 && plan.skipped === 100);
}

console.log(`\n${passed} checks passed\n`);
