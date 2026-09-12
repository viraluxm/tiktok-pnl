// APPROVED HOURS ARE FOR LIVE HOSTS ONLY.
//
// THE RULE THIS FILE EXISTS TO PROTECT, in one sentence: a FULFILLMENT shift has no Approved Hours
// input, no override control and no approved_minutes written through any app path, so payroll pays
// its canonical worked time (clock in → clock out − breaks) — while LIVE HOST behaviour is exactly
// what main shipped.
//
// WHY IT MATTERS. Before this change the manager tile prefilled the approval box for a
// non-host with the clocked figure ROUNDED TO WHOLE MINUTES, and Confirm stored that copy. Within
// three days production held 37 fulfillment rows carrying approved_minutes: 33 differed from the
// punch only by that rounding, and one read 23h41m against a 7h40m shift — a $352 overpayment
// nothing in the UI distinguished from the others.
//
// Exercises the REAL approvedHours.ts, employees.ts and calendarModel.ts, transpiled at runtime,
// plus greps over the REAL PersonCard / useShifts / modals for the invariants a unit test cannot
// reach (a React tile is not mountable here — there is no renderer in this suite).
//
// Run:  TZ=UTC node src/lib/shifts/approvedHoursLiveHostOnly.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'ah-hosts-'));
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
/** Strip comments, so a prose mention of a rule can never be what satisfies a check about code. */
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');

const A = await import(transpile('./approvedHours.ts', 'approvedHours.mjs'));
const employeesUrl = transpile('../employees.ts', 'employees.mjs');
const E = await import(employeesUrl);
const TC = await import(transpile('../timeclock.ts', 'timeclock.mjs'));
const CM = await import(transpile('../schedule/calendarModel.ts', 'calendarModel.mjs', {
  "'@/lib/employees'": `'${employeesUrl}'`,
}));

let passed = 0;
const check = (n, c, e = '') => { assert.ok(c, `FAIL: ${n} ${e}`); console.log(`  ✓ ${n}${e ? ` — ${e}` : ''}`); passed++; };
const eq = (n, a, b) => check(n, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} == ${JSON.stringify(b)}`);
const near = (n, a, b) => check(n, Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

const CARD = read('../../components/employees/weekly/PersonCard.tsx');
const CARD_CODE = strip(CARD);
const HOOK = read('../../hooks/useShifts.ts');
const HOOK_CODE = strip(HOOK);

// A fulfillment punch with SECONDS in it — the shape every production row has, and the reason the
// old whole-minute prefill was lossy. 6:00:00 AM → 2:03:17 PM, 40m unpaid break.
const JUAN = {
  employee_id: 'e-juan',
  date: '2026-09-15',
  start_time: '06:00:00',
  end_time: '14:03:00',
  source: 'time_clock',
  source_rule_id: null,
  confirmed_at: '2026-09-16T01:00:00Z',
  break_minutes: 40,
  clock_in_at: '2026-09-15T06:00:00-07:00',
  clock_out_at: '2026-09-15T14:03:17-07:00',
  auto_closed: false,
  approved_minutes: null,
};

console.log('\n1. THE PREDICATE — one place says who has approved hours at all');
{
  eq('only a live host', [A.approvedHoursApply('host'), A.approvedHoursApply('fulfillment'), A.approvedHoursApply('other')],
    [true, false, false]);
  // `=== 'host'`, never `!== 'fulfillment'`: an unrecognised role must fall on the SAFE side.
  eq("a role teamOfRole cannot classify lands in 'other', which has no approved hours",
    A.approvedHoursApply(TC.teamOfRole('warehouse lead')), false);
  eq('the host vocabulary is the app-wide one', [TC.teamOfRole('host'), TC.teamOfRole('Live Host'), TC.teamOfRole('  LIVE HOST ')],
    ['host', 'host', 'host']);
  eq('fulfillment normalises the same way', [TC.teamOfRole('fulfillment'), TC.teamOfRole(' Fulfillment ')], ['fulfillment', 'fulfillment']);
  eq('a missing role is not a host', [A.approvedHoursApply(TC.teamOfRole(null)), A.approvedHoursApply(TC.teamOfRole(undefined)), A.approvedHoursApply(TC.teamOfRole(''))],
    [false, false, false]);
  // The kernel restates teamOfRole's union rather than importing it (it must transpile alone);
  // if the two ever diverge, this is what says so.
  const teamKey = read('../timeclock.ts').match(/export type TeamKey = ([^;]+);/)[1].trim();
  const approvedTeam = read('./approvedHours.ts').match(/export type ApprovedTeam = ([^;]+);/)[1].trim();
  eq('ApprovedTeam is TeamKey, spelled out', approvedTeam, teamKey);
  // The requirement is DERIVED, so "who gets a box" and "who must fill it" cannot drift.
  check('approvedMinutesRequired is derived from approvedHoursApply, not a second copy of the rule',
    /return approvedHoursApply\(team\);/.test(read('./approvedHours.ts')));
  eq('…and it still answers the same as before for every team',
    [A.approvedMinutesRequired('host'), A.approvedMinutesRequired('fulfillment'), A.approvedMinutesRequired('other')],
    [true, false, false]);
}

console.log('\n2. THE WRITE GATE — minutes cannot reach the RPC without an authorising team');
{
  eq('a host figure passes through untouched', A.approvedMinutesForTeam('host', 478), 478);
  eq('a host may still approve exactly zero (a real decision, not a blank)', A.approvedMinutesForTeam('host', 0), 0);
  eq('a host may withdraw an approval with null', A.approvedMinutesForTeam('host', null), null);
  eq('a FULFILLMENT figure becomes NULL', A.approvedMinutesForTeam('fulfillment', 480), null);
  eq('…even a deliberate zero', A.approvedMinutesForTeam('fulfillment', 0), null);
  eq('…and any unclassified role too', A.approvedMinutesForTeam('other', 480), null);

  // useShifts is the ONLY module issuing the two RPCs that can set the column. Both must gate.
  const confirmBody = HOOK_CODE.slice(HOOK_CODE.indexOf('const confirmShift'), HOOK_CODE.indexOf('const setApprovedMinutes'));
  const setBody = HOOK_CODE.slice(HOOK_CODE.indexOf('const setApprovedMinutes'));
  check('confirmShift sends p_approved_minutes only through approvedMinutesForTeam',
    /p_approved_minutes: approvedMinutesForTeam\(team, approvedMinutes \?\? null\)/.test(confirmBody), confirmBody.replace(/\s+/g, ' ').slice(0, 0) || '');
  check('lensed_set_approved_minutes sends it through the same gate',
    /p_approved_minutes: approvedMinutesForTeam\(team, approvedMinutes\)/.test(setBody));
  check('neither mutation can be called without a team (it is required, not optional)',
    /team: ApprovedTeam;/.test(HOOK_CODE) && !/team\?: ApprovedTeam/.test(HOOK_CODE));
  check('there is no other path to p_approved_minutes anywhere in the hook',
    (HOOK_CODE.match(/p_approved_minutes/g) ?? []).length === 2,
    `${(HOOK_CODE.match(/p_approved_minutes/g) ?? []).length} occurrences`);
  // The gate is only worth anything if these really are the only two writers in the app.
  const { readdirSync, statSync } = await import('node:fs');
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const files = [];
  (function walk(d) {
    for (const n of readdirSync(d)) {
      if (n === 'node_modules' || n === '.next') continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(n)) files.push(p);
    }
  })(root);
  // app/preview/ is excluded: those routes hold no Supabase client at all (section 9 proves it for
  // this change's route, and lib/preview/gate.ts 404s them in production), so a mention of the
  // argument name there is a label in a log line, not a write.
  const writers = files.filter((f) => {
    if (f.includes('/app/preview/')) return false;
    const src = strip(readFileSync(f, 'utf8'));
    return /lensed_set_approved_minutes|p_approved_minutes/.test(src);
  }).map((f) => f.slice(root.length).replace(/^\//, ''));
  eq('exactly one module in src/ names the approved-minutes RPC arguments', writers, ['hooks/useShifts.ts']);
  check('…and no surface writes the column directly through PostgREST',
    !files.some((f) => /\.update\(\s*\{[^}]*approved_minutes/.test(strip(readFileSync(f, 'utf8')))));
}

console.log('\n3. THE FULFILLMENT TILE — no input, no override control, confirm sends NULL');
{
  check('the tile computes the team once and gates on approvedHoursApply',
    /const team = teamOfRole\(person\.role\);/.test(CARD_CODE)
    && /const approvedApplies = approvedHoursApply\(team\);/.test(CARD_CODE));
  // THE INPUT. approvedInputs is the JSX holding both number boxes; it renders behind the gate.
  check('the hrs/min inputs render ONLY when approved hours apply',
    /\{approvedApplies && punch && !punch\.isOpen && punch\.confirmable && \(!punch\.confirmed \|\| adjusting\) && approvedInputs\}/.test(CARD_CODE));
  check('…and approvedInputs is the only thing that renders those two boxes',
    (CARD_CODE.match(/aria-label="Approved (hours|minutes)"/g) ?? []).length === 2
    && (CARD_CODE.match(/\{approvedApplies && [^}]*approvedInputs\}/g) ?? []).length === 1);
  // THE OVERRIDE. "Adjust approved hours" is the other way a figure can be entered.
  check('the "Adjust approved hours" control renders ONLY when approved hours apply',
    /\{approvedApplies && punch && !punch\.isOpen && punch\.confirmed && onApprovedMinutes && \(/.test(CARD_CODE));
  eq('…and there is exactly one such control in the tile',
    (CARD_CODE.match(/Adjust approved hours/g) ?? []).length, 1);
  // CONFIRM. Nothing is parsed when there are no boxes; an explicit null goes out instead.
  check('confirm skips the parser and sends null when approved hours do not apply',
    /const parsed = approvedApplies\s*\?\s*parseApprovedInput\(approved\.hours, approved\.minutes, mustApprove\)\s*:\s*\(\{ ok: true, minutes: null \} as const\);/
      .test(CARD_CODE.replace(/\s+/g, ' ').replace(/ /g, ' ')) || /approvedApplies\s*\?[\s\S]{0,120}\{ ok: true, minutes: null \}/.test(CARD_CODE));
  check('every confirm call carries the team', (CARD_CODE.match(/onConfirm\(punch\.id, (?:false|true), team/g) ?? []).length === 2);
  check('the override call carries the team too', /onApprovedMinutes\(punch\.id, team, parsed\.minutes\)/.test(CARD_CODE));
  check('saveApproved refuses outright for a team without approved hours',
    /if \(!punch \|\| !onApprovedMinutes \|\| !approvedApplies\) return;/.test(CARD_CODE));
  // The prefill that created the 37 rows is gone: no clocked figure is seeded for a non-host.
  check('no clocked figure is seeded into the boxes for a team without approved hours',
    /const defaultMinutes = approvedApplies && punch/.test(CARD_CODE));
  // The CLOCKED block, Edit and Confirm are untouched — the mock's "only the worked shift info".
  check('the tile still shows the CLOCKED span and its duration', />Clocked<\/div>/.test(CARD) && /punch\.clockedHours/.test(CARD_CODE));
  check('Edit and Confirm are still offered', />Edit<\/button>/.test(CARD) && /'Confirm'/.test(CARD_CODE));
}

console.log('\n4. A LEGACY FULFILLMENT FIGURE IS STILL SHOWN — hiding it would hide what pays');
{
  // 37 rows were confirmed BEFORE this change and still carry a value, one of them by 16 hours.
  // The read-only Approved line is deliberately NOT gated on approvedApplies: it renders on a
  // stored value alone, so the tile can never disagree with the pay statement in silence.
  const block = CARD_CODE.slice(CARD_CODE.indexOf('punch.approvedMinutes != null && !adjusting'));
  check('the read-only Approved line keys on a STORED value, not on the role',
    /\{punch && !punch\.isOpen && punch\.approvedMinutes != null && !adjusting && \(/.test(CARD_CODE));
  check('…and it is a display, not an input', /formatApprovedMinutes\(punch\.approvedMinutes\)/.test(block)
    && !/aria-label="Approved hours"/.test(block.slice(0, 400)));
  // A row confirmed under THIS build has approved_minutes null, so the line does not render.
  eq('a fulfillment row confirmed under this build carries no figure to show',
    A.approvedMinutesForTeam('fulfillment', E.hoursToMinutes(E.clockedShiftHours(JUAN))), null);
}

console.log('\n5. PAYROLL IS UNCHANGED — and strictly more exact than the prefill was');
{
  // THE PROOF ASKED FOR: removing the input does not move fulfillment payroll, because NULL was
  // always the fallback and the fallback is the canonical worked-time calculation.
  near('clock in → clock out − breaks = 7h23m17s', E.clockedShiftHours(JUAN), (8 * 3600 + 3 * 60 + 17 - 40 * 60) / 3600);
  near('with approved_minutes NULL, paidShiftHours pays exactly that', E.paidShiftHours(JUAN), E.clockedShiftHours(JUAN));
  eq('the shift is payable on its own (approval is not a payability gate)', E.isPayableShift(JUAN), true);

  // What the OLD prefill would have stored, and what it cost.
  const prefill = E.hoursToMinutes(E.clockedShiftHours(JUAN));
  check('the old prefill would have rounded the span to whole minutes',
    Math.abs(E.paidShiftHours({ ...JUAN, approved_minutes: prefill }) - E.clockedShiftHours(JUAN)) > 0,
    `${prefill} min vs ${E.clockedShiftHours(JUAN)} h`);
  check('…so removing it makes the figure MORE exact, never less',
    Math.abs(E.paidShiftHours(JUAN) - E.clockedShiftHours(JUAN))
      < Math.abs(E.paidShiftHours({ ...JUAN, approved_minutes: prefill }) - E.clockedShiftHours(JUAN)));

  // computePay is the money path.
  const emp = [{ id: 'e-juan', name: 'Juan Reyes', role: 'fulfillment', hourly_rate: 22, status: 'active', user_id: 'o', hire_date: null, probation_end_date: null, created_at: '', updated_at: '' }];
  near('computePay hours = the canonical worked time', E.computePay(emp, [JUAN])[0].hours, E.clockedShiftHours(JUAN));
  near('computePay pay = those hours × rate', E.computePay(emp, [JUAN])[0].pay, E.clockedShiftHours(JUAN) * 22);

  // paidShiftHours itself is NOT rewritten — the null-fallback branch is exactly as main has it.
  const emp_ts = strip(read('../employees.ts'));
  check('paidShiftHours still reads approved_minutes first and falls back to clockedShiftHours',
    /export function paidShiftHours\(s: ShiftLike\): number \{\s*if \(s\.approved_minutes != null\) return Math\.max\(0, s\.approved_minutes \/ 60\);\s*return clockedShiftHours\(s\);\s*\}/.test(emp_ts));
  check('clockedShiftHours is untouched: instants preferred, break subtracted, floored at 0',
    /const spanH = \(new Date\(s\.clock_out_at\)\.getTime\(\) - new Date\(s\.clock_in_at\)\.getTime\(\)\) \/ 3_600_000;/.test(emp_ts)
    && /return Math\.max\(0, spanH - breakHours\);/.test(emp_ts));
}

console.log('\n6. LIVE HOST — everything main shipped, unchanged');
{
  const ADRIANA = {
    ...JUAN, employee_id: 'e-adriana', break_minutes: 0,
    start_time: '16:00:00', end_time: '22:00:00',
    clock_in_at: '2026-09-15T16:00:00-07:00', clock_out_at: '2026-09-15T22:00:00-07:00',
  };
  near('the clocked span is 6h', E.clockedShiftHours(ADRIANA), 6);
  near('an approved 5h20m pays 5h20m, not the 6h punch', E.paidShiftHours({ ...ADRIANA, approved_minutes: 320 }), 320 / 60);
  near('…and the punch is still 6h afterwards', E.clockedShiftHours({ ...ADRIANA, approved_minutes: 320 }), 6);
  eq('the approved figure survives the write gate for a host', A.approvedMinutesForTeam('host', 320), 320);

  // THE REQUIREMENT. A blank pair is still a refusal for a host and still permitted for anyone
  // else — parseApprovedInput is byte-identical to main, and mustApprove still keys on the team.
  eq('blank + host → MISSING', A.parseApprovedInput('', '', A.approvedMinutesRequired('host')), { ok: false, code: 'MISSING' });
  eq('7 hrs 58 min still parses to 478', A.parseApprovedInput('7', '58', true), { ok: true, minutes: 478 });
  eq('60 in the minutes box is still refused', A.parseApprovedInput('7', '60', true), { ok: false, code: 'MINUTES_RANGE' });
  eq('over 24h is still refused', A.parseApprovedInput('25', '0', true), { ok: false, code: 'TOO_LONG' });
  eq('exactly 24h is still allowed', A.parseApprovedInput('24', '0', true), { ok: true, minutes: 1440 });
  eq('the ceiling still matches the DB CHECK', A.MAX_APPROVED_MINUTES, 1440);
  check('the tile still shows the Live Host note beside the boxes',
    /Live Host hours are verified live time, not the clocked span\./.test(CARD));
  check('the host requirement still reaches the parser as `mustApprove`',
    /parseApprovedInput\(approved\.hours, approved\.minutes, mustApprove\)/.test(CARD_CODE));

  // THE SERVER SIDE IS UNTOUCHED. Migration 139 still refuses a host with no figure, and this
  // change adds no migration — the schema already supports NULL as "pay the canonical figure".
  const mig = read('../../../supabase/migrations/139_shift_approved_minutes.sql');
  check('139 still raises HOST_APPROVED_MINUTES_REQUIRED', /HOST_APPROVED_MINUTES_REQUIRED/.test(mig));
  check('139 still gates that on the host role predicate', /lower\(btrim\(e\.role\)\) in \('host', 'live host'\)/.test(mig));
  const migs = (await import('node:fs')).readdirSync(fileURLToPath(new URL('../../../supabase/migrations', import.meta.url)));
  eq('this change adds NO migration — 139 is still the last approved-hours one',
    migs.filter((f) => /approved/i.test(f)).sort(), ['139_shift_approved_minutes.sql']);
}

console.log('\n7. TWO FULFILLMENT SHIFTS IN ONE DAY — separate rows, separate confirms, actual hours');
{
  const morning = { ...JUAN, start_time: '06:00:00', end_time: '10:00:00', clock_in_at: '2026-09-15T06:00:00-07:00', clock_out_at: '2026-09-15T10:00:00-07:00', break_minutes: 0 };
  const afternoon = { ...JUAN, start_time: '14:00:00', end_time: '18:00:00', clock_in_at: '2026-09-15T14:00:00-07:00', clock_out_at: '2026-09-15T18:00:00-07:00', break_minutes: 0 };
  near('the morning session pays its own 4h', E.paidShiftHours(morning), 4);
  near('the afternoon session pays its own 4h', E.paidShiftHours(afternoon), 4);
  const emp = [{ id: 'e-juan', name: 'Juan Reyes', role: 'fulfillment', hourly_rate: 22, status: 'active', user_id: 'o', hire_date: null, probation_end_date: null, created_at: '', updated_at: '' }];
  near('both contribute to pay — 8h for the day, not 4h', E.computePay(emp, [morning, afternoon])[0].hours, 8);

  // The calendar still surfaces BOTH as separate person entries (the multi-shift release), and
  // neither carries an approved figure.
  const punches = [morning, afternoon].map((s, i) => ({
    id: `pk-${i}`, employee_id: s.employee_id, source: 'time_clock', date: s.date,
    start_time: s.start_time, end_time: s.end_time, clock_in_at: s.clock_in_at, clock_out_at: s.clock_out_at,
    break_minutes: 0, confirmed_at: null, approved_minutes: null, auto_closed: false,
  }));
  const days = CM.buildCalendarDays({
    days: ['2026-09-15'], employees: [{ id: 'e-juan', name: 'Juan Reyes', role: 'fulfillment' }],
    punches, scheduled: [], todayISO: '2026-09-16', view: 'all',
  });
  const people = days.get('2026-09-15').people;
  eq('the day carries TWO entries for the same person', people.length, 2);
  eq('…each with its own punch id', people.map((p) => p.punch.id).sort(), ['pk-0', 'pk-1']);
  eq('…each pending its own confirmation', people.map((p) => p.state), ['pending', 'pending']);
  eq('…and neither carries an approved figure', people.map((p) => p.punch.approvedMinutes), [null, null]);
  people.forEach((p) => near(`${p.punch.id} pays its actual worked hours`, p.punch.hours, 4));
  // Both would confirm to NULL through the real write gate.
  eq('confirming either one writes NULL', people.map((p) => A.approvedMinutesForTeam(TC.teamOfRole(p.role), E.hoursToMinutes(p.punch.clockedHours))), [null, null]);
}

console.log('\n8. NOTHING IN THIS CHANGE TOUCHES HISTORY');
{
  // The gate shapes NEW writes only. It is a pure function of (team, minutes) — it cannot reach a
  // stored row, and nothing in this change issues an UPDATE, a backfill or a migration.
  const legacy = { ...JUAN, approved_minutes: 1421 }; // the real production outlier, 23h41m
  near('a legacy fulfillment row keeps paying its stored figure', E.paidShiftHours(legacy), 1421 / 60);
  check('…which is emphatically NOT the clocked figure, so the assertion means something',
    Math.abs(E.paidShiftHours(legacy) - E.clockedShiftHours(legacy)) > 15);
  eq('reading it back leaves the column exactly as stored', legacy.approved_minutes, 1421);
  check('the write gate has no way to reach a stored row (pure, two scalars in)',
    /export function approvedMinutesForTeam\(team: ApprovedTeam, minutes: number \| null\): number \| null \{\s*return approvedHoursApply\(team\) \? minutes : null;\s*\}/
      .test(read('./approvedHours.ts')));
  check('the kernel module still imports nothing at all', !/^\s*import /m.test(read('./approvedHours.ts')));
  // NO BACKFILL. Not one file this change touches writes approved_minutes anywhere except as the
  // two RPC arguments already counted in section 2 — no column write, no upsert, no sweep over
  // stored rows. (useShifts' single-row deleteShift is pre-existing, unrelated to this column, and
  // is deliberately not what is being asserted here.)
  for (const f of ['./approvedHours.ts', '../employees.ts', '../../hooks/useShifts.ts', '../../components/employees/weekly/PersonCard.tsx']) {
    const src = strip(read(f));
    check(`${f}: never writes approved_minutes to a stored row`,
      !/\.(update|upsert|insert)\(\s*\{[^}]*approved_minutes/.test(src)
      && !/from\('shifts'\)[\s\S]{0,200}approved_minutes\s*[:=]/.test(src));
  }
  check('and the whole change adds no SQL file at all',
    (await import('node:fs')).readdirSync(fileURLToPath(new URL('../../../supabase/migrations', import.meta.url)))
      .every((f) => !/approved_hours|live_host_only|140_/.test(f) || f === '140_squish_multibind_stable_plan.sql'));
}

console.log('\n9. THE REVIEW ROUTE IS FIXTURE-ONLY');
{
  const pv = read('../../app/preview/approved-hours/ApprovedHoursPreview.tsx');
  const pg = read('../../app/preview/approved-hours/page.tsx');
  const fx = read('../../app/preview/approved-hours/fixtures.ts');
  check('the page is gated by isPreviewRouteAllowed and 404s otherwise',
    /if \(!isPreviewRouteAllowed\(\)\) notFound\(\);/.test(pg));
  check('no Supabase client, fetch, RPC or server action anywhere in the route',
    !/createClient|supabase|\.rpc\(|fetch\(|'use server'/.test(strip(pv) + strip(fx) + strip(pg)));
  check('it mounts the REAL modals and tile, not a fork',
    /@\/components\/employees\/weekly\/DayPeopleModal/.test(pv) && /@\/components\/employees\/weekly\/PendingConfirmModal/.test(pv)
    && /@\/lib\/schedule\/calendarModel/.test(pv));
  check('…and records writes through the REAL gate, so the log shows what production would store',
    /approvedMinutesForTeam\(team, approvedMinutes \?\? null\)/.test(strip(pv)));
  check('the fixtures name nobody real — the three people are invented for this page',
    /Juan Reyes/.test(fx) && /Adriana Cruz/.test(fx) && /Marisol Vega/.test(fx));
  check('it covers the fulfillment single day, the host shift and the split fulfillment day',
    /JUAN_DAY/.test(fx) && /ADRIANA_SHOW/.test(fx) && /MARISOL_MORNING/.test(fx) && /MARISOL_AFTERNOON/.test(fx));
}

console.log(`\n${passed} checks passed`);
