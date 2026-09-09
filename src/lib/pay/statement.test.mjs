// THE PAY STATEMENT: that its money is payroll's money, that an edit moves the interval payroll
// actually reads, that the plan never becomes pay, and that the day/week grouping the screen and
// the printed statement both read adds back up to the total.
//
// Everything under test is the REAL module, transpiled at runtime — the real buildPayStatement,
// the real isPayableShift/paidShiftHours/computePay from employees.ts, the real
// buildShiftEditPatch/shiftEditPrefill from punchEdit.ts, the real laWallTimeToUtc. Nothing here
// reimplements a rule it then checks against itself.
//
// Run:  TZ=UTC node src/lib/pay/statement.test.mjs
//       TZ=Asia/Tokyo node src/lib/pay/statement.test.mjs   (must be host-TZ independent)
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'paystatement-'));
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
const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const tzUrl = transpile('../schedule/timezone.ts', 'timezone.mjs');
const employeesUrl = transpile('../employees.ts', 'employees.mjs');
const weeklyUrl = transpile('../weeklySchedule.ts', 'weeklySchedule.mjs');
const punchUrl = transpile('../shifts/punchEdit.ts', 'punchEdit.mjs', {
  "'@/lib/schedule/timezone'": `'${tzUrl}'`,
  "'@/lib/weeklySchedule'": `'${weeklyUrl}'`,
});
const stmtUrl = transpile('./statement.ts', 'statement.mjs', {
  "'@/lib/employees'": `'${employeesUrl}'`,
  "'@/lib/schedule/timezone'": `'${tzUrl}'`,
});

const {
  buildPayStatement, exclusionReasonOf, payStatementFilename,
  workedDayGroups, payPeriodWeeks, formatClock12, formatDayLabel, formatBreak,
} = await import(stmtUrl);
const { computePay, isPayableShift, paidShiftHours } = await import(employeesUrl);
const { buildShiftEditPatch, shiftEditPrefill } = await import(punchUrl);
const { laWallTimeToUtc, laWallClockOf } = await import(tzUrl);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name}${extra ? ` — ${extra}` : ''}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const cents = (n) => Math.round(n * 100);

const PERIOD = { start: '2026-08-24', end: '2026-09-06', payday: '2026-09-11' };

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────
// Shaped after real production rows (a manual 06:00–14:00 correction stacked on the punch that
// already covered it; a 47.75h forgotten clock-out carrying a 2417-minute break). Instants are
// built through the REAL laWallTimeToUtc rather than hand-computed, so the fixture cannot encode
// a timezone assumption the app does not make.
const EMP = (over = {}) => ({
  id: 'e1', user_id: 'u1', name: 'Juan Reyes', role: 'fulfillment', status: 'active',
  hourly_rate: 22, hire_date: null, probation_end_date: null,
  created_at: '', updated_at: '', ...over,
});

let seq = 0;
function punch(date, start, end, over = {}) {
  const outDate = end <= start ? isoAdd(date, 1) : date;
  return {
    id: `p${++seq}`, user_id: 'u1', employee_id: 'e1', date,
    start_time: `${start}:00`, end_time: `${end}:00`,
    source: 'time_clock', source_rule_id: null,
    confirmed_at: '2026-09-02T00:00:00.000Z', confirmed_by: 'u1', break_minutes: 0,
    clock_in_at: laWallTimeToUtc(date, start).toISOString(),
    clock_out_at: laWallTimeToUtc(outDate, end).toISOString(),
    auto_closed: false, created_at: '', updated_at: '', ...over,
  };
}
function manual(date, start, end, over = {}) {
  return {
    id: `m${++seq}`, user_id: 'u1', employee_id: 'e1', date,
    start_time: `${start}:00`, end_time: end === null ? null : `${end}:00`,
    source: 'manual', source_rule_id: null,
    confirmed_at: null, confirmed_by: null, break_minutes: 0,
    clock_in_at: null, clock_out_at: null,
    auto_closed: false, created_at: '', updated_at: '', ...over,
  };
}
function isoAdd(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const build = (shifts, employee = EMP()) =>
  buildPayStatement({ employee, period: PERIOD, shifts, generatedAtISO: '2026-09-08T17:00:00.000Z' });

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§1 A record reads as the span it is actually paid for');
{
  const day = manual('2026-08-25', '06:00', '14:00');
  check('a plain day shows its own wall clock',
    build([day]).rows[0].startLabel === '06:00' && build([day]).rows[0].endLabel === '14:00');
  check('...and is paid for it', near(build([day]).totals.paidHours, 8));

  const overnight = manual('2026-08-25', '17:00', '01:00');
  const or_ = build([overnight]).rows[0];
  check('an overnight record names the day its end lands on', or_.endDateISO === '2026-08-26', String(or_.endDateISO));
  check('...and is paid the wrapped span', near(or_.paidHours, 8));

  // A time_clock row whose wall clock has DIVERGED from its instants must display the INSTANTS —
  // showing the stale copy next to hours derived from the punch is the bug this feature exists to
  // make impossible.
  const diverged = punch('2026-08-25', '06:00', '14:00', { start_time: '05:00:00', end_time: '13:00:00' });
  const dr = build([diverged]).rows[0];
  check('a diverged punch displays its instants, not its stale wall clock',
    dr.startLabel === '06:00' && dr.endLabel === '14:00', `${dr.startLabel}-${dr.endLabel}`);
  check('...and its hours come from the same basis', near(dr.paidHours, paidShiftHours(diverged)));

  // A 47.75h punch: the instants branch has no 24h ceiling, so hours must not wrap.
  const long = punch('2026-08-24', '05:59', '05:44', {
    clock_out_at: laWallTimeToUtc('2026-08-26', '05:44').toISOString(),
    break_minutes: 2417,
  });
  const lr = build([long]).rows[0];
  check('a 47.75h punch is paid its real span minus the break, never wrapped',
    near(lr.paidHours, 47.75 - 2417 / 60, 1e-6), `${lr.paidHours.toFixed(2)}h`);
  check('...and says the end landed two days later', lr.endDateISO === '2026-08-26');
  check('a long break reads in hours, not raw minutes', formatBreak(2417) === '40h 17m', formatBreak(2417));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§2 The statement total IS payroll — computePay parity');
{
  const shifts = [
    punch('2026-08-26', '06:06', '14:01', { break_minutes: 27 }),
    manual('2026-08-26', '06:00', '14:00'),
    punch('2026-08-27', '06:04', '14:02', { break_minutes: 62 }),
    punch('2026-08-27', '18:59', '23:30'),
    manual('2026-08-31', '17:00', '01:00'), // overnight
    punch('2026-09-01', '06:15', '13:58'),
  ];
  const emp = EMP();
  const s = build(shifts);
  const [row] = computePay([emp], shifts);

  check('rows were actually produced (this assertion is not vacuous)', s.rows.length === 6, `${s.rows.length} rows`);
  check('total paid hours === computePay hours, exactly', s.totals.paidHours === row.hours,
    `${s.totals.paidHours} vs ${row.hours}`);
  check('total owed === computePay pay, exactly', s.totals.gross === row.pay,
    `${s.totals.gross} vs ${row.pay}`);

  // Every row's hours are paidShiftHours of that row — no second definition anywhere.
  const byId = new Map(shifts.map((x) => [x.id, x]));
  const wrong = s.rows.filter((r) => r.paidHours !== paidShiftHours(byId.get(r.shiftId)));
  check('every row\'s paid hours === paidShiftHours(row)', wrong.length === 0, `${s.rows.length} rows checked`);

  // Instants branch specifically: a punch row must NOT be measured off its wall clock.
  const punchRows = s.rows.filter((r) => r.source === 'time_clock');
  check('punch rows exist in the fixture', punchRows.length === 4, `${punchRows.length}`);
  const p1 = s.rows.find((r) => r.shiftId === shifts[0].id);
  check('a punch row nets its break off the instant span', near(p1.paidHours, 7.916666666666667 - 27 / 60, 1e-9),
    `${p1.paidHours.toFixed(4)}h`);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§3 Rows sum to the total a manager is shown');
{
  const shifts = [
    punch('2026-08-26', '06:06', '14:01', { break_minutes: 27 }),
    manual('2026-08-27', '06:00', '14:30', { break_minutes: 30 }),
    punch('2026-09-02', '09:00', '17:00'),
  ];
  const s = build(shifts);
  const sumHours = s.rows.reduce((n, r) => n + r.paidHours, 0);
  const sumAmount = s.rows.reduce((n, r) => n + r.amount, 0);
  check('Σ row paid hours === totals.paidHours', sumHours === s.totals.paidHours, `${s.rows.length} rows`);
  check('Σ row amount === totals.gross to the cent', cents(sumAmount) === cents(s.totals.gross),
    `${cents(sumAmount)}¢ vs ${cents(s.totals.gross)}¢`);
  check('the single rate line reconciles to the total',
    s.rateLines.length === 1 && s.rateLines[0].amount === s.totals.gross && s.rateLines[0].hours === s.totals.paidHours);
  check('worked days counts distinct dates', s.totals.workedDays === 3, `${s.totals.workedDays}`);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§4 The plan never becomes pay');
{
  // A materialized recurring row — the frozen SCHEDULE — is the only thing this person has.
  const planned = manual('2026-08-25', '09:00', '17:00', { source_rule_id: 'rule-1' });
  const s = build([planned]);
  const [row] = computePay([EMP()], [planned]);

  check('a scheduled-only row contributes ZERO payable rows', s.rows.length === 0);
  check('...zero hours', s.totals.paidHours === 0 && row.hours === 0);
  check('...zero pay', s.totals.gross === 0 && row.pay === 0);
  check('...and is shown as scheduled-only, not as pay',
    s.excluded.length === 1 && s.excluded[0].reason === 'schedule_plan');
  check('...and it still appears in the week grid as a day with no payable hours',
    payPeriodWeeks(s).flatMap((w) => w.days).find((d) => d.dateISO === '2026-08-25').hours === 0);

  // The statement builder only ever receives stored `shifts` rows. A projected recurring instance
  // has no id/source/break_minutes and is structurally not one; assert the module never mentions
  // the projection generator, so it cannot start consuming them.
  const stmtSrc = src('./statement.ts');
  check('statement.ts never touches the recurring projection generator',
    !stmtSrc.includes('generateRecurringShifts') && !stmtSrc.includes('shift_instances'));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§5 Both worked-time sources flow through the one model');
{
  const p = punch('2026-08-26', '06:06', '14:01', { break_minutes: 27 });
  const m = manual('2026-08-26', '15:00', '19:00', { break_minutes: 15 });
  const s = build([p, m]);
  const rp = s.rows.find((r) => r.shiftId === p.id);
  const rm = s.rows.find((r) => r.shiftId === m.id);

  check('the punch row is labelled Time Clock', rp.sourceLabel === 'Time Clock');
  check('the manual row is labelled Manual Entry', rm.sourceLabel === 'Manual Entry');
  check('a record carries source context and nothing that judges it',
    !('warnings' in rm) && !('spanHours' in rm), Object.keys(rm).join(','));
  check('both are paid', near(rp.paidHours, paidShiftHours(p)) && near(rm.paidHours, paidShiftHours(m)));
  check('the manual row displays its own wall clock', rm.startLabel === '15:00' && rm.endLabel === '19:00');
  check('the punch row displays the instants as Pacific wall clock',
    rp.startLabel === laWallClockOf(p.clock_in_at).time && rp.endLabel === laWallClockOf(p.clock_out_at).time);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§6 An edit moves the interval PAYROLL reads — the historical bug, pinned');
{
  // The canonical composed path, as useShifts.updateShift runs it: read the stored row back,
  // hand it to buildShiftEditPatch, apply the patch, rebuild the statement from DB truth.
  const applyEdit = (row, edit) => {
    const patch = buildShiftEditPatch(row, edit);
    return patch === null ? { row, patch } : { row: { ...row, ...patch }, patch };
  };

  // (a) THE PROJECTION. buildShiftEditPatch judges change against shiftEditPrefill(row), which
  // reads the INSTANTS for a punch row. If the read-back does not select them the comparison
  // silently falls back to the wall clock — which is the divergence bug in a new costume.
  const hookSrc = src('../../hooks/useShifts.ts');
  const projection = /\.select\('([^']*source[^']*)'\)/.exec(hookSrc);
  check('updateShift reads a projection back before patching', projection !== null);
  check('...and that projection includes clock_in_at', projection[1].includes('clock_in_at'), projection[1]);
  check('...and clock_out_at', projection[1].includes('clock_out_at'));

  // (b) A punch whose wall clock has diverged from its instants — 43 such rows are in production.
  const diverged = punch('2026-08-26', '06:06', '14:01', {
    start_time: '06:00:00', end_time: '14:00:00', // stale display copy, never applied to pay
  });
  const before = build([diverged]);
  check('the form opens at the instants, not the stale wall clock',
    shiftEditPrefill(diverged).start === '06:06' && shiftEditPrefill(diverged).end === '14:01');
  check('and so does the statement', before.rows[0].startLabel === '06:06');

  // The manager shortens the shift by an hour: 06:06 → 13:01.
  const { row: edited, patch } = applyEdit(diverged, { start_time: '06:06', end_time: '13:01' });
  check('the patch writes the punch instant, which is what pay reads',
    patch.clock_out_at !== undefined, JSON.stringify(patch));
  check('the patch does NOT rewrite the untouched start instant', patch.clock_in_at === undefined);
  const after = build([edited]);
  check('paid hours fell by exactly one hour', near(after.totals.paidHours, before.totals.paidHours - 1, 1e-9),
    `${before.totals.paidHours.toFixed(4)} → ${after.totals.paidHours.toFixed(4)}`);
  check('the amount fell by exactly one hour of pay',
    near(after.totals.gross, before.totals.gross - 22, 1e-9));
  check('the rebuilt total still equals computePay on the saved row',
    after.totals.paidHours === computePay([EMP()], [edited])[0].hours);
  check('the row the manager reads now shows the corrected end', after.rows[0].endLabel === '13:01');

  // (c) THE BUG ITSELF, as a standing guard: a patch that touched only the wall clock must NOT
  // change what is paid. If someone ever "simplifies" the edit path back to writing start_time /
  // end_time on a punch row, this fails.
  const wallOnly = { ...diverged, start_time: '01:00:00', end_time: '23:00:00' };
  const wallOnlyStatement = build([wallOnly]);
  check('rewriting ONLY the wall clock of a punch row changes no money',
    wallOnlyStatement.totals.gross === before.totals.gross,
    'pay follows the instants, so a display-only write is inert');

  // (d) A manual row is the mirror image: the wall clock IS the pay basis.
  const man = manual('2026-08-27', '09:00', '17:00');
  const manBefore = build([man]);
  const { row: manAfter, patch: manPatch } = applyEdit(man, { start_time: '09:00', end_time: '16:00' });
  check('a manual edit writes the wall clock and no instants',
    manPatch.end_time === '16:00' && manPatch.clock_in_at === undefined && manPatch.clock_out_at === undefined);
  check('and one hour comes off the manual row too',
    near(build([manAfter]).totals.paidHours, manBefore.totals.paidHours - 1, 1e-9));

  // (e) A break-only correction moves money without disturbing either endpoint.
  const { row: broke, patch: brkPatch } = applyEdit(diverged, { break_minutes: 30 });
  check('a break-only save emits only break_minutes', Object.keys(brkPatch).join(',') === 'break_minutes');
  check('and takes exactly 30 minutes off the pay',
    near(build([broke]).totals.paidHours, before.totals.paidHours - 0.5, 1e-9));

  // (f) Open-and-save is inert.
  check('saving without changing anything produces no patch at all',
    buildShiftEditPatch(diverged, { start_time: '06:06', end_time: '14:01', break_minutes: 0 }) === null);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§7 Grouping by day and by week — the arrangement screen and paper share');
{
  const shifts = [
    punch('2026-08-26', '06:06', '14:01', { break_minutes: 27 }),
    manual('2026-08-26', '15:00', '19:00'),   // a second record on the SAME day
    punch('2026-08-27', '06:04', '14:02', { break_minutes: 62 }),
    manual('2026-09-05', '09:00', '17:00'),   // in week 2
  ];
  const s = build(shifts);

  // ── by day (what the Pay Details panel lists) ──
  const days = workedDayGroups(s);
  check('one group per worked date, in date order', days.length === 3 &&
    days.map((d) => d.dateISO).join(',') === '2026-08-26,2026-08-27,2026-09-05');
  check('a day with two records keeps BOTH, separately',
    days[0].rows.length === 2 && days[0].rows[0].shiftId !== days[0].rows[1].shiftId,
    'they must stay individually editable');
  check('...and they are not merged into one interval',
    days[0].rows[0].startLabel !== days[0].rows[1].startLabel);
  check('a day total is the sum of its own records',
    near(days[0].hours, days[0].rows[0].paidHours + days[0].rows[1].paidHours));
  check('day names are right', days[0].dayName === 'Wednesday' && days[2].dayName === 'Saturday',
    `${days[0].dayName}/${days[2].dayName}`);
  check('the day groups add back up to the statement total',
    near(days.reduce((n, d) => n + d.hours, 0), s.totals.paidHours), `${s.totals.paidHours.toFixed(2)}h`);
  check('and so do their amounts',
    cents(days.reduce((n, d) => n + d.amount, 0)) === cents(s.totals.gross));

  // ── by week (what the printed statement is read in) ──
  const weeks = payPeriodWeeks(s);
  check('a biweekly period is exactly two weeks', weeks.length === 2);
  check('...of seven days each', weeks.every((w) => w.days.length === 7));
  check('EVERY calendar day in the period is present, worked or not',
    weeks.flatMap((w) => w.days).length === 14);
  check('...and they are the period\'s own dates, in order', (() => {
    const all = weeks.flatMap((w) => w.days.map((d) => d.dateISO));
    return all[0] === PERIOD.start && all[13] === PERIOD.end &&
      all.every((d, i) => i === 0 || d > all[i - 1]);
  })());
  check('week 1 runs Mon-Sun', weeks[0].start === '2026-08-24' && weeks[0].end === '2026-08-30');
  check('week 2 runs Mon-Sun', weeks[1].start === '2026-08-31' && weeks[1].end === '2026-09-06');
  check('a day nobody worked carries no rows and no hours', (() => {
    const off = weeks[0].days.find((d) => d.dateISO === '2026-08-25');
    return off.rows.length === 0 && off.hours === 0 && off.amount === 0;
  })());
  check('WEEK 1 + WEEK 2 subtotals equal the total payable hours',
    near(weeks[0].hours + weeks[1].hours, s.totals.paidHours),
    `${weeks[0].hours.toFixed(2)} + ${weeks[1].hours.toFixed(2)} = ${s.totals.paidHours.toFixed(2)}`);
  check('...and neither week is empty in this fixture (not a vacuous pass)',
    weeks[0].hours > 0 && weeks[1].hours > 0);
  check('the week amounts also reconcile',
    cents(weeks[0].amount + weeks[1].amount) === cents(s.totals.gross));
  check('grouping invented no records',
    weeks.flatMap((w) => w.days).flatMap((d) => d.rows).length === s.rows.length, `${s.rows.length}`);

  // An overnight record belongs to the day it STARTED on — the same date predicate pay uses.
  const over = build([manual('2026-08-30', '17:00', '01:00')]);
  const w = payPeriodWeeks(over);
  check('an overnight record sits on its own date, not the day it ended',
    w[0].days[6].dateISO === '2026-08-30' && w[0].days[6].rows.length === 1 && w[1].days[0].rows.length === 0);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§8 Long and unusual records are reported exactly as they are');
{
  // No cap, no exclusion, no flag — the record is laid out and the manager judges it.
  const forgotten = punch('2026-08-24', '05:59', '05:44', {
    clock_out_at: laWallTimeToUtc('2026-08-26', '05:44').toISOString(),
    break_minutes: 2417,
  });
  const s = build([forgotten]);
  check('the hours are reported, never silently capped',
    s.totals.paidHours === computePay([EMP()], [forgotten])[0].hours);
  check('nothing on the record judges it',
    JSON.stringify(s).toLowerCase().indexOf('review') === -1 &&
    JSON.stringify(s).toLowerCase().indexOf('unusual') === -1 &&
    JSON.stringify(s).toLowerCase().indexOf('overlap') === -1);

  // Two records covering the same hours are BOTH kept and BOTH paid, untouched.
  const a = punch('2026-08-26', '06:06', '14:01');
  const b = manual('2026-08-26', '06:00', '14:00');
  const dup = build([a, b]);
  check('two records over the same time are both listed', dup.rows.length === 2);
  check('...both paid, with nothing deducted or merged',
    dup.totals.paidHours === computePay([EMP()], [a, b])[0].hours);
  check('...and they sit under one day so the duplication is visible',
    workedDayGroups(dup).length === 1 && workedDayGroups(dup)[0].rows.length === 2);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§9 Rows that are in the period but not in the money');
{
  const open = manual('2026-08-30', '06:00', null);
  const pending = punch('2026-08-31', '06:00', '14:00', { confirmed_at: null });
  const plan = manual('2026-09-01', '09:00', '17:00', { source_rule_id: 'r1' });
  const paid = manual('2026-09-02', '09:00', '17:00');
  const shifts = [open, pending, plan, paid];
  const s = build(shifts);

  check('only the payable row is in the money', s.rows.length === 1 && s.rows[0].shiftId === paid.id);
  check('the total matches computePay with three rows excluded',
    s.totals.gross === computePay([EMP()], shifts)[0].pay);
  const reasons = Object.fromEntries(s.excluded.map((e) => [e.reason, e.shiftId]));
  check('the open shift is named as an open clock-in', reasons.open === open.id);
  check('the unconfirmed punch is named as one', reasons.awaiting_confirmation === pending.id);
  check('the schedule row is named as scheduled only', reasons.schedule_plan === plan.id);
  check('the copy states facts and never passes judgement', (() => {
    const words = s.excluded.map((e) => `${e.label} ${e.detail}`).join(' ').toLowerCase();
    return !/review|warning|problem|error|unusual|overlap|suspicious|wrong/.test(words);
  })(), JSON.stringify(s.excluded.map((e) => e.label)));
  check('no manager-facing copy leaks a column or table name',
    !s.excluded.some((e) => /confirmed_at|source_rule_id|shift_instances|time_clock'|_id\b/.test(e.detail + e.label)),
    JSON.stringify(s.excluded.map((e) => e.label)));

  // The exclusion reason is derived from the REAL predicate, never a parallel copy of it.
  const mismatch = shifts.filter((x) => (exclusionReasonOf(x) === null) !== isPayableShift(x));
  check('exclusionReasonOf agrees with isPayableShift on every row', mismatch.length === 0,
    `${shifts.length} rows checked`);

  // Confirming the punch must move it into pay with no other change.
  const confirmed = { ...pending, confirmed_at: '2026-09-03T00:00:00.000Z' };
  const after = build([open, confirmed, plan, paid]);
  check('confirming a punch adds exactly its hours', near(after.totals.paidHours, s.totals.paidHours + 8, 1e-9));
  check('an excluded day still appears in the week grid, with zero hours', (() => {
    const grid = payPeriodWeeks(s).flatMap((w) => w.days);
    const d = grid.find((x) => x.dateISO === '2026-08-30');
    return d.rows.length === 0 && d.hours === 0;
  })(), 'it prints as Off — honest about pay, and the panel says why');
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§10 Rates are reported as the product actually stores them');
{
  // Verified against the live schema: employees.hourly_rate is the ONLY rate in the database —
  // no rate history, no per-shift rate, no override table. One line, honestly.
  const shifts = [manual('2026-08-26', '09:00', '17:00'), manual('2026-08-27', '09:00', '13:00')];
  const a = build(shifts, EMP({ hourly_rate: 22 }));
  const b = build(shifts, EMP({ hourly_rate: 30 }));
  check('every row carries the rate it was paid at', a.rows.every((r) => r.rate === 22));
  check('a different rate produces a proportionally different statement',
    near(b.totals.gross, (a.totals.gross / 22) * 30, 1e-9));
  check('the rate breakdown is one line, and it reconciles',
    a.rateLines.length === 1 && a.rateLines[0].rate === 22 && a.rateLines[0].amount === a.totals.gross);
  check('a zero-rate employee is reported as zero owed, not hidden',
    build(shifts, EMP({ hourly_rate: 0 })).totals.gross === 0 &&
      build(shifts, EMP({ hourly_rate: 0 })).totals.paidHours === 12);
  check('no invented payroll concepts', (() => {
    const s = JSON.stringify(a).toLowerCase();
    return !/(\bnet pay\b|withhold|deduction|\btax\b|benefit|cash paid|payment method)/.test(s);
  })(), 'gross hours and money only');
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§11 One person, one period, one filename');
{
  const s = build([manual('2026-08-26', '09:00', '17:00')], EMP({ name: 'Carlos' }));
  check('the filename is the documented shape',
    payStatementFilename(s) === 'Viralux-Payroll-Hours-Statement-Carlos-2026-08-24-to-2026-09-06.pdf',
    payStatementFilename(s));
  check('it is stable across rebuilds', payStatementFilename(s) === payStatementFilename(build([], EMP({ name: 'Carlos' }))));
  const messy = build([], EMP({ name: '  José  Núñez-Ортега / #2  ' }));
  check('accents, punctuation and spaces are sanitised out',
    /^Viralux-Payroll-Hours-Statement-[A-Za-z0-9-]+-2026-08-24-to-2026-09-06\.pdf$/.test(payStatementFilename(messy)),
    payStatementFilename(messy));
  check('a name that sanitises to nothing still yields a filename',
    payStatementFilename(build([], EMP({ name: '***' }))) ===
      'Viralux-Payroll-Hours-Statement-Employee-2026-08-24-to-2026-09-06.pdf');
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§12 There is only one payroll calculation');
{
  const stmtSrc = src('./statement.ts');
  check('statement.ts imports the real payable gate rather than restating it',
    /import\s*\{[^}]*isPayableShift[^}]*\}\s*from '@\/lib\/employees'/s.test(stmtSrc));
  check('...and the real paid-hours function',
    /import\s*\{[^}]*paidShiftHours[^}]*\}\s*from '@\/lib\/employees'/s.test(stmtSrc));
  check('statement.ts never multiplies a break out by hand',
    !/break_minutes\s*\/\s*60/.test(stmtSrc), 'that arithmetic belongs to paidShiftHours alone');
  check('statement.ts never re-implements the payable rule',
    !/source\s*===\s*'time_clock'\s*&&\s*\w*\.?confirmed_at/.test(stmtSrc));

  // The document renderer must be structurally incapable of recomputing pay.
  const pdfSrc = src('./statementPdf.ts');
  check('the PDF renderer cannot see payroll at all',
    !pdfSrc.includes('@/lib/employees') && !pdfSrc.includes('paidShiftHours') &&
      !pdfSrc.includes('isPayableShift') && !pdfSrc.includes('computePay'));
  check('the PDF renderer imports only the statement model', (() => {
    const specs = [...pdfSrc.matchAll(/from '([^']+)';/g)].map((m) => m[1]);
    return specs.length > 0 && specs.every((x) => x === './statement');
  })(), 'pdf-lib is a dynamic import; the brand mark is a fetched public asset');
  check('the PDF renderer never does rate arithmetic',
    !/\*\s*(statement\.)?rate|rate\s*\*/.test(pdfSrc), 'it prints statement.totals, it does not derive them');
  check('the PDF renderer sums nothing of its own — weeks come from the model',
    /payPeriodWeeks\(statement\)/.test(pdfSrc) && !/reduce\(\(n, r\) => n \+ r\.paidHours/.test(pdfSrc));

  // The presentation cleanup, pinned: nothing in the model or on any surface tells a manager that
  // a record looks wrong. If anomaly copy comes back, it comes back deliberately, not by drift.
  const modal = src('../../components/employees/PayDetailModal.tsx');
  const grid = src('../../components/employees/PayGrid.tsx');
  const preview = src('../../app/preview/pay-detail/PayDetailPreview.tsx');
  // Comments are stripped first: these files explain at length WHY the anomaly presentation was
  // removed, and matching the explanation instead of the code is how a guard silently rots.
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const JUDGY = /needs review|things to review|overlapping worked time|unusually long|reviewCount|warnings/i;
  for (const [label, code] of [
    ['the statement model', stmtSrc], ['the PDF', pdfSrc], ['the detail panel', modal],
    ['the tile grid', grid], ['the preview page', preview],
  ]) {
    check(`${label} carries no anomaly presentation`, !JUDGY.test(strip(code)));
  }
  check('the tile grid has no review badge', !/badge|reviewCount/i.test(strip(grid)));
  check('the detail panel lays the period out week by week, not as a flat table',
    /payPeriodWeeks\(statement\)/.test(modal),
    'payPeriodWeeks carries every calendar day, including the ones nobody worked');

  // The not-paid records stay reachable but folded shut, last on the page — context when someone
  // goes looking for it, never something competing with the payable rows.
  check('the not-paid records are a disclosure, closed by default',
    /<details/.test(modal) && !/<details[^>]*\bopen\b/.test(modal));
  check('...labelled by count, in plain words',
    /not included in pay/.test(modal) && /<summary/.test(modal));
  check('...and it sits after the payable rows, not before them',
    modal.indexOf('payPeriodWeeks') < modal.indexOf('not included in pay'));
  check('the disclosure carries no count badge or colour alarm',
    !/bg-tt-yellow|text-tt-yellow|bg-tt-red|text-tt-red/.test(
      modal.slice(modal.indexOf('function NotPaid'))),
    'muted and dashed only');

  // The Pay tab must keep feeding computePay the period rows and nothing else.
  const viewSrc = src('../../components/employees/PayView.tsx').replace(/\/\/[^\n]*/g, '');
  const calls = viewSrc.match(/computePay\([^)]*\)/g) || [];
  check('PayView calls computePay exactly once', calls.length === 1, calls.join(' | '));
  check('...with periodShifts, never the recurring projection',
    calls[0] === 'computePay(employees, periodShifts)', calls[0]);
  check('the Pay tab still fetches exactly the pay period — no widened scan left behind',
    /useShifts\(period\.start, period\.end\)/.test(viewSrc) && !/scanShifts|LOOKBACK/.test(viewSrc));
  check('the detail panel does not compute pay either', (() => {
    const modal = src('../../components/employees/PayDetailModal.tsx');
    return !modal.includes('paidShiftHours') && !modal.includes('computePay') && !modal.includes('isPayableShift');
  })());
  check('the tile grid does not compute pay either', (() => {
    const grid = src('../../components/employees/PayGrid.tsx');
    return !grid.includes('paidShiftHours') && !grid.includes('computePay');
  })());
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§13 Manager-facing formatting');
{
  check('12-hour clock', formatClock12('05:59') === '5:59 AM' && formatClock12('17:34') === '5:34 PM');
  check('midnight and noon', formatClock12('00:00') === '12:00 AM' && formatClock12('12:00') === '12:00 PM');
  check('an empty end reads as a dash, not 12:00 AM', formatClock12('') === '—');
  check('weekday labels are correct', formatDayLabel('2026-08-24') === 'Mon Aug 24',
    formatDayLabel('2026-08-24'));
  check('...across a year boundary too', formatDayLabel('2027-01-01') === 'Fri Jan 1',
    formatDayLabel('2027-01-01'));
}

console.log(`\n${passed} checks passed`);
