// Proof for the shifts-calendar day model. calendarModel.ts is pure with NO value imports, so we
// transpile it alone.  Run:  node src/lib/schedule/calendarModel.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict'; import ts from 'typescript';

const src = readFileSync(fileURLToPath(new URL('./calendarModel.ts', import.meta.url)), 'utf8');
const { outputText } = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const out = join(mkdtempSync(join(tmpdir(), 'cm-')), 'cm.mjs'); writeFileSync(out, outputText);
const {
  buildCalendarDays, punchHours, wallHours, densityLevel, isPaydayISO, formatDelta, initialsOf,
} = await import(pathToFileURL(out).href);

let passed = 0;
const check = (n, c, x = '') => { assert.ok(c, `FAIL: ${n} ${x}`); console.log(`  ✓ ${n}`); passed++; };

const EMPS = [
  { id: 'e1', name: 'Tomas Vela', role: 'fulfillment' },
  { id: 'e2', name: 'Haley', role: 'host' },
  { id: 'e3', name: 'Chris', role: 'fulfillment' },
];
const DAYS = ['2026-08-30', '2026-08-31', '2026-09-01'];
const TODAY = '2026-08-31';

const punch = (o) => ({
  id: 'p', source: 'time_clock', employee_id: 'e1', date: '2026-08-31', start_time: '05:00', end_time: '13:00',
  clock_in_at: null, clock_out_at: null, break_minutes: 0, confirmed_at: null, auto_closed: false, ...o,
});
const sched = (o) => ({ id: 's', employee_id: 'e1', date: '2026-08-31', start_time: '05:00', end_time: '13:00', origin: 'rule', ...o });
const build = (o) => buildCalendarDays({ employees: EMPS, punches: [], scheduled: [], days: DAYS, view: 'all', todayISO: TODAY, ...o });
const day = (m, d = '2026-08-31') => m.get(d);

console.log('\nhours');
check('wall clock 5a–1p = 8h', wallHours('05:00', '13:00') === 8);
check('overnight 5p–1a = 8h', wallHours('17:00', '01:00') === 8);
check('open shift = 0h', wallHours('05:00', null) === 0);
check('break subtracted', punchHours(punch({ break_minutes: 30 })) === 7.5);
check('instants beat the wall clock (26h not wrapped to 2h)',
  punchHours(punch({ start_time: '05:00', end_time: '07:00', clock_in_at: '2026-08-31T12:00:00Z', clock_out_at: '2026-09-01T14:00:00Z' })) === 26);
check('negative span floors at 0', punchHours(punch({ break_minutes: 600 })) === 0);

console.log('\nthe Tomas case — one row, not two');
{
  const m = build({ punches: [punch({ start_time: '05:04', end_time: '13:12' })], scheduled: [sched()] });
  const people = day(m).people;
  check('scheduled + punched collapse to ONE person row', people.length === 1);
  check('the punch is carried', people[0].punch != null && people[0].punch.hours === 8.13);
  check('the schedule rides alongside as context', people[0].scheduled != null && people[0].scheduled.hours === 8);
  check('delta is punch − scheduled', people[0].deltaHours === 0.13);
}

console.log('\nviews');
{
  const punches = [punch({ id: 'p1' })];
  const scheduled = [sched({ id: 's2', employee_id: 'e2' })];
  check("'clocked' shows only punchers", day(build({ punches, scheduled, view: 'clocked' })).people.map((p) => p.employee_id).join() === 'e1');
  check("'scheduled' shows only the scheduled", day(build({ punches, scheduled, view: 'scheduled' })).people.map((p) => p.employee_id).join() === 'e2');
  check("'all' shows both", day(build({ punches, scheduled, view: 'all' })).people.length === 2);
  check("'clocked' hides the schedule so no plan number sits beside pay",
    day(build({ punches: [punch()], scheduled: [sched()], view: 'clocked' })).people[0].scheduled === null);
  check('…but the delta still computes from the real pair',
    day(build({ punches: [punch({ end_time: '14:00' })], scheduled: [sched()], view: 'clocked' })).people[0].deltaHours === 1);
}

console.log('\nwasScheduled survives the Clock-ins view');
{
  const m = build({ punches: [punch()], scheduled: [sched()], view: 'clocked' });
  const p = day(m).people[0];
  check('the plan numbers are hidden', p.scheduled === null);
  check('…but we still know they WERE scheduled', p.wasScheduled === true);
  check('a punch with no schedule reads as not scheduled',
    day(build({ punches: [punch()], view: 'clocked' })).people[0].wasScheduled === false);
}

console.log('\nstates');
{
  check('unconfirmed punch → pending', day(build({ punches: [punch()] })).people[0].state === 'pending');
  check('confirmed punch → confirmed', day(build({ punches: [punch({ confirmed_at: '2026-08-31T20:00:00Z' })] })).people[0].state === 'confirmed');
  check('no clock-out → open', day(build({ punches: [punch({ end_time: null })] })).people[0].state === 'open');
  check('PAST scheduled, never punched → no_show',
    day(build({ scheduled: [sched({ date: '2026-08-30' })] }), '2026-08-30').people[0].state === 'no_show');
  check('FUTURE scheduled → scheduled, not a no-show',
    day(build({ scheduled: [sched({ date: '2026-09-01' })] }), '2026-09-01').people[0].state === 'scheduled');
  check('TODAY scheduled, not yet punched → scheduled (day is not over)',
    day(build({ scheduled: [sched()] })).people[0].state === 'scheduled');
}

console.log("\nthe plan view carries no payroll states");
{
  const punches = [punch({ employee_id: 'e1' })];                        // unconfirmed
  const scheduled = [sched({ employee_id: 'e1' }), sched({ id: 's3', employee_id: 'e3' })];
  const m = build({ punches, scheduled, view: 'scheduled' });
  const byId = Object.fromEntries(day(m).people.map((p) => [p.employee_id, p]));
  check('an unconfirmed punch is NOT yellow in the plan view', byId.e1.state === 'confirmed');
  check('no pending badge in the plan view', day(m).pendingCount === 0);
  check('…but the same punch IS pending in All', day(build({ punches, scheduled, view: 'all' })).people.find((p) => p.employee_id === 'e1').state === 'pending');
  check('scheduled today, no punch yet → still upcoming', byId.e3.state === 'scheduled');
}
{
  const m = build({ scheduled: [sched({ date: '2026-08-30' })], view: 'scheduled' });
  check('scheduled in the PAST with no punch → no_show', day(m, '2026-08-30').people[0].state === 'no_show');
}

console.log('\nmanual rows are not confirmation-gated');
{
  const m = build({ punches: [punch({ source: 'manual', confirmed_at: null })] });
  const p = day(m).people[0];
  check('a manual row is never "pending"', p.state === 'confirmed');
  check('…and offers no Confirm button', p.punch.confirmable === false);
  check('it still counts as worked', p.punch.hours === 8 && day(m).clockedCount === 1);
  check('a manual row never inflates the pending badge', day(m).pendingCount === 0);
}
check('a time_clock row IS confirmable', day(build({ punches: [punch()] })).people[0].punch.confirmable === true);

console.log('\nprecedence + counts');
{
  const m = build({ scheduled: [sched({ id: 'rule', origin: 'rule' }), sched({ id: 'inst', origin: 'instance', end_time: '15:00' })] });
  check('an instance outranks a rule', day(m).people[0].scheduled.id === 'inst' && day(m).people[0].scheduled.hours === 10);
}
{
  const m = build({
    punches: [punch({ id: 'a', employee_id: 'e1' }), punch({ id: 'b', employee_id: 'e2', confirmed_at: 'x' }), punch({ id: 'c', employee_id: 'e3', end_time: null })],
  });
  const c = day(m);
  check('headcount counts people', c.headcount === 3);
  check('pendingCount counts only unconfirmed', c.pendingCount === 1);
  check('openCount counts only still-on-the-clock', c.openCount === 1);
  check('open sorts first, pending second', c.people.map((p) => p.state).join() === 'open,pending,confirmed');
}
check('role filter narrows the cell',
  day(build({ punches: [punch({ employee_id: 'e1' }), punch({ id: 'x', employee_id: 'e2' })], roleFilter: 'host' })).people.map((p) => p.employee_id).join() === 'e2');
check('a punch outside the grid is ignored', day(build({ punches: [punch({ date: '2026-07-01' })] })).headcount === 0);

console.log('\ndisplay helpers');
check('density 0 when empty', densityLevel(0, 10) === 0);
check('density tops out at 4', densityLevel(10, 10) === 4);
check('density is relative to the busiest day', densityLevel(2, 8) === 1 && densityLevel(8, 8) === 4);
check('payday = anchor', isPaydayISO('2026-07-17', '2026-07-17'));
check('payday = anchor + 14d', isPaydayISO('2026-07-31', '2026-07-17'));
check('payday = anchor − 14d (backwards too)', isPaydayISO('2026-07-03', '2026-07-17'));
check('a non-payday is not one', !isPaydayISO('2026-07-24', '2026-07-17'));
check('formatDelta signs', formatDelta(1.2) === '+1.2h' && formatDelta(-0.5) === '−0.5h' && formatDelta(0) === 'on time');
check('formatDelta of null is empty', formatDelta(null) === '');
check('initials match the badge rule', initialsOf('Tomas Vela') === 'TV' && initialsOf('Haley') === 'HA' && initialsOf('') === '?');

console.log(`\n${passed} checks passed\n`);
