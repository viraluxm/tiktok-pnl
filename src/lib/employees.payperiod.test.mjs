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
const { PAY_ANCHOR, nextPayday, paydayAtOffset, payPeriodFor, generateRecurringShifts, computePay } =
  await import(pathToFileURL(outFile).href);

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

// ── Materialized recurring day is NOT double-counted within a period window
console.log('\nperiod window: materialized day counted once');
{
  const EMP = { id: 'e', hourly_rate: 10 };
  const rule = {
    id: 'r', user_id: 'u', employee_id: 'e',
    days_of_week: [1, 2, 3, 4, 5], start_time: '09:00', end_time: '17:00', // 8h
    start_date: '2026-06-01', active: true, store_id: null,
  };
  const { start, end } = payPeriodFor('2026-07-17'); // Jun 29 – Jul 12
  const TODAY = d(2026, 7, 12); // Sunday, so the whole window is past

  // Projection-only baseline for the window (10 workdays Jun 29–Jul 10 × 8h = 80h).
  const projOnly = generateRecurringShifts([rule], [], start, end, new Set(), TODAY);
  const before = computePay([EMP], projOnly.filter((g) => !g.skipped))[0].hours;

  // Materialize ONE day (Jul 6) as a real row; generator must exclude it.
  const materialized = new Set(['r|2026-07-06']);
  const realRow = { employee_id: 'e', date: '2026-07-06', start_time: '09:00', end_time: '17:00', source_rule_id: 'r' };
  const gen = generateRecurringShifts([rule], [], start, end, materialized, TODAY);
  const after = computePay([EMP], [realRow, ...gen.filter((g) => !g.skipped)])[0].hours;

  check('window projects 10 workdays = 80h', before === 80, `got ${before}`);
  check('generator excludes the materialized day (9 projected)', gen.length === 9, `got ${gen.length}`);
  check('EXACTLY-ONCE in period: total unchanged 80h (not 88)', after === before, `before=${before} after=${after}`);
}

console.log(`\nALL PASSED (${passed} assertions)`);
