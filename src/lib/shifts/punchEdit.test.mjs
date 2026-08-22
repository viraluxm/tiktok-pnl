// PUNCH-INSTANT EDIT: conversion, DST, overnight, display parity, and the confirm-gate
// regression. Exercises the REAL punchInstantsForWallClock (punchEdit.ts), the REAL
// paidShiftHours/isPayableShift (employees.ts), the REAL instantHours/cardFromShift path
// (weeklySchedule.ts) and the REAL computeConfirmFlags (schedule/confirmFlags.ts), all
// transpiled at runtime — no reimplementation of any of them here.
//
// Run:  TZ=UTC node src/lib/shifts/punchEdit.test.mjs
//       TZ=Asia/Tokyo node src/lib/shifts/punchEdit.test.mjs   (must be host-TZ independent)
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'punchedit-'));
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
const employeesUrl = transpile('../employees.ts', 'employees.mjs');
const flagsUrl = transpile('../schedule/confirmFlags.ts', 'confirmFlags.mjs');
const punchUrl = transpile('./punchEdit.ts', 'punchEdit.mjs', {
  "'@/lib/schedule/timezone'": `'${tzUrl}'`,
  "'@/lib/weeklySchedule'": `'${weeklyUrl}'`,
});

const { punchInstantsForWallClock, buildShiftEditPatch, REOPEN_PUNCH_ERROR } = await import(punchUrl);
const { indexWeekCards, instantHours, durationHours } = await import(weeklyUrl);
const { paidShiftHours, isPayableShift, shiftHours } = await import(employeesUrl);
const { computeConfirmFlags, IMPLAUSIBLE_SPAN_HOURS } = await import(flagsUrl);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name}${extra ? ` — ${extra}` : ''}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// A stored time_clock row, exactly as `shifts` holds one. Punch instants and wall clock agree
// at first (this is what lensed_clock_out writes); an edit is applied via applyEdit() below.
const punchRow = (over = {}) => ({
  id: 'sh-1',
  employee_id: 'e1',
  date: '2026-08-12',
  start_time: '06:10',
  end_time: '14:10',
  source: 'time_clock',
  source_rule_id: null,
  confirmed_at: '2026-08-15T23:36:00.000Z',
  break_minutes: 0,
  clock_in_at: '2026-08-12T13:10:00.000Z', // 06:10 PT
  clock_out_at: '2026-08-12T21:10:00.000Z', // 14:10 PT
  ...over,
});

// Applies an edit by calling the REAL buildShiftEditPatch — the same function useShifts.
// updateShift calls — and merging its patch onto the row exactly as the UPDATE would. Nothing
// about which-column-wins is reimplemented here.
function applyEdit(row, edit) {
  const patch = buildShiftEditPatch(row, edit);
  return patch == null ? row : { ...row, ...patch };
}

// ═══ 1 — the core repair: editing a punch row moves the instants AND the wall clock ═══
console.log('\n1 — edit writes the punch instants');
{
  // The real 8/12 correction: 21:12 PT clock-out corrected back to 14:12 PT.
  const row = punchRow({ end_time: '21:12', clock_out_at: '2026-08-13T04:12:00.000Z' });
  const after = applyEdit(row, { end_time: '14:12' });

  check('clock_out_at CHANGED', after.clock_out_at !== row.clock_out_at,
    `${row.clock_out_at} → ${after.clock_out_at}`);
  check('clock_out_at is the corrected instant (14:12 PT = 21:12Z)',
    after.clock_out_at === '2026-08-12T21:12:00.000Z', after.clock_out_at);
  check('clock_in_at recomputed to the same instant (start untouched)',
    after.clock_in_at === '2026-08-12T13:10:00.000Z', after.clock_in_at);
  check('start_time/end_time stay IN SYNC with the instants',
    after.start_time === '06:10' && after.end_time === '14:12',
    `${after.start_time}–${after.end_time}`);

  // The actual regression this PR fixes: paidShiftHours must return the CORRECTED number.
  const paidBefore = paidShiftHours(row);
  const paidAfter = paidShiftHours(after);
  check('paidShiftHours BEFORE the fix would have paid the raw span', near(paidBefore, 15.033333333333333),
    `${paidBefore}h`);
  check('paidShiftHours AFTER the edit returns the CORRECTED span', near(paidAfter, 8.033333333333333),
    `${paidAfter}h`);
  check('the correction is no longer discarded', paidAfter < paidBefore,
    `${paidBefore}h → ${paidAfter}h`);
  check('paid hours now equal the wall clock the admin entered',
    near(paidAfter, shiftHours(after.start_time, after.end_time) - after.break_minutes / 60),
    `paid=${paidAfter} wall=${shiftHours(after.start_time, after.end_time)}`);
  // Regression guard for the exact old bug: the pre-fix write (wall clock only) must NOT move pay.
  const wallOnly = { ...row, end_time: '14:12' };
  check('CONTROL: wall-clock-only write leaves pay unchanged (the bug)',
    near(paidShiftHours(wallOnly), paidBefore), `${paidShiftHours(wallOnly)}h`);
}

// ═══ 2 — break minutes are untouched and still subtracted ═══
console.log('\n2 — break minutes preserved');
{
  const row = punchRow({ break_minutes: 30 });
  const after = applyEdit(row, { start_time: '06:00', end_time: '14:00' });
  check('break_minutes unchanged by the edit', after.break_minutes === 30);
  check('paid hours = corrected span − break (8h − 0.5h)', near(paidShiftHours(after), 7.5),
    `${paidShiftHours(after)}h`);
}

// ═══ 3 — overnight: end < start puts the OUT instant on date+1 ═══
console.log('\n3 — overnight');
{
  const row = punchRow({ date: '2026-08-12', start_time: '22:00', end_time: '06:00',
    clock_in_at: '2026-08-13T05:00:00.000Z', clock_out_at: '2026-08-13T13:00:00.000Z' });
  const after = applyEdit(row, { start_time: '22:00', end_time: '05:30' });
  check('in instant is on the shift date (Aug 12 22:00 PDT = Aug 13 05:00Z)',
    after.clock_in_at === '2026-08-13T05:00:00.000Z', after.clock_in_at);
  check('out instant is on date+1 (Aug 13 05:30 PDT = Aug 13 12:30Z)',
    after.clock_out_at === '2026-08-13T12:30:00.000Z', after.clock_out_at);
  check('span is 7.5h, not a negative or +24h wrap', near(paidShiftHours(after), 7.5),
    `${paidShiftHours(after)}h`);
  check('out instant strictly after in instant',
    Date.parse(after.clock_out_at) > Date.parse(after.clock_in_at));

  // Same-day (end > start) must NOT roll the date forward.
  const sameDay = applyEdit(punchRow(), { start_time: '06:00', end_time: '14:00' });
  check('non-overnight edit keeps both instants on the shift date',
    sameDay.clock_in_at.slice(0, 10) === '2026-08-12' && sameDay.clock_out_at.slice(0, 10) === '2026-08-12',
    `${sameDay.clock_in_at} / ${sameDay.clock_out_at}`);
}

// ═══ 4 — DST. Both 2026 Pacific transitions, both directions, day and overnight. ═══
console.log(`\n4 — DST (host TZ = ${process.env.TZ ?? 'unset'})`);
{
  const span = (date, s, e) => {
    const i = punchInstantsForWallClock(date, s, e);
    return (Date.parse(i.clock_out_at) - Date.parse(i.clock_in_at)) / 3_600_000;
  };

  // Offsets resolve through the named zone, not a fixed offset.
  const summer = punchInstantsForWallClock('2026-07-15', '12:00', '20:00');
  check('summer noon = 19:00Z (PDT, UTC-7)', summer.clock_in_at === '2026-07-15T19:00:00.000Z', summer.clock_in_at);
  const winter = punchInstantsForWallClock('2026-01-15', '12:00', '20:00');
  check('winter noon = 20:00Z (PST, UTC-8)', winter.clock_in_at === '2026-01-15T20:00:00.000Z', winter.clock_in_at);
  check('a fixed -07:00 offset would be WRONG in winter',
    winter.clock_in_at !== '2026-01-15T19:00:00.000Z');

  // FALL-BACK: the transition fires at 02:00 on Sun Nov 1 2026, so the shift that CROSSES it is
  // the one dated Oct 31 — a 25-hour civil day makes an 8h nominal overnight span elapse 9h.
  // Adding 8*3600*1000 ms to the in instant would give 8h; that is the bug this avoids.
  const fb = span('2026-10-31', '22:00', '06:00');
  check('fall-back overnight Oct 31 22:00→06:00 elapses 9h (nominal 8h)', near(fb, 9), `${fb}h`);
  const fbInst = punchInstantsForWallClock('2026-10-31', '22:00', '06:00');
  check('fall-back in = Nov 1 05:00Z (PDT, UTC-7) / out = Nov 1 14:00Z (PST, UTC-8)',
    fbInst.clock_in_at === '2026-11-01T05:00:00.000Z' && fbInst.clock_out_at === '2026-11-01T14:00:00.000Z',
    `${fbInst.clock_in_at} → ${fbInst.clock_out_at}`);
  check('naive ms-addition would have put the out instant an hour early',
    Date.parse(fbInst.clock_out_at) - (Date.parse(fbInst.clock_in_at) + 8 * 3_600_000) === 3_600_000,
    `real out ${fbInst.clock_out_at} vs in+8h ${new Date(Date.parse(fbInst.clock_in_at) + 8 * 3_600_000).toISOString()}`);
  check('Oct 31 23:00 → Nov 1 05:00 elapses 7h (nominal 6h)', near(span('2026-10-31', '23:00', '05:00'), 7),
    `${span('2026-10-31', '23:00', '05:00')}h`);
  // A shift starting the EVENING OF the transition date is already post-transition at both ends,
  // so it is a plain 8h. (This is the case I first expected to be 9h — it is not, and pinning it
  // stops a future "fix" from double-counting the hour.)
  check('Nov 1 22:00→06:00 is a plain 8h (transition already past by 22:00)',
    near(span('2026-11-01', '22:00', '06:00'), 8), `${span('2026-11-01', '22:00', '06:00')}h`);

  // SPRING-FORWARD: mirror image. Transition at 02:00 Sun Mar 8 2026 ⇒ a 23-hour civil day.
  const sf = span('2026-03-07', '22:00', '06:00');
  check('spring-forward Mar 7 22:00→06:00 elapses 7h (nominal 8h)', near(sf, 7), `${sf}h`);
  check('spring-forward Mar 7 23:00→05:00 elapses 5h (nominal 6h)',
    near(span('2026-03-07', '23:00', '05:00'), 5), `${span('2026-03-07', '23:00', '05:00')}h`);
  check('the two transitions move the span in OPPOSITE directions', fb === 9 && sf === 7,
    `fall-back ${fb}h vs spring-forward ${sf}h on the same 8h nominal span`);
  // A daytime shift on each transition date is unaffected in span.
  check('Mar 8 daytime 12:00→18:00 = 6h', near(span('2026-03-08', '12:00', '18:00'), 6));
  check('Nov 1 daytime 12:00→18:00 = 6h', near(span('2026-11-01', '12:00', '18:00'), 6));
  // Spans that straddle 02:00 on each transition morning.
  check('Nov 1 01:00→03:00 elapses 3h (02:00 happens twice)', near(span('2026-11-01', '01:00', '03:00'), 3),
    `${span('2026-11-01', '01:00', '03:00')}h`);
  check('Mar 8 01:00→05:00 elapses 3h (02:00 never happens)', near(span('2026-03-08', '01:00', '05:00'), 3),
    `${span('2026-03-08', '01:00', '05:00')}h`);

  // 02:30 on spring-forward morning does not exist as a wall-clock time. Assert what the code
  // ACTUALLY returns (measured, not assumed) so the behaviour is pinned and any future Intl or
  // engine change surfaces here instead of in payroll.
  const gap = punchInstantsForWallClock('2026-03-08', '02:30', '06:00');
  check('nonexistent 02:30 on Mar 8 resolves deterministically to 09:30Z (pinned, pre-transition offset)',
    gap.clock_in_at === '2026-03-08T09:30:00.000Z', gap.clock_in_at);
  check('…and still yields a positive, sane span of 3.5h',
    Date.parse(gap.clock_out_at) > Date.parse(gap.clock_in_at)
      && near((Date.parse(gap.clock_out_at) - Date.parse(gap.clock_in_at)) / 3_600_000, 3.5),
    `${gap.clock_in_at} → ${gap.clock_out_at}`);
}

// ═══ 5 — manual rows: wall clock only, instants stay NULL, pay still correct ═══
console.log('\n5 — manual shifts unchanged');
{
  const manual = {
    id: 'sh-m', employee_id: 'e2', date: '2026-08-12',
    start_time: '09:00', end_time: '17:00',
    source: 'manual', source_rule_id: null, confirmed_at: null, break_minutes: 0,
    clock_in_at: null, clock_out_at: null,
  };
  const after = applyEdit(manual, { start_time: '09:00', end_time: '16:00' });
  check('wall clock written', after.start_time === '09:00' && after.end_time === '16:00');
  check('clock_in_at stays NULL (no instants invented)', after.clock_in_at === null);
  check('clock_out_at stays NULL', after.clock_out_at === null);
  check('no instant keys added to the row at all',
    !Object.keys(after).some((k) => k.startsWith('clock_') && after[k] !== null));
  check('paidShiftHours reads the corrected wall clock', near(paidShiftHours(after), 7),
    `${paidShiftHours(after)}h`);
  check('manual row is payable without confirmation (unchanged)', isPayableShift(after) === true);
  // A manual overnight row still uses the +24h wrap, not an instants path.
  const overnightManual = applyEdit(manual, { start_time: '22:00', end_time: '06:00' });
  check('manual overnight = 8h via the wall-clock wrap', near(paidShiftHours(overnightManual), 8),
    `${paidShiftHours(overnightManual)}h`);
}

// ═══ 6 — reopening a punch row is refused (would violate 097's CHECK) ═══
console.log('\n6 — reopen guard');
{
  let threw = null;
  try { applyEdit(punchRow(), { end_time: null }); } catch (e) { threw = e; }
  check('editing a time_clock row to end_time:null throws', threw !== null);
  check('…with the readable REOPEN_PUNCH_ERROR, not a raw 23514',
    threw && threw.message === REOPEN_PUNCH_ERROR, threw && threw.message);
  // Manual rows may still be reopened.
  const reopened = applyEdit(
    { id: 'm', employee_id: 'e2', date: '2026-08-12', start_time: '09:00', end_time: '17:00',
      source: 'manual', source_rule_id: null, break_minutes: 0, clock_in_at: null, clock_out_at: null },
    { end_time: null },
  );
  check('manual row CAN still be reopened', reopened.end_time === null);
  check('a reopened manual row is not payable (open ⇒ excluded)', isPayableShift(reopened) === false);
}

// ═══ 7 — no-op edit must not touch a real punch ═══
console.log('\n7 — no-op edit');
{
  const row = punchRow({ end_time: '21:12', clock_out_at: '2026-08-13T04:12:00.000Z' });
  const after = applyEdit(row, {});
  check('empty patch returns the row untouched', after === row);
  check('…so a diverging row is NOT silently rewritten by an unrelated save',
    after.clock_out_at === '2026-08-13T04:12:00.000Z', after.clock_out_at);
}

// ═══ 8 — DISPLAY: the calendar now shows the number payroll pays ═══
console.log('\n8 — calendar display parity');
{
  const weekDates = new Set(['2026-08-12']);
  const row = punchRow({ end_time: '14:12', clock_out_at: '2026-08-13T04:12:00.000Z' }); // diverging
  const cards = indexWeekCards([row], [], weekDates);
  const list = cards.get('e1|2026-08-12');
  // Non-vacuous: prove the lookup produced a card before asserting anything about it.
  check('LOOKUP GUARD: the week index produced exactly 1 card for e1|2026-08-12',
    Array.isArray(list) && list.length === 1, `got ${list ? list.length : 'undefined'}`);
  const card = list[0];
  check('card.hours EQUALS paidShiftHours (single source of truth)',
    near(card.hours, paidShiftHours(row)), `card=${card.hours} paid=${paidShiftHours(row)}`);
  check('card.hours is NOT the stale wall-clock duration',
    !near(card.hours, durationHours(row.start_time, row.end_time)),
    `instants=${card.hours} wallclock=${durationHours(row.start_time, row.end_time)}`);
  check('startMin/endMin stay wall-clock (grid layout + overlap unaffected)',
    card.startMin === 370 && card.endMin === 852, `${card.startMin}/${card.endMin}`);

  // After the edit lands, calendar and payroll agree on the corrected figure.
  const edited = applyEdit(row, { end_time: '14:12' });
  const editedCards = indexWeekCards([edited], [], weekDates).get('e1|2026-08-12');
  check('LOOKUP GUARD: edited row produced a card', Array.isArray(editedCards) && editedCards.length === 1);
  check('post-edit card.hours == paidShiftHours == 8.033h',
    near(editedCards[0].hours, paidShiftHours(edited)) && near(editedCards[0].hours, 8.033333333333333),
    `${editedCards[0].hours}h`);

  // Manual + recurring rows keep the wall-clock display.
  const manualRow = { id: 'm', employee_id: 'e2', date: '2026-08-12', start_time: '09:00',
    end_time: '17:00', source: 'manual', source_rule_id: null, break_minutes: 0,
    clock_in_at: null, clock_out_at: null };
  const mCards = indexWeekCards([manualRow], [], weekDates).get('e2|2026-08-12');
  check('LOOKUP GUARD: manual row produced a card', Array.isArray(mCards) && mCards.length === 1);
  check('manual card.hours = wall-clock duration (8h)', near(mCards[0].hours, 8), `${mCards[0].hours}h`);
  check('manual card.hours also == paidShiftHours', near(mCards[0].hours, paidShiftHours(manualRow)));

  // An open row still reads 0 regardless of any instants present.
  const openRow = punchRow({ end_time: null });
  const oCards = indexWeekCards([openRow], [], weekDates).get('e1|2026-08-12');
  check('LOOKUP GUARD: open row produced a card', Array.isArray(oCards) && oCards.length === 1);
  check('open card.hours = 0', oCards[0].hours === 0 && oCards[0].isOpen === true);

  // instantHours ↔ paidShiftHours parity, incl. a break and a floor-at-0 case.
  const cases = [
    ['2026-08-12T13:10:00.000Z', '2026-08-12T21:10:00.000Z', 0],
    ['2026-08-12T13:10:00.000Z', '2026-08-12T21:10:00.000Z', 30],
    ['2026-08-12T13:10:00.000Z', '2026-08-13T04:12:00.000Z', 0],
    ['2026-08-12T13:10:00.000Z', '2026-08-12T13:20:00.000Z', 60], // break > span ⇒ floor 0
  ];
  check('PARITY LOOKUP GUARD: 4 parity cases to compare', cases.length === 4);
  let mismatches = 0;
  for (const [i, o, b] of cases) {
    const viaCard = instantHours(i, o, b);
    const viaPay = paidShiftHours({ employee_id: 'x', start_time: '00:00', end_time: '00:00',
      clock_in_at: i, clock_out_at: o, break_minutes: b });
    if (!near(viaCard, viaPay)) mismatches++;
  }
  check('instantHours == paidShiftHours on every case', mismatches === 0, `${mismatches} mismatch(es)`);
  check('break > span floors at 0, never negative', instantHours(cases[3][0], cases[3][1], 60) === 0);
}

// ═══ 9 — REGRESSION: the 14h confirm block is UNMODIFIED and now works as intended ═══
console.log('\n9 — confirm block (unmodified) reacts to the corrected instants');
{
  const flagsFor = (row) => computeConfirmFlags({
    clockedHours: paidShiftHours(row),
    breakMinutes: row.break_minutes ?? 0,
    scheduled: null,
    employeeHasRules: false,
    scheduleAppliesToDate: false,
  });
  const blocked = (row) => flagsFor(row).some((f) => f.kind === 'implausible_span');

  check('threshold is still 14h (constant untouched)', IMPLAUSIBLE_SPAN_HOURS === 14);

  // A forgotten clock-out: 33.5h raw punch.
  const forgotten = punchRow({ confirmed_at: null, end_time: '15:33',
    clock_in_at: '2026-08-08T13:01:00.000Z', clock_out_at: '2026-08-09T22:33:00.000Z' });
  check('LOOKUP GUARD: the forgotten punch really is >14h',
    paidShiftHours(forgotten) > IMPLAUSIBLE_SPAN_HOURS, `${paidShiftHours(forgotten)}h`);
  check('a >14h punch is REFUSED by the confirm block', blocked(forgotten) === true);

  // Corrected DOWN to a normal span → the block clears (this only works now that edits move
  // the instants; under the old write path paidShiftHours stayed at 33.5h and it never cleared).
  const corrected = applyEdit({ ...forgotten, date: '2026-08-08' }, { start_time: '06:01', end_time: '13:44' });
  check('corrected span is under the threshold', paidShiftHours(corrected) < IMPLAUSIBLE_SPAN_HOURS,
    `${paidShiftHours(corrected)}h`);
  check('…so the confirm block now ACCEPTS it', blocked(corrected) === false,
    `flags: ${flagsFor(corrected).map((f) => f.kind).join(',') || 'none'}`);
  // The old wall-clock-only write must still be blocked — proves the fix is what cleared it.
  const wallOnlyFix = { ...forgotten, start_time: '06:01', end_time: '13:44' };
  check('CONTROL: wall-clock-only "fix" is still refused (the old bug)', blocked(wallOnlyFix) === true,
    `${paidShiftHours(wallOnlyFix)}h`);

  // Editing a normal shift UP past 14h must still be refused.
  const inflated = applyEdit(punchRow({ confirmed_at: null }), { start_time: '06:00', end_time: '21:00' });
  check('an edit to a >14h span is still refused', blocked(inflated) === true,
    `${paidShiftHours(inflated)}h`);
}

// ═══ 10 — employee_time_entries is never referenced by the write path ═══
console.log('\n10 — raw punch log untouched');
{
  const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  // Comments legitimately DISCUSS employee_time_entries (that it is never written is the whole
  // point), so assert on CODE only — strip block and line comments first.
  const codeOf = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const src = read('./punchEdit.ts');
  const hookSrc = read('../../hooks/useShifts.ts');
  const srcCode = codeOf(src);
  const hookCode = codeOf(hookSrc);

  // Non-vacuous: prove the files were read, the strip left real code, and the code under test
  // is present — before asserting anything is absent from it.
  check('LOOKUP GUARD: punchEdit.ts read and contains the converter',
    src.length > 0 && srcCode.includes('punchInstantsForWallClock'), `${src.length} bytes, ${srcCode.length} of code`);
  check('LOOKUP GUARD: useShifts.ts read and contains updateShift',
    hookSrc.length > 0 && hookCode.includes('const updateShift'), `${hookSrc.length} bytes, ${hookCode.length} of code`);
  check('LOOKUP GUARD: comment strip kept the code but dropped the prose',
    srcCode.includes('export function') && !srcCode.includes('raw badge log'),
    `${src.length - srcCode.length} bytes of comment removed`);

  check('punchEdit.ts CODE never references employee_time_entries', !srcCode.includes('employee_time_entries'));
  check('useShifts.ts CODE never references employee_time_entries', !hookCode.includes('employee_time_entries'));

  const tables = [...hookCode.matchAll(/\.from\('([^']+)'\)/g)].map((m) => m[1]);
  check('LOOKUP GUARD: found .from() table calls in the hook', tables.length >= 5, `${tables.length} calls`);
  check('every table the hook touches is `shifts`', new Set(tables).size === 1 && tables[0] === 'shifts',
    [...new Set(tables)].join(','));

  const rpcs = [...hookCode.matchAll(/\.rpc\(([^)]*)\)/g)].map((m) => m[1].trim());
  check('LOOKUP GUARD: the confirm RPC call is still present', rpcs.length === 1, rpcs.join(' | '));
  check('updateShift added no new RPC', rpcs.every((r) => r.startsWith('fn')), rpcs.join(' | '));

  check('no DDL shipped in this module', !/alter\s+table|create\s+(table|trigger|constraint)/i.test(src));
}

console.log(`\n${passed} checks passed\n`);
