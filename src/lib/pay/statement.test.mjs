// THE PAY STATEMENT: that its money is payroll's money, that an edit moves the interval payroll
// actually reads, and that the plan never becomes pay.
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
const pickerUrl = transpile('../shipping/pickerPerformance.ts', 'pickerPerformance.mjs');
const econUrl = transpile('../shipping/pickCostEconomics.ts', 'pickCostEconomics.mjs', {
  "'@/lib/employees'": `'${employeesUrl}'`,
  "'@/lib/shipping/pickerPerformance'": `'${pickerUrl}'`,
});
const punchUrl = transpile('../shifts/punchEdit.ts', 'punchEdit.mjs', {
  "'@/lib/schedule/timezone'": `'${tzUrl}'`,
  "'@/lib/weeklySchedule'": `'${weeklyUrl}'`,
});
const stmtUrl = transpile('./statement.ts', 'statement.mjs', {
  "'@/lib/employees'": `'${employeesUrl}'`,
  "'@/lib/schedule/timezone'": `'${tzUrl}'`,
  "'@/lib/shipping/pickCostEconomics'": `'${econUrl}'`,
});

const {
  buildPayStatement, wallIntervalOf, exclusionReasonOf, payStatementFilename,
  LONG_SPAN_HOURS, OVERLAP_SCAN_LOOKBACK_DAYS, formatClock12, formatDayLabel,
} = await import(stmtUrl);
const { computePay, isPayableShift, paidShiftHours } = await import(employeesUrl);
const { buildShiftEditPatch, shiftEditPrefill } = await import(punchUrl);
const { laWallTimeToUtc, laWallClockOf } = await import(tzUrl);
const { MAX_PLAUSIBLE_PUNCH_HOURS } = await import(econUrl);

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
console.log('\n§1 Interval derivation mirrors the database range helper');
// lensed_shift_wall_range: instants for a time_clock row with both, else wall clock with a day
// added when end <= start, and an unbounded upper for an open row.
{
  const day = manual('2026-08-25', '06:00', '14:00');
  const iv = wallIntervalOf(day);
  check('a plain day is exactly its wall-clock span', near((iv.hi - iv.lo) / 60, 8));

  const overnight = manual('2026-08-25', '17:00', '01:00');
  const ivo = wallIntervalOf(overnight);
  check('end < start rolls into the next day', near((ivo.hi - ivo.lo) / 60, 8));

  const degenerate = manual('2026-08-25', '06:00', '06:00');
  check(
    'end == start is a full day, as `end_time <= start_time` in the DB helper',
    near((wallIntervalOf(degenerate).hi - wallIntervalOf(degenerate).lo) / 60, 24),
  );

  const open = manual('2026-08-25', '06:00', null);
  check('an open row has an unbounded upper bound', wallIntervalOf(open).hi === null);

  // A 47.75h punch: the instants branch has no 24h ceiling, so the interval must NOT wrap.
  const long = punch('2026-08-24', '05:59', '05:44', {
    clock_out_at: laWallTimeToUtc('2026-08-26', '05:44').toISOString(),
  });
  const ivl = wallIntervalOf(long);
  check('a 47.75h punch reads as 47.75h, not wrapped to 23.75h', near((ivl.hi - ivl.lo) / 60, 47.75, 1e-6),
    `${((ivl.hi - ivl.lo) / 60).toFixed(2)}h`);

  // A time_clock row whose wall clock has DIVERGED from its instants must follow the instants.
  const diverged = punch('2026-08-25', '06:00', '14:00', {
    start_time: '05:00:00', end_time: '13:00:00', // the stale display copy
  });
  const ivd = wallIntervalOf(diverged);
  check(
    'a diverged punch is read from its instants, not its wall clock',
    laWallClockOf(diverged.clock_in_at).time === '06:00' && near(ivd.lo % 1440, 6 * 60),
  );
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
  check('a scheduled-only row is not counted as something to review',
    s.totals.reviewCount === 0, 'the plan is not an anomaly');

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
  check('a manual row carries a neutral note, never a review flag',
    rm.warnings.length === 1 && rm.warnings[0].kind === 'manual_entry' && rm.warnings[0].tone === 'note');
  check('a punch row carries no manual note', !rp.warnings.some((w) => w.kind === 'manual_entry'));
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
console.log('\n§7 Overlapping worked time is surfaced, and nothing is touched');
{
  const p = punch('2026-08-26', '06:06', '14:01', { break_minutes: 27 });
  const m = manual('2026-08-26', '06:00', '14:00'); // the classic stacked correction
  const clean = manual('2026-08-27', '06:00', '14:00');
  const s = build([p, m, clean]);

  const flagged = s.rows.filter((r) => r.warnings.some((w) => w.kind === 'overlap'));
  check('both sides of an overlap are flagged', flagged.length === 2, `${flagged.map((r) => r.shiftId).join(',')}`);
  check('the non-overlapping row is not flagged',
    !s.rows.find((r) => r.shiftId === clean.id).warnings.some((w) => w.kind === 'overlap'));
  const detail = flagged[0].warnings.find((w) => w.kind === 'overlap').detail;
  check('the warning names the conflicting record so a manager can compare',
    detail.includes('Wed Aug 26') && /\d{1,2}:\d{2} (AM|PM)/.test(detail) && /Time Clock|Manual Entry/.test(detail),
    detail);
  check('...in manager language, not an ISO date or a row id',
    !detail.includes('2026-08-26') && !detail.includes(p.id) && !detail.includes(m.id), detail);
  check('the warning does not quantify the conflict in money',
    !flagged.some((r) => r.warnings.some((w) => w.kind === 'overlap' && /\$/.test(w.detail))),
    'the occupancy interval is gross of breaks, so a dollar figure would be wrong');

  // DETECTION MUST NOT MOVE MONEY.
  const noOverlap = build([p, clean]);
  const withOverlap = build([p, m, clean]);
  check('flagging an overlap does not change the flagged rows\' paid hours',
    withOverlap.rows.find((r) => r.shiftId === p.id).paidHours ===
      noOverlap.rows.find((r) => r.shiftId === p.id).paidHours);
  check('and the period total is still the plain sum of every payable row',
    withOverlap.totals.paidHours === computePay([EMP()], [p, m, clean])[0].hours,
    'an overlap is reported, never deducted');

  // Touching endpoints are not an overlap (half-open, as the DB range is).
  const a = manual('2026-08-28', '06:00', '14:00');
  const b = manual('2026-08-28', '14:00', '18:00');
  check('back-to-back shifts are NOT an overlap',
    build([a, b]).rows.every((r) => !r.warnings.some((w) => w.kind === 'overlap')));

  // THE LOOKBACK. A punch DATED before the period whose instants reach into it must still be seen.
  const reachesIn = punch('2026-08-22', '05:59', '05:44', {
    clock_out_at: laWallTimeToUtc('2026-08-24', '05:44').toISOString(),
  });
  const inPeriod = manual('2026-08-24', '05:00', '05:30');
  const look = build([reachesIn, inPeriod]);
  check('a pre-period punch reaching into the period raises the flag',
    look.rows.find((r) => r.shiftId === inPeriod.id).warnings.some((w) => w.kind === 'overlap'));
  check('...while the pre-period row itself is neither paid nor listed',
    look.rows.length === 1 && look.excluded.every((e) => e.shiftId !== reachesIn.id),
    'only its shadow is used');
  check('the lookback covers the worst span on record (47.75h reaches 2 days)',
    OVERLAP_SCAN_LOOKBACK_DAYS >= 3, `${OVERLAP_SCAN_LOOKBACK_DAYS} days`);

  // An OPEN row is unbounded in the DB guard, but must not declare a conflict against every
  // later shift here — it pays nothing and is already reported as an Open Clock-In.
  const openRow = manual('2026-08-30', '09:00', null);
  const later = manual('2026-09-02', '09:00', '17:00');
  const withOpen = build([openRow, later]);
  check('an open clock-in does not manufacture a conflict with every later shift',
    withOpen.rows.every((r) => !r.warnings.some((w) => w.kind === 'overlap')),
    'one forgotten clock-out would otherwise flag the whole rest of the period');
  check('...and the open row is still reported on its own',
    withOpen.excluded.length === 1 && withOpen.excluded[0].reason === 'open');

  // An unconfirmed punch is not payable, but IS a conflict once someone confirms it.
  const pending = punch('2026-08-29', '06:00', '14:00', { confirmed_at: null });
  const stacked = manual('2026-08-29', '06:30', '10:00');
  const q = build([pending, stacked]);
  check('a manual row stacked on an UNCONFIRMED punch is still flagged',
    q.rows.find((r) => r.shiftId === stacked.id).warnings.some((w) => w.kind === 'overlap'),
    'it double-pays the moment the punch is confirmed');
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§8 An implausibly long span is impossible to miss');
{
  check('the threshold is the one the product already shows managers',
    LONG_SPAN_HOURS === MAX_PLAUSIBLE_PUNCH_HOURS && LONG_SPAN_HOURS === 18);

  // The real production shape: 47.75h end to end, 2417 minutes of break, 7.47h paid.
  const forgotten = punch('2026-08-24', '05:59', '05:44', {
    clock_out_at: laWallTimeToUtc('2026-08-26', '05:44').toISOString(),
    break_minutes: 2417,
  });
  const s = build([forgotten]);
  const r = s.rows[0];
  check('the long span is flagged for review', r.warnings.some((w) => w.kind === 'long_span' && w.tone === 'review'));
  check('...even though its PAID hours look ordinary', r.paidHours < 8 && r.spanHours > 40,
    `paid ${r.paidHours.toFixed(2)}h, span ${r.spanHours.toFixed(2)}h`);
  check('the hours are reported, never silently capped',
    s.totals.paidHours === computePay([EMP()], [forgotten])[0].hours);
  check('the row says the end lands on a different day', r.endDateISO === '2026-08-26');

  const normal = punch('2026-08-25', '06:00', '20:00'); // 14h — long, but under the threshold
  check('a genuine 14h double shift is NOT flagged',
    !build([normal]).rows[0].warnings.some((w) => w.kind === 'long_span'));
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
  check('the unconfirmed punch is named as needing review', reasons.awaiting_confirmation === pending.id);
  check('the schedule row is named as scheduled only', reasons.schedule_plan === plan.id);
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
  check('an open clock-in counts as something to review', s.totals.reviewCount >= 1);
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
    return !/(\bnet pay\b|withhold|deduction|\btax\b|benefit)/.test(s);
  })(), 'gross hours and money only');
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§11 One person, one period, one filename');
{
  const s = build([manual('2026-08-26', '09:00', '17:00')], EMP({ name: 'Carlos' }));
  check('the filename is the documented shape',
    payStatementFilename(s) === 'Lensed-Pay-Statement-Carlos-2026-08-24-to-2026-09-06.pdf',
    payStatementFilename(s));
  check('it is stable across rebuilds', payStatementFilename(s) === payStatementFilename(build([], EMP({ name: 'Carlos' }))));
  const messy = build([], EMP({ name: '  José  Núñez-Ортега / #2  ' }));
  check('accents, punctuation and spaces are sanitised out',
    /^Lensed-Pay-Statement-[A-Za-z0-9-]+-2026-08-24-to-2026-09-06\.pdf$/.test(payStatementFilename(messy)),
    payStatementFilename(messy));
  check('a name that sanitises to nothing still yields a filename',
    payStatementFilename(build([], EMP({ name: '***' }))) ===
      'Lensed-Pay-Statement-Employee-2026-08-24-to-2026-09-06.pdf');
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
  check('the PDF renderer imports only the statement model',
    (pdfSrc.match(/^import .* from '(.+)';$/gm) || []).every((l) => l.includes("'./statement'")),
    'pdf-lib is a dynamic import inside the function');
  check('the PDF renderer never does rate arithmetic',
    !/\*\s*(statement\.)?rate|rate\s*\*/.test(pdfSrc), 'it prints statement.totals, it does not derive them');

  // The Pay tab must keep feeding computePay the period rows and nothing else.
  const viewSrc = src('../../components/employees/PayView.tsx').replace(/\/\/[^\n]*/g, '');
  const calls = viewSrc.match(/computePay\([^)]*\)/g) || [];
  check('PayView calls computePay exactly once', calls.length === 1, calls.join(' | '));
  check('...with periodShifts, never the recurring projection',
    calls[0] === 'computePay(employees, periodShifts)', calls[0]);
  check('periodShifts is filtered back to the pay period before it is paid',
    /periodShifts\s*=\s*useMemo\(\s*\(\)\s*=>\s*scanShifts\.filter\(\(s\) => s\.date >= period\.start && s\.date <= period\.end\)/.test(viewSrc),
    'the widened fetch feeds warnings only');
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
