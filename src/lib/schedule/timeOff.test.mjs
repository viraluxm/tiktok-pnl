// Proof for the time-off window rule. timeOff.ts is pure with no value imports, so transpile it
// alone.  Run:  node src/lib/schedule/timeOff.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict'; import ts from 'typescript';

const src = readFileSync(fileURLToPath(new URL('./timeOff.ts', import.meta.url)), 'utf8');
const { outputText } = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const out = join(mkdtempSync(join(tmpdir(), 'to-')), 'to.mjs'); writeFileSync(out, outputText);
const { checkTimeOffWindow, earliestRequestableDate, inclusiveDays, addDaysISO } = await import(pathToFileURL(out).href);

let passed = 0;
const check = (n, c) => { assert.ok(c, `FAIL: ${n}`); console.log(`  ✓ ${n}`); passed++; };

// Real biweekly cycle: PAY_ANCHOR 2026-07-17 (Fri payday) → periods start Mondays, 14 days apart.
// Period boundaries used below: ... 2026-08-24, 2026-09-07, 2026-09-21, 2026-10-05 ...
const ANCHOR_START = '2026-08-24';
function periodStartOf(dateISO) {
  let s = ANCHOR_START;
  while (addDaysISO(s, 14) <= dateISO) s = addDaysISO(s, 14);
  while (s > dateISO) s = addDaysISO(s, -14);
  return s;
}
const W = (startDate, endDate, todayISO) =>
  checkTimeOffWindow({ startDate, endDate, todayISO, periodStartOf });

console.log('\ndate helpers');
check('inclusiveDays: a single day is 1', inclusiveDays('2026-09-10', '2026-09-10') === 1);
check('inclusiveDays: both ends counted', inclusiveDays('2026-09-10', '2026-09-12') === 3);
check('addDaysISO crosses a month end', addDaysISO('2026-08-31', 1) === '2026-09-01');
check('addDaysISO crosses DST (Nov 1 2026) intact', addDaysISO('2026-10-31', 2) === '2026-11-02');

console.log('\nthe rule — today 2026-09-01, inside period 08-24…09-06');
{
  const today = '2026-09-01';
  check('a day in the CURRENT period is refused',
    W('2026-09-04', '2026-09-04', today).reason === 'period_closed');
  check('today itself is refused', W(today, today, today).reason === 'period_closed');
  check('the NEXT period (09-07) is open — asked 6 days out',
    W('2026-09-10', '2026-09-10', today).allowed);
  check('a far-future period is open', W('2026-10-14', '2026-10-16', today).allowed);
  check('earliest requestable is the next period start',
    earliestRequestableDate(today, periodStartOf) === '2026-09-07');
}

console.log('\nthe lead-time cutoff closes the period that is about to be built');
{
  // Period 09-07 starts Mon 09-07; with 3 days lead it closes once today + 3 >= 09-07.
  check('asked 2026-09-03 (4 days out) → still open',
    W('2026-09-10', '2026-09-10', '2026-09-03').allowed);
  check('asked 2026-09-04 (3 days out) → CLOSED, schedule is being built',
    W('2026-09-10', '2026-09-10', '2026-09-04').reason === 'period_closed');
  check('…and the earliest then rolls to the period after',
    earliestRequestableDate('2026-09-04', periodStartOf) === '2026-09-21');
}

console.log('\nboundaries');
{
  const today = '2026-09-01';
  check('the exact first day of the open period is allowed',
    W('2026-09-07', '2026-09-07', today).allowed);
  check('the day BEFORE it (last day of current period) is refused',
    W('2026-09-06', '2026-09-06', today).reason === 'period_closed');
  check('a range STARTING open may run into the following period',
    W('2026-09-18', '2026-09-24', today).allowed);
  check('a range starting in a closed period is refused even if it ends open',
    W('2026-09-05', '2026-09-09', today).reason === 'period_closed');
}

console.log('\nrange shape');
{
  const today = '2026-09-01';
  check('end before start → range_inverted',
    W('2026-09-12', '2026-09-10', today).reason === 'range_inverted');
  check('exactly 14 days is allowed', W('2026-09-07', '2026-09-20', today).allowed);
  check('15 days → range_too_long',
    W('2026-09-07', '2026-09-21', today).reason === 'range_too_long');
  check('an inverted range is caught BEFORE the deadline check',
    W('2026-09-04', '2026-09-02', today).reason === 'range_inverted');
}

console.log('\nevery refusal still reports where the window opens');
check('a refusal carries earliestRequestable',
  W('2026-09-04', '2026-09-04', '2026-09-01').earliestRequestable === '2026-09-07');

console.log(`\n${passed} checks passed\n`);
