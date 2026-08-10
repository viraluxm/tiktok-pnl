// Unit proof for the global biweekly pay-period math (feat/biweekly-pay-period).
// No app test runner exists, so this transpiles employees.ts at runtime via the repo's
// `typescript` devDep (its only import is type-only, erased) and exercises the REAL
// nextPayday / paydayAtOffset / payPeriodFor + the materialized-exclusion guard.
//
// Run:  TZ=UTC node src/lib/employees.payperiod.test.mjs

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./employees.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'pp-')), 'employees.mjs');
writeFileSync(outFile, outputText);
const {
  PAY_ANCHOR, nextPayday, paydayAtOffset, payPeriodFor,
  payPeriodContaining, payPeriodStartFor,
  generateRecurringShifts, computePay,
} = await import(pathToFileURL(outFile).href);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};
const d = (y, m, day) => new Date(y, m - 1, day); // local; run under TZ=UTC

// ── Anchor + period boundary
console.log('\nPAY PERIOD boundary');
{
  check('PAY_ANCHOR is 2026-07-17', PAY_ANCHOR === '2026-07-17');
  const p = payPeriodFor('2026-07-17');
  check("payPeriodFor('2026-07-17') = {Jun 29, Jul 12}",
    p.start === '2026-06-29' && p.end === '2026-07-12', `got ${p.start}..${p.end}`);
  // Contiguous, non-overlapping periods (prev ends the day before this starts).
  const prev = payPeriodFor('2026-07-03');
  check('previous period = {Jun 15, Jun 28} (contiguous, no overlap)',
    prev.start === '2026-06-15' && prev.end === '2026-06-28', `got ${prev.start}..${prev.end}`);
  const next = payPeriodFor('2026-07-31');
  check('next period = {Jul 13, Jul 26}',
    next.start === '2026-07-13' && next.end === '2026-07-26', `got ${next.start}..${next.end}`);
}

// ── nextPayday(today): global, >= today, steps of 14 from the anchor
console.log('\nnextPayday(today)');
{
  check("today Jul 11 → Jul 17", nextPayday(d(2026, 7, 11)) === '2026-07-17', nextPayday(d(2026, 7, 11)));
  check("payday itself (Jul 17) → Jul 17 (on-or-after)", nextPayday(d(2026, 7, 17)) === '2026-07-17');
  check("day after payday (Jul 18) → Jul 31", nextPayday(d(2026, 7, 18)) === '2026-07-31');
  check("Jul 31 → Jul 31", nextPayday(d(2026, 7, 31)) === '2026-07-31');
  check("Aug 1 → Aug 14", nextPayday(d(2026, 8, 1)) === '2026-08-14');
  check("well before anchor (Jul 1) → Jul 03", nextPayday(d(2026, 7, 1)) === '2026-07-03', nextPayday(d(2026, 7, 1)));
}

// ── paydayAtOffset: prev/next navigation
console.log('\npaydayAtOffset (nav)');
{
  const t = d(2026, 7, 11);
  check('offset 0 → Jul 17', paydayAtOffset(0, t) === '2026-07-17');
  check('offset -1 → Jul 03', paydayAtOffset(-1, t) === '2026-07-03');
  check('offset +1 → Jul 31', paydayAtOffset(1, t) === '2026-07-31');
}

// ── Deploy C (punches are truth): a MATERIALIZED recurring day does NOT pay.
// Pre-Deploy-C this block asserted a materialized recurring row still paid ("counted once = 80h").
// That is now wrong: shifts with source_rule_id set are the frozen PLAN, excluded by isPayableShift.
// In the app, PayView passes ONLY real shifts to computePay (no projections), so the sole recurring
// input is the materialized row — which pays 0. Recurring never reaches pay.
console.log('\nperiod window (Deploy C): materialized recurring day pays 0, generator still excludes it');
{
  const EMP = { id: 'e', hourly_rate: 10 };
  const rule = {
    id: 'r', user_id: 'u', employee_id: 'e',
    days_of_week: [1, 2, 3, 4, 5], start_time: '09:00', end_time: '17:00', // 8h
    start_date: '2026-06-01', active: true, store_id: null,
  };
  const { start, end } = payPeriodFor('2026-07-17'); // Jun 29 – Jul 12
  const TODAY = d(2026, 7, 12); // Sunday, so the whole window is past

  // computePay is a pure summer: raw projections passed in still sum (10 workdays × 8h = 80h).
  // Keeping projections OUT of pay is PayView's job (it no longer passes periodGenerated) — not
  // computePay's. Documented here so the boundary is explicit.
  const projOnly = generateRecurringShifts([rule], [], start, end, new Set(), TODAY);
  check('computePay sums raw projections (10 workdays = 80h) — PayView is what withholds them',
    computePay([EMP], projOnly.filter((g) => !g.skipped))[0].hours === 80);

  // Generator still excludes a materialized (rule,date) from projection (unchanged).
  const materialized = new Set(['r|2026-07-06']);
  const realRow = { employee_id: 'e', date: '2026-07-06', start_time: '09:00', end_time: '17:00', source: 'manual', source_rule_id: 'r' };
  const gen = generateRecurringShifts([rule], [], start, end, materialized, TODAY);
  check('generator excludes the materialized day (9 projected)', gen.length === 9, `got ${gen.length}`);

  // NEW invariant: the materialized recurring row pays 0 (source_rule_id guard).
  check('materialized recurring row pays 0h', computePay([EMP], [realRow])[0].hours === 0,
    `got ${computePay([EMP], [realRow])[0].hours}`);

  // App model: PayView passes real shifts only. With just the materialized row as the recurring
  // input, recurring pay for the period = 0.
  check('app model (real shifts only): recurring pay = 0h', computePay([EMP], [realRow])[0].hours === 0);
}

// ── payPeriodContaining / payPeriodStartFor: the returned window must CONTAIN the date,
//    including the first five days of each window where payPeriodFor(nextPayday(D)) does NOT.
//    This is the guard against a silently-wrong +5 offset if the anchor/cadence ever moves.
console.log('\npayPeriodContaining: containment across boundaries');
{
  const iso = (dt) => dt.toISOString().slice(0, 10);
  // Walk every day across ~5 windows (Jun 15 → Aug 23) and assert start <= D <= end.
  let allContained = true;
  let firstFail = '';
  for (let t = Date.UTC(2026, 5, 15); t <= Date.UTC(2026, 7, 23); t += 86400000) {
    const D = iso(new Date(t));
    const w = payPeriodContaining(D);
    if (!(w.start <= D && D <= w.end)) { allContained = false; firstFail = `${D} → ${w.start}..${w.end}`; break; }
  }
  check('every date Jun 15–Aug 23 lands inside its own window', allContained, firstFail);

  // The exact lag-gap the naive composition gets wrong: first 5 days of {Jul 13 … Jul 26}.
  for (const D of ['2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17']) {
    const w = payPeriodContaining(D);
    check(`${D} → {Jul 13, Jul 26}`, w.start === '2026-07-13' && w.end === '2026-07-26', `got ${w.start}..${w.end}`);
  }

  // payPeriodStartFor is just the start; and it DIFFERS from the naive lag-bearing composition,
  // which is the whole point (naive would return 2026-06-29 for Jul 15).
  check("payPeriodStartFor('2026-07-15') = 2026-07-13", payPeriodStartFor('2026-07-15') === '2026-07-13');
  check('naive payPeriodFor(nextPayday(D)) WOULD mis-bucket Jul 15 to Jun 29 (documents the lag)',
    payPeriodFor(nextPayday(d(2026, 7, 15))).start === '2026-06-29');

  // Window-boundary dates (Sunday end, Monday start) resolve to the right side.
  check("period end (Sun Jul 26) stays in {Jul 13, Jul 26}", payPeriodStartFor('2026-07-26') === '2026-07-13');
  check("next start (Mon Jul 27) moves to {Jul 27, Aug 09}", payPeriodStartFor('2026-07-27') === '2026-07-27');
}

console.log(`\nALL PASSED (${passed} assertions)`);
