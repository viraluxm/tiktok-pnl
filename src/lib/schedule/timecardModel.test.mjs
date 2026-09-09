// timecardModel: the employee's read-only timecard, derived from real `shifts` rows the way
// payroll reads them.
//
// THE RULE THIS FILE PROTECTS: the hours shown are paidShiftHours over isPayableShift rows —
// REUSED, not re-derived. Scheduled (plan) rows never appear; unconfirmed punches are shown but
// counted separately; overnight punches book to the evening they started; nothing is capped or
// invented.
//
// Run:  TZ=UTC node src/lib/schedule/timecardModel.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'timecard-'));
const write = (n, s) => { const p = join(dir, n); writeFileSync(p, s); return pathToFileURL(p).href; };
function transpile(rel, out, rw = {}) {
  const sp = fileURLToPath(new URL(rel, import.meta.url));
  let { outputText } = ts.transpileModule(readFileSync(sp, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  for (const [f, t] of Object.entries(rw)) outputText = outputText.split(f).join(t);
  return write(out, outputText);
}
const timezone = transpile('./timezone.ts', 'timezone.mjs');
const employees = transpile('../employees.ts', 'employees.mjs');
const labor = transpile('../labor.ts', 'labor.mjs', { "'@/lib/employees'": `'${employees}'` });
const T = await import(transpile('./timecardModel.ts', 'timecardModel.mjs', {
  "'@/lib/employees'": `'${employees}'`, "'@/lib/labor'": `'${labor}'`, "'./timezone'": `'${timezone}'`,
}));
const E = await import(employees);

let passed = 0;
const check = (n, c, e = '') => { assert.ok(c, `FAIL: ${n} ${e}`); console.log(`  ✓ ${n}${e ? ` — ${e}` : ''}`); passed++; };
const eq = (n, a, b) => check(n, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} == ${JSON.stringify(b)}`);

const ME = 'emp-me';
const row = (o = {}) => ({
  id: 'r1', employee_id: ME, date: '2026-09-07', start_time: '06:00:00', end_time: '14:00:00',
  source: 'time_clock', source_rule_id: null, confirmed_at: '2026-09-07T22:00:00Z', break_minutes: 0,
  clock_in_at: '2026-09-07T05:58:00-07:00', clock_out_at: '2026-09-07T14:04:00-07:00', auto_closed: false, ...o,
});
const WEEK = { start: '2026-09-07', end: '2026-09-13' };
const PERIOD = { start: '2026-08-31', end: '2026-09-13' };
const TODAY = '2026-09-08';

console.log('\n1. ENTRY MAPPING — a normal same-day confirmed punch');
{
  const e = T.toTimecardEntry(row());
  eq('books to its clock-in LA date', e.date, '2026-09-07');
  eq('clock in/out are the canonical instants', [e.clock_in, e.clock_out], ['2026-09-07T05:58:00-07:00', '2026-09-07T14:04:00-07:00']);
  eq('hours = paidShiftHours (8h06m = 8.1)', e.hours, E.paidShiftHours(row()));
  eq('…which is 8.1', Math.round(e.hours * 100) / 100, 8.1);
  eq('payable, complete', [e.payable, e.state, e.source], [true, 'complete', 'time_clock']);
}

console.log('\n2. OVERNIGHT — books to the evening it started; instants keep both dates');
{
  const e = T.toTimecardEntry(row({ id: 'r2', date: '2026-09-08', start_time: '18:02:00', end_time: '02:07:00',
    clock_in_at: '2026-09-08T18:02:00-07:00', clock_out_at: '2026-09-09T02:07:00-07:00' }));
  eq('date = Tue (clock-in day)', e.date, '2026-09-08');
  eq('clock_out is Wednesday 2:07 AM PDT', new Date(e.clock_out).toISOString(), '2026-09-09T09:07:00.000Z');
  eq('8h 05m', Math.round(e.hours * 60), 485);
}

console.log('\n3. WHAT IS NOT WORKED TIME');
{
  eq('materialized PLAN row (source_rule_id) is dropped', T.toTimecardEntry(row({ source_rule_id: 'rule-1', source: 'manual', clock_in_at: null, clock_out_at: null })), null);
  const u = T.toTimecardEntry(row({ id: 'u', confirmed_at: null }));
  eq('unconfirmed punch is SHOWN…', u.state, 'awaiting_confirmation');
  eq('…but not payable', u.payable, false);
  eq('…and still carries its real duration (no capping)', Math.round(u.hours * 100) / 100, 8.1);
  const a = T.toTimecardEntry(row({ id: 'a', auto_closed: true, clock_out_at: '2026-09-08T02:00:00-07:00' }));
  eq('auto-closed 20h punch keeps its 20h (never trimmed to look nice)', Math.round(a.hours * 100) / 100, 20.03);
  eq('auto-closed state', a.state, 'auto_closed');
}

console.log('\n4. MANUAL CORRECTIONS — wall clock → instants through the DST-safe converter');
{
  const m = T.toTimecardEntry(row({ id: 'm', source: 'manual', confirmed_at: null, clock_in_at: null, clock_out_at: null,
    date: '2026-09-09', start_time: '16:00', end_time: '01:00', break_minutes: 30 }));
  eq('manual row is payable regardless of confirmation', m.payable, true);
  eq('instants derived: 4 PM Wed → 1 AM Thu PDT', [new Date(m.clock_in).toISOString(), new Date(m.clock_out).toISOString()],
    ['2026-09-09T23:00:00.000Z', '2026-09-10T08:00:00.000Z']);
  eq('9h span − 30m break = 8.5 (paidShiftHours)', m.hours, 8.5);
  eq('break carried', m.break_minutes, 30);
  const open = T.toTimecardEntry(row({ id: 'o', source: 'manual', end_time: null, clock_in_at: null, clock_out_at: null }));
  eq('open manual shift → in progress, 0 hours, not payable', [open.state, open.hours, open.payable, open.clock_out], ['in_progress', 0, false, null]);
}

console.log('\n5. WINDOWS — week vs pay period, worked vs pending, day grouping');
{
  const rows = [
    row({ id: 'w1', date: '2026-09-07', clock_in_at: '2026-09-07T05:58:00-07:00', clock_out_at: '2026-09-07T14:00:00-07:00' }), // Mon, 8.03h
    row({ id: 'w2', date: '2026-09-08', clock_in_at: '2026-09-08T18:00:00-07:00', clock_out_at: '2026-09-09T02:00:00-07:00' }), // Tue night, 8h
    row({ id: 'w3', date: '2026-09-09', confirmed_at: null, clock_in_at: '2026-09-09T18:00:00-07:00', clock_out_at: '2026-09-10T02:00:00-07:00' }), // Wed, unconfirmed 8h
    row({ id: 'p1', date: '2026-09-02', clock_in_at: '2026-09-02T06:00:00-07:00', clock_out_at: '2026-09-02T14:00:00-07:00' }), // last week (in period), 8h
    row({ id: 'x1', date: '2026-08-30', clock_in_at: '2026-08-30T06:00:00-07:00', clock_out_at: '2026-08-30T14:00:00-07:00' }), // before period
    row({ id: 'plan', date: '2026-09-10', source: 'manual', source_rule_id: 'rule', clock_in_at: null, clock_out_at: null }),   // plan, dropped
    // two punches on one day (split shift) — must be one day with two entries
    row({ id: 's1', date: '2026-09-11', clock_in_at: '2026-09-11T06:00:00-07:00', clock_out_at: '2026-09-11T10:00:00-07:00' }),
    row({ id: 's2', date: '2026-09-11', clock_in_at: '2026-09-11T12:00:00-07:00', clock_out_at: '2026-09-11T16:00:00-07:00' }),
  ];
  const tc = T.buildTimecard({ shifts: rows, open: { clocked_in_at: '2026-09-12T17:58:00-07:00', on_break: false, needs_manual_close: false }, todayISO: TODAY, week: WEEK, period: PERIOD });
  eq('week worked = 8.03 + 8 + 4 + 4 (unconfirmed excluded)', tc.week.workedHours, 24.03);
  eq('week pending = the unconfirmed 8', tc.week.pendingHours, 8);
  eq('period worked adds last week\'s 8, excludes Aug 30', tc.period.workedHours, 32.03);
  eq('period pending = 8', tc.period.pendingHours, 8);
  eq('week days newest first', tc.week.days.map((d) => d.date), ['2026-09-11', '2026-09-09', '2026-09-08', '2026-09-07']);
  eq('split shift = one day, two entries in clock-in order', tc.week.days[0].entries.map((e) => e.id), ['s1', 's2']);
  eq('day hours are payable only (Wed = 0)', tc.week.days.find((d) => d.date === '2026-09-09').hours, 0);
  eq('plan row never appears', tc.period.days.some((d) => d.entries.some((e) => e.id === 'plan')), false);
  eq('open punch surfaced, not counted', [tc.open.clockedInAt, tc.week.workedHours], ['2026-09-12T17:58:00-07:00', 24.03]);
  eq('read range covers both windows ±1 day', T.timecardReadRange(WEEK, PERIOD), { from: '2026-08-30', to: '2026-09-14' });
}

console.log('\n6. PAY-PERIOD BOUNDARY — a punch on the period\'s first day counts; the day before does not');
{
  const rows = [
    row({ id: 'b0', date: '2026-08-30', clock_in_at: '2026-08-30T22:00:00-07:00', clock_out_at: '2026-08-31T06:00:00-07:00' }), // Sun night → books to Aug 30 (before period)
    row({ id: 'b1', date: '2026-08-31', clock_in_at: '2026-08-31T06:00:00-07:00', clock_out_at: '2026-08-31T14:00:00-07:00' }), // Mon (first day)
  ];
  const tc = T.buildTimecard({ shifts: rows, open: null, todayISO: TODAY, week: WEEK, period: PERIOD });
  eq('only the Monday punch is in the period', tc.period.days.map((d) => d.date), ['2026-08-31']);
  eq('period worked = 8', tc.period.workedHours, 8);
  eq('this week has nothing', tc.week.days, []);
  eq('no open punch → null', tc.open, null);
}

console.log(`\n${passed} checks passed`);
