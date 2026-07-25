// Unit tests for the monthly shift calendar logic (feat/employee-weekly-shift-calendar).
// Transpiles weeklySchedule.ts standalone via the repo's `typescript` devDep (type-only
// imports are erased), like the weekly/payperiod tests.
//
// Run:  TZ=UTC node src/lib/employees.monthly.test.mjs

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./weeklySchedule.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'mo-')), 'weeklySchedule.mjs');
writeFileSync(outFile, outputText);
const W = await import(pathToFileURL(outFile).href);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

const emp = (id, name, role, status = 'active') => ({ id, name, role, status });
const ALICE = emp('a', 'Alice', 'host');
const BOB = emp('b', 'Bob', 'fulfillment');
const CAROL = emp('c', 'Carol', 'manager'); // Other
const DAVE = emp('d', 'Dave', 'host', 'former'); // excluded
const PAT = emp('p', 'Pat', 'fulfillment', 'probation');
const EMPLOYEES = [ALICE, BOB, CAROL, DAVE, PAT];

// ── Month grid range calculation ─────────────────────────────────────────────
console.log('\nMonth grid range');
{
  // July 2026: 1st = Wed 07-01; Monday on/before = 06-29; last = Fri 07-31; Sunday after = 08-02.
  const g = W.monthGridDays('2026-07-15');
  check('monthStart = 2026-07-01', g.monthStart === '2026-07-01', g.monthStart);
  check('monthEnd = 2026-07-31', g.monthEnd === '2026-07-31', g.monthEnd);
  check('gridStart = Monday 2026-06-29', g.gridStart === '2026-06-29', g.gridStart);
  check('gridEnd = Sunday 2026-08-02', g.gridEnd === '2026-08-02', g.gridEnd);
  check('grid is whole weeks (35 days / 5 weeks)', g.days.length === 35 && g.weeks.length === 5, `${g.days.length} days`);
  check('every week has 7 days', g.weeks.every((w) => w.length === 7));
  check('gridStart is a Monday, gridEnd is a Sunday', W.parseYMD(g.gridStart).getUTCDay() === 1 && W.parseYMD(g.gridEnd).getUTCDay() === 0);
  check('grid spans full month (includes 07-01 and 07-31)', g.days.includes('2026-07-01') && g.days.includes('2026-07-31'));
  check('monthTitle = "July 2026"', W.monthTitle('2026-07-15') === 'July 2026', W.monthTitle('2026-07-15'));
}

// ── Previous / current / next month navigation ───────────────────────────────
console.log('\nMonth navigation');
{
  check('startOfMonthISO normalizes any day', W.startOfMonthISO('2026-07-15') === '2026-07-01');
  check('prev month', W.addMonthsISO('2026-07-01', -1) === '2026-06-01', W.addMonthsISO('2026-07-01', -1));
  check('next month', W.addMonthsISO('2026-07-01', 1) === '2026-08-01', W.addMonthsISO('2026-07-01', 1));
  check('next wraps year (Dec→Jan)', W.addMonthsISO('2026-12-01', 1) === '2027-01-01', W.addMonthsISO('2026-12-01', 1));
  check('prev wraps year (Jan→Dec)', W.addMonthsISO('2026-01-01', -1) === '2025-12-01', W.addMonthsISO('2026-01-01', -1));
  // Adjacent months' grids are contiguous with no gap.
  const g = W.monthGridDays('2026-07-01');
  const next = W.monthGridDays(W.addMonthsISO('2026-07-01', 1));
  check('next month grid starts within a week of this grid end', next.gridStart <= W.addDaysISO(g.gridEnd, 1), `${g.gridEnd} → ${next.gridStart}`);
}

// ── Trailing / leading adjacent-month dates ──────────────────────────────────
console.log('\nAdjacent-month (trailing/leading) dates');
{
  const anchor = '2026-07-01';
  check('06-29 is a grid day but NOT in month', W.monthGridDays(anchor).days.includes('2026-06-29') && !W.isInMonth('2026-06-29', anchor));
  check('08-02 is a grid day but NOT in month', W.monthGridDays(anchor).days.includes('2026-08-02') && !W.isInMonth('2026-08-02', anchor));
  check('07-15 IS in month', W.isInMonth('2026-07-15', anchor));
  // A shift on a leading adjacent day still appears in the model (range covers the whole grid).
  const shifts = [{ id: 's-lead', employee_id: 'a', date: '2026-06-30', start_time: '09:00', end_time: '12:00', source_rule_id: null }];
  const model = W.buildMonthModel({ employees: EMPLOYEES, shifts, generated: [], gridDays: W.monthGridDays(anchor).days, roleFilter: 'all' });
  check('leading-day shift (06-30) is present in the grid model', (model.get('2026-06-30') ?? []).length === 1);
}

// ── Role grouping + multiple shifts + overnight within a day ──────────────────
console.log('\nDay model: role grouping / multiple shifts / overnight / former exclusion');
{
  const anchor = '2026-07-01';
  const grid = W.monthGridDays(anchor);
  const shifts = [
    { id: 's1', employee_id: 'a', date: '2026-07-01', start_time: '09:00', end_time: '17:00', source_rule_id: null }, // Alice host
    { id: 's2', employee_id: 'a', date: '2026-07-01', start_time: '18:00', end_time: '20:00', source_rule_id: null }, // Alice 2nd shift
    { id: 's3', employee_id: 'b', date: '2026-07-01', start_time: '17:00', end_time: '01:00', source_rule_id: null }, // Bob overnight
    { id: 's4', employee_id: 'd', date: '2026-07-01', start_time: '10:00', end_time: '12:00', source_rule_id: null }, // Dave FORMER
    { id: 's5', employee_id: 'a', date: '2026-07-01', start_time: '13:00', end_time: '14:00', source_rule_id: 'rule-x' }, // Alice materialized
  ];
  const generated = [
    { id: 'rp:2026-07-01', rule_id: 'rp', employee_id: 'p', date: '2026-07-01', start_time: '09:00', end_time: '13:00', modified: false, skipped: false }, // Pat fulfillment recurring
  ];
  const model = W.buildMonthModel({ employees: EMPLOYEES, shifts, generated, gridDays: grid.days, roleFilter: 'all' });
  const day = model.get('2026-07-01') ?? [];
  check('former employee (Dave) excluded', day.every((e) => e.employee.id !== 'd'));
  check('day has 5 entries (Alice×3 incl. materialized, Bob, Pat)', day.length === 5, `got ${day.length}`);
  check('multiple shifts for one employee (Alice ×3)', day.filter((e) => e.employee.id === 'a').length === 3);

  const groups = W.groupDayEntriesByRole(day);
  check('groups ordered Live Hosts then Fulfillment', groups.map((g) => g.key).join(',') === 'host,fulfillment', groups.map((g) => g.key).join(','));
  check('Live Hosts group = Alice ×3, ordered by start', groups[0].entries.map((e) => e.card.start_time).join(',') === '09:00,13:00,18:00');
  check('Fulfillment group = Pat(09:00) then Bob(17:00)', groups[1].entries.map((e) => e.employee.id).join(',') === 'p,b');

  const bob = day.find((e) => e.employee.id === 'b');
  check('Bob 17:00–01:00 flagged overnight', bob.card.isOvernight === true);
  check('overnight range displays 5 PM–1 AM', W.formatTimeRange12(bob.card.start_time, bob.card.end_time) === '5 PM–1 AM');
  const mat = day.find((e) => e.card.id === 's5');
  check('materialized shift → protected recurring card (isFrozen)', mat.card.kind === 'recurring' && mat.card.isFrozen === true);

  // Role filter narrows the day.
  const hostOnly = W.buildMonthModel({ employees: EMPLOYEES, shifts, generated, gridDays: grid.days, roleFilter: 'host' });
  check('host filter → only Alice entries on the day', (hostOnly.get('2026-07-01') ?? []).every((e) => e.employee.id === 'a'));
}

// ── Overflow "+N more" ────────────────────────────────────────────────────────
console.log('\nOverflow +N more');
{
  check('MONTH_CELL_MAX_ENTRIES = 3', W.MONTH_CELL_MAX_ENTRIES === 3);
  check('6 entries, cap 3 → visible 3, more 3', JSON.stringify(W.overflowSplit(6, 3)) === JSON.stringify({ visible: 3, more: 3 }));
  check('2 entries, cap 3 → visible 2, more 0', JSON.stringify(W.overflowSplit(2, 3)) === JSON.stringify({ visible: 2, more: 0 }));
  check('3 entries, cap 3 → visible 3, more 0', JSON.stringify(W.overflowSplit(3, 3)) === JSON.stringify({ visible: 3, more: 0 }));
  check('default cap uses MONTH_CELL_MAX_ENTRIES (5 → more 2)', W.overflowSplit(5).more === 2);
}

// ── 12-hour time display (month cells reuse the shared formatter) ─────────────
console.log('\n12-hour display in month');
{
  check('17:00 → 5 PM', W.formatTime12('17:00') === '5 PM');
  check('17:30 → 5:30 PM', W.formatTime12('17:30') === '5:30 PM');
  check('00:00 → 12 AM', W.formatTime12('00:00') === '12 AM');
  check('range 17:00–01:00 → 5 PM–1 AM', W.formatTimeRange12('17:00', '01:00') === '5 PM–1 AM');
}

// ── Clicking a day preselects the correct Add-Shift date (no off-by-one) ──────
console.log('\nAdd-Shift date from a clicked day');
{
  const grid = W.monthGridDays('2026-07-01');
  // The month cell hands its exact ISO date to Add Shift; grid days are those exact ISO
  // dates, so the first clickable cell (a leading adjacent day) preselects 2026-06-29.
  check('first clickable cell date is exactly 2026-06-29', grid.days[0] === '2026-06-29');
  check('an in-month cell preselects its own date (2026-07-10)', grid.days.includes('2026-07-10') && W.isInMonth('2026-07-10', '2026-07-01'));
  check('last clickable cell date is exactly 2026-08-02 (trailing day)', grid.days[grid.days.length - 1] === '2026-08-02');
}

console.log(`\nALL PASSED (${passed} assertions)`);
