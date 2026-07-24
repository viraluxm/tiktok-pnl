// Unit tests for the weekly shift calendar logic (feat/employee-weekly-shift-calendar).
// No app test runner exists, so this transpiles weeklySchedule.ts (and employees.ts, for a
// parity check) at runtime via the repo's `typescript` devDep — their only imports are
// type-only and are erased. Mirrors employees.payperiod.test.mjs / employees.materialize.test.mjs.
//
// Run:  TZ=UTC node src/lib/employees.weekly.test.mjs

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

function loadTs(relPath) {
  const srcPath = fileURLToPath(new URL(relPath, import.meta.url));
  const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const outFile = join(mkdtempSync(join(tmpdir(), 'wk-')), `${relPath.replace(/[^a-z]/gi, '_')}.mjs`);
  writeFileSync(outFile, outputText);
  return import(pathToFileURL(outFile).href);
}

const W = await loadTs('./weeklySchedule.ts');
const { shiftHours } = await loadTs('./employees.ts');

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

// Fixtures — minimal structural shapes (only fields the pure logic reads).
const emp = (id, name, role, status = 'active') => ({ id, name, role, status });
const ALICE = emp('a', 'Alice', 'host');
const BOB = emp('b', 'Bob', 'fulfillment');
const CAROL = emp('c', 'Carol', 'manager'); // → Other
const DAVE = emp('d', 'Dave', 'host', 'former'); // excluded
const PAT = emp('p', 'Pat', 'fulfillment', 'probation');
const EMPLOYEES = [ALICE, BOB, CAROL, DAVE, PAT];

// ── Monday–Sunday week boundaries ────────────────────────────────────────────
console.log('\nWeek boundaries (Mon→Sun)');
{
  // 2026-07-01 is a Wednesday; its Monday is 2026-06-29 (asserted also by the pay-period test).
  check("mondayOfISO('2026-07-01') = 2026-06-29", W.mondayOfISO('2026-07-01') === '2026-06-29', W.mondayOfISO('2026-07-01'));
  check("mondayOfISO on a Sunday rolls back", W.mondayOfISO('2026-07-05') === '2026-06-29', W.mondayOfISO('2026-07-05'));
  check("mondayOfISO on a Monday is itself", W.mondayOfISO('2026-06-29') === '2026-06-29');
  const wr = W.weekRangeForAnchor('2026-07-01');
  check('weekRange start=Mon 06-29 end=Sun 07-05', wr.start === '2026-06-29' && wr.end === '2026-07-05', `${wr.start}..${wr.end}`);
  check('weekRange has 7 dates Mon→Sun', wr.dates.length === 7 && wr.dates[0] === '2026-06-29' && wr.dates[6] === '2026-07-05');
  check('day 0 label is Mon, day 6 is Sun', W.WEEKDAY_LABELS[0] === 'Mon' && W.WEEKDAY_LABELS[6] === 'Sun');
}

// ── Week navigation fetches the correct range ────────────────────────────────
console.log('\nWeek navigation range');
{
  const wr = W.weekRangeForAnchor('2026-07-01'); // 06-29 .. 07-05
  const prevAnchor = W.addDaysISO(wr.start, -7);
  const nextAnchor = W.addDaysISO(wr.start, 7);
  const prev = W.weekRangeForAnchor(prevAnchor);
  const next = W.weekRangeForAnchor(nextAnchor);
  check('previous week = 06-22 .. 06-28', prev.start === '2026-06-22' && prev.end === '2026-06-28', `${prev.start}..${prev.end}`);
  check('next week = 07-06 .. 07-12', next.start === '2026-07-06' && next.end === '2026-07-12', `${next.start}..${next.end}`);
  check('adjacent weeks are contiguous, no overlap', W.addDaysISO(prev.end, 1) === wr.start && W.addDaysISO(wr.end, 1) === next.start);
}

// ── Role grouping + filtering + former exclusion ─────────────────────────────
console.log('\nRole grouping / filtering / former exclusion');
{
  check("roleGroupOf('host') = host", W.roleGroupOf('host') === 'host');
  check("roleGroupOf('fulfillment') = fulfillment", W.roleGroupOf('fulfillment') === 'fulfillment');
  check("roleGroupOf('manager') = other", W.roleGroupOf('manager') === 'other');
  check("roleGroupOf('HOST') case-insensitive", W.roleGroupOf('HOST') === 'host');
  check("roleGroupOf('') = other", W.roleGroupOf('') === 'other');
  check('schedulableEmployees drops former', W.schedulableEmployees(EMPLOYEES).every((e) => e.status !== 'former'));
  check('schedulableEmployees keeps 4 of 5 (Dave dropped)', W.schedulableEmployees(EMPLOYEES).length === 4);

  const week = W.weekRangeForAnchor('2026-07-01');
  const allGroups = W.buildWeekModel({ employees: EMPLOYEES, shifts: [], generated: [], weekDates: week.dates, roleFilter: 'all' });
  const byKey = Object.fromEntries(allGroups.map((g) => [g.key, g]));
  check('all filter → host, fulfillment, other groups present', allGroups.map((g) => g.key).join(',') === 'host,fulfillment,other', allGroups.map((g) => g.key).join(','));
  check('host group = [Alice] only (Dave excluded)', byKey.host.employees.length === 1 && byKey.host.employees[0].employee.id === 'a');
  check('fulfillment group = [Bob, Pat]', byKey.fulfillment.employees.map((e) => e.employee.id).sort().join(',') === 'b,p');
  check('other group = [Carol]', byKey.other.employees.length === 1 && byKey.other.employees[0].employee.id === 'c');

  const hostOnly = W.buildWeekModel({ employees: EMPLOYEES, shifts: [], generated: [], weekDates: week.dates, roleFilter: 'host' });
  check("host filter → exactly one group (host)", hostOnly.length === 1 && hostOnly[0].key === 'host');
  const fulfilOnly = W.buildWeekModel({ employees: EMPLOYEES, shifts: [], generated: [], weekDates: week.dates, roleFilter: 'fulfillment' });
  check('fulfillment filter → only Bob + Pat', fulfilOnly[0].employees.map((e) => e.employee.id).sort().join(',') === 'b,p');
  check('probation flag detected for Pat', W.isProbation(PAT) && !W.isProbation(ALICE));
}

// ── Durations: same-day + overnight (+ parity with shiftHours) ────────────────
console.log('\nDurations & shiftHours parity');
{
  check('same-day 09:00–17:00 = 8h', W.durationHours('09:00', '17:00') === 8);
  check('same-day with seconds 09:00:00–12:30:00 = 3.5h', W.durationHours('09:00:00', '12:30:00') === 3.5);
  check('overnight 22:00–02:00 = 4h', W.durationHours('22:00', '02:00') === 4);
  check('isOvernight true for 22:00–02:00', W.isOvernight('22:00', '02:00') === true);
  check('isOvernight false for 09:00–17:00', W.isOvernight('09:00', '17:00') === false);
  check('open shift (null end) = 0h', W.durationHours('09:00', null) === 0);
  const cases = [['09:00', '17:00'], ['22:00', '02:00'], ['00:00', '23:59'], ['12:00', '12:30'], ['17:00', '03:00']];
  let parity = W.durationHours('09:00', null) === shiftHours('09:00', null);
  for (const [s, e] of cases) parity = parity && W.durationHours(s, e) === shiftHours(s, e);
  check('durationHours matches employees.shiftHours on all cases', parity);
}

// ── Multiple shifts on one day + overlap detection ───────────────────────────
console.log('\nMultiple shifts / overlap');
{
  const week = W.weekRangeForAnchor('2026-07-01'); // 06-29 .. 07-05
  const shifts = [
    { id: 's1', employee_id: 'a', date: '2026-06-29', start_time: '09:00', end_time: '12:00', source_rule_id: null },
    { id: 's2', employee_id: 'a', date: '2026-06-29', start_time: '13:00', end_time: '17:00', source_rule_id: null },
  ];
  const groups = W.buildWeekModel({ employees: [ALICE], shifts, generated: [], weekDates: week.dates, roleFilter: 'all' });
  const aliceCells = groups[0].employees[0].cells;
  const mon = aliceCells[0]; // 06-29
  check('two shifts stack in one cell', mon.cards.length === 2, `got ${mon.cards.length}`);
  check('cell cards sorted by start time', mon.cards[0].start_time === '09:00' && mon.cards[1].start_time === '13:00');
  check('non-overlapping shifts → no overlap warning', mon.hasOverlap === false);
  check('Alice weekly total = 7h (3 + 4)', groups[0].employees[0].totalHours === 7, `got ${groups[0].employees[0].totalHours}`);

  check('detectOverlap: 09–12 & 13–17 = false', W.detectOverlap(mon.cards) === false);
  const overlapping = W.buildWeekModel({
    employees: [ALICE],
    shifts: [...shifts, { id: 's3', employee_id: 'a', date: '2026-06-29', start_time: '11:00', end_time: '15:00', source_rule_id: null }],
    generated: [],
    weekDates: week.dates,
    roleFilter: 'all',
  });
  check('overlapping shift → hasOverlap true', overlapping[0].employees[0].cells[0].hasOverlap === true);
  // Overnight overlap: 22–02 overlaps 23–01 (extended-minute comparison).
  const night = [
    { id: 'n1', employee_id: 'a', date: '2026-06-30', start_time: '22:00', end_time: '02:00', source_rule_id: null },
    { id: 'n2', employee_id: 'a', date: '2026-06-30', start_time: '23:00', end_time: '01:00', source_rule_id: null },
  ];
  const nightGroups = W.buildWeekModel({ employees: [ALICE], shifts: night, generated: [], weekDates: week.dates, roleFilter: 'all' });
  check('overnight shifts overlap detected', nightGroups[0].employees[0].cells[1].hasOverlap === true);
}

// ── Materialized recurring row is NOT a deletable one-off ─────────────────────
console.log('\nMaterialized (frozen) vs one-off + generated recurring');
{
  const week = W.weekRangeForAnchor('2026-07-01');
  const shifts = [
    { id: 'plain', employee_id: 'a', date: '2026-06-29', start_time: '09:00', end_time: '17:00', source_rule_id: null },
    { id: 'frozen', employee_id: 'a', date: '2026-06-30', start_time: '09:00', end_time: '13:00', source_rule_id: 'rule-1' },
  ];
  const generated = [
    { id: 'rule-1:2026-07-01', rule_id: 'rule-1', employee_id: 'a', date: '2026-07-01', start_time: '09:00', end_time: '17:00', modified: false, skipped: false },
    { id: 'rule-1:2026-07-02', rule_id: 'rule-1', employee_id: 'a', date: '2026-07-02', start_time: '09:00', end_time: '17:00', modified: false, skipped: true },
  ];
  const groups = W.buildWeekModel({ employees: [ALICE], shifts, generated, weekDates: week.dates, roleFilter: 'all' });
  const cells = groups[0].employees[0].cells;
  const plainCard = cells[0].cards[0]; // 06-29
  const frozenCard = cells[1].cards[0]; // 06-30
  const genCard = cells[2].cards[0]; // 07-01
  check('plain one-off → kind oneoff, not frozen', plainCard.kind === 'oneoff' && plainCard.isFrozen === false);
  check('materialized row → kind recurring + isFrozen (never a deletable one-off)', frozenCard.kind === 'recurring' && frozenCard.isFrozen === true);
  check('generated occurrence → kind recurring, not frozen', genCard.kind === 'recurring' && genCard.isFrozen === false);
  check('skipped generated occurrence is dropped from the grid', cells[3].cards.length === 0);
}

// ── Duplicate-shift prefilling ────────────────────────────────────────────────
console.log('\nDuplicate prefill');
{
  const card = { employee_id: 'a', start_time: '09:00:00', end_time: '17:00:00', extra: 'ignored' };
  const pre = W.duplicatePrefill(card);
  check('duplicatePrefill keeps employee + hours', pre.employee_id === 'a' && pre.start_time === '09:00:00' && pre.end_time === '17:00:00');
  check('duplicatePrefill drops non-shift fields', !('extra' in pre));
  const openCard = { employee_id: 'b', start_time: '10:00', end_time: null };
  check('duplicatePrefill preserves null end (open)', W.duplicatePrefill(openCard).end_time === null);
}

// ── validateShiftTimes (editor) ───────────────────────────────────────────────
console.log('\nvalidateShiftTimes');
{
  const ok = W.validateShiftTimes('09:00', '17:00', {});
  check('09:00–17:00 valid, 8h, not overnight/long', ok.ok && ok.hours === 8 && !ok.overnight && !ok.longWarning);
  const same = W.validateShiftTimes('09:00', '09:00', {});
  check('start == end is rejected', same.ok === false && /same/i.test(same.error));
  const night = W.validateShiftTimes('17:00', '03:00', {});
  check('end < start valid + flagged overnight (10h)', night.ok && night.overnight && night.hours === 10);
  const long = W.validateShiftTimes('06:00', '23:00', {});
  check('17h shift valid but longWarning (not blocked)', long.ok && long.longWarning && long.hours === 17);
  const open = W.validateShiftTimes('09:00', null, { open: true });
  check('open shift valid with only a start', open.ok && open.error === null);
  const openNoStart = W.validateShiftTimes('', null, { open: true });
  check('open shift without start is rejected', openNoStart.ok === false);
  const missing = W.validateShiftTimes('09:00', '', {});
  check('missing end is rejected', missing.ok === false);
}

// ── 12-hour AM/PM display formatting ─────────────────────────────────────────
console.log('\n12-hour time formatting');
{
  check('00:00 → 12 AM', W.formatTime12('00:00') === '12 AM', W.formatTime12('00:00'));
  check('05:00 → 5 AM', W.formatTime12('05:00') === '5 AM', W.formatTime12('05:00'));
  check('12:00 → 12 PM', W.formatTime12('12:00') === '12 PM', W.formatTime12('12:00'));
  check('17:00 → 5 PM', W.formatTime12('17:00') === '5 PM', W.formatTime12('17:00'));
  check('17:30 → 5:30 PM', W.formatTime12('17:30') === '5:30 PM', W.formatTime12('17:30'));
  check('00:40 → 12:40 AM', W.formatTime12('00:40') === '12:40 AM', W.formatTime12('00:40'));
  check('handles HH:MM:SS (06:00:00 → 6 AM)', W.formatTime12('06:00:00') === '6 AM', W.formatTime12('06:00:00'));
  check('minutes kept, no leading zero on hour (09:05 → 9:05 AM)', W.formatTime12('09:05') === '9:05 AM', W.formatTime12('09:05'));

  // Ranges (examples from the spec).
  check('range 17:00–01:00 → 5 PM–1 AM', W.formatTimeRange12('17:00', '01:00') === '5 PM–1 AM', W.formatTimeRange12('17:00', '01:00'));
  check('range 06:00–14:00 → 6 AM–2 PM', W.formatTimeRange12('06:00', '14:00') === '6 AM–2 PM', W.formatTimeRange12('06:00', '14:00'));
  check('range 17:00–00:40 → 5 PM–12:40 AM', W.formatTimeRange12('17:00', '00:40') === '5 PM–12:40 AM', W.formatTimeRange12('17:00', '00:40'));
  check('open range (null end) → "5 PM–open"', W.formatTimeRange12('17:00', null) === '5 PM–open', W.formatTimeRange12('17:00', null));

  // Overnight display + correct duration are independent concerns; both hold.
  check('overnight 17:00→01:00 displays as 5 PM–1 AM AND is still 8h',
    W.formatTimeRange12('17:00', '01:00') === '5 PM–1 AM' && W.durationHours('17:00', '01:00') === 8);
  check('overnight is flagged', W.isOvernight('17:00', '01:00') === true);
  // "· Ends <weekday>": 2026-06-29 is a Monday, so a shift that night ends Tuesday.
  check("nextDayWeekday('2026-06-29') = Tuesday", W.nextDayWeekday('2026-06-29') === 'Tuesday', W.nextDayWeekday('2026-06-29'));
  check('nextDayWeekday("") is empty (no crash on missing date)', W.nextDayWeekday('') === '');
}

console.log(`\nALL PASSED (${passed} assertions)`);
