// APPROVED HOURS (migration 139) — the manager-confirmed payable duration, kept separate from the
// attendance punch.
//
// THE RULE THIS FILE EXISTS TO PROTECT, in one sentence: payroll pays approved_minutes when a
// manager set one, the punch is never rewritten to move that number, and every shift that existed
// before this feature keeps the exact figure it had.
//
// Exercises the REAL employees.ts, approvedHours.ts, timecardModel.ts and calendarModel.ts,
// transpiled at runtime, plus greps over the real migration and the real routes for the invariants
// no unit test can express.
//
// Run:  TZ=UTC node src/lib/employees.approvedHours.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'approved-'));
const write = (n, s) => { const p = join(dir, n); writeFileSync(p, s); return pathToFileURL(p).href; };
function transpile(rel, out, rw = {}) {
  const sp = fileURLToPath(new URL(rel, import.meta.url));
  let { outputText } = ts.transpileModule(readFileSync(sp, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  for (const [f, t] of Object.entries(rw)) outputText = outputText.split(f).join(t);
  return write(out, outputText);
}
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const employeesUrl = transpile('./employees.ts', 'employees.mjs');
const E = await import(employeesUrl);
const A = await import(transpile('./shifts/approvedHours.ts', 'approvedHours.mjs'));
const TC = await import(transpile('./timeclock.ts', 'timeclock.mjs'));
const timezone = transpile('./schedule/timezone.ts', 'timezone.mjs');
const labor = transpile('./labor.ts', 'labor.mjs', { "'@/lib/employees'": `'${employeesUrl}'` });
const TM = await import(transpile('./schedule/timecardModel.ts', 'timecardModel.mjs', {
  "'@/lib/employees'": `'${employeesUrl}'`, "'@/lib/labor'": `'${labor}'`, "'./timezone'": `'${timezone}'`,
}));
const CM = await import(transpile('./schedule/calendarModel.ts', 'calendarModel.mjs', {
  "'@/lib/employees'": `'${employeesUrl}'`,
}));

let passed = 0;
const check = (n, c, e = '') => { assert.ok(c, `FAIL: ${n} ${e}`); console.log(`  ✓ ${n}${e ? ` — ${e}` : ''}`); passed++; };
const eq = (n, a, b) => check(n, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} == ${JSON.stringify(b)}`);
const near = (n, a, b) => check(n, Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

// Carlos: punched 5:48 PM → 2:20 AM (8h32m clocked), live 7h58m (478 approved minutes).
const CARLOS = {
  employee_id: 'emp-carlos',
  date: '2026-09-08',
  start_time: '17:48:00',
  end_time: '02:20:00',
  source: 'time_clock',
  source_rule_id: null,
  confirmed_at: '2026-09-09T18:00:00Z',
  break_minutes: 0,
  clock_in_at: '2026-09-08T17:48:00-07:00',
  clock_out_at: '2026-09-09T02:20:00-07:00',
  auto_closed: false,
  approved_minutes: null,
};
const withApproved = (m) => ({ ...CARLOS, approved_minutes: m });

console.log('\n1. THE PUNCH IS NOT THE PAYROLL FIGURE — and is never rewritten to become one');
{
  near('clocked span is 8h32m', E.clockedShiftHours(CARLOS), 8 + 32 / 60);
  const approved = withApproved(478);
  near('approved 478 min pays 7h58m', E.paidShiftHours(approved), 478 / 60);
  near('…while the clocked figure still reads 8h32m', E.clockedShiftHours(approved), 8 + 32 / 60);
  // The instants are the attendance record: identical objects in, identical instants out.
  eq('clock_in_at is untouched by approval', approved.clock_in_at, CARLOS.clock_in_at);
  eq('clock_out_at is untouched by approval', approved.clock_out_at, CARLOS.clock_out_at);
  check('the two figures genuinely differ (the test would be vacuous otherwise)',
    Math.abs(E.paidShiftHours(approved) - E.clockedShiftHours(approved)) > 0.5);

  // NOTHING in the confirm path writes a clock instant. The RPC is the only writer of the approved
  // column, and its UPDATE names three columns — none of them a punch.
  const mig = strip(read('../../supabase/migrations/139_shift_approved_minutes.sql'));
  const updates = [...mig.matchAll(/update public\.shifts[\s\S]*?where/g)].map((m) => m[0]);
  check('migration 139 issues at least one shifts UPDATE', updates.length >= 3, `${updates.length}`);
  for (const u of updates) {
    check('no shifts UPDATE in 139 touches clock_in_at / clock_out_at / start_time / end_time',
      !/clock_in_at|clock_out_at|start_time|end_time/.test(u));
  }
  const hook = strip(read('../hooks/useShifts.ts'));
  const confirmBody = hook.slice(hook.indexOf('const confirmShift'), hook.indexOf('const setApprovedMinutes'));
  check('the confirm mutation sends only the shift id and the approved minutes',
    /p_shift_id: id/.test(confirmBody) && /p_approved_minutes/.test(confirmBody)
    && !/clock_in_at|clock_out_at|start_time|end_time/.test(confirmBody));
  // OVERLOAD RESOLUTION. The confirm branch must send BOTH argument names: sending only
  // p_shift_id would resolve to the LEGACY overload, which silently records no approval.
  check('the confirm branch always sends p_approved_minutes (never the bare legacy shape)',
    /confirmed[\s\S]{0,80}\?\s*\{\s*p_shift_id: id,\s*p_approved_minutes:/.test(confirmBody),
    confirmBody.replace(/\s+/g, ' ').slice(confirmBody.replace(/\s+/g, ' ').indexOf('const args'), 160));
}

console.log('\n2. LEGACY SHIFTS ARE UNTOUCHED — approved_minutes NULL keeps the old figure exactly');
{
  const shapes = [
    ['punch with instants', CARLOS],
    ['punch with a break', { ...CARLOS, break_minutes: 30 }],
    ['manual wall-clock row', { ...CARLOS, source: 'manual', clock_in_at: null, clock_out_at: null }],
    ['overnight wall clock, no instants', { ...CARLOS, source: 'manual', clock_in_at: null, clock_out_at: null, start_time: '16:00', end_time: '01:00' }],
    ['forgotten clock-out spanning 26h', { ...CARLOS, clock_out_at: '2026-09-09T19:48:00-07:00' }],
    ['absent approved_minutes key entirely', (() => { const c = { ...CARLOS }; delete c.approved_minutes; return c; })()],
  ];
  for (const [label, s] of shapes) {
    near(`${label}: paid === clocked when nothing is approved`, E.paidShiftHours(s), E.clockedShiftHours(s));
  }
  // The fallback is a NULL check, not a falsy check: 0 approved minutes is a real decision.
  near('approved 0 pays 0 — it does NOT fall through to the clocked span', E.paidShiftHours(withApproved(0)), 0);
  check('…and the clocked span was non-zero, so that assertion means something', E.clockedShiftHours(withApproved(0)) > 8);
}

console.log('\n3. APPROVED HOURS DO NOT MAKE A SHIFT PAYABLE — isPayableShift is still the only gate');
{
  const unconfirmed = { ...withApproved(478), confirmed_at: null };
  eq('an UNCONFIRMED time-clock punch with approved minutes is not payable', E.isPayableShift(unconfirmed), false);
  eq('a materialized PLAN row with approved minutes is still not payable',
    E.isPayableShift({ ...withApproved(478), source_rule_id: 'rule-1' }), false);
  eq('an OPEN shift with approved minutes is still not payable',
    E.isPayableShift({ ...withApproved(478), end_time: null }), false);
  eq('the confirmed one IS payable', E.isPayableShift(withApproved(478)), true);

  // computePay is the money path: it gates on payability FIRST, then pays the approved figure.
  const emp = [{ id: 'emp-carlos', name: 'Carlos', role: 'host', hourly_rate: 20, status: 'active', user_id: 'o', hire_date: null, probation_end_date: null, created_at: '', updated_at: '' }];
  const paidRows = E.computePay(emp, [withApproved(478)]);
  near('computePay hours = approved hours', paidRows[0].hours, 478 / 60);
  near('computePay pay = approved hours × rate (derived, never stored)', paidRows[0].pay, (478 / 60) * 20);
  const unpaidRows = E.computePay(emp, [unconfirmed]);
  eq('an unconfirmed approved shift contributes ZERO to pay', unpaidRows[0].hours, 0);
}

console.log('\n4. FULFILLMENT DEFAULT — the existing canonical payable duration, breaks and all');
{
  const ful = { ...CARLOS, employee_id: 'emp-madison', break_minutes: 30 };
  near('canonical payable is 8h02m (8h32m span − 30m break)', E.clockedShiftHours(ful), 8 + 2 / 60);
  eq('default approved minutes = 482 (the canonical figure, not the raw span)', E.defaultApprovedMinutes(ful, false), 482);
  eq('a clean 8h30m span with a 30m break defaults to 480',
    E.defaultApprovedMinutes({ ...CARLOS, clock_out_at: '2026-09-09T02:18:00-07:00', break_minutes: 30 }, false), 480);
  // Confirming with that default must reproduce today's payroll exactly.
  near('confirming at the default pays what the legacy path paid',
    E.paidShiftHours({ ...ful, approved_minutes: E.defaultApprovedMinutes(ful, false) }), E.clockedShiftHours(ful));
  eq('minutes conversion rounds to whole minutes', [E.hoursToMinutes(7.9666666), E.hoursToMinutes(8), E.hoursToMinutes(-1)], [478, 480, 0]);
}

console.log('\n5. LIVE HOST — no silent default, an explicit figure is required');
{
  eq('a live host gets NO default approved duration', E.defaultApprovedMinutes(CARLOS, true), null);
  check('…and specifically NOT the clocked span (the bug this prevents)',
    E.defaultApprovedMinutes(CARLOS, true) !== E.hoursToMinutes(E.clockedShiftHours(CARLOS)));
  eq('the requirement keys on the host team', [
    A.approvedMinutesRequired('host'), A.approvedMinutesRequired('fulfillment'), A.approvedMinutesRequired('other'),
  ], [true, false, false]);

  // The SQL guard and the TS normalisation must recognise the same host vocabulary, or a host could
  // be confirmed with no approved duration by whichever side disagreed.
  const mig = read('../../supabase/migrations/139_shift_approved_minutes.sql');
  const sqlList = mig.match(/lower\(btrim\(e\.role\)\) in \(([^)]*)\)/);
  check('139 gates the host requirement on a role predicate', !!sqlList);
  const sqlRoles = sqlList[1].split(',').map((x) => x.trim().replace(/'/g, ''));
  eq('the SQL host vocabulary is host / live host', sqlRoles.sort(), ['host', 'live host']);
  for (const r of sqlRoles) {
    eq(`teamOfRole('${r}') agrees it is a host`, TC.teamOfRole(r), 'host');
  }
  eq('teamOfRole normalises spacing/case the same way the SQL btrim+lower does',
    [TC.teamOfRole('  Host '), TC.teamOfRole('LIVE HOST')], ['host', 'host']);
  check('139 raises HOST_APPROVED_MINUTES_REQUIRED rather than defaulting',
    /HOST_APPROVED_MINUTES_REQUIRED/.test(mig));
  check('the manager tile refuses to submit a blank host figure (MISSING)',
    /parseApprovedInput\(approved\.hours, approved\.minutes, mustApprove\)/.test(read('../components/employees/weekly/PersonCard.tsx')));

  // WHY there is no live-session prefill: the only existing live-hours aggregation is day-clipped,
  // which under-reports exactly the 6pm–2am host shift this feature is for. Pinning that here so
  // nobody "improves" the default by wiring it in.
  const LH = await import(transpile('./schedule/liveHours.ts', 'liveHours.mjs', { "'./timezone'": `'${timezone}'` }));
  const session = { host_id: 'emp-carlos', status: 'ended', started_at: '2026-09-08T18:03:00-07:00', ended_at: '2026-09-09T02:01:00-07:00', end_source: 'live_ended' };
  const day = LH.liveHoursForHostDate([session], 'emp-carlos', '2026-09-08');
  eq('the live session really is 7h58m long', Math.round(((Date.parse(session.ended_at) - Date.parse(session.started_at)) / 60000)), 478);
  eq('but liveHoursForHostDate clips it at Pacific midnight', day.state, 'known');
  check('…reporting only ~5h57m for the shift date, not 7h58m',
    Math.abs(day.hours - (5 + 57 / 60)) < 0.02, `${day.hours}`);
  check('so an authoritative shift→live-duration prefill does not exist and is not used',
    !/liveHoursForHostDate/.test(strip(read('./employees.ts'))) && !/liveHoursForHostDate/.test(strip(read('./shifts/approvedHours.ts'))));
}

console.log('\n6. THE MANAGER INPUT KERNEL');
{
  eq('7 hrs 58 min → 478', A.parseApprovedInput('7', '58', true), { ok: true, minutes: 478 });
  eq('hours only', A.parseApprovedInput('8', '', true), { ok: true, minutes: 480 });
  eq('minutes only', A.parseApprovedInput('', '45', true), { ok: true, minutes: 45 });
  eq('explicit zero is allowed', A.parseApprovedInput('0', '0', true), { ok: true, minutes: 0 });
  eq('blank + required → MISSING', A.parseApprovedInput('', '', true), { ok: false, code: 'MISSING' });
  eq('blank + optional → null (legacy fallback, not an error)', A.parseApprovedInput('', '', false), { ok: true, minutes: null });
  eq('60 in the minutes box is refused, not silently carried', A.parseApprovedInput('7', '60', true), { ok: false, code: 'MINUTES_RANGE' });
  eq('non-numeric is refused rather than read as 0', A.parseApprovedInput('seven', '58', true), { ok: false, code: 'NOT_A_NUMBER' });
  eq('fractions are refused (minutes are whole)', A.parseApprovedInput('7.5', '', true), { ok: false, code: 'NOT_A_NUMBER' });
  eq('negative is refused', A.parseApprovedInput('-1', '', true), { ok: false, code: 'NEGATIVE' });
  eq('over 24h is refused', A.parseApprovedInput('25', '0', true), { ok: false, code: 'TOO_LONG' });
  eq('exactly 24h is allowed', A.parseApprovedInput('24', '0', true), { ok: true, minutes: 1440 });
  eq('round-trip 478 → boxes → 478', A.parseApprovedInput(A.splitApprovedMinutes(478).hours, A.splitApprovedMinutes(478).minutes, true), { ok: true, minutes: 478 });
  eq('split of null is two empty boxes', A.splitApprovedMinutes(null), { hours: '', minutes: '' });
  eq('formatting matches the portal', [A.formatApprovedMinutes(478), A.formatApprovedMinutes(480), A.formatApprovedMinutes(null)], ['7h 58m', '8h 00m', '—']);
  check('every refusal has a manager-readable sentence',
    Object.values(A.APPROVED_INPUT_MESSAGES).every((m) => typeof m === 'string' && m.length > 10));
  check('the input ceiling matches the DB CHECK (1440)',
    A.MAX_APPROVED_MINUTES === 1440 && /approved_minutes <= 1440/.test(read('../../supabase/migrations/139_shift_approved_minutes.sql')));
}

console.log('\n7. ONE PAYROLL RULE — the manager calendar and the employee portal read the same figure');
{
  const punch = {
    id: 'p1', source: 'time_clock', employee_id: 'emp-carlos', date: '2026-09-08',
    start_time: '17:48', end_time: '02:20',
    clock_in_at: CARLOS.clock_in_at, clock_out_at: CARLOS.clock_out_at,
    break_minutes: 0, confirmed_at: CARLOS.confirmed_at, approved_minutes: 478, auto_closed: false,
  };
  near('calendar punchHours = the approved figure', CM.punchHours(punch), 7.97);
  near('calendar punchClockedHours = the attendance figure', CM.punchClockedHours(punch), 8.53);
  near('calendar and payroll agree exactly', CM.punchHours(punch), Math.round(E.paidShiftHours(withApproved(478)) * 100) / 100);
  // The old duplicate implementation is gone: calendarModel now calls the canonical module.
  const cm = strip(read('./schedule/calendarModel.ts'));
  check('calendarModel imports the canonical payroll functions', /from '@\/lib\/employees'/.test(cm));
  check('…and no longer subtracts break minutes itself inside punchHours',
    !/function punchHours[\s\S]{0,400}?break_minutes \?\? 0\) \/ 60/.test(cm));

  const days = CM.buildCalendarDays({
    days: ['2026-09-08'], employees: [{ id: 'emp-carlos', name: 'Carlos Ruiz', role: 'host' }],
    punches: [punch], scheduled: [], todayISO: '2026-09-09', view: 'clocked',
  });
  const person = days.get('2026-09-08').people[0];
  near('DayPunch.hours is the paying figure', person.punch.hours, 7.97);
  near('DayPunch.clockedHours is the attendance figure', person.punch.clockedHours, 8.53);
  eq('DayPunch carries the approved minutes for the tile to label', person.punch.approvedMinutes, 478);
}

console.log('\n8. THE EMPLOYEE TIMECARD — clocked and approved side by side, read-only');
{
  const row = { ...CARLOS, id: 's1', approved_minutes: 478 };
  const e = TM.toTimecardEntry(row);
  near('entry.hours is the approved figure', e.hours, 478 / 60);
  near('entry.clocked_hours is the punch span', e.clocked_hours, 8 + 32 / 60);
  eq('entry carries the approved minutes', e.approved_minutes, 478);
  eq('entry is payable (confirmed)', e.payable, true);
  eq('the raw instants reach the employee unchanged', [e.clock_in, e.clock_out], [CARLOS.clock_in_at, CARLOS.clock_out_at]);
  eq('overnight: the punch books to the evening it started', e.date, '2026-09-08');
  check('and the clock-out really is the next LA day',
    new Date(e.clock_out).toISOString() === '2026-09-09T09:20:00.000Z');

  // UNCONFIRMED: shown, but never presented as final payroll.
  const pending = TM.toTimecardEntry({ ...row, confirmed_at: null, approved_minutes: null });
  eq('an unconfirmed punch is not payable', pending.payable, false);
  eq('…is flagged awaiting confirmation', pending.state, 'awaiting_confirmation');
  eq('…and carries no approved minutes', pending.approved_minutes, null);
  const scr = read('../components/portal/TimecardScreen.tsx');
  // The employee-facing words for "not approved yet" are "Waiting for approval" — never a 0, which
  // would read as a shift that vanished.
  check('the screen prints "Waiting for approval" instead of a number when not payable',
    /Waiting for approval/.test(scr) && !/Awaiting approval/.test(scr));
  check('the screen labels both figures', /label="Clocked"/.test(scr) && /label="Approved"/.test(scr));
  check('the screen explains what approved hours are', /What are approved hours\?/.test(scr));
  check('the live-host sentence is present and conditional', /Based on confirmed Live Host working time/.test(scr) && /showLiveNote/.test(scr));
  check('the approved-hours explanation names the Live Host rule only for a live host',
    /Live Host approved hours are normally based on confirmed live-working time/.test(scr) && /isHost && \(/.test(scr));
  // NO MONEY, anywhere on the employee's hours screen.
  check('the screen never renders a rate, a gross or a dollar sign',
    !/hourly_rate|grossPay|estimated|\$\{?\s*[a-zA-Z_]*[Pp]ay\b/.test(scr) && !/>\s*\$/.test(scr));
  // "Pay Day" is a SCHEDULED date. Lensed stores no proof a payment happened, so nothing may claim one.
  check('the screen says "Pay Day" and never claims the period was paid',
    /Pay Day/.test(scr) && !/\bPaid\b/.test(strip(scr)));

  // Window totals come from the canonical payable path, and the approved figure is what sums.
  const week = { start: '2026-09-07', end: '2026-09-13' };
  const period = { start: '2026-08-31', end: '2026-09-13' };
  const tc = TM.buildTimecard({ shifts: [row], open: null, todayISO: '2026-09-09', week, period });
  near('week approved total = 7.97', tc.week.workedHours, 7.97);
  eq('an unconfirmed punch lands in pendingHours, never in the approved total',
    TM.buildTimecard({ shifts: [{ ...row, confirmed_at: null, approved_minutes: null }], open: null, todayISO: '2026-09-09', week, period }).week.workedHours, 0);

  // READ-ONLY: no employee-facing route writes any of it.
  const portalDir = fileURLToPath(new URL('../app/s/[token]', import.meta.url));
  const { readdirSync, statSync } = await import('node:fs');
  const routes = [];
  (function walk(d) {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n === 'route.ts') routes.push(p);
    }
  })(portalDir);
  check('the token routes exist', routes.length >= 7, `${routes.length}`);
  for (const r of routes) {
    const src = strip(readFileSync(r, 'utf8'));
    check(`${r.split('/s/[token]/')[1]}: never writes approved_minutes or a punch`,
      !/approved_minutes|clock_in_at|clock_out_at|lensed_set_approved_minutes|lensed_confirm_time_clock_shift/.test(src));
  }
  const tcLib = strip(read('./schedule/timecard.ts'));
  check('the timecard read is scoped to the token employee AND the owner',
    /\.eq\('user_id', employee\.user_id\)/.test(tcLib) && /\.eq\('employee_id', employee\.id\)/.test(tcLib));
  check('the timecard performs no write at all', !/\.(insert|update|upsert|delete|rpc)\(/.test(tcLib));
  check('the timecard select carries approved_minutes (or the portal would show the legacy figure)',
    /approved_minutes/.test(tcLib));
  check('no rate or money reaches the employee payload',
    !/hourly_rate|gross|pay_amount|dollars/.test(strip(read('./schedule/portalTypes.ts')) + tcLib));
}

console.log('\n9. EVERY PAYROLL-SHAPED READ SELECTS approved_minutes');
{
  // A select list that feeds isPayableShift but omits the approved column would silently pay the
  // legacy figure on that surface only. The marker for a PAYABILITY-shaped read is selecting BOTH
  // fields that gate isPayableShift — source_rule_id and confirmed_at. (source_rule_id alone is
  // not enough: the materializer reads it to find already-frozen rule days and pays nobody.)
  const { readdirSync, statSync } = await import('node:fs');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = [];
  (function walk(d) {
    for (const n of readdirSync(d)) {
      if (n === 'node_modules' || n === '.next') continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(n)) files.push(p);
    }
  })(root);
  let examined = 0;
  for (const f of files) {
    const src = strip(readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/\.select\(\s*'([^']*)'/g)) {
      const list = m[1];
      if (!list.includes('source_rule_id') || !list.includes('confirmed_at')) continue;
      examined++;
      check(`${f.slice(root.length)}: payability-shaped select includes approved_minutes`,
        list.includes('approved_minutes'), list.slice(0, 60) + '…');
    }
  }
  check('payability-shaped select lists were actually found (not a vacuous pass)', examined >= 5, `${examined} lists`);
}

console.log('\n10. SCHEDULED HOURS STAY SCHEDULED — shift_instances only, never approved/paid');
{
  const snap = strip(read('./schedule/portalSnapshot.ts'));
  const schedLine = snap.match(/scheduledHours:[^\n]*/)[0];
  check('scheduledHours sums planned shift spans, not punches',
    /shifts\.filter/.test(schedLine) && !/approved|paidShiftHours|workedHours/.test(schedLine), schedLine.trim().slice(0, 80));
  check('the snapshot reads shift_instances for the plan', /from\('shift_instances'\)/.test(snap));
  check('workedHours comes from the timecard (the canonical payable path)', /workedHours: timecard\.week\.workedHours/.test(snap));
  const home = read('../components/portal/HomeScreen.tsx');
  check('Home still labels the plan "Scheduled"', /Scheduled<\/p>|>Scheduled</.test(home));
  check('Home labels the payroll figure "Approved" with a "Payroll hours" caption',
    /Approved <ChevronRight/.test(home) && /Payroll hours/.test(home));
  check('Home reads scheduledHours for one and workedHours for the other',
    /fmtHours\(snap\.thisWeek\.scheduledHours\)/.test(home) && /fmtHours\(snap\.thisWeek\.workedHours\)/.test(home));

  // PAY PERIOD + PAY DAY, and the no-money rule on the surfaces that show them.
  const scr2 = read('../components/portal/TimecardScreen.tsx');
  check('Home shows the pay period, its two hour figures and the Pay Day',
    /snap\.payPeriod/.test(home) && /fmtPeriodRange/.test(home) && /fmtPayday/.test(home));
  check('the waiting line is rendered ONLY when something is actually waiting',
    /pp\.pendingHours > 0 &&/.test(home) && /summary\.pendingHours > 0 &&/.test(scr2));
  check('neither surface ever says "Paid" — only "Pay Day"',
    !/>\s*Paid\b|Paid on|Paid ·/.test(home + scr2) && /Pay Day/.test(home) && /Pay Day/.test(scr2));
  // Comments STRIPPED: this file's own "NO MONEY" note must not be what satisfies or fails the
  // guard. The check is about rendered code, not prose.
  check('no rate, gross, estimate or currency symbol on either surface',
    !/hourly_rate|gross|net_?pay|estimate|\$\{?\d|USD/i.test(strip(home) + strip(scr2)));

  // ZERO STATES. A 32px "0 hrs approved" reads as "your hours were zeroed"; the honest reading is
  // that nothing is confirmed yet. Both surfaces must say it in words and show no figure.
  check('a period with no approved hours says so in words, not as a 0, on Home',
    /No hours approved yet/.test(home) && /pp\.workedHours > 0 \?/.test(home));
  check('…and on the Hours screen', /No hours approved yet/.test(scr2) && /summary\.workedHours > 0 \?/.test(scr2));
  check('…and a worked-nothing history row says "No approved hours" rather than 0',
    /No approved hours/.test(scr2) && /p\.workedHours > 0/.test(scr2));
  check('an unconfirmed entry says "Waiting for approval" instead of a fake 0',
    /Waiting for approval/.test(scr2));
  check('the approved-hours explainer is present, with the Live Host sentence gated on the role',
    /What are approved hours\?/.test(scr2) && /isHost && \(/.test(scr2));
}

console.log('\n11. THE DATABASE IS THE BOUNDARY — approved_minutes is server-only');
{
  const mig = read('../../supabase/migrations/139_shift_approved_minutes.sql');
  check('the guard trigger now covers approved_minutes',
    /new\.approved_minutes is distinct from old\.approved_minutes/.test(mig));
  check('…and still refuses outside the confirm context',
    /coalesce\(current_setting\('lensed\.confirm_ctx', true\), ''\) <> 'on'/.test(mig));
  // ADDITIVE ROLLOUT. The legacy one-argument confirm must survive 139 so the app deployed before
  // Approved Hours keeps working during the rollout — and the new overload must have NO DEFAULT,
  // or `confirm(p_shift_id => …)` becomes ambiguous and EVERY existing confirm call breaks.
  // SQL comments are `--` lines, which the JS-oriented strip() above does not touch. 139's header
  // QUOTES the future cleanup DROP and the rollback DROPs as documentation, so the executable
  // statements have to be isolated before asserting that nothing is dropped.
  const migCode = mig.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  check('no DROP of a function, table or column survives in executable SQL',
    !/\bdrop\s+(function|table|column)\b/i.test(migCode),
    (migCode.match(/\bdrop\s+\w+[^\n;]*/gi) ?? []).join(' | '));
  check('the only DROP at all is 139 re-creating its OWN check constraint idempotently',
    (migCode.match(/\bdrop\s+\w+/gi) ?? []).every((d) => /drop constraint/i.test(d))
    && /drop constraint if exists shifts_approved_minutes_range/.test(migCode));
  check('…specifically, the legacy one-argument confirm is never dropped',
    !/drop function if exists public\.lensed_confirm_time_clock_shift\(uuid\)\s*;/.test(migCode));
  check('…and is not reissued either, so 139 cannot drift it (071 stays its only definition)',
    !/create or replace function public\.lensed_confirm_time_clock_shift\(\s*p_shift_id uuid\s*\)/.test(migCode));
  check('the NEW overload takes two arguments with NO default (the anti-ambiguity rule)',
    /create or replace function public\.lensed_confirm_time_clock_shift\(\s*p_shift_id uuid,\s*p_approved_minutes integer\s*\)/.test(migCode)
    && !/p_approved_minutes integer default/.test(migCode));
  check('the legacy overload is marked TRANSITION ONLY for the future cleanup',
    /comment on function public\.lensed_confirm_time_clock_shift\(uuid\) is/.test(migCode)
    && /TRANSITION ONLY/.test(mig));
  check('the header documents the cleanup migration and its preconditions',
    /CLEANUP, LATER AND SEPARATELY/.test(mig) && /pg_stat_user_functions/.test(mig));
  check('the header states the migration may be applied BEFORE the code deploy',
    /MAY BE APPLIED \*\*BEFORE\*\* THE CODE DEPLOY/.test(mig));
  check('139 documents its rollback, including that dropping the column destroys approvals',
    /^-- ROLLBACK$/m.test(mig) && /DESTROYS approvals/.test(mig));
  // Applying by hand against a table the kiosk writes: without a lock timeout the ALTER waits on
  // any in-flight punch and every reader queues behind its lock request.
  check('139 sets a lock_timeout before touching shifts',
    /^set local lock_timeout = '3s';$/m.test(migCode));
  // And it must stay ONE transaction: the widened guard dereferences new.approved_minutes, so the
  // column has to exist first — splitting them would leave the column briefly UNGUARDED.
  check('139 is exactly one transaction (no unguarded window between column and guard)',
    (migCode.match(/^begin;$/gm) ?? []).length === 1
    && (migCode.match(/^commit;$/gm) ?? []).length === 1);
  check('…and the column is added BEFORE the guard is replaced (plpgsql late binding)',
    migCode.indexOf('add column if not exists approved_minutes')
      < migCode.indexOf('create or replace function public.shifts_guard_confirmation'));
  check('…and the header explains why the file is not split',
    /ONE TRANSACTION, DELIBERATELY/.test(mig) && /has no field/.test(mig));
  check('unconfirming clears the approval (no payable-looking number on an unconfirmed shift)',
    /set confirmed_at = null, confirmed_by = null, approved_minutes = null/.test(mig));
  check('the correction RPC refuses an unconfirmed time-clock shift', /SHIFT_NOT_CONFIRMED/.test(mig));
  check('the correction RPC re-stamps the audit fields', /confirmed_by = case when v_shift\.source = 'time_clock' then v_user/.test(mig));
  check('all three functions are granted to authenticated only (manager session, auth.uid())',
    (mig.match(/grant execute on function[^\n]*to authenticated;/g) ?? []).length === 3
    && !/to service_role/.test(mig));
  // This file IS the ledger — the DB has none — so the header must say what production actually
  // holds. It used to assert "NOT APPLIED"; the migration has since been applied, and the file was
  // renumbered 137 -> 139 because PR #231 landed its own 137 on main while this branch sat unmerged.
  check('the migration records that it IS applied to production, and does not still claim otherwise',
    /APPLIED TO PRODUCTION/.test(mig) && !/⚠️ NOT APPLIED/.test(mig));
  check('…and warns against applying it a second time',
    /DO NOT APPLY IT AGAIN/.test(mig));
  check('…and records the renumber, so the prefix change is traceable',
    /RENUMBERED 137 → 139/.test(mig) && /BOOKKEEPING ONLY/.test(mig));
  check('…and explains why the in-database function comment still says "migration 137"',
    /EXECUTABLE SQL, not a comment/.test(mig));
  check('the migration still names the deploy order',
    mig.includes('FULLY ADDITIVE') && mig.includes('THE CODE DEPLOY'));
  check('the new RPC is NOT registered as service-role-only',
    !/lensed_set_approved_minutes/.test(read('../../scripts/check-rpc-grants.mjs')));
}

console.log(`\n${passed} checks passed`);
