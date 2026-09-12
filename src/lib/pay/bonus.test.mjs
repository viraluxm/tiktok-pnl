// BONUS / INCENTIVE PAY, in both calculation types: that a bonus lands on the person and the period
// it was entered for and on NOBODY else; that a FLAT line is worth what was typed and an HOURLY
// line is worth its rate times the CANONICAL PAYABLE HOURS payroll already computed; that the two
// add up in cents rather than in floats; that editing and deleting move the total by exactly the
// right amount; that correcting a shift RE-PRICES an hourly incentive with nobody touching it —
// and, the load-bearing half, that NONE of it changes a single worked hour, rate, approved duration
// or payroll figure.
//
// Everything under test is the REAL module, transpiled at runtime: the real buildPayStatement,
// bonusSummaryFor, hourlyBonusCents, formatBonusBasis and totalOwedOf from statement.ts, the real
// computePay / isPayableShift / paidShiftHours from employees.ts, the real buildShiftEditPatch from
// punchEdit.ts, the real parseBonusAmount from bonusInput.ts. Nothing here reimplements a rule it
// then checks against itself.
//
// The database's guarantees are not reachable from Node, so the ones that matter — who owns a row,
// whose employee it may point at, what a valid period is, and that a flat row and an hourly row
// cannot be the same row — are asserted STRUCTURALLY over the real migration and the real hook, in
// §10. A comment claiming tenant isolation is not tenant isolation.
//
// Run:  TZ=UTC node src/lib/pay/bonus.test.mjs
//       TZ=Asia/Tokyo node src/lib/pay/bonus.test.mjs   (must be host-TZ independent)
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'paybonus-'));
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
// These files explain themselves at length; match the CODE, not the prose.
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const tzUrl = transpile('../schedule/timezone.ts', 'timezone.mjs');
const employeesUrl = transpile('../employees.ts', 'employees.mjs');
const weeklyUrl = transpile('../weeklySchedule.ts', 'weeklySchedule.mjs');
const stmtUrl = transpile('./statement.ts', 'statement.mjs', {
  "'@/lib/employees'": `'${employeesUrl}'`,
  "'@/lib/schedule/timezone'": `'${tzUrl}'`,
});
const inputUrl = transpile('./bonusInput.ts', 'bonusInput.mjs');
const punchUrl = transpile('../shifts/punchEdit.ts', 'punchEdit.mjs', {
  "'@/lib/schedule/timezone'": `'${tzUrl}'`,
  "'@/lib/weeklySchedule'": `'${weeklyUrl}'`,
});

const {
  buildPayStatement, bonusItemsFor, bonusSummaryFor, sumBonusCents, centsToDollars, totalOwedOf,
  hourlyBonusCents, formatBonusBasis, formatPayableDuration, formatMoney, payPeriodWeeks,
  paidHoursByDateOf,
  BONUS_FALLBACK_LABEL,
} = await import(stmtUrl);
const { computePay, paidShiftHours, payrollTeamOfRole, PAY_ANCHOR, payPeriodFor } = await import(employeesUrl);
const { parseBonusAmount, centsToInput, normalizeBonusDescription, BONUS_MAX_CENTS, BONUS_MAX_RATE_CENTS } =
  await import(inputUrl);
const { buildShiftEditPatch } = await import(punchUrl);
const { laWallTimeToUtc } = await import(tzUrl);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name}${extra ? ` — ${extra}` : ''}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};
const cents = (n) => Math.round(n * 100);

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────
// Carlos is the review case from the preview route, to the dollar: 72.50 payable hours at $22.00
// = $1,595.00 of worked pay. Every total below is checked against those two figures.
const PERIOD = { start: '2026-08-24', end: '2026-09-06', payday: '2026-09-11' };
const PREV_PERIOD = { start: '2026-08-10', end: '2026-08-23', payday: '2026-08-28' };

const EMP = (over = {}) => ({
  id: 'e-carlos', user_id: 'u1', name: 'Carlos Herrera', role: 'fulfillment', status: 'active',
  hourly_rate: 22, hire_date: null, probation_end_date: null, created_at: '', updated_at: '', ...over,
});
const CARLOS = EMP();
const OTHER = EMP({ id: 'e-dana', name: 'Dana Whitfield' });

let seq = 0;
function punch(employee_id, date, start, end, over = {}) {
  const outDate = end <= start ? isoAdd(date, 1) : date;
  return {
    id: `p${++seq}`, user_id: 'u1', employee_id, date,
    start_time: `${start}:00`, end_time: `${end}:00`,
    source: 'time_clock', source_rule_id: null,
    confirmed_at: '2026-09-07T00:00:00.000Z', confirmed_by: 'u1', break_minutes: 0,
    clock_in_at: laWallTimeToUtc(date, start).toISOString(),
    clock_out_at: laWallTimeToUtc(outDate, end).toISOString(),
    auto_closed: false, created_at: '', updated_at: '', ...over,
  };
}
function isoAdd(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const SHIFTS = [
  punch('e-carlos', '2026-08-24', '08:00', '16:00'),
  punch('e-carlos', '2026-08-25', '08:00', '16:00'),
  punch('e-carlos', '2026-08-26', '08:00', '16:00'),
  punch('e-carlos', '2026-08-27', '08:00', '16:30'),
  punch('e-carlos', '2026-08-28', '08:00', '16:00'),
  punch('e-carlos', '2026-08-31', '08:00', '16:00'),
  punch('e-carlos', '2026-09-01', '08:00', '16:00'),
  punch('e-carlos', '2026-09-02', '08:00', '16:00'),
  punch('e-carlos', '2026-09-03', '09:00', '17:00'),
  // Dana works one clean day, so "another employee" is a real person with real pay.
  punch('e-dana', '2026-08-24', '08:00', '16:00'),
];

let bseq = 0;
const row = (employee_id, over) => {
  bseq++;
  return {
    id: `b${bseq}`, user_id: 'u1', employee_id,
    period_start: PERIOD.start, period_end: PERIOD.end,
    kind: 'bonus', calculation_type: 'flat', amount_cents: null, rate_cents_per_hour: null,
    target_date: null, description: null,
    created_at: `2026-09-07T18:0${bseq}:00.000Z`, updated_at: `2026-09-07T18:0${bseq}:00.000Z`,
    ...over,
  };
};
/** A FLAT bonus row, shaped as the CHECK constraints require. */
const flat = (employee_id, amount_cents, description, over = {}) =>
  row(employee_id, { calculation_type: 'flat', amount_cents, rate_cents_per_hour: null, target_date: null, description, ...over });
/**
 * An HOURLY bonus row — a RATE and a DAY, and deliberately no stored total anywhere.
 * `target_date` is REQUIRED by the database (migration 151), so it is required here too.
 */
const hourly = (employee_id, rate_cents_per_hour, description, target_date, over = {}) => {
  if (!target_date) throw new Error('hourly() needs a target_date — an hourly bonus is day-specific');
  return row(employee_id, {
    calculation_type: 'hourly', amount_cents: null, rate_cents_per_hour, target_date, description, ...over,
  });
};

const stmt = (adjustments, employee = CARLOS, period = PERIOD, shifts = SHIFTS) =>
  buildPayStatement({ employee, period, shifts, adjustments, generatedAtISO: '2026-09-08T17:00:00.000Z' });

// The baseline the whole feature must not move.
const BASE = stmt(undefined);

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§1 The fixture is the reviewed one, and worked pay is untouched by any of this');
{
  check('72.50 payable hours', BASE.totals.paidHours.toFixed(2) === '72.50', BASE.totals.paidHours.toFixed(2));
  check('$1,595.00 of worked pay', cents(BASE.totals.gross) === 159500, formatMoney(BASE.totals.gross));
  check('with NO adjustments argument at all there are no bonus lines', BASE.bonusItems.length === 0);
  check('...bonusTotal is 0, not undefined', BASE.totals.bonusTotal === 0 && BASE.totals.bonusCents === 0);
  check('...both component totals are 0 too',
    BASE.totals.flatBonusTotal === 0 && BASE.totals.hourlyBonusTotal === 0);
  check('...and totalOwed IS gross — the pre-bonus statement, unchanged',
    BASE.totals.totalOwed === BASE.totals.gross);

  const empty = stmt([]);
  check('an empty adjustments list is identical to omitting it',
    JSON.stringify(empty) === JSON.stringify(BASE));
  const foreign = stmt([flat('e-dana', 50000, 'Dana bonus'), hourly('e-dana', 500, 'Dana incentive', '2026-08-24')]);
  check('another person\'s bonuses leave this statement byte-identical',
    JSON.stringify(foreign) === JSON.stringify(BASE));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§2 FLAT — a fixed sum, worth what was typed');
{
  const s = stmt([flat('e-carlos', 10000, 'Performance bonus')]);
  check('the line is flat', s.bonusItems[0].calculationType === 'flat');
  check('...worth exactly $100.00', s.bonusItems[0].calculatedBonusCents === 10000);
  check('...carrying its entered amount', s.bonusItems[0].amountCents === 10000);
  check('...and NO rate or eligible hours — those belong to the other type',
    s.bonusItems[0].rateCentsPerHour === null && s.bonusItems[0].eligiblePaidHours === null);
  check('it shows its working as "Flat"', formatBonusBasis(s.bonusItems[0]) === 'Flat');
  check('bonus pay is $100.00', formatMoney(s.totals.bonusTotal) === '$100.00');
  check('...all of it flat', cents(s.totals.flatBonusTotal) === 10000 && s.totals.hourlyBonusTotal === 0);
  check('TOTAL OWED is $1,695.00', formatMoney(s.totals.totalOwed) === '$1,695.00');
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§3 HOURLY IS DAY-SPECIFIC — a rate times ONE DAY\'s canonical payable hours');
{
  // The product example: base $25/hr, Tuesday carries 8.00 payable hours, +$5/hr on Tuesday = $40.
  const emp = EMP({ id: 'e-t', hourly_rate: 25 });
  const shifts = [
    punch('e-t', '2026-08-24', '08:00', '16:00'),                 // Mon 8.00
    punch('e-t', '2026-09-01', '08:00', '16:00'),                 // TUE 8.00
    punch('e-t', '2026-09-02', '08:00', '16:00'),                 // Wed 8.00
  ];
  const s = stmt([hourly('e-t', 500, 'Tuesday incentive', '2026-09-01')], emp, PERIOD, shifts);
  const item = s.bonusItems[0];

  check('the line is hourly and names its day', item.calculationType === 'hourly' && item.targetDateISO === '2026-09-01');
  check('...carrying its entered rate', item.rateCentsPerHour === 500);
  check('...and NO flat amount', item.amountCents === null);
  check('the eligible hours are TUESDAY\'s 8.00 — not the period\'s 24.00',
    item.eligiblePaidHours === 8 && s.totals.paidHours === 24);
  check('8.00 hr x $5.00/hr = $40.00', item.calculatedBonusCents === 4000, formatMoney(item.amount));
  check('it shows the day, the rate and the hours', formatBonusBasis(item) === 'Tue Sep 1 · $5.00/hr × 8h payable',
    formatBonusBasis(item));
  check('worked pay is the period\'s 24.00 x $25.00', cents(s.totals.gross) === 60000);
  check('TOTAL OWED = worked + the one day\'s incentive', cents(s.totals.totalOwed) === 60000 + 4000);

  // OTHER DAYS MUST NOT CONTRIBUTE.
  const wed = stmt([hourly('e-t', 500, 'Wednesday incentive', '2026-09-02')], emp, PERIOD, shifts);
  check('a WEDNESDAY incentive prices Wednesday, not Tuesday', wed.bonusItems[0].eligiblePaidHours === 8);
  check('...and moving the day changes nothing about the hours themselves',
    wed.totals.paidHours === s.totals.paidHours);
  const longWed = [...shifts.filter((x) => x.date !== '2026-09-02'), punch('e-t', '2026-09-02', '08:00', '20:00')];
  const tueUnmoved = stmt([hourly('e-t', 500, 'Tuesday incentive', '2026-09-01')], emp, PERIOD, longWed);
  check('lengthening WEDNESDAY leaves a TUESDAY incentive untouched at $40.00',
    tueUnmoved.bonusItems[0].calculatedBonusCents === 4000 && tueUnmoved.totals.paidHours === 28);

  // paidHoursByDate is the statement's own grouping.
  check('totals.paidHoursByDate keys the payable rows by their own date',
    s.totals.paidHoursByDate['2026-09-01'] === 8 && s.totals.paidHoursByDate['2026-08-24'] === 8);
  check('...and it IS paidHoursByDateOf(rows) — one derivation, not two',
    JSON.stringify(s.totals.paidHoursByDate) === JSON.stringify(paidHoursByDateOf(s.rows)));
  check('...summing it gives back the period total',
    Object.values(s.totals.paidHoursByDate).reduce((a, b) => a + b, 0).toFixed(2) === s.totals.paidHours.toFixed(2));
  check('...and it groups exactly as the rendered day groups do',
    payPeriodWeeks(s).flatMap((w) => w.days).filter((d) => d.hours > 0)
      .every((d) => d.hours === s.totals.paidHoursByDate[d.dateISO]));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§4 WHICH HOURS A DAY HAS — the payroll rule, per team, unchanged');
{
  // BREAKS: Tuesday 8h raw minus 30m unpaid = 7.50 payable, so $5/hr pays $37.50.
  const bEmp = EMP({ id: 'e-b', hourly_rate: 20 });
  const brk = [punch('e-b', '2026-09-01', '08:00', '16:00', { break_minutes: 30 })];
  const bS = stmt([hourly('e-b', 500, 'Tuesday incentive', '2026-09-01')], bEmp, PERIOD, brk);
  check('Tuesday 8h raw minus a 30m unpaid break = 7.50 payable hours', bS.totals.paidHours.toFixed(2) === '7.50');
  check('...so $5.00/hr pays $37.50, not $40.00', bS.totals.bonusCents === 3750, formatMoney(bS.totals.bonusTotal));
  check('...and the working says 7h 30m', formatBonusBasis(bS.bonusItems[0]).endsWith('$5.00/hr × 7h 30m payable'));

  // MULTI-SHIFT on the target day: 4 + 4 = 8, priced once.
  const sEmp = EMP({ id: 'e-s', hourly_rate: 20 });
  const split = [punch('e-s', '2026-09-01', '06:00', '10:00'), punch('e-s', '2026-09-01', '14:00', '18:00')];
  const sS = stmt([hourly('e-s', 500, 'Tuesday incentive', '2026-09-01')], sEmp, PERIOD, split);
  check('a split Tuesday is still TWO payable records', sS.rows.length === 2);
  check('...whose hours SUM to 8.00 for the day', sS.totals.paidHoursByDate['2026-09-01'] === 8);
  check('...so the incentive is $40.00, counted once across the pair', sS.totals.bonusCents === 4000);

  // FULFILLMENT: approved_minutes stays inert; the punch prices the day.
  const typo = [punch('e-x', '2026-09-01', '06:06', '13:46', { approved_minutes: 1421 })];
  const ful = EMP({ id: 'e-x', role: 'fulfillment', hourly_rate: 20 });
  const fulS = stmt([hourly('e-x', 500, 'Tuesday incentive', '2026-09-01')], ful, PERIOD, typo);
  check('fulfillment still pays the CLOCKED 7.67 h that day, not the stored 23.68',
    fulS.totals.paidHours.toFixed(2) === '7.67');
  check('...via the real paidShiftHours, unchanged',
    fulS.rows[0].paidHours === paidShiftHours(typo[0], payrollTeamOfRole('fulfillment')));
  check('...so its incentive prices the CLOCKED day: $38.33', fulS.totals.bonusCents === 3833, formatMoney(fulS.totals.bonusTotal));

  // LIVE HOST: the SAME row pays its approved duration, and the incentive follows.
  const host = EMP({ id: 'e-x', role: 'host', hourly_rate: 20 });
  const hostS = stmt([hourly('e-x', 500, 'Tuesday incentive', '2026-09-01')], host, PERIOD, typo);
  check('a live host still pays the APPROVED 23.68 h that day', hostS.totals.paidHours.toFixed(2) === '23.68');
  check('...so its incentive prices the APPROVED day: $118.42', hostS.totals.bonusCents === 11842, formatMoney(hostS.totals.bonusTotal));
  check('...so the two teams differ, and neither check is vacuous', hostS.totals.bonusCents !== fulS.totals.bonusCents);

  // The spec's live-host example: 6.00 approved hours at $3.00/hr = $18.00.
  const h6 = [punch('e-h', '2026-09-01', '06:00', '16:00', { approved_minutes: 360 })];
  const hEmp = EMP({ id: 'e-h', role: 'host', hourly_rate: 25 });
  const h6S = stmt([hourly('e-h', 300, 'Live show incentive', '2026-09-01')], hEmp, PERIOD, h6);
  check('6.00 approved hours x $3.00/hr = $18.00', h6S.totals.bonusCents === 1800, formatMoney(h6S.totals.bonusTotal));

  // UNCONFIRMED: not payable, so the day has 0 eligible bonus hours.
  const unconf = [punch('e-u', '2026-09-01', '08:00', '16:00', { confirmed_at: null })];
  const uS = stmt([hourly('e-u', 500, 'Tuesday incentive', '2026-09-01'), flat('e-u', 10000, 'Flat anyway')],
    EMP({ id: 'e-u', hourly_rate: 20 }), PERIOD, unconf);
  check('an unconfirmed Tuesday punch pays nothing', uS.totals.paidHours === 0);
  check('...so the day has 0 eligible bonus hours and the incentive is $0.00',
    uS.bonusItems.find((b) => b.calculationType === 'hourly').eligiblePaidHours === 0 &&
      cents(uS.totals.hourlyBonusTotal) === 0);
  check('...while the flat bonus is still owed in full', formatMoney(uS.totals.totalOwed) === '$100.00');
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§5 A ZERO-HOUR DAY IS LEGAL, AND RE-PRICES ITSELF LATER');
{
  const emp = EMP({ id: 'e-z', hourly_rate: 20 });
  const worked = [punch('e-z', '2026-09-01', '08:00', '16:00')];
  // Saturday Aug 29: nothing worked.
  const bonusRow = hourly('e-z', 500, 'Saturday cover incentive', '2026-08-29');
  const before = stmt([bonusRow], emp, PERIOD, worked);
  check('the bonus EXISTS on a day with no payable hours', before.bonusItems.length === 1);
  check('...its eligible hours are 0.00', before.bonusItems[0].eligiblePaidHours === 0);
  check('...it is worth $0.00, not an error', before.bonusItems[0].calculatedBonusCents === 0);
  check('...and it still states its day', formatBonusBasis(before.bonusItems[0]).startsWith('Sat Aug 29 · $5.00/hr'));
  check('...leaving total owed equal to worked pay', before.totals.totalOwed === before.totals.gross);

  // A Saturday shift is later added and confirmed.
  const after = stmt([bonusRow], emp, PERIOD, [...worked, punch('e-z', '2026-08-29', '09:00', '15:00')]);
  check('once a 6.00-hour Saturday shift is confirmed, the SAME row is worth $30.00',
    after.bonusItems[0].eligiblePaidHours === 6 && after.bonusItems[0].calculatedBonusCents === 3000);
  check('...with nothing deleted or re-entered', after.bonusItems[0].id === before.bonusItems[0].id);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§6 DYNAMIC REPRICING — and the stored row is never rewritten');
{
  const emp = EMP({ id: 'e-d', hourly_rate: 25 });
  const SH = [punch('e-d', '2026-09-01', '08:00', '16:00'), punch('e-d', '2026-09-02', '08:00', '16:00')];
  const incentive = hourly('e-d', 500, 'Tuesday incentive', '2026-09-01');
  const frozen = JSON.stringify(incentive);
  const before = stmt([incentive], emp, PERIOD, SH);
  check('before: Tuesday 8.00 hr -> $40.00', before.bonusItems[0].calculatedBonusCents === 4000);

  // A REAL correction through the REAL patch builder: Tuesday ends half an hour earlier.
  const target = SH.find((x) => x.date === '2026-09-01');
  const patch = buildShiftEditPatch(target, { end_time: '15:30' });
  check('the correction produced a patch on the punch instant', patch !== null && patch.clock_out_at !== undefined);
  const after = stmt([incentive], emp, PERIOD, SH.map((x) => (x.id === target.id ? { ...x, ...patch } : x)));
  check('after: Tuesday 7.50 payable hours', after.totals.paidHoursByDate['2026-09-01'] === 7.5);
  check('THE INCENTIVE RE-PRICED ITSELF: $40.00 → $37.50', after.bonusItems[0].calculatedBonusCents === 3750,
    formatMoney(after.totals.bonusTotal));
  check('...WITHOUT the stored row changing by a single byte', JSON.stringify(incentive) === frozen);
  check('...and the row still holds only a rate and a day, never a total',
    incentive.rate_cents_per_hour === 500 && incentive.target_date === '2026-09-01' &&
      incentive.amount_cents === null && !Object.keys(incentive).some((k) => /calculated|total/i.test(k)));

  // MOVING THE DAY re-prices off the new day's hours.
  const longWed = SH.map((x) => (x.date === '2026-09-02' ? { ...x, end_time: '20:00:00', clock_out_at: null, clock_in_at: null, source: 'manual' } : x));
  const moved = stmt([{ ...incentive, target_date: '2026-09-02' }], emp, PERIOD, longWed);
  check('editing the target date to Wednesday prices WEDNESDAY\'s 12.00 hours: $60.00',
    moved.bonusItems[0].eligiblePaidHours === 12 && moved.bonusItems[0].calculatedBonusCents === 6000,
    formatMoney(moved.totals.bonusTotal));
  check('...and its stated day moved with it', formatBonusBasis(moved.bonusItems[0]).startsWith('Wed Sep 2 · '));

  // THE BASE RATE IS NEVER TOUCHED.
  check('employee.hourly_rate is still exactly $25.00', emp.hourly_rate === 25 && after.rate === 25);
  check('...and the rate line still prices worked pay at $25.00, not $30.00',
    after.rateLines.every((l) => l.rate === 25) && cents(after.totals.gross) === cents(after.totals.paidHours * 25));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§7 THE PRODUCT EXAMPLE, end to end');
{
  // Base $25/hr · 80.00 period hours · $2,000.00 worked · Tuesday 8.00 hr · +$5/hr · $40 · $2,040.
  const emp = EMP({ id: 'e-p', hourly_rate: 25 });
  const SH = [
    punch('e-p','2026-08-24','08:00','16:00'), punch('e-p','2026-08-25','08:00','16:00'),
    punch('e-p','2026-08-26','08:00','16:00'), punch('e-p','2026-08-27','08:00','16:00'),
    punch('e-p','2026-08-28','08:00','16:00'), punch('e-p','2026-08-31','08:00','16:00'),
    punch('e-p','2026-09-01','06:00','10:00'), punch('e-p','2026-09-01','14:00','18:00'),
    punch('e-p','2026-09-02','08:00','16:00'), punch('e-p','2026-09-03','08:00','16:00'),
    punch('e-p','2026-09-04','08:00','16:00'),
  ];
  const s = stmt([hourly('e-p', 500, 'Tuesday incentive', '2026-09-01')], emp, PERIOD, SH);
  check('80.00 payable hours', s.totals.paidHours.toFixed(2) === '80.00', s.totals.paidHours.toFixed(2));
  check('$2,000.00 worked pay', formatMoney(s.totals.gross) === '$2,000.00');
  check('Tuesday carries 8.00 payable hours (4 + 4)', s.totals.paidHoursByDate['2026-09-01'] === 8);
  check('Tuesday incentive = $40.00', formatMoney(s.totals.bonusTotal) === '$40.00');
  check('TOTAL OWED = $2,040.00', formatMoney(s.totals.totalOwed) === '$2,040.00');
  check('EMPLOYEE BASE RATE IS STILL $25.00/hr — never $30.00', emp.hourly_rate === 25 && s.rate === 25);
  check('...and nothing in the statement reports a $30 rate',
    !JSON.stringify(s.rateLines).includes('30') && s.rows.every((r) => r.rate === 25));
}
// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§7b ADD / EDIT / DELETE, and the scoping that keeps money where it was put');
{
  const emp = EMP({ id: 'e-c', hourly_rate: 25 });
  const other = EMP({ id: 'e-c2', name: 'Someone Else', hourly_rate: 25 });
  const SH = [
    punch('e-c', '2026-09-01', '08:00', '16:00'),   // TUE 8.00
    punch('e-c', '2026-09-02', '08:00', '16:00'),   // WED 8.00
    punch('e-c2', '2026-09-01', '08:00', '16:00'),  // the other person's own Tuesday
  ];
  const base = stmt([], emp, PERIOD, SH);
  const f = flat('e-c', 10000, 'Performance');
  const h = hourly('e-c', 500, 'Tuesday incentive', '2026-09-01');

  // ADD
  check('ADD FLAT $100.00 -> total +$100.00',
    cents(stmt([f], emp, PERIOD, SH).totals.totalOwed) - cents(base.totals.totalOwed) === 10000);
  check('ADD HOURLY $5.00/hr on an 8.00-hour Tuesday -> total +$40.00',
    cents(stmt([h], emp, PERIOD, SH).totals.totalOwed) - cents(base.totals.totalOwed) === 4000);

  // EDIT
  check('EDIT FLAT $100 -> $125 changes total by +$25.00',
    cents(stmt([{ ...f, amount_cents: 12500 }], emp, PERIOD, SH).totals.totalOwed)
      - cents(stmt([f], emp, PERIOD, SH).totals.totalOwed) === 2500);
  check('EDIT RATE $5.00 -> $7.50/hr re-prices off the SAME day: $60.00',
    stmt([{ ...h, rate_cents_per_hour: 750 }], emp, PERIOD, SH).totals.bonusCents === 6000);
  check('EDIT DAY Tuesday -> Wednesday prices WEDNESDAY\'s hours',
    stmt([{ ...h, target_date: '2026-09-02' }], emp, PERIOD, SH).bonusItems[0].targetDateISO === '2026-09-02');

  // Neither edit touched worked time.
  for (const [label, rows] of [['flat edit', [{ ...f, amount_cents: 12500 }]], ['rate edit', [{ ...h, rate_cents_per_hour: 750 }]],
                               ['day edit', [{ ...h, target_date: '2026-09-02' }]]]) {
    const e2 = stmt(rows, emp, PERIOD, SH);
    check(`a ${label} left the payable rows byte-identical`, JSON.stringify(e2.rows) === JSON.stringify(base.rows));
    check(`...and worked pay untouched`, e2.totals.gross === base.totals.gross);
  }

  // DELETE
  const both = stmt([f, h], emp, PERIOD, SH);
  const deleted = stmt([h], emp, PERIOD, SH);
  check('DELETE the flat bonus drops total by exactly $100.00',
    cents(both.totals.totalOwed) - cents(deleted.totals.totalOwed) === 10000);
  check('...the hourly line survives, still worth $40.00', deleted.totals.bonusCents === 4000);
  check('...and worked hours are untouched', deleted.totals.paidHours === base.totals.paidHours);
  check('deleting every bonus restores the original statement, byte for byte',
    JSON.stringify(stmt([], emp, PERIOD, SH)) === JSON.stringify(base));

  // MULTI-EMPLOYEE ISOLATION.
  const otherS = stmt([f, h], other, PERIOD, SH);
  check('another employee sees neither bonus', otherS.bonusItems.length === 0 && otherS.totals.bonusCents === 0);
  check('...even though they worked the SAME Tuesday', otherS.totals.paidHoursByDate['2026-09-01'] === 8);
  check('...and they still get paid their own worked time', cents(otherS.totals.gross) === cents(8 * 25));

  // PAY PERIOD ISOLATION — prior, next and off-cycle, via the canonical helpers.
  for (const [label, per] of [['PREVIOUS period', PREV_PERIOD],
                              ['NEXT period', { start: '2026-09-07', end: '2026-09-20' }]]) {
    check(`a bonus is invisible in the ${label}`, stmt([f, h], emp, { ...per, payday: '' }, SH).bonusItems.length === 0);
  }
  check('a bonus is invisible in an OFF-CYCLE window',
    stmt([f, h], emp, { start: '2026-08-25', end: '2026-09-07', payday: '' }, SH).bonusItems.length === 0);

  // NO DESCRIPTION still renders as something, in either type.
  check('a flat bonus with no reason renders a plain label',
    stmt([flat('e-c', 2500, null)], emp, PERIOD, SH).bonusItems[0].label === BONUS_FALLBACK_LABEL);
  check('...and so does an hourly one, which still states its day',
    stmt([hourly('e-c', 500, '   ', '2026-09-01')], emp, PERIOD, SH).bonusItems[0].label === BONUS_FALLBACK_LABEL);

  // bonusSummaryFor is still the one shared selector buildPayStatement uses.
  const viaSelector = bonusSummaryFor([f, h], 'e-c', PERIOD, base.totals.paidHoursByDate);
  check('bonusSummaryFor over the statement\'s own per-day hours gives the statement\'s own total',
    viaSelector.cents === both.totals.bonusCents, formatMoney(viaSelector.total));
  check('...split correctly into flat and hourly', viaSelector.flatCents === 10000 && viaSelector.hourlyCents === 4000);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§8 MONEY — cents, never floats');
{
  const drift = stmt([flat('e-carlos', 10, 'ten cents'), flat('e-carlos', 20, 'twenty cents')]);
  check('$0.10 + $0.20 is exactly $0.30', drift.totals.bonusCents === 30 && formatMoney(drift.totals.bonusTotal) === '$0.30');
  check('...and the naive float sum would NOT have been', 0.1 + 0.2 !== 0.3, 'the check above is not vacuous');

  const many = Array.from({ length: 100 }, (_, i) => flat('e-carlos', 1007, `bonus ${i}`));
  check('100 x $10.07 is exactly $1,007.00',
    sumBonusCents(bonusItemsFor(many, 'e-carlos', PERIOD, 72.5)) === 100700);
  check('centsToDollars is a pure divide', centsToDollars(12345) === 123.45 && centsToDollars(0) === 0);

  // Parsing an AMOUNT.
  check('"150" → 15000 cents', parseBonusAmount('150').cents === 15000);
  check('"150.5" → 15050 cents (fifty cents, not five)', parseBonusAmount('150.5').cents === 15050);
  check('"$1,595.00" → 159500 cents', parseBonusAmount('$1,595.00').cents === 159500);
  check('"19.99" → 1999, which Number("19.99")*100 is not',
    parseBonusAmount('19.99').cents === 1999 && Number('19.99') * 100 !== 1999);
  // Parsing a RATE.
  check('"2" as a rate → 200 cents/hr', parseBonusAmount('2', 'rate').cents === 200);
  check('"2.50" as a rate → 250 cents/hr', parseBonusAmount('2.50', 'rate').cents === 250);
  check('"$2.00/hr" as a rate → 200 cents/hr', parseBonusAmount('$2.00/hr', 'rate').cents === 200);
  for (const bad of ['', '   ', '0', '0.00', '-5', 'abc', '1.234', '1e3']) {
    check(`"${bad}" is refused as an amount`, parseBonusAmount(bad).ok === false);
    check(`"${bad}" is refused as a rate`, parseBonusAmount(bad, 'rate').ok === false);
  }
  check('a refusal carries a sentence, not a token', /[a-z] [a-z]/.test(parseBonusAmount('abc').error));
  check('a rate refusal says so in its own words',
    parseBonusAmount('', 'rate').error !== parseBonusAmount('', 'amount').error);
  check('the amount cap matches the SQL cap', BONUS_MAX_CENTS === 100000000);
  check('the rate cap matches the SQL cap, and is far lower', BONUS_MAX_RATE_CENTS === 100000 && BONUS_MAX_RATE_CENTS < BONUS_MAX_CENTS);
  check('$1,000,000.00 flat is allowed, $1,000,000.01 is not',
    parseBonusAmount('1000000').cents === BONUS_MAX_CENTS && parseBonusAmount('1000000.01').ok === false);
  check('$1,000.00/hr is allowed, $1,000.01/hr is not',
    parseBonusAmount('1000', 'rate').cents === BONUS_MAX_RATE_CENTS && parseBonusAmount('1000.01', 'rate').ok === false);
  check('a flat-sized amount typed into the rate box is refused', parseBonusAmount('100000', 'rate').ok === false);

  check('centsToInput round-trips', centsToInput(10050) === '100.50' && centsToInput(250) === '2.50' && centsToInput(5) === '0.05');
  check('an edit form opens on the stored figure', parseBonusAmount(centsToInput(12345)).cents === 12345);
  check('description normalization trims and collapses',
    normalizeBonusDescription('  Performance   bonus  ') === 'Performance bonus');
  check('...and an empty reason is no reason', normalizeBonusDescription('   ') === null);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§9 THE PAY TILE reads the same numbers the statement does — both types');
{
  // '2026-08-25' carries 8.00 payable hours in the module fixture.
  const items = [
    flat('e-carlos', 10000, 'Performance bonus'),
    flat('e-carlos', 5000, 'Attendance bonus'),
    hourly('e-carlos', 200, 'Tuesday incentive', '2026-08-25'),
  ];

  // Exactly what PayView now does for a tile: computePay for the worked figures, and the NORMALIZED
  // STATEMENT for the bonus — because a day-specific bonus needs per-day hours only it produces.
  const pay = computePay([CARLOS, OTHER], SHIFTS);
  for (const p of pay) {
    const detail = stmt(items, p.employee);
    const tileTotal = totalOwedOf(p.pay, detail.totals.bonusTotal);
    check(`${p.employee.name}: the tile's total owed IS the statement's total owed`,
      cents(tileTotal) === cents(detail.totals.totalOwed), formatMoney(tileTotal));
    check(`${p.employee.name}: computePay's worked pay IS the statement's gross`,
      cents(p.pay) === cents(detail.totals.gross));
    check(`${p.employee.name}: computePay's hours ARE the statement's payable hours`,
      p.hours === detail.totals.paidHours);
  }

  const carlos = stmt(items);
  check('Carlos: $150.00 flat + 8.00 hr x $2.00 = $166.00 of bonus pay',
    cents(carlos.totals.flatBonusTotal) === 15000 && cents(carlos.totals.hourlyBonusTotal) === 1600 &&
      formatMoney(carlos.totals.bonusTotal) === '$166.00');
  check('Dana carries none of it', stmt(items, OTHER).totals.bonusCents === 0);
  check('...and still gets paid her own worked time', cents(stmt(items, OTHER).totals.gross) === cents(8 * 22));

  const rosterTotal = pay.reduce((a, p) => a + totalOwedOf(p.pay, stmt(items, p.employee).totals.bonusTotal), 0);
  const rosterWorked = pay.reduce((a, p) => a + p.pay, 0);
  check('the roster total exceeds worked pay by exactly the bonuses',
    cents(rosterTotal) - cents(rosterWorked) === 16600);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§9b THE PRINTED WORKING MUST MULTIPLY OUT TO THE PRINTED MONEY');
{
  // THE CASE THAT PROMPTED THIS. A live host on 1828 approved minutes at $3.00/hr is owed exactly
  // $91.40. Stated as '30.47 hr' the expression read 30.47 x 3.00 = $91.41, so a CORRECT payroll
  // figure was printed beside arithmetic that made it look a penny short.
  const oddHost = EMP({ id: 'e-odd', role: 'host', hourly_rate: 25 });
  const oddShift = [punch('e-odd', '2026-08-24', '06:00', '14:00', { approved_minutes: 1828 })];
  const oddS = stmt([hourly('e-odd', 300, 'Live show incentive', '2026-08-24')], oddHost, PERIOD, oddShift);
  const oddItem = oddS.bonusItems[0];

  check('the exact payable duration is still 30.4666… hours',
    Math.abs(oddItem.eligiblePaidHours - 1828 / 60) < 1e-12, String(oddItem.eligiblePaidHours));
  check('the money is unchanged — still $91.40', oddItem.calculatedBonusCents === 9140);
  check('the basis reads as a DAY plus a duration', formatBonusBasis(oddItem) === 'Mon Aug 24 · $3.00/hr × 30h 28m payable',
    formatBonusBasis(oddItem));
  check('...and 30h 28m x $3.00 IS $91.40 — the visible arithmetic reconciles',
    Math.round(300 * (30 + 28 / 60)) === 9140);
  check('...the misleading "30.47" appears nowhere in it', !formatBonusBasis(oddItem).includes('30.47'));
  check('...nor any bare 2-decimal hour figure at all', !/\d+\.\d\d\s*hr/.test(formatBonusBasis(oddItem)));

  // The clean case still reads cleanly.
  const clean = stmt([hourly('e-carlos', 200, 'Productivity incentive', '2026-08-24')]).bonusItems[0];
  check('a whole-hour day reads as a duration too', formatBonusBasis(clean).endsWith('$2.00/hr × 8h payable'),
    formatBonusBasis(clean));
  check('...and 8h x $2.00 IS $16.00', Math.round(200 * 8) === 1600 && clean.calculatedBonusCents === 1600);

  // ── THE PROPERTY ITSELF, not just two examples ───────────────────────────────────────────────
  // Parse the rendered duration back out of the string and multiply it by the rendered rate. That
  // is exactly what a reader checking the line by hand would do, so it must come out at the
  // rendered money — unless the line carries the '~' that says the figure is rounded.
  const parseBasis = (basis) => {
    const m = /^(?:[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} · )?\$([\d,]+\.\d\d)\/hr × (~?)((?:\d+h ?)?(?:\d+m ?)?(?:\d+s ?)?) payable$/.exec(basis);
    if (!m) return null;
    const rateCents = Math.round(Number(m[1].replace(/,/g, '')) * 100);
    const d = /^(?:(\d+)h ?)?(?:(\d+)m ?)?(?:(\d+)s ?)?$/.exec(m[3].trim());
    const hours = Number(d[1] || 0) + Number(d[2] || 0) / 60 + Number(d[3] || 0) / 3600;
    return { rateCents, approx: m[2] === '~', hours };
  };

  // Rates a real incentive might carry, against durations of every shape: whole hours, whole
  // minutes, whole seconds, and sub-second spans of the kind 512 of 522 production punches have.
  const RATES = [1, 25, 100, 150, 200, 250, 300, 333, 500, 1000, 7199, 100000];
  const HOURS = [
    0, 0.25, 1, 7.5, 8, 30 + 28 / 60, 72.5, 1828 / 60, 1421 / 60, 242 / 60,
    7 + 40 / 60 + 23 / 3600,                     // whole seconds
    7.673055555555556 + 0.0000317,               // sub-second, like a real punch
    23.684722222222224, 30.466666666666665, 12.345678901234,
  ];
  let examined = 0, exact = 0, approx = 0, unparsed = 0, mismatched = 0;
  for (const rateCents of RATES) {
    for (const h of HOURS) {
      const item = {
        calculationType: 'hourly', rateCentsPerHour: rateCents, targetDateISO: '2026-09-01',
        eligiblePaidHours: h, calculatedBonusCents: hourlyBonusCents(rateCents, h),
      };
      const basis = formatBonusBasis(item);
      const parsed = parseBasis(basis);
      examined++;
      if (!parsed) { unparsed++; continue; }
      if (parsed.rateCents !== rateCents) { mismatched++; continue; }
      const asRead = Math.round(parsed.rateCents * parsed.hours);
      if (asRead === item.calculatedBonusCents) exact++;
      else if (parsed.approx) approx++;
      else mismatched++;
    }
  }
  check('every rendered basis parses back to a rate and a duration', unparsed === 0, `${examined} examined`);
  check('NO line shows arithmetic that disagrees with the money beside it', mismatched === 0,
    `${examined} combinations examined`);
  check('...and the overwhelming majority reconcile EXACTLY, with no hedge',
    exact >= examined - approx && exact > examined * 0.9, `${exact}/${examined} exact, ${approx} marked ~`);
  // Anti-vacuity in both directions: the '~' tier must be reachable, and the old format must fail.
  check('the "~" tier is reachable, so the check above is not passing by never firing', approx > 0,
    `${approx} lines needed the marker`);
  check('...and the OLD 2-decimal format would have failed this very property',
    Math.round(300 * 30.47) !== 9140, `30.47 x $3.00 = ${(Math.round(300 * 30.47) / 100).toFixed(2)}`);

  // The three tiers, named.
  check('tier 1 — whole minutes, for an approved-hours host', formatBonusBasis(oddItem).includes('30h 28m'));
  const secs = { calculationType: 'hourly', rateCentsPerHour: 200, targetDateISO: '2026-09-01', eligiblePaidHours: 7 + 40 / 60 + 23 / 3600 };
  secs.calculatedBonusCents = hourlyBonusCents(200, secs.eligiblePaidHours);
  check('tier 2 — whole seconds, for an ordinary clocked punch',
    formatBonusBasis(secs) === 'Tue Sep 1 · $2.00/hr × 7h 40m 23s payable', formatBonusBasis(secs));
  const wild = { calculationType: 'hourly', rateCentsPerHour: 90000, targetDateISO: '2026-09-01', eligiblePaidHours: 7.6730872 };
  wild.calculatedBonusCents = hourlyBonusCents(90000, wild.eligiblePaidHours);
  check('tier 3 — a rate so high that even seconds cannot reconcile says so with "~"',
    formatBonusBasis(wild).includes('$900.00/hr × ~'), formatBonusBasis(wild));

  // Shapes of the duration itself.
  check('a whole number of hours drops the minutes', formatPayableDuration(8) === '8h');
  check('under an hour drops the hours', formatPayableDuration(0.75) === '45m');
  check('zero is stated, not blank', formatPayableDuration(0) === '0m');
  check('seconds only appear when asked for',
    formatPayableDuration(7 + 40 / 60 + 23 / 3600) === '7h 40m' &&
      formatPayableDuration(7 + 40 / 60 + 23 / 3600, 3600) === '7h 40m 23s');

  // ── AND THE REST OF THE STATEMENT IS UNTOUCHED ───────────────────────────────────────────────
  // This is a bonus-line presentation change only. The normal hours displays keep their decimals.
  check('the statement\'s own payable-hours figure still reads 30.47',
    oddS.totals.paidHours.toFixed(2) === '30.47');
  check('...and Carlos\'s still reads 72.50', BASE.totals.paidHours.toFixed(2) === '72.50');
  check('the week subtotals still carry 2-decimal hours',
    payPeriodWeeks(BASE)[0].hours.toFixed(2) === '40.50');
  check('a FLAT line still just says "Flat" — no duration anywhere near it',
    formatBonusBasis(stmt([flat('e-carlos', 10000, 'Performance bonus')]).bonusItems[0]) === 'Flat');
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§9c THE DAY IS ENFORCED, AND THERE IS NO PAY-PERIOD HOURLY OPTION');
{
  const sql = src('../../../supabase/migrations/151_bonus_target_date.sql');
  const ddl = sql.replace(/^\s*--[^\n]*$/gm, '');

  check('151 adds target_date, nullable with no default', /add column if not exists target_date date/.test(ddl));
  check('...and NOTHING else — no scope column', !/add column[^;]*scope/i.test(ddl));
  check('a FLAT row may not carry a day',
    /check \(calculation_type <> 'flat' or target_date is null\)/.test(ddl));
  check('an HOURLY row MUST carry a day — the client is not trusted with this',
    /check \(calculation_type <> 'hourly' or target_date is not null\)/.test(ddl));
  check('...and that day must be INSIDE the bonus\'s own pay period',
    /check \(target_date is null\s+or \(target_date >= period_start and target_date <= period_end\)\)/.test(ddl));
  check('150\'s constraints are left alone — no drop/re-add on a table holding real money',
    !/drop constraint/i.test(ddl));
  check('it writes no data — no backfill of any kind',
    !/\binsert\s+into\b/i.test(ddl) && !/\bupdate\s+public\./i.test(ddl) && !/\bdelete\s+from\b/i.test(ddl));
  check('it creates and replaces no function', !/create (or replace )?function/i.test(ddl));
  check('...and touches no payroll table', !/alter table public\.(shifts|employees|shift_instances)/i.test(ddl));
  check('the file records that it HAS been applied, with a date and a do-not-repeat warning',
    /✅ APPLIED TO PRODUCTION \d{4}-\d{2}-\d{2}/.test(sql) && /DO NOT APPLY IT AGAIN/.test(sql) &&
      !/⛔ NOT APPLIED/.test(sql));
  check('...and states the zero-hourly-rows gate that made the change safe',
    /ZERO hourly rows/.test(sql));

  // The constraint predicates, as a truth table, evaluated here the way the preflight runs them
  // against live Postgres.
  const flatOk   = (t, d) => t !== 'flat'   || d === null;
  const hourlyOk = (t, d) => t !== 'hourly' || d !== null;
  const inPeriod = (d) => d === null || (d >= PERIOD.start && d <= PERIOD.end);
  const TRUTH = [
    ['flat',   null,         true ],
    ['flat',   '2026-08-25', false],  // a flat bonus has no day
    ['hourly', '2026-08-25', true ],
    ['hourly', null,         false],  // an hourly bonus must name one
    ['hourly', '2026-09-07', false],  // ...inside its own period
    ['hourly', '2026-08-23', false],  // ...on both sides
  ];
  const bad = TRUTH.filter(([t, d, want]) => (flatOk(t, d) && hourlyOk(t, d) && inPeriod(d)) !== want);
  check('the three predicates admit exactly the rows they should', bad.length === 0,
    `${TRUTH.length} cases, ${TRUTH.filter((x) => x[2]).length} admissible`);

  // NO PAY-PERIOD HOURLY OPTION ANYWHERE.
  const model = strip(src('./statement.ts'));
  check('the statement model exposes no period-wide hourly concept',
    !/periodWide|wholePeriod|entirePeriod/i.test(model));
  check('an hourly BonusItem always reports the day it priced',
    /targetDateISO: string \| null/.test(src('./statement.ts')));
  check('...and the basis string leads with it',
    /const day = item\.targetDateISO \?/.test(src('./statement.ts')));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§10 THE GUARANTEES THAT LIVE IN SQL — asserted over the real migration');
{
  const sql = src('../../../supabase/migrations/150_employee_pay_adjustments.sql');
  // Strip SQL comments so the assertions match EXECUTABLE SQL, never the explanation above it.
  const ddl = sql.replace(/^\s*--[^\n]*$/gm, '');

  check('the table is created', /create table if not exists public\.employee_pay_adjustments/.test(ddl));

  // OWNER.
  check('user_id DEFAULTS to auth.uid() — the client never names an owner',
    /user_id uuid not null default auth\.uid\(\)/.test(ddl));
  check('...and the hook does not send one either', !/user_id/.test(strip(src('../../hooks/usePayAdjustments.ts'))));

  // TENANT.
  check('the FK target index on employees exists',
    /create unique index if not exists uq_employees_id_user\s+on public\.employees \(id, user_id\)/.test(ddl));
  check('the employee FK is COMPOSITE on (employee_id, user_id)',
    /foreign key \(employee_id, user_id\) references public\.employees \(id, user_id\)/.test(ddl));
  check('...so a bonus of EITHER type cannot point at another tenant\'s employee',
    !/employee_id uuid not null references public\.employees\s*\(\s*id\s*\)/.test(ddl));

  // RLS — unchanged by the addition of a second calculation type.
  check('RLS is enabled', /alter table public\.employee_pay_adjustments enable row level security/.test(ddl));
  check('the own-row policy covers ALL verbs', /create policy employee_pay_adjustments_own_rows[\s\S]*?for all/.test(ddl));
  check('...it gates reads with auth.uid() = user_id', /using \(auth\.uid\(\) = user_id\)/.test(ddl));
  check('...and writes too', /with check \(auth\.uid\(\) = user_id\)/.test(ddl));
  check('authenticated is granted the four verbs it needs',
    /grant select, insert, update, delete on public\.employee_pay_adjustments to authenticated/.test(ddl));
  check('anon gets nothing', /revoke all on public\.employee_pay_adjustments from anon/.test(ddl));

  // THE TWO TYPES.
  check('calculation_type exists and is closed to two values',
    /calculation_type text not null default 'flat'/.test(ddl) &&
      /check \(calculation_type in \('flat', 'hourly'\)\)/.test(ddl));
  check('both money columns are integer cents', /amount_cents integer/.test(ddl) && /rate_cents_per_hour integer/.test(ddl));
  check('...and NEITHER is NOT NULL — the shape checks police them, so both types stay writable',
    !/amount_cents integer not null/.test(ddl) && !/rate_cents_per_hour integer not null/.test(ddl));
  check('a FLAT row must carry a positive amount and NO rate',
    /check \(calculation_type <> 'flat'\s+or \(amount_cents is not null and amount_cents > 0 and rate_cents_per_hour is null\)\)/.test(ddl));
  check('an HOURLY row must carry a positive rate and NO amount',
    /check \(calculation_type <> 'hourly'\s+or \(rate_cents_per_hour is not null and rate_cents_per_hour > 0 and amount_cents is null\)\)/.test(ddl));
  check('both ceilings are present, and the rate ceiling is the lower one',
    /check \(amount_cents is null or amount_cents <= 100000000\)/.test(ddl) &&
      /check \(rate_cents_per_hour is null or rate_cents_per_hour <= 100000\)/.test(ddl));

  // The shape predicates, evaluated here on the same truth table the preflight runs in Postgres.
  const flatOk = (ct, amt, rate) => ct !== 'flat' || (amt !== null && amt > 0 && rate === null);
  const hourlyOk = (ct, amt, rate) => ct !== 'hourly' || (rate !== null && rate > 0 && amt === null);
  const TRUTH = [
    ['flat', 10000, null, true], ['flat', null, null, false], ['flat', 0, null, false],
    ['flat', -1, null, false], ['flat', 10000, 200, false],
    ['hourly', null, 200, true], ['hourly', null, null, false], ['hourly', null, 0, false],
    ['hourly', 10000, 200, false], ['hourly', 10000, null, false],
  ];
  const mismatches = TRUTH.filter(([ct, a, r, want]) => (flatOk(ct, a, r) && hourlyOk(ct, a, r)) !== want);
  check('the shape predicates admit exactly the rows they should', mismatches.length === 0,
    `${TRUTH.length} rows examined, ${TRUTH.filter((t) => t[3]).length} admissible`);

  // NO STORED TOTAL — the property the whole derivation rests on. Asserted over the COLUMN LIST
  // itself, not the whole file: `comment on table` legitimately contains the words "total" and
  // "calculated" (it is the sentence telling the next reader never to add such a column), and a
  // guard that matched prose would be measuring the warning instead of the schema.
  const createBody = /create table if not exists public\.employee_pay_adjustments \(([\s\S]*?)\n\);/.exec(ddl);
  check('the column list was actually found — this guard is not vacuous', createBody !== null);
  const columns = createBody[1]
    .split('\n')
    .filter((l) => !/^\s*constraint\b/.test(l) && !/^\s*(or|check|foreign key|on update)\b/.test(l))
    .join('\n');
  check('the column list has the columns we expect to see',
    /amount_cents/.test(columns) && /rate_cents_per_hour/.test(columns) && /calculation_type/.test(columns));
  check('...and NO calculated/derived total column among them',
    !/calculated|_total\b|bonus_cents/i.test(columns), columns.replace(/\s+/g, ' ').slice(0, 80));
  check('...and nothing in the app writes one either',
    !/calculated_/i.test(strip(src('../../hooks/usePayAdjustments.ts'))));

  // PERIOD — the literal is DERIVED, and this is the pin.
  const m = /\(\(period_start - date '(\d{4}-\d{2}-\d{2})'\) % 14\) = 0/.exec(ddl);
  check('the period CHECK exists and carries a date literal', m !== null);
  const anchorStart = payPeriodFor(PAY_ANCHOR).start;
  check('...and that literal IS payPeriodFor(PAY_ANCHOR).start, from the real helper',
    m[1] === anchorStart, `${m[1]} vs ${anchorStart}`);
  check('...and a period is exactly 14 days', /period_end = period_start \+ 13/.test(ddl));

  const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
  let walked = 0, ok = true;
  for (let off = -40; off <= 40; off++) {
    const p = payPeriodFor(isoAdd(PAY_ANCHOR, off * 14));
    if (daysBetween(p.start, p.end) !== 13) ok = false;
    if (daysBetween(anchorStart, p.start) % 14 !== 0) ok = false;
    walked++;
  }
  check('every one of 81 real pay periods satisfies the SQL predicate', ok && walked === 81, `${walked} examined`);
  check('...and an off-cycle window would be refused', daysBetween(anchorStart, isoAdd(anchorStart, 7)) % 14 !== 0);

  // APPLIED, and recorded as such — this DB has no migration ledger, so the file header IS the
  // deployment record and the assertion follows it (exactly as 149's suite does).
  check('the file records that it HAS been applied to production',
    /✅ APPLIED TO PRODUCTION/.test(sql) && !/⛔ NOT APPLIED/.test(sql));
  check('...with a date, and a DO-NOT-APPLY-AGAIN warning',
    /APPLIED TO PRODUCTION \d{4}-\d{2}-\d{2}/.test(sql) && /DO NOT APPLY IT AGAIN/.test(sql));
  for (const forbidden of ['shifts', 'approved_minutes', 'hourly_rate', 'confirmed_at', 'break_minutes']) {
    check(`the migration never writes ${forbidden}`,
      !new RegExp(`(update|insert into|alter table)[^;]*\\b${forbidden}\\b`, 'i').test(ddl));
  }
  check('it writes no data at all — no backfill, no seed',
    !/\binsert\s+into\b/i.test(ddl) && !/\bupdate\s+public\./i.test(ddl) && !/\bdelete\s+from\b/i.test(ddl));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§11 THE UI RENDERS THE MODEL AND NEITHER ADDS NOR MULTIPLIES');
{
  const panel = strip(src('../../components/employees/BonusPanel.tsx'));
  const modal = strip(src('../../components/employees/PayDetailModal.tsx'));
  const grid = strip(src('../../components/employees/PayGrid.tsx'));
  const view = strip(src('../../components/employees/PayView.tsx'));
  const hook = strip(src('../../hooks/usePayAdjustments.ts'));

  // PAY DETAILS.
  check('Pay Details renders the bonus section', /<BonusSection[\s\n]/.test(modal));
  check('...fed from statement.bonusItems', /items=\{statement\.bonusItems\}/.test(modal));
  check('...with the subtotal read off the statement', /bonusTotal=\{statement\.totals\.bonusTotal\}/.test(modal));
  check('...and the headline is TOTAL OWED', /fmt\(statement\.totals\.totalOwed\)/.test(modal));
  check('the + Add Bonus action sits by the summary', /<AddBonusButton/.test(modal));
  check('the bonus section comes AFTER the week tables and BEFORE the total',
    modal.indexOf('<BonusSection') > modal.lastIndexOf('<Week') &&
      modal.indexOf('<BonusSection') < modal.lastIndexOf('Total owed'));
  check('the form is told the period\'s days and their hours, rather than working them out',
    /periodDays=\{periodDays\}/.test(modal) && /paidHoursByDate=\{statement\.totals\.paidHoursByDate\}/.test(modal));
  check('...and that day list comes from the SAME week grouping the panel renders',
    /weeks\.flatMap\(\(w\) => w\.days\.map\(\(d\) => d\.dateISO\)\)/.test(modal));
  check('Pay Details does no arithmetic over money',
    !/totals\.gross\s*\+|\+\s*totals\.bonus|bonusItems\.reduce|rateCentsPerHour\s*\*/.test(modal));

  // THE PANEL — this is where a second rate x hours would most plausibly appear.
  check('each line shows its working through the shared formatter', /formatBonusBasis\(item\)/.test(panel));
  check('...and the panel never multiplies a rate by hours itself',
    !/rateCentsPerHour\s*\*|\*\s*eligiblePaidHours|\*\s*paidHours/.test(panel));
  check('...nor sums the lines', !/reduce\(/.test(panel) && !/calculatedBonusCents\s*\+/.test(panel));
  check('it prints the subtotal it was handed', /\{fmt\(bonusTotal\)\}/.test(panel));
  check('the empty case renders nothing at all', /if \(items\.length === 0\) return null;/.test(panel));
  check('edit and delete are offered per line, wired to the caller\'s handlers',
    /onClick=\{\(\) => onEditItem\(item\)\}/.test(panel) && /onClick=\{\(\) => onDeleteItem\(item\)\}/.test(panel));
  check('both dialogs go through OverlayLayer, above the z-50 panel that opened them',
    (panel.match(/<OverlayLayer>/g) || []).length === 2);
  check('the form offers BOTH bonus types when adding',
    /value: 'flat'/.test(panel) && /value: 'hourly'/.test(panel) && /type="radio"/.test(panel));
  // THE SIMPLIFICATION: an hourly bonus is day-specific, full stop.
  check('an hourly bonus REQUIRES a day, offered as a closed list of the period\'s own dates',
    /periodDays\.map\(\(d\)/.test(panel) && /periodDays\.includes\(targetDate\)/.test(panel));
  check('...and there is NO "entire pay period" hourly option anywhere in the UI',
    !/entire pay period/i.test(panel) && !/whole pay period/i.test(panel) && !/scope/i.test(panel));
  // Comment-stripped: these files describe themselves at length and both legitimately use the WORD
  // "scope" in prose ("scoped to one pay period", "RLS already scopes this"). What must not exist
  // is a scope IDENTIFIER — a field, column or variable encoding a second source of truth beside
  // target_date.
  check('...nor any scope field/column in the model or the write path', (() => {
    const model = strip(src('./statement.ts'));
    const hook2 = strip(src('../../hooks/usePayAdjustments.ts'));
    const ident = /\bscope\b\s*[:?=]|['"]scope['"]|scope_/i;
    return !ident.test(model) && !ident.test(hook2);
  })());
  check('...and the row type carries a target_date, not a scope',
    /target_date/.test(src('../../types/index.ts')) && !/\bscope\b\s*[:?]/i.test(strip(src('../../types/index.ts'))));
  check('...and the hourly hint says ONE chosen day', /ONE chosen day/.test(panel));
  check('...and does NOT offer a type change when editing — delete and re-add instead',
    /editing \?/.test(panel) && /delete this bonus and add it again/.test(panel));
  check('the form parses money through the shared parser, never with Number()',
    /parseBonusAmount\(value, hourly \? 'rate' : 'amount'\)/.test(panel) &&
      !/Number\(/.test(panel) && !/parseFloat/.test(panel));
  check('the delete dialog states the basis and calls a derived figure a CURRENT value',
    /formatBonusBasis\(item\)/.test(panel) && /Current value/.test(panel));

  // THE TILE.
  check('the tile headline is total owed', /\{fmt\(totalOwed\)\}/.test(grid));
  check('...the bonus note is conditional, so the grid does not change shape', /bonusTotal > 0 &&/.test(grid));
  check('...and carries no formula — no rate, no eligible hours, no basis string',
    !/eligiblePaidHours|rateCentsPerHour|formatBonusBasis|calculationType/.test(grid));
  check('...the only per-hour figure on a tile is still the employee\'s own base rate',
    (grid.match(/\/hr/g) || []).length === 1 && /fmt\(employee\.hourly_rate\)\}\/hr/.test(grid));
  check('the tile still computes nothing', !/computePay|paidShiftHours|hourly_rate\s*\*/.test(grid));

  // THE PAY TAB.
  check('PayView still feeds computePay the period rows only',
    /computePay\(employees, periodShifts\)/.test(view));
  check('...and fetches bonuses for exactly the selected period',
    /usePayAdjustments\(period\.start, period\.end\)/.test(view));
  check('...building one statement per employee, which is what knows the per-day hours',
    /const statementsByEmployee = useMemo/.test(view));
  check('...and adding with the shared rule', /totalOwedOf\(p\.pay, bonusTotal\)/.test(view));
  check('PayView never prices an hourly bonus by hand',
    !/rate_cents_per_hour\s*\*|\*\s*p\.hours|paidHoursByDate\[/.test(view));
  check('...it reads bonusTotal off the normalized statement instead',
    /statementsByEmployee\.get\(p\.employee\.id\)\?\.totals\.bonusTotal/.test(view) &&
      /buildPayStatement\(\{/.test(view));

  // THE HOOK.
  check('every mutation refetches instead of patching a cached total',
    (hook.match(/onSuccess: refetchAll/g) || []).length === 3 && !/setQueryData/.test(hook));
  check('the query is keyed on the period, so switching periods refetches',
    /queryKey = \['pay_adjustments', user\?\.id, periodStart, periodEnd\]/.test(hook));
  check('the hook does no payroll maths', !/hourly_rate|paidShiftHours|computePay|\* 100|\/ 100/.test(hook));
  check('all three shape columns are ALWAYS named on a write, with the unused ones null',
    /amount_cents: hourly \? null : fields\.amount_cents/.test(hook) &&
      /rate_cents_per_hour: hourly \? fields\.rate_cents_per_hour : null/.test(hook) &&
      /target_date: hourly \? fields\.target_date : null/.test(hook));
  check('an edit cannot move a bonus to another person, period, or calculation type', (() => {
    const update = hook.split('const updateBonus')[1].split('const deleteBonus')[0];
    return !/employee_id:/.test(update) && !/period_start/.test(update) && /calculation_type, \.\.\.patch/.test(update);
  })());
}

console.log(`\n${passed} checks passed`);
