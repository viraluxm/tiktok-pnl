// ADD WORKED TIME — the client half: which tiles offer the action, what the form opens at, what
// the manager is told when the server refuses, and that the break rule is literally the SAME code
// the merged break editor uses.
//
// Exercises the REAL canAddWorkedTimeAt/scheduledEndInstant/workedTimePrefill/
// manualWorkedErrorMessage (shifts/manualWorked.ts), the REAL buildCalendarDays
// (schedule/calendarModel.ts) and the REAL break helpers (shifts/punchEdit.ts), all transpiled at
// runtime — nothing is reimplemented here.
//
// ELIGIBILITY IS TIME-BASED, not day-based, so every case below pins an explicit `now`. A
// day-granular rule cannot express "the shift ended two hours ago" and made a same-day miss wait
// until midnight; the instant comparison is what the assertions in §1 actually check.
//
// NOT COVERED HERE, deliberately: the repo has no React test renderer (no jsdom, no
// @testing-library), so "the button renders" and "the field is editable" are not assertable in
// this suite. What IS assertable is the pure rule behind the button and the exact prefill the
// container hands the modal — the same split canRemoveScheduled already uses. The server-side
// guarantees (overlap, races, source='manual', untouched punch tables) are proved against a real
// Postgres in supabase/tests/manual_worked/.
//
// Run:  TZ=UTC node src/lib/shifts/manualWorked.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'manualworked-'));
function transpile(srcRel, outName, rewrites = {}) {
  const srcPath = fileURLToPath(new URL(srcRel, import.meta.url));
  let { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  for (const [from, to] of Object.entries(rewrites)) outputText = outputText.split(from).join(to);
  const outFile = join(dir, outName);
  writeFileSync(outFile, outputText);
  return pathToFileURL(outFile).href;
}

const tzUrl = transpile('../schedule/timezone.ts', 'timezone.mjs');
const weeklyUrl = transpile('../weeklySchedule.ts', 'weeklySchedule.mjs');
const punchUrl = transpile('./punchEdit.ts', 'punchEdit.mjs', {
  "'@/lib/schedule/timezone'": `'${tzUrl}'`,
  "'@/lib/weeklySchedule'": `'${weeklyUrl}'`,
});
const manualUrl = transpile('./manualWorked.ts', 'manualWorked.mjs', {
  "'./punchEdit'": `'${punchUrl}'`,
  "'@/lib/schedule/timezone'": `'${tzUrl}'`,
});
// calendarModel takes the canonical payroll duration from '@/lib/employees' (migration 137).
const employeesUrl = transpile('../employees.ts', 'employees.mjs');
const calUrl = transpile('../schedule/calendarModel.ts', 'calendarModel.mjs', {
  "'@/lib/employees'": `'${employeesUrl}'`,
});

const {
  workedTimePrefill, manualWorkedErrorMessage, canAddWorkedTimeAt, scheduledEndInstant,
  WORKED_TIME_OVERLAP_MESSAGE, OPEN_SHIFT_MESSAGE, EMPLOYEE_NOT_FOUND_MESSAGE,
  GENERIC_CREATE_FAILED_MESSAGE, OPEN_PUNCH_CONFLICT_MESSAGE, UNRECONCILED_PUNCH_MESSAGE,
} = await import(manualUrl);
const {
  assertBreakShape, assertBreakFitsSpan, wallClockSpanMinutes,
  buildShiftEditPatch, BREAK_INVALID_ERROR, BREAK_TOO_LONG_ERROR,
} = await import(punchUrl);
const { buildCalendarDays, canRemoveScheduled } = await import(calUrl);

let passed = 0;
const check = (n, c, x = '') => { assert.ok(c, `FAIL: ${n} ${x}`); console.log(`  ✓ ${n}`); passed++; };
const threw = (fn, msg) => {
  try { fn(); return false; } catch (e) { return e.message === msg; }
};

// ── fixtures ─────────────────────────────────────────────────────────────────
const EMPS = [{ id: 'e1', name: 'Elizabeth', role: 'host' }];
const TODAY = '2026-09-10';
const PAST = '2026-09-06';   // strictly before TODAY → a no-show if unworked
const FUTURE = '2026-09-12';
const DAYS = [PAST, TODAY, FUTURE];

const sched = (date, o = {}) => ({
  id: `i:${date}`, employee_id: 'e1', date,
  start_time: '17:00', end_time: '01:00', origin: 'instance', source: 'admin_open', ...o,
});
const punch = (date, o = {}) => ({
  id: `p:${date}`, source: 'time_clock', employee_id: 'e1', date,
  start_time: '17:04', end_time: '01:12', clock_in_at: null, clock_out_at: null,
  break_minutes: 0, confirmed_at: null, auto_closed: false, ...o,
});

const personOn = (date, { punches = [], scheduled = [] }) =>
  buildCalendarDays({
    employees: EMPS, punches, scheduled, days: DAYS, view: 'all', todayISO: TODAY,
  }).get(date).people[0];

console.log('\n§1 — which tiles offer Add Worked Time (TIME-based eligibility)');

// The scheduled span in every fixture is 17:00 → 01:00 LA, i.e. OVERNIGHT: it ends at 01:00 on the
// FOLLOWING calendar day. That is deliberate — an overnight span is where a day-granular rule and
// an instant-based one disagree most loudly.
const at = (iso) => new Date(iso);
const endOf = (date) => scheduledEndInstant(date, { start_time: '17:00', end_time: '01:00' });

// The end instant itself: 17:00→01:00 on Sep 6 must end 01:00 on Sep 7 LA (08:00Z, PDT = UTC-7).
check('overnight span ends on the NEXT day', endOf('2026-09-06').toISOString() === '2026-09-07T08:00:00.000Z',
  endOf('2026-09-06').toISOString());
check('a same-day span ends on its own day',
  scheduledEndInstant('2026-09-06', { start_time: '06:00', end_time: '14:00' }).toISOString() === '2026-09-06T21:00:00.000Z');

// 1. PAST scheduled day, no punch → offered.
const noShow = personOn(PAST, { scheduled: [sched(PAST)] });
check('past scheduled day with no punch classifies as no_show', noShow.state === 'no_show', noShow.state);
check('1. PAST no-show offers Add Worked Time', canAddWorkedTimeAt(noShow, PAST, at('2026-09-10T12:00:00Z')) === true);

// 2. TODAY, scheduled period FULLY ENDED → offered. This is the case a day-granular rule missed.
const todayPerson = personOn(TODAY, { scheduled: [sched(TODAY)] });
check('2. TODAY + shift already ended offers it',
  canAddWorkedTimeAt(todayPerson, TODAY, at('2026-09-11T09:00:00Z')) === true);   // 02:00 LA next day

// 3. TODAY, still in progress → HIDDEN.
check('3. TODAY + shift still in progress hides it (mid-shift)',
  canAddWorkedTimeAt(todayPerson, TODAY, at('2026-09-11T05:00:00Z')) === false);  // 22:00 LA, ends 01:00
check('3b. TODAY + shift not started yet hides it',
  canAddWorkedTimeAt(todayPerson, TODAY, at('2026-09-10T20:00:00Z')) === false);  // 13:00 LA, starts 17:00
check('3c. one minute BEFORE the end still hides it',
  canAddWorkedTimeAt(todayPerson, TODAY, new Date(endOf(TODAY).getTime() - 60_000)) === false);
check('3d. exactly AT the end instant offers it (eligible the moment it ends)',
  canAddWorkedTimeAt(todayPerson, TODAY, endOf(TODAY)) === true);

// 4. FUTURE → HIDDEN.
check('4. FUTURE scheduled day hides it',
  canAddWorkedTimeAt(personOn(FUTURE, { scheduled: [sched(FUTURE)] }), FUTURE, at('2026-09-10T12:00:00Z')) === false);

// 5. The overnight example from the spec, verbatim: Sep 6 16:00 → Sep 7 02:00.
{
  const ov = { punch: null, scheduled: { start_time: '16:00', end_time: '02:00' } };
  check('5. overnight: Sep 6 22:00 LA → HIDDEN (still running)',
    canAddWorkedTimeAt(ov, '2026-09-06', at('2026-09-07T05:00:00Z')) === false);
  check('5b. overnight: Sep 7 01:00 LA → HIDDEN (one hour left)',
    canAddWorkedTimeAt(ov, '2026-09-06', at('2026-09-07T08:00:00Z')) === false);
  check('5c. overnight: Sep 7 03:00 LA → SHOWN (period over)',
    canAddWorkedTimeAt(ov, '2026-09-06', at('2026-09-07T10:00:00Z')) === true);
}

// A worked record of ANY source suppresses it — the duplicate-pay affordance guard.
const AFTER = at('2026-09-12T12:00:00Z');
const worked = personOn(PAST, { scheduled: [sched(PAST)], punches: [punch(PAST)] });
check('tile with a punch does NOT offer Add Worked Time', canAddWorkedTimeAt(worked, PAST, AFTER) === false);
check('… including a MANUAL worked row (equally payable)',
  canAddWorkedTimeAt(personOn(PAST, { scheduled: [sched(PAST)], punches: [punch(PAST, { source: 'manual' })] }), PAST, AFTER) === false);
check('… including an OPEN punch (still on the clock)',
  canAddWorkedTimeAt(personOn(PAST, { scheduled: [sched(PAST)], punches: [punch(PAST, { end_time: null })] }), PAST, AFTER) === false);
check('… including an UNCONFIRMED punch',
  canAddWorkedTimeAt(personOn(PAST, { scheduled: [sched(PAST)], punches: [punch(PAST, { confirmed_at: null })] }), PAST, AFTER) === false);
check('no scheduled span at all → not offered',
  canAddWorkedTimeAt({ punch: null, scheduled: null }, PAST, AFTER) === false);

// THE TWO ACTIONS OVERLAP AT THE RULE LEVEL NOW — and that is why the component has explicit
// precedence. canRemoveScheduled is DAY-granular ('scheduled' covers anything today or later), so
// a shift TODAY whose period has already ended satisfies BOTH predicates. Asserting a mutual
// exclusion here would be asserting something false; what must hold is that the TILE never offers
// both, which is a PersonCard concern.
{
  const endedToday = personOn(TODAY, { scheduled: [sched(TODAY)] });
  const afterEnd = endOf(TODAY);
  const bothRulesTrue =
    canAddWorkedTimeAt(endedToday, TODAY, afterEnd) === true && canRemoveScheduled(endedToday) === true;
  check('an ended same-day shift satisfies BOTH rules (hence the need for precedence)', bothRulesTrue);

  // SOURCE GUARD: the component must withdraw Remove when Add Worked Time is offered. Comments are
  // stripped first — this file explains the precedence at length, and matching the explanation
  // instead of the code would leave the guard permanently green.
  const cardRaw = readFileSync(fileURLToPath(new URL('../../components/employees/weekly/PersonCard.tsx', import.meta.url)), 'utf8');
  const card = cardRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  check('PersonCard withdraws Remove Shift when Add Worked Time is offered',
    /canRemoveScheduled\(person\)\s*&&\s*!canAddWorked/.test(card));
  check('PersonCard uses the TIME-aware rule, not the retired day-granular one',
    card.includes('canAddWorkedTimeAt(person, dateISO)') && !/\bcanAddWorkedTime\(/.test(card));
  check('PersonCard refuses the affordance without a dateISO',
    /!!dateISO\s*&&\s*canAddWorkedTimeAt/.test(card));
}

// And a FUTURE plan still offers only Remove, never Add — the fence that matters most.
{
  const future = personOn(FUTURE, { scheduled: [sched(FUTURE)] });
  check('a FUTURE plan offers Remove but NEVER Add Worked Time',
    canRemoveScheduled(future) === true &&
    canAddWorkedTimeAt(future, FUTURE, at('2026-09-10T12:00:00Z')) === false);
}

console.log('\n§2 — what the form opens at (prefill)');

// 3+4. employee / date / start / end come from the tile and its scheduled span.
const pre = workedTimePrefill(noShow, PAST);
check('prefills the employee from the card', JSON.stringify(pre.employeeIds) === '["e1"]');
check('prefills the selected day', pre.date === PAST);
check('prefills start from the scheduled span', pre.start === '17:00', pre.start);
check('prefills end from the scheduled span', pre.end === '01:00', pre.end);
// 6. break starts at zero — nothing was observed, and inventing one is a fabrication.
check('prefills break = 0', pre.breakMinutes === 0);

// 'HH:MM:SS' from Postgres must reach an <input type="time"> as 'HH:MM'.
const secs = workedTimePrefill(
  { employee_id: 'e1', scheduled: { start_time: '06:00:00', end_time: '14:30:00' } }, PAST);
check('trims HH:MM:SS to HH:MM for the time input', secs.start === '06:00' && secs.end === '14:30');
check('no scheduled span → null prefill rather than a half-filled form',
  workedTimePrefill({ employee_id: 'e1', scheduled: null }, PAST) === null);

// 5. The prefill is a SEED, not a record: it carries no identity of the scheduled row, so nothing
//    downstream can mistake it for the plan or write back to it.
check('prefill carries no shift_instance id', !('id' in pre) && !('instanceId' in pre));

console.log('\n§3 — the break rule is shared, not re-implemented');

// 17. break = 0 is valid.
check('break 0 is valid', !threw(() => assertBreakShape(0), BREAK_INVALID_ERROR));
// 19-adjacent: shape rejections.
check('negative break rejected', threw(() => assertBreakShape(-1), BREAK_INVALID_ERROR));
check('fractional break rejected', threw(() => assertBreakShape(30.5), BREAK_INVALID_ERROR));
check('NaN break rejected', threw(() => assertBreakShape(Number('abc')), BREAK_INVALID_ERROR));

// 19. break >= span rejected, against the SAME span rule pay uses.
check('8h shift: 480m break rejected (equal to span pays zero)',
  threw(() => assertBreakFitsSpan(480, wallClockSpanMinutes('06:00', '14:00')), BREAK_TOO_LONG_ERROR));
check('8h shift: 481m break rejected', threw(() => assertBreakFitsSpan(481, 480), BREAK_TOO_LONG_ERROR));
check('8h shift: 30m break accepted', !threw(() => assertBreakFitsSpan(30, 480), BREAK_TOO_LONG_ERROR));
check('open shift has no upper bound to check', !threw(() => assertBreakFitsSpan(999, null), BREAK_TOO_LONG_ERROR));

// The overnight wrap is the shared one — 17:00→01:00 is 8h, not a negative.
check('overnight span wraps (17:00→01:00 = 480m)', wallClockSpanMinutes('17:00', '01:00') === 480);
check('same start/end reads as a full day (24h)', wallClockSpanMinutes('06:00', '06:00') === 1440);
check('open shift span is null', wallClockSpanMinutes('06:00', null) === null);

// PARITY: the merged break editor must still enforce exactly this, through the same helpers.
const editRow = { source: 'manual', date: PAST, start_time: '06:00', end_time: '14:00', break_minutes: 0 };
check('edit path still rejects an over-long break (unchanged behaviour)',
  threw(() => buildShiftEditPatch(editRow, { break_minutes: 480 }), BREAK_TOO_LONG_ERROR));
check('edit path still rejects a fractional break', threw(() => buildShiftEditPatch(editRow, { break_minutes: 1.5 }), BREAK_INVALID_ERROR));
check('edit path still accepts a valid break', JSON.stringify(buildShiftEditPatch(editRow, { break_minutes: 30 })) === '{"break_minutes":30}');
// The no-op guard must survive the refactor: an unchanged break writes nothing at all.
check('edit path still treats an unchanged break as a no-op', buildShiftEditPatch(editRow, { break_minutes: 0 }) === null);

console.log('\n§4 — refusals reach the manager as sentences, never as Postgres');

// 12. the required message, mapped from the RPC's stable token.
check('overlap token → the required sentence',
  manualWorkedErrorMessage({ code: '23P01', message: 'WORKED_TIME_OVERLAP' }) === WORKED_TIME_OVERLAP_MESSAGE);
check('… and the sentence is the one specified',
  WORKED_TIME_OVERLAP_MESSAGE ===
  'Worked time already exists for this employee during that period. Edit the existing shift instead.');
check('overlap recognised from the SQLSTATE alone',
  manualWorkedErrorMessage({ code: '23P01', message: 'some wrapper text' }) === WORKED_TIME_OVERLAP_MESSAGE);
check('break-too-long token → the shared break message',
  manualWorkedErrorMessage({ code: '22023', message: 'BREAK_TOO_LONG' }) === BREAK_TOO_LONG_ERROR);
check('break-invalid token → the shared break message',
  manualWorkedErrorMessage({ code: '22023', message: 'BREAK_INVALID' }) === BREAK_INVALID_ERROR);
check('employee token → its own sentence',
  manualWorkedErrorMessage({ code: '42501', message: 'EMPLOYEE_NOT_FOUND' }) === EMPLOYEE_NOT_FOUND_MESSAGE);

// RAW-PUNCH refusals are a different problem from an existing shift overlapping, and the remedy is
// different too, so each gets its own sentence naming the next action.
check('open-punch token → its own sentence',
  manualWorkedErrorMessage({ message: 'OPEN_PUNCH_CONFLICT', code: '23P01' }) === OPEN_PUNCH_CONFLICT_MESSAGE);
check('… and it tells the manager to clock them out first',
  /clock(ed)? them out/i.test(OPEN_PUNCH_CONFLICT_MESSAGE));
check('unreconciled-punch token → its own sentence',
  manualWorkedErrorMessage({ message: 'UNRECONCILED_PUNCH_OVERLAP', code: '23P01' }) === UNRECONCILED_PUNCH_MESSAGE);
check('… and it explains it would pay twice',
  /pay twice/i.test(UNRECONCILED_PUNCH_MESSAGE));
check('the three 23P01 refusals are DISTINCT sentences',
  new Set([WORKED_TIME_OVERLAP_MESSAGE, OPEN_PUNCH_CONFLICT_MESSAGE, UNRECONCILED_PUNCH_MESSAGE]).size === 3);
check('open-shift unique violation keeps its existing wording',
  manualWorkedErrorMessage({ code: '23505', message: 'duplicate key value violates unique constraint' }) === OPEN_SHIFT_MESSAGE);

// The anti-leak property: anything unrecognised must NOT surface raw database text.
const raw = 'null value in column "employee_id" of relation "shifts" violates not-null constraint';
const mapped = manualWorkedErrorMessage({ code: '23502', message: raw });
check('unrecognised error falls back to a generic sentence', mapped === GENERIC_CREATE_FAILED_MESSAGE);
check('… and leaks no Postgres text', !mapped.includes('relation') && !mapped.includes('constraint'));
check('empty error object is still safe', manualWorkedErrorMessage({}) === GENERIC_CREATE_FAILED_MESSAGE);

console.log(`\n${passed} checks passed\n`);
