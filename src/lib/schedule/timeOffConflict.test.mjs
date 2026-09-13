// Proof for the time-off ↔ schedule conflict rules.
//
// REPLACES timeOffIndex.test.mjs, which could not import what it tested: the logic lived in
// TimeOffQueue.tsx and a .tsx cannot be transpiled alone here, so that file DUPLICATED the
// functions verbatim and asserted the copy. A test of a copy passes happily while the original
// rots. timeOffConflict.ts is pure with no value imports, so this transpiles and imports the
// REAL code.
//   Run:  node src/lib/schedule/timeOffConflict.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict'; import ts from 'typescript';

const src = readFileSync(fileURLToPath(new URL('./timeOffConflict.ts', import.meta.url)), 'utf8');
const { outputText } = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const out = join(mkdtempSync(join(tmpdir(), 'toc-')), 'toc.mjs'); writeFileSync(out, outputText);
const {
  timeOffDays, indexTimeOffByDate, indexTimeOffByEmployeeDate, timeOffMarkFor, timeOffOnDate,
  timeOffCellLabel, timeOffConflictsFor, timeOffConfirmMessage, isTimeOffMark, TIME_OFF_LABEL,
} = await import(pathToFileURL(out).href);

let passed = 0;
const check = (n, c) => { assert.ok(c, `FAIL: ${n}`); console.log(`  ✓ ${n}`); passed++; };

const req = (employee_id, start_date, end_date, status) => ({ employee_id, start_date, end_date, status });
const ADRIANA = 'emp-adriana';
const BEN = 'emp-ben';
const markOf = (rows, emp, date) => timeOffMarkFor(indexTimeOffByEmployeeDate(rows), emp, date);

// ── 1/2/4. Range expansion, inclusive on BOTH ends ───────────────────────────
console.log('\nrange expansion — inclusive boundaries');
check('a one-day request yields exactly that day',
  JSON.stringify(timeOffDays(req(ADRIANA, '2026-09-26', '2026-09-26', 'pending'))) === '["2026-09-26"]');
check('Sep 26–27 covers BOTH days (the stated example)',
  JSON.stringify(timeOffDays(req(ADRIANA, '2026-09-26', '2026-09-27', 'approved'))) === '["2026-09-26","2026-09-27"]');
check('a multi-day range covers every day between',
  timeOffDays(req(ADRIANA, '2026-09-21', '2026-09-27', 'approved')).length === 7);
check('the day AFTER the end is not covered',
  markOf([req(ADRIANA, '2026-09-26', '2026-09-27', 'approved')], ADRIANA, '2026-09-28') === null);
check('the day BEFORE the start is not covered',
  markOf([req(ADRIANA, '2026-09-26', '2026-09-27', 'approved')], ADRIANA, '2026-09-25') === null);

// ── 5. Crossing a week boundary ──────────────────────────────────────────────
console.log('\nweek and month boundaries');
{
  // Sat 2026-09-26 -> Sun 2026-09-27 is a Sat/Sun pair: different weeks in a Sun-start grid.
  const rows = [req(ADRIANA, '2026-09-26', '2026-09-27', 'approved')];
  check('a Sat→Sun request marks the day in EACH week',
    markOf(rows, ADRIANA, '2026-09-26') === 'approved' && markOf(rows, ADRIANA, '2026-09-27') === 'approved');
}
{
  const rows = [req(ADRIANA, '2026-09-29', '2026-10-02', 'pending')];
  check('a request crossing a month end covers both months',
    markOf(rows, ADRIANA, '2026-09-30') === 'pending' && markOf(rows, ADRIANA, '2026-10-01') === 'pending');
}
check('crossing the Nov 2026 DST change does not drop or duplicate a day',
  timeOffDays(req(ADRIANA, '2026-10-31', '2026-11-02', 'approved')).join(',') === '2026-10-31,2026-11-01,2026-11-02');
check('crossing a year end is intact',
  timeOffDays(req(ADRIANA, '2026-12-31', '2027-01-01', 'approved')).join(',') === '2026-12-31,2027-01-01');

// ── 1/2/3. Status semantics ──────────────────────────────────────────────────
console.log('\nstatus — pending marks, approved marks, denied never does');
check('a one-day PENDING request marks the day',
  markOf([req(ADRIANA, '2026-09-26', '2026-09-26', 'pending')], ADRIANA, '2026-09-26') === 'pending');
check('a one-day APPROVED request marks the day',
  markOf([req(ADRIANA, '2026-09-26', '2026-09-26', 'approved')], ADRIANA, '2026-09-26') === 'approved');
check('a DENIED request does NOT mark the day — that person is working',
  markOf([req(ADRIANA, '2026-09-26', '2026-09-26', 'denied')], ADRIANA, '2026-09-26') === null);
check('a WITHDRAWN request does not mark the day either',
  markOf([req(ADRIANA, '2026-09-26', '2026-09-26', 'withdrawn')], ADRIANA, '2026-09-26') === null);
check('isTimeOffMark accepts only pending/approved',
  isTimeOffMark('pending') && isTimeOffMark('approved') && !isTimeOffMark('denied') && !isTimeOffMark('withdrawn'));
check('a denied request is dropped from the per-DATE index too',
  indexTimeOffByDate([req(ADRIANA, '2026-09-26', '2026-09-26', 'denied')]).size === 0);

// ── The index is PER EMPLOYEE, not just per date ─────────────────────────────
console.log('\nper-employee scoping');
{
  const rows = [req(ADRIANA, '2026-09-26', '2026-09-26', 'approved')];
  check('Adriana’s request marks Adriana', markOf(rows, ADRIANA, '2026-09-26') === 'approved');
  check('Adriana’s request does NOT mark Ben on the same day',
    markOf(rows, BEN, '2026-09-26') === null);
}

// ── 10. One employee, several separate requests in the visible week ──────────
console.log('\nmultiple requests in one week');
{
  const rows = [
    req(ADRIANA, '2026-09-21', '2026-09-21', 'approved'),
    req(ADRIANA, '2026-09-24', '2026-09-25', 'pending'),
    req(ADRIANA, '2026-09-23', '2026-09-23', 'denied'),
  ];
  const idx = indexTimeOffByEmployeeDate(rows);
  check('each request keeps its own status',
    timeOffMarkFor(idx, ADRIANA, '2026-09-21') === 'approved' &&
    timeOffMarkFor(idx, ADRIANA, '2026-09-24') === 'pending' &&
    timeOffMarkFor(idx, ADRIANA, '2026-09-25') === 'pending');
  check('the denied one leaves its day clear',
    timeOffMarkFor(idx, ADRIANA, '2026-09-23') === null);
  check('untouched days in the same week stay clear',
    timeOffMarkFor(idx, ADRIANA, '2026-09-22') === null);
}
{
  // Overlapping requests on ONE day: the stronger constraint must win, whichever order they load.
  const pendingFirst = [req(ADRIANA, '2026-09-26', '2026-09-26', 'pending'), req(ADRIANA, '2026-09-20', '2026-09-30', 'approved')];
  const approvedFirst = [req(ADRIANA, '2026-09-20', '2026-09-30', 'approved'), req(ADRIANA, '2026-09-26', '2026-09-26', 'pending')];
  check('approved beats pending when both cover a day (pending loaded first)',
    markOf(pendingFirst, ADRIANA, '2026-09-26') === 'approved');
  check('approved beats pending regardless of row order',
    markOf(approvedFirst, ADRIANA, '2026-09-26') === 'approved');
}

// ── timeOffOnDate: the single-date view used by the crew picker ──────────────
console.log('\nsingle-date view (crew picker)');
{
  const rows = [
    req(ADRIANA, '2026-09-26', '2026-09-27', 'approved'),
    req(BEN, '2026-09-27', '2026-09-27', 'pending'),
    req(BEN, '2026-09-26', '2026-09-26', 'denied'),
  ];
  const d26 = timeOffOnDate(rows, '2026-09-26');
  const d27 = timeOffOnDate(rows, '2026-09-27');
  check('Sep 26 lists only Adriana (Ben’s is denied)',
    d26.size === 1 && d26.get(ADRIANA) === 'approved');
  check('Sep 27 lists both, each with its own status',
    d27.size === 2 && d27.get(ADRIANA) === 'approved' && d27.get(BEN) === 'pending');
  check('a date outside every range lists nobody',
    timeOffOnDate(rows, '2026-09-25').size === 0);
  check('timeOffOnDate agrees with the employee/date index',
    d27.get(ADRIANA) === markOf(rows, ADRIANA, '2026-09-27'));
}

// ── 6/7. Existing shift + request: the label states BOTH facts ───────────────
console.log('\nconflict labels — a shift is never silently resolved');
check('pending, no shift', timeOffCellLabel('pending', false) === 'Time off requested');
check('approved, no shift', timeOffCellLabel('approved', false) === 'Approved time off');
check('pending + an existing shift names both',
  timeOffCellLabel('pending', true) === 'Time off requested · Shift scheduled');
check('approved + an existing shift names both (the stated example)',
  timeOffCellLabel('approved', true) === 'Approved time off · Shift scheduled');
check('the labels come from one table', TIME_OFF_LABEL.pending === 'Time off requested' && TIME_OFF_LABEL.approved === 'Approved time off');

// ── 8/9. The save-time warning ───────────────────────────────────────────────
console.log('\nsave-time conflict detection');
const WEEK = ['2026-09-20','2026-09-21','2026-09-22','2026-09-23','2026-09-24','2026-09-25','2026-09-26'];
{
  const idx = indexTimeOffByEmployeeDate([req(ADRIANA, '2026-09-26', '2026-09-27', 'approved')]);
  const hits = timeOffConflictsFor(idx, ADRIANA, WEEK);
  check('only the requested day inside the week is flagged',
    hits.length === 1 && hits[0].date === '2026-09-26' && hits[0].mark === 'approved');
  check('a week with no requests flags nothing',
    timeOffConflictsFor(idx, BEN, WEEK).length === 0);
  check('conflicts are reported in the order the dates were given',
    timeOffConflictsFor(indexTimeOffByEmployeeDate([req(ADRIANA, '2026-09-20', '2026-09-26', 'pending')]), ADRIANA, WEEK)
      .map((c) => c.date).join(',') === WEEK.join(','));
  check('a repeat week beyond the visible one is still checked',
    timeOffConflictsFor(
      indexTimeOffByEmployeeDate([req(ADRIANA, '2026-10-05', '2026-10-05', 'approved')]),
      ADRIANA, ['2026-09-28', '2026-10-05', '2026-10-12'],
    ).length === 1);
}

console.log('\nconfirmation wording');
const fmt = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' })
  .format(new Date(Date.UTC(...iso.split('-').map(Number).map((v, i) => (i === 1 ? v - 1 : v)))));
{
  const one = timeOffConfirmMessage('Adriana', [{ date: '2026-09-26', mark: 'pending' }], fmt);
  check('single pending reads as a request', one.includes('Adriana requested Sep 26 off.'));
  check('single conflict asks about ONE shift', one.trim().endsWith('Schedule this shift anyway?'));

  const appr = timeOffConfirmMessage('Adriana', [{ date: '2026-09-26', mark: 'approved' }], fmt);
  check('single approved reads as approved time off',
    appr.includes('Adriana has approved time off on Sep 26.'));

  const many = timeOffConfirmMessage('Adriana', [
    { date: '2026-09-26', mark: 'approved' }, { date: '2026-09-27', mark: 'approved' },
  ], fmt);
  check('multiple dates are listed together', many.includes('Sep 26, Sep 27'));
  check('multiple conflicts ask about SHIFTS', many.trim().endsWith('Schedule these shifts anyway?'));

  const mixed = timeOffConfirmMessage('Adriana', [
    { date: '2026-09-26', mark: 'approved' }, { date: '2026-09-28', mark: 'pending' },
  ], fmt);
  check('approved and pending are stated separately, not flattened',
    mixed.includes('has approved time off on Sep 26') && mixed.includes('requested Sep 28 off'));
  check('every wording ends by offering the override',
    mixed.trim().endsWith('Schedule these shifts anyway?'));

  const long = timeOffConfirmMessage('Adriana',
    Array.from({ length: 9 }, (_, i) => ({ date: `2026-09-${10 + i}`, mark: 'pending' })), fmt);
  check('a long list is capped so the dialog stays readable', long.includes('and 3 more'));
}

console.log('\nbad data cannot hang the builder');
check('an inverted range yields no days',
  timeOffDays(req(ADRIANA, '2026-09-27', '2026-09-26', 'pending')).length === 0);
check('an absurd range is capped rather than looping forever',
  timeOffDays(req(ADRIANA, '2026-01-01', '2030-01-01', 'approved')).length === 60);

console.log(`\n${passed} checks passed\n`);
