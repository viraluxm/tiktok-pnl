// APPROVED HOURS ARE FOR LIVE HOSTS ONLY.
//
// THE RULE THIS FILE EXISTS TO PROTECT, in one sentence: a FULFILLMENT shift has no Approved Hours
// input, no override control and no approved_minutes written through any app path, AND a stored
// approved_minutes has ZERO effect on what it pays — payroll always uses its canonical worked time
// (clock in → clock out − breaks) — while LIVE HOST behaviour is exactly what main shipped.
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
const timezone = transpile('../schedule/timezone.ts', 'timezone.mjs');
const ST = await import(transpile('../pay/statement.ts', 'statement.mjs', {
  "'@/lib/employees'": `'${employeesUrl}'`, "'@/lib/schedule/timezone'": `'${timezone}'`,
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

console.log('\n3. THE FULFILLMENT TILE — the manager is NEVER asked to approve anything');
{
  check('the tile computes the team once and gates on approvedHoursApply',
    /const team = teamOfRole\(person\.role\);/.test(CARD_CODE)
    && /const approvedApplies = approvedHoursApply\(team\);/.test(CARD_CODE));

  // ── NOTHING THAT ASKS FOR A NUMBER MAY RENDER ────────────────────────────────────────────────
  // Each of the four affordances is counted, then shown to sit behind the gate. Counting first is
  // what makes the gate assertions meaningful: a second, ungated copy would change the count.
  eq('there are exactly two approved-hours number inputs in the file',
    (CARD_CODE.match(/aria-label="Approved (hours|minutes)"/g) ?? []).length, 2);
  eq('…both inside the single `approvedInputs` block', (CARD_CODE.match(/const approvedInputs = \(/g) ?? []).length, 1);
  check('…which renders ONLY when approved hours apply',
    /\{approvedApplies && punch && !punch\.isOpen && punch\.confirmable && \(!punch\.confirmed \|\| adjusting\) && approvedInputs\}/.test(CARD_CODE));
  eq('…and is referenced nowhere else', (CARD_CODE.match(/approvedInputs/g) ?? []).length, 2);

  eq('there is exactly one "Adjust approved hours" control', (CARD_CODE.match(/Adjust approved hours/g) ?? []).length, 1);
  check('…and it renders ONLY when approved hours apply',
    /\{approvedApplies && punch && !punch\.isOpen && punch\.confirmed && onApprovedMinutes && \(/.test(CARD_CODE));
  eq('there is exactly one "Approved hours" label and one "Approved" read-out heading',
    [(CARD_CODE.match(/>Approved hours<\/div>/g) ?? []).length, (CARD_CODE.match(/>Approved<\/div>/g) ?? []).length], [1, 1]);
  check('…and the read-out is gated too', /\{approvedApplies && punch && !punch\.isOpen && punch\.approvedMinutes != null/.test(CARD_CODE));

  // ── NO VALIDATION MAY FIRE ───────────────────────────────────────────────────────────────────
  // Both parseApprovedInput calls sit behind approvedApplies, so APPROVED_INPUT_MESSAGES — MISSING
  // included — is unreachable for a fulfillment shift. There is no path to "enter the approved
  // hours for this shift" on a tile that never offered a box.
  eq('parseApprovedInput is called exactly twice', (CARD_CODE.match(/parseApprovedInput\(/g) ?? []).length, 2);
  check('…once behind the ternary in confirm',
    /const parsed = approvedApplies\s*\?\s*parseApprovedInput\(approved\.hours, approved\.minutes, mustApprove\)\s*:\s*\(\{ ok: true, minutes: null \} as const\);/
      .test(CARD_CODE));
  check('…and once in saveApproved, which returns early for a team without approved hours',
    /if \(!punch \|\| !onApprovedMinutes \|\| !approvedApplies\) return;/.test(CARD_CODE));
  eq('APPROVED_INPUT_MESSAGES is only ever read from a parse result',
    (CARD_CODE.match(/APPROVED_INPUT_MESSAGES\[parsed\.code\]/g) ?? []).length, 2);
  check('…and there is no other way to set an approved-hours error on the tile',
    (CARD_CODE.match(/APPROVED_INPUT_MESSAGES/g) ?? []).length === 3);

  // ── CONFIRM IS ONE CLICK ─────────────────────────────────────────────────────────────────────
  check('confirm skips the parser and sends an explicit null when approved hours do not apply',
    /approvedApplies\s*\?[\s\S]{0,120}\{ ok: true, minutes: null \}/.test(CARD_CODE));
  eq('every confirm call carries the team', (CARD_CODE.match(/onConfirm\(punch\.id, (?:false|true), team/g) ?? []).length, 2);
  check('the override call carries the team too', /onApprovedMinutes\(punch\.id, team, parsed\.minutes\)/.test(CARD_CODE));
  check('there is no second confirmation step, modal or state between the button and onConfirm',
    /onClick=\{\(\) => run\(true\)\}/.test(CARD_CODE) && !/setStep|setPendingConfirm|confirmStage/.test(CARD_CODE));
  // …and what that click sends really is NULL, through the real write gate.
  eq('a fulfillment confirm writes NULL no matter what figure is in hand',
    [480, 0, 1421, null].map((m) => A.approvedMinutesForTeam('fulfillment', m)), [null, null, null, null]);

  // ── WHAT THE TILE DOES SHOW ──────────────────────────────────────────────────────────────────
  // CLOCKED span, BREAK, PAID HOURS — the arithmetic, and nothing to decide.
  check('a non-host tile shows the CLOCKED range', /range\(punch\.start_time, punch\.end_time\)/.test(CARD_CODE));
  check('…a BREAK line, always, so the deduction is visible even at 0 min',
    />Break<\/div>[\s\S]{0,200}\{punch\.breakMinutes\} min/.test(CARD_CODE));
  check('…and a PAID HOURS line read from punch.hours, the payable figure',
    />Paid hours<\/div>[\s\S]{0,200}fmtPaidHours\(punch\.hours\)/.test(CARD_CODE));
  check('…printed in decimal hours, the unit Pay Details and the PDF use',
    /return `\$\{hours\.toFixed\(2\)\} hr`;/.test(CARD_CODE));
  check('…and it is NOT re-derived from clockedHours on that branch',
    !/approvedApplies[\s\S]{0,80}:[\s\S]{0,300}hoursToMinutes\(punch\.clockedHours\)[\s\S]{0,40}Paid/.test(CARD_CODE));
  check('an OPEN punch says "in progress" rather than printing a paid figure',
    /punch\.isOpen \? \(\s*<div className="text-\[10\.5px\] text-tt-muted">in progress<\/div>/.test(CARD_CODE));
  check('Edit and Confirm are still the only two actions', />Edit<\/button>/.test(CARD) && /'Confirm'/.test(CARD_CODE));
  // The HOST branch of the same block is untouched.
  check('a host tile still shows its clocked duration and inline break, as before',
    /approvedApplies \? \(\s*<div className="text-\[10\.5px\] tabular-nums text-tt-muted">\s*\{punch\.isOpen \? 'in progress' : formatApprovedMinutes\(hoursToMinutes\(punch\.clockedHours\)\)\}/.test(CARD_CODE));
}

console.log('\n3b. ONE TILE, EVERY CONFIRMATION SURFACE — so the rule cannot be missed anywhere');
{
  // The rule lives in PersonCard. That is only sufficient if PersonCard is the ONLY thing a
  // manager can confirm worked time from, so this sweeps for a second one rather than assuming.
  const { readdirSync, statSync } = await import('node:fs');
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const files = [];
  (function walk(d) {
    for (const n of readdirSync(d)) {
      if (n === 'node_modules' || n === '.next') continue;
      const p2 = join(d, n);
      if (statSync(p2).isDirectory()) walk(p2);
      else if (/\.tsx$/.test(n)) files.push(p2);
    }
  })(root);

  // A manager confirmation surface is one that renders an approved-hours input, or an
  // Unconfirm control, or calls the confirm callback with a shift id.
  const surfaces = files.filter((f) => {
    const src = strip(readFileSync(f, 'utf8'));
    return /aria-label="Approved (hours|minutes)"/.test(src)
      || />Unconfirm</.test(src)
      || /onConfirm\(punch\.id/.test(src);
  }).map((f) => f.slice(root.length).replace(/^\//, ''));
  eq('exactly one component renders manager shift confirmation', surfaces,
    ['components/employees/weekly/PersonCard.tsx']);

  // Everything that mounts it passes the callbacks straight through, so each surface inherits the
  // gate rather than re-deciding it. (Previews included — they mount the production tile.)
  const mounts = files.filter((f) => /<PersonCard\b/.test(readFileSync(f, 'utf8')))
    .map((f) => f.slice(root.length).replace(/^\//, '')).sort();
  eq('and these are every surface that mounts it — the day modal, the confirm queue, one preview',
    mounts, [
      'app/preview/employee-portal/PortalPreview.tsx',
      'components/employees/weekly/DayPeopleModal.tsx',
      'components/employees/weekly/PendingConfirmModal.tsx',
    ]);
  // The approved-hours review route mounts the two MODALS rather than the tile directly, which is
  // the point: it exercises the same path a manager takes, not a shortcut around it.
  const ahPreview = read('../../app/preview/approved-hours/ApprovedHoursPreview.tsx');
  check('the review route reaches the tile through the real day modal and confirm queue',
    /<DayPeopleModal/.test(ahPreview) && /<PendingConfirmModal/.test(ahPreview) && !/<PersonCard/.test(ahPreview));
  for (const m of mounts) {
    const src = strip(readFileSync(join(root, m), 'utf8'));
    check(`${m}: passes onConfirm through without adding an approved-hours step`,
      /onConfirm=\{/.test(src) && !/aria-label="Approved/.test(src) && !/parseApprovedInput/.test(src));
  }
  // The day modal and the confirm queue — the two production ones — declare the team-carrying
  // signature, so neither can be handed a stale three-argument callback.
  for (const m of ['components/employees/weekly/DayPeopleModal.tsx', 'components/employees/weekly/PendingConfirmModal.tsx']) {
    const src = readFileSync(join(root, m), 'utf8');
    check(`${m}: declares the team-carrying confirm signature`,
      /onConfirm: \(shiftId: string, confirmed: boolean, team: ApprovedTeam, approvedMinutes\?: number \| null\) => Promise<void>;/.test(src)
      && /onApprovedMinutes\?: \(shiftId: string, team: ApprovedTeam, approvedMinutes: number \| null\) => Promise<void>;/.test(src));
  }
  // And the month calendar — the one production container — forwards the team to useShifts.
  const cal = strip(read('../../components/employees/weekly/ScheduleMonthCalendar.tsx'));
  check('the calendar container forwards the team to both mutations',
    /confirmShift\.mutateAsync\(\{ id: shiftId, confirmed, team, approvedMinutes \}\)/.test(cal)
    && /setApprovedMinutes\.mutateAsync\(\{ id: shiftId, team, approvedMinutes \}\)/.test(cal));
}

console.log('\n4. A LEGACY FULFILLMENT FIGURE IS NOT SHOWN — because it no longer pays anything');
{
  // 40 rows were confirmed BEFORE this change and still carry a value, one of them by 16 hours.
  // Those values are audit history now: paidShiftHours ignores them for a fulfillment employee, so
  // printing one beside the punch would be printing a number that pays nobody. The read-out is
  // therefore gated on the TEAM, not merely on the presence of a stored value.
  check('the read-only Approved line renders only where approved hours apply',
    /\{approvedApplies && punch && !punch\.isOpen && punch\.approvedMinutes != null && !adjusting && \(/.test(CARD_CODE));
  // …and the PAID HOURS the tile prints is punch.hours, which for that row is the punch — so the
  // 1421 is invisible on screen precisely because it is invisible to payroll.
  check('the non-host branch prints punch.hours and never punch.approvedMinutes',
    />Paid hours<\/div>[\s\S]{0,200}fmtPaidHours\(punch\.hours\)/.test(CARD_CODE));
  // punch.approvedMinutes is read on exactly four lines, and every one of them sits on a path a
  // non-host cannot reach. Enumerated rather than counted, so a fifth read has to be classified.
  const amLines = CARD_CODE.split('\n').map((l) => l.trim()).filter((l) => l.includes('punch.approvedMinutes'));
  eq('punch.approvedMinutes is read on exactly four lines', amLines.length, 4);
  check('1/4 — the input prefill, behind `approvedApplies &&` on the same expression',
    /const defaultMinutes = approvedApplies && punch/.test(CARD_CODE) && amLines[0].startsWith('? (punch.approvedMinutes'));
  check('2/4 — the read-out gate, which begins with approvedApplies',
    amLines[1].startsWith('{approvedApplies && punch'));
  check('3/4 — the read-out itself, inside that gate', amLines[2].includes('formatApprovedMinutes(punch.approvedMinutes)'));
  check('4/4 — the Cancel reset, inside the host-gated adjust block',
    amLines[3].includes('setApproved(splitApprovedMinutes(punch.approvedMinutes'));
  check('…and that adjust block is itself gated on approvedApplies',
    CARD_CODE.indexOf('{approvedApplies && punch && !punch.isOpen && punch.confirmed && onApprovedMinutes')
      < CARD_CODE.indexOf('setApproved(splitApprovedMinutes(punch.approvedMinutes'));
  // A row confirmed under THIS build has approved_minutes null anyway.
  eq('a fulfillment row confirmed under this build carries no figure at all',
    A.approvedMinutesForTeam('fulfillment', E.hoursToMinutes(E.clockedShiftHours(JUAN))), null);
}

console.log('\n5. FULFILLMENT PAYROLL IS ALWAYS THE CANONICAL WORKED TIME');
{
  near('clock in → clock out − breaks = 7h23m17s', E.clockedShiftHours(JUAN), (8 * 3600 + 3 * 60 + 17 - 40 * 60) / 3600);
  near('with approved_minutes NULL, paidShiftHours pays exactly that', E.paidShiftHours(JUAN, 'fulfillment'), E.clockedShiftHours(JUAN));
  eq('the shift is payable on its own (approval is not a payability gate)', E.isPayableShift(JUAN), true);

  // THE CORE ASSERTION. A stored value — any stored value — changes nothing for fulfillment.
  for (const m of [0, 1, 180, 443, 480, 1421, 1440]) {
    near(`approved ${m} min has ZERO effect on a fulfillment shift`,
      E.paidShiftHours({ ...JUAN, approved_minutes: m }, 'fulfillment'), E.clockedShiftHours(JUAN));
  }
  check('…and those same values DO move a host, so the loop above is not vacuous',
    [0, 180, 1421].every((m) => E.paidShiftHours({ ...JUAN, approved_minutes: m }, 'host') === m / 60));
  near('an unclassified role is paid its punch too — the safe side, never the host exception',
    E.paidShiftHours({ ...JUAN, approved_minutes: 1421 }, 'other'), E.clockedShiftHours(JUAN));

  // The old prefill's rounding is gone as well: NULL keeps the span to the second.
  const prefill = E.hoursToMinutes(E.clockedShiftHours(JUAN));
  check('the old prefill would have rounded the span to whole minutes',
    Math.abs(prefill / 60 - E.clockedShiftHours(JUAN)) > 0, `${prefill} min vs ${E.clockedShiftHours(JUAN)} h`);
  near('…and payroll now keeps the exact span regardless', E.paidShiftHours({ ...JUAN, approved_minutes: prefill }, 'fulfillment'), E.clockedShiftHours(JUAN));

  // computePay is the money path, and it resolves the team from the roster it was handed — the
  // caller never states it, so no caller can state it wrongly.
  const FUL = { id: 'e-juan', name: 'Juan Reyes', role: 'fulfillment', hourly_rate: 22, status: 'active', user_id: 'o', hire_date: null, probation_end_date: null, created_at: '', updated_at: '' };
  const legacy = { ...JUAN, approved_minutes: 1421 };
  near('computePay hours = the canonical worked time, even on a legacy override',
    E.computePay([FUL], [legacy])[0].hours, E.clockedShiftHours(JUAN));
  near('computePay pay = those hours × rate', E.computePay([FUL], [legacy])[0].pay, E.clockedShiftHours(JUAN) * 22);
  near('the SAME row for a host pays the override — the roster role is what decides',
    E.computePay([{ ...FUL, role: 'host' }], [legacy])[0].hours, 1421 / 60);
  eq('the roster vocabulary is teamOfRole\'s, character for character', [
    E.payrollTeamOfRole('host'), E.payrollTeamOfRole('Live Host'), E.payrollTeamOfRole('  FULFILLMENT '),
    E.payrollTeamOfRole('warehouse lead'), E.payrollTeamOfRole(null), E.payrollTeamOfRole(undefined), E.payrollTeamOfRole(''),
  ], ['host', 'host', 'fulfillment', 'other', 'other', 'other', 'other']);
  for (const r of ['host', 'Live Host', '  LIVE HOST ', 'fulfillment', ' Fulfillment ', 'warehouse lead', '', null, undefined]) {
    eq(`payrollTeamOfRole(${JSON.stringify(r)}) === teamOfRole(...)`, E.payrollTeamOfRole(r), TC.teamOfRole(r));
  }
  eq('approvedMinutesPay (payroll) and approvedHoursApply (UI/write) agree on every team',
    ['host', 'fulfillment', 'other'].map((t) => [E.approvedMinutesPay(t), A.approvedHoursApply(t)]),
    [[true, true], [false, false], [false, false]]);

  // clockedShiftHours is NOT rewritten, and paidShiftHours' host branch is the same arithmetic.
  const emp_ts = strip(read('../employees.ts'));
  check('clockedShiftHours is untouched: instants preferred, break subtracted, floored at 0',
    /const spanH = \(new Date\(s\.clock_out_at\)\.getTime\(\) - new Date\(s\.clock_in_at\)\.getTime\(\)\) \/ 3_600_000;/.test(emp_ts)
    && /return Math\.max\(0, spanH - breakHours\);/.test(emp_ts));
  check('the host branch still divides the stored minutes by 60, floored at 0',
    /if \(approvedMinutesPay\(team\)\) return Math\.max\(0, s\.approved_minutes \/ 60\);/.test(emp_ts));
  // The team is never defaulted, in either direction.
  check('paidShiftHours declares team as a REQUIRED parameter',
    /export function paidShiftHours\(s: ShiftLike, team: PayrollTeam\): number/.test(emp_ts)
    && !/team: PayrollTeam = /.test(emp_ts) && !/team\?: PayrollTeam/.test(emp_ts));
  let threw = false;
  try { E.paidShiftHours({ ...JUAN, approved_minutes: 480 }); } catch { threw = true; }
  check('…and omitting it on a row that carries a stored value throws rather than guessing', threw);
  check('omitting it on a row with NO stored value is harmless (the team cannot change the answer)',
    Math.abs(E.paidShiftHours(JUAN) - E.clockedShiftHours(JUAN)) < 1e-12);
}

console.log('\n5b. ROBERTO — the real production row, under the new rule');
{
  // THE REAL ROW, copied field for field out of production on 2026-09-12 (read-only):
  //   shift  bc7a1b1b-6440-40bf-8e95-7cb52c300435   Roberto, fulfillment, $22.00/h
  //   date   2026-09-10
  //   punch  2026-09-10 23:55:17.31674+00 → 2026-09-11 08:00:00+00   (LA 16:55:17 → 01:00:00)
  //   break  25 min       approved_minutes 1421 (23h41m)
  // Under the OLD rule the stored figure paid: 23.6833h × $22 = $521.03.
  // Under THIS rule the punch pays: 8.078523h span − 25m = 7.661856h × $22 = $168.56.
  const ROBERTO = {
    employee_id: 'e-roberto', date: '2026-09-10',
    start_time: '16:55:00', end_time: '01:00:00',
    source: 'time_clock', source_rule_id: null, confirmed_at: '2026-09-11T00:00:00Z',
    break_minutes: 25,
    clock_in_at: '2026-09-10T23:55:17.31674+00:00', clock_out_at: '2026-09-11T08:00:00+00:00',
    approved_minutes: 1421,
  };
  const EMP_R = { id: 'e-roberto', name: 'Roberto', role: 'fulfillment', hourly_rate: 22, status: 'active', user_id: 'o', hire_date: null, probation_end_date: null, created_at: '', updated_at: '' };
  const canonical = E.clockedShiftHours(ROBERTO);
  check('the raw punch span is 8.078523h', Math.abs((Date.parse(ROBERTO.clock_out_at) - Date.parse(ROBERTO.clock_in_at)) / 3_600_000 - 8.078523) < 1e-6);
  check('the canonical figure is 7.661856h (span − 25m break)', Math.abs(canonical - 7.661856) < 1e-6, `${canonical}`);
  near('paidShiftHours pays the punch, not the 23h41m', E.paidShiftHours(ROBERTO, 'fulfillment'), canonical);
  check('the old rule would have paid 23.6833h — the difference is 16.02 hours of real money',
    Math.abs(E.paidShiftHours(ROBERTO, 'host') - canonical - 16.0215) < 1e-3,
    `${E.paidShiftHours(ROBERTO, 'host')} vs ${canonical}`);
  near('computePay agrees', E.computePay([EMP_R], [ROBERTO])[0].hours, canonical);
  check('gross pay is $168.56, not $521.03',
    Math.abs(E.computePay([EMP_R], [ROBERTO])[0].pay - 168.56) < 0.005,
    `$${E.computePay([EMP_R], [ROBERTO])[0].pay.toFixed(2)}`);
  // Pay Details and the PDF both render buildPayStatement's rows, so proving it here proves both.
  const stmt = ST.buildPayStatement({
    employee: EMP_R, period: { start: '2026-08-31', end: '2026-09-13', payday: '2026-09-18' },
    shifts: [{ ...ROBERTO, id: 'bc7a1b1b', user_id: 'o' }], generatedAtISO: '2026-09-14T00:00:00Z',
  });
  eq('the statement has exactly one payable row', stmt.rows.length, 1);
  check('Pay Details shows 7.661856 paid hours', Math.abs(stmt.rows[0].paidHours - 7.661856) < 1e-6, `${stmt.rows[0].paidHours}`);
  check('…at $22.00, for $168.56', stmt.rows[0].rate === 22 && Math.abs(stmt.rows[0].amount - 168.56) < 0.005, `$${stmt.rows[0].amount.toFixed(2)}`);
  check('…and the statement total is the same $168.56 over 7.661856 hours',
    Math.abs(stmt.totals.gross - 168.56) < 0.005 && Math.abs(stmt.totals.paidHours - 7.661856) < 1e-6,
    `$${stmt.totals.gross.toFixed(2)} / ${stmt.totals.paidHours}h`);
  check('the row still prints the real punch times, unedited',
    stmt.rows[0].breakMinutes === 25 && stmt.rows[0].dateISO === '2026-09-10');
  eq('the stored 1421 is untouched — this feature reads it, never writes it', ROBERTO.approved_minutes, 1421);
}

console.log('\n6. LIVE HOST — everything main shipped, unchanged');
{
  const ADRIANA = {
    ...JUAN, employee_id: 'e-adriana', break_minutes: 0,
    start_time: '16:00:00', end_time: '22:00:00',
    clock_in_at: '2026-09-15T16:00:00-07:00', clock_out_at: '2026-09-15T22:00:00-07:00',
  };
  near('the clocked span is 6h', E.clockedShiftHours(ADRIANA), 6);
  near('an approved 5h20m pays 5h20m, not the 6h punch', E.paidShiftHours({ ...ADRIANA, approved_minutes: 320 }, 'host'), 320 / 60);
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

  // THE HOST SERVER PATH IS UNTOUCHED. 139 still refuses a host with no figure; 149 keeps that
  // line and every other line of the host branch exactly as it is (see section 10).
  const mig = read('../../../supabase/migrations/139_shift_approved_minutes.sql');
  check('139 still raises HOST_APPROVED_MINUTES_REQUIRED', /HOST_APPROVED_MINUTES_REQUIRED/.test(mig));
  check('139 still gates that on the host role predicate', /lower\(btrim\(e\.role\)\) in \('host', 'live host'\)/.test(mig));
  check('139 is not edited by this change — it is the applied record of what production runs',
    /✅ APPLIED TO PRODUCTION 2026-09-09/.test(mig));
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
  near('a legacy fulfillment row still holds its stored figure', legacy.approved_minutes / 60, 1421 / 60);
  near('…but pays its punch, because the payroll rule ignores it', E.paidShiftHours(legacy, 'fulfillment'), E.clockedShiftHours(legacy));
  check('…and the two are 16h apart, so that assertion means something',
    Math.abs(1421 / 60 - E.clockedShiftHours(legacy)) > 15);
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
  // The ONE migration this change adds writes no data either — asserted in full in section 10.
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
  check('…and the Roberto legacy-override case, with the stored 1421 minutes',
    /ROBERTO_LEGACY/.test(fx) && /approved_minutes: 1421/.test(fx) && /break_minutes: 25/.test(fx));
  check('the preview prints the payable figure from DayPunch.hours, never re-deriving one',
    /formatApprovedMinutes\(hoursToMinutes\(p\.punch!\.hours\)\)/.test(pv)
    && !/approved_minutes \/ 60/.test(strip(pv)));
}

console.log('\n10. THE SERVER ENFORCES IT TOO — migration 149');
{
  const M = read('../../../supabase/migrations/149_approved_minutes_live_host_only.sql');
  // `--` comments are not touched by strip() (it is JS-oriented), so isolate executable SQL before
  // asserting anything about what the file DOES. The header quotes error names and rollback notes.
  const code = M.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

  // CONFIRM: a non-host's argument is coerced to NULL before anything can write it.
  check('confirm computes v_approved from the host predicate',
    /v_approved := case when v_is_host is true then p_approved_minutes else null end;/.test(code));
  check('…and the UPDATE writes v_approved, never the raw argument',
    /approved_minutes = coalesce\(v_approved, approved_minutes\)/.test(code)
    && !/approved_minutes = coalesce\(p_approved_minutes/.test(code));
  check('…and the write is not even entered unless v_approved is non-null or it is a first confirm',
    /if v_shift\.confirmed_at is null or v_approved is not null then/.test(code));
  // Inside the CONFIRM body specifically, the raw argument may appear only in the signature, the
  // range check and the coercion. Any fourth mention is a path that could write it unfiltered.
  const confirmSql = code.slice(
    code.indexOf('create or replace function public.lensed_confirm_time_clock_shift'),
    code.indexOf('create or replace function public.lensed_set_approved_minutes'),
  );
  check('the confirm body isolates cleanly', confirmSql.length > 500 && confirmSql.includes('v_approved :='));
  // Three lines only: the signature, the 0..1440 range check (three mentions on one line), and
  // the coercion. Five mentions in total; a sixth would be a path that writes it unfiltered.
  eq('p_approved_minutes appears in confirm only as signature, range check and coercion',
    (confirmSql.match(/p_approved_minutes/g) ?? []).length, 5);
  eq('…on exactly three lines',
    confirmSql.split('\n').filter((l) => l.includes('p_approved_minutes')).length, 3);
  // set_approved_minutes DOES write the raw argument — correctly, because by that line the shift
  // has already been proven to belong to a live host and anything else has raised.
  const setSql = code.slice(code.indexOf('create or replace function public.lensed_set_approved_minutes'));
  check('the correction RPC raises for a non-host BEFORE it reaches its UPDATE',
    setSql.indexOf("raise exception 'APPROVED_MINUTES_NOT_ALLOWED_FOR_TEAM'") < setSql.indexOf('update public.shifts')
    && setSql.indexOf("raise exception 'APPROVED_MINUTES_NOT_ALLOWED_FOR_TEAM'") > 0);

  // SET-APPROVED-MINUTES: a non-host is refused outright.
  check('the correction RPC refuses a non-host',
    /if v_is_host is distinct from true then\s*raise exception 'APPROVED_MINUTES_NOT_ALLOWED_FOR_TEAM'/.test(code));
  check('…using `is distinct from true`, so a NULL role lookup is refused too, not allowed through',
    !/if v_is_host is false then/.test(code));
  check('the refusal token has a manager-readable sentence in the app',
    /APPROVED_MINUTES_NOT_ALLOWED_FOR_TEAM/.test(read('../timeclock.ts'))
    && /Approved hours apply to Live Hosts only/.test(read('../timeclock.ts')));

  // BOTH new lookups use the SAME role vocabulary as teamOfRole and as 139, and both are
  // owner-scoped — a shift belonging to another tenant must not be classifiable at all.
  const predicates = code.match(/lower\(btrim\(e\.role\)\) in \([^)]*\)/g) ?? [];
  eq('both functions use the same host predicate, twice', predicates.length, 2);
  for (const pr of predicates) eq('…and it is the teamOfRole vocabulary', pr, "lower(btrim(e.role)) in ('host', 'live host')");
  eq('both employees lookups are scoped to the calling owner',
    (code.match(/where e\.id = v_shift\.employee_id and e\.user_id = v_user;/g) ?? []).length, 2);

  // THE HOST PATH IS UNCHANGED, line for line.
  check('the host requirement is still raised', /HOST_APPROVED_MINUTES_REQUIRED/.test(code));
  check('the range check is still 0..1440', /p_approved_minutes < 0 or p_approved_minutes > 1440/.test(code));
  check('ownership, source, closed-entry and open-break guards all survive',
    ['SHIFT_NOT_FOUND', 'SHIFT_NOT_TIME_CLOCK', 'SHIFT_NOT_CLOSED', 'TIME_ENTRY_NOT_FOUND',
      'TIME_ENTRY_NOT_CLOSED', 'BREAK_OPEN', 'SHIFT_NOT_CONFIRMED', 'NOT_AUTHENTICATED']
      .every((t) => code.includes(t)));
  check('the punch is never written', !/(update public\.shifts[\s\S]*?where)[\s\S]*?/.test(code)
    || (code.match(/update public\.shifts[\s\S]*?where/g) ?? []).every((u) => !/clock_in_at|clock_out_at|start_time|end_time/.test(u)));

  // SECURITY POSTURE PRESERVED — verified against pg_proc before writing this file.
  check('neither function is turned into SECURITY DEFINER', !/security definer/i.test(code));
  eq('both keep set search_path to public', (code.match(/set search_path to 'public'/g) ?? []).length, 2);
  eq('both keep language plpgsql returning jsonb', (code.match(/returns jsonb\s*language plpgsql/g) ?? []).length, 2);
  eq('both re-issue their grant to authenticated (CONVENTIONS.md)',
    (code.match(/grant execute on function[^\n]*to authenticated;/g) ?? []).length, 2);
  check('…and to nothing else', !/to service_role|to anon|to public/.test(code));
  check('neither is registered service-role-only',
    !/lensed_set_approved_minutes|lensed_confirm_time_clock_shift/.test(read('../../../scripts/check-rpc-grants.mjs')));

  // NO DATA IS TOUCHED. This is the assertion the whole "historical rows are preserved" promise
  // rests on, so it is made against executable SQL only.
  const updates = code.match(/update public\.shifts[\s\S]*?where [^\n]*/g) ?? [];
  eq('exactly two UPDATEs, both inside a function body and both keyed to one shift id', updates.length, 2);
  for (const u of updates) check('…scoped `where id = p_shift_id`', /where id = p_shift_id/.test(u), u.slice(-40));
  check('no DELETE, no INSERT, no backfill, no ALTER, no DROP anywhere in executable SQL',
    !/\b(delete\s+from|insert\s+into|alter\s+table|drop\s+\w+|truncate)\b/i.test(code),
    (code.match(/\b(delete\s+from|insert\s+into|alter\s+table|drop\s+\w+|truncate)\b/gi) ?? []).join(' | '));
  check('…and nothing sweeps the column across rows',
    !/set approved_minutes = null\s*(where\s+)?(;|$)/im.test(code) && !/approved_minutes is not null[\s\S]{0,40}update/i.test(code));

  // OPERATIONAL SAFETY, per CLAUDE.md and CONVENTIONS.md.
  check('one transaction', (code.match(/^begin;$/gm) ?? []).length === 1 && (code.match(/^commit;$/gm) ?? []).length === 1);
  check('a lock_timeout is set before touching anything', /^set local lock_timeout = '3s';$/m.test(code));
  // This DB has no migration ledger, so the header IS the applied-state record (same rule as 139).
  check('the header records that it IS applied, with a timestamp, and does not still claim otherwise',
    /✅ APPLIED TO PRODUCTION 2026-09-12 05:18 UTC/.test(M) && !/⛔ NOT APPLIED/.test(M));
  check('…and warns against applying it a second time', /DO NOT APPLY IT AGAIN/.test(M));
  check('…and records the before/after evidence CLAUDE.md requires',
    /capture path never paused/.test(M) && /md5\(prosrc\) before\/after/.test(M)
    && /DATA UNTOUCHED/.test(M) && /62 rows total, 40 of/.test(M));
  check('…and the live behaviour check, including that it was rolled back',
    /ROLLED BACK/.test(M) && /APPROVED_MINUTES_NOT_ALLOWED_FOR_TEAM/.test(M));
  check('…and states the CODE-FIRST deploy order, which is the reverse of 139',
    /DEPLOY ORDER — CODE FIRST/.test(M) && /OPPOSITE OF 139/.test(M));
  check('…and records the live prosrc md5s it was diffed against',
    /d5adb95d2d90eadeaed090e26d3a7ac3/.test(M) && /347f2bcdda9a1c45fa0f82bcd1e54b51/.test(M));
  check('…and documents its rollback', /^-- ROLLBACK$/m.test(M) && /139_shift_approved_minutes\.sql, sections 3 and 5/.test(M));
  check('…and carries post-apply verification that proves its own lookups found rows',
    /POST-APPLY VERIFICATION/.test(M) && /or the comparison is\n--     vacuous/.test(M));
  check('…and states plainly that no historical value is modified',
    /NO DATA IS MODIFIED/.test(M) && /separately-approved change/.test(M));
  // The DB has no migration ledger, so the file is where the owner's two decisions are recorded.
  check('…and records the owner-approved CODE-FIRST release sequence',
    /CODE-FIRST ORDER EXPLICITLY APPROVED BY THE OWNER, 2026-09-11/.test(M)
    && /read-only production smoke test/.test(M) && /only then apply this migration/.test(M));
  check('…and records the owner-approved decision to KEEP the 40 historical rows',
    /HISTORICAL ROWS: KEEP, EXPLICITLY DECIDED BY THE OWNER, 2026-09-11/.test(M)
    && /NOT to be bulk\n--      cleared/.test(M));
}

console.log(`\n${passed} checks passed`);
