// BONUS / INCENTIVE PAY: that a bonus lands on the person and the period it was entered for and on
// NOBODY else, that several of them add up in cents rather than in floats, that editing and
// deleting one moves the total by exactly the right amount — and, the load-bearing half, that NONE
// of it changes a single worked hour, rate, approved duration or payroll figure.
//
// Everything under test is the REAL module, transpiled at runtime: the real buildPayStatement,
// bonusSummaryFor and totalOwedOf from statement.ts, the real computePay / isPayableShift /
// paidShiftHours from employees.ts, the real parseBonusAmount from bonusInput.ts. Nothing here
// reimplements a rule it then checks against itself.
//
// The database's guarantees are not reachable from Node, so the ones that matter — who owns a row,
// whose employee it may point at, what a valid period is — are asserted STRUCTURALLY over the real
// migration and the real hook, in §9. A comment claiming tenant isolation is not tenant isolation.
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
const stmtUrl = transpile('./statement.ts', 'statement.mjs', {
  "'@/lib/employees'": `'${employeesUrl}'`,
  "'@/lib/schedule/timezone'": `'${tzUrl}'`,
});
const inputUrl = transpile('./bonusInput.ts', 'bonusInput.mjs');

const {
  buildPayStatement, bonusItemsFor, bonusSummaryFor, sumBonusCents, centsToDollars, totalOwedOf,
  formatMoney, payPeriodWeeks, BONUS_FALLBACK_LABEL,
} = await import(stmtUrl);
const { computePay, paidShiftHours, payrollTeamOfRole, PAY_ANCHOR, payPeriodFor } = await import(employeesUrl);
const { parseBonusAmount, centsToInput, normalizeBonusDescription, BONUS_MAX_CENTS } = await import(inputUrl);
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
function bonus(employee_id, amount_cents, description, period = PERIOD, over = {}) {
  bseq++;
  return {
    id: `b${bseq}`, user_id: 'u1', employee_id,
    period_start: period.start, period_end: period.end,
    kind: 'bonus', amount_cents, description,
    created_at: `2026-09-07T18:0${bseq}:00.000Z`, updated_at: `2026-09-07T18:0${bseq}:00.000Z`,
    ...over,
  };
}

const stmt = (adjustments, employee = CARLOS, period = PERIOD) =>
  buildPayStatement({ employee, period, shifts: SHIFTS, adjustments, generatedAtISO: '2026-09-08T17:00:00.000Z' });

// The baseline the whole feature must not move.
const BASE = stmt(undefined);

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§1 The fixture is the reviewed one, and worked pay is untouched by any of this');
{
  check('72.50 payable hours', BASE.totals.paidHours.toFixed(2) === '72.50', BASE.totals.paidHours.toFixed(2));
  check('$1,595.00 of worked pay', cents(BASE.totals.gross) === 159500, formatMoney(BASE.totals.gross));
  check('with NO adjustments argument at all there are no bonus lines', BASE.bonusItems.length === 0);
  check('...bonusTotal is 0, not undefined', BASE.totals.bonusTotal === 0 && BASE.totals.bonusCents === 0);
  check('...and totalOwed IS gross — the pre-bonus statement, unchanged',
    BASE.totals.totalOwed === BASE.totals.gross);

  // An omitted argument and an empty list must produce the identical object, or "no bonuses" would
  // mean two different things depending on which caller you came from.
  const empty = stmt([]);
  check('an empty adjustments list is identical to omitting it',
    JSON.stringify(empty) === JSON.stringify(BASE));

  // And a bonus for somebody else entirely must not perturb it either.
  const foreign = stmt([bonus('e-dana', 50000, 'Dana bonus')]);
  check('another person\'s bonus leaves this statement byte-identical',
    JSON.stringify(foreign) === JSON.stringify(BASE));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§2 CREATE — a bonus belongs to one employee and one pay period');
{
  const b100 = bonus('e-carlos', 10000, 'Performance bonus');
  const s = stmt([b100]);
  check('the $100 bonus is on Carlos\'s statement', s.bonusItems.length === 1);
  check('...with its own amount', s.bonusItems[0].amountCents === 10000 && s.bonusItems[0].amount === 100);
  check('...and its own description', s.bonusItems[0].description === 'Performance bonus');
  check('bonus pay is $100.00', formatMoney(s.totals.bonusTotal) === '$100.00');
  check('TOTAL OWED is $1,695.00', formatMoney(s.totals.totalOwed) === '$1,695.00');

  // ANOTHER PERIOD must not see it.
  const prev = buildPayStatement({
    employee: CARLOS, period: PREV_PERIOD, shifts: SHIFTS, adjustments: [b100],
    generatedAtISO: '2026-09-08T17:00:00.000Z',
  });
  check('the PREVIOUS period does not see it', prev.bonusItems.length === 0 && prev.totals.bonusTotal === 0);
  const next = buildPayStatement({
    employee: CARLOS, period: { start: '2026-09-07', end: '2026-09-20', payday: '2026-09-25' },
    shifts: SHIFTS, adjustments: [b100], generatedAtISO: '2026-09-08T17:00:00.000Z',
  });
  check('the NEXT period does not see it', next.bonusItems.length === 0 && next.totals.bonusTotal === 0);

  // ANOTHER EMPLOYEE must not see it.
  const dana = stmt([b100], OTHER);
  check('another employee does not see it', dana.bonusItems.length === 0 && dana.totals.bonusTotal === 0);
  check('...and still gets paid their own worked time', cents(dana.totals.gross) === cents(8 * 22));

  // A row whose period only HALF matches is not a near-miss to be tolerated — it is a different
  // window, and the selector must refuse it outright rather than guess.
  const halfMatch = bonus('e-carlos', 10000, 'Wrong end', { start: PERIOD.start, end: '2026-09-05' });
  check('a row with the right start and the wrong end is NOT selected',
    stmt([halfMatch]).bonusItems.length === 0);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§3 MULTIPLE — every bonus keeps its own identity');
{
  const items = [bonus('e-carlos', 10000, 'Performance bonus'), bonus('e-carlos', 5000, 'Attendance incentive')];
  const s = stmt(items);
  check('both bonuses are present — neither overwrote the other', s.bonusItems.length === 2);
  check('each has its own id', s.bonusItems[0].id !== s.bonusItems[1].id);
  check('$100 + $50 = $150.00 bonus pay', s.totals.bonusCents === 15000 && formatMoney(s.totals.bonusTotal) === '$150.00');
  check('TOTAL OWED is $1,745.00', formatMoney(s.totals.totalOwed) === '$1,745.00');
  check('they are listed oldest first', s.bonusItems[0].label === 'Performance bonus');

  // Two bonuses saved in the same second still come out in a stable order.
  const tie = [
    bonus('e-carlos', 100, 'B', PERIOD, { id: 'zzz', created_at: '2026-09-07T18:00:00.000Z' }),
    bonus('e-carlos', 100, 'A', PERIOD, { id: 'aaa', created_at: '2026-09-07T18:00:00.000Z' }),
  ];
  check('a created_at tie breaks on id, deterministically',
    stmt(tie).bonusItems.map((b) => b.id).join(',') === 'aaa,zzz');

  // A bonus with no reason still has to say something on the statement.
  const anon = stmt([bonus('e-carlos', 2500, null)]);
  check('a bonus with no description renders as a plain label',
    anon.bonusItems[0].label === BONUS_FALLBACK_LABEL && anon.bonusItems[0].description === null);
  const blank = stmt([bonus('e-carlos', 2500, '   ')]);
  check('...and a whitespace-only description is the same thing, not a blank line',
    blank.bonusItems[0].label === BONUS_FALLBACK_LABEL && blank.bonusItems[0].description === null);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§4 PAYROLL — worked pay is untouched, and the total is exactly the sum');
{
  const items = [bonus('e-carlos', 10000, 'Performance bonus'), bonus('e-carlos', 5000, 'Attendance incentive')];
  const s = stmt(items);

  check('paid hours are IDENTICAL to the no-bonus statement', s.totals.paidHours === BASE.totals.paidHours);
  check('worked pay (gross) is IDENTICAL', s.totals.gross === BASE.totals.gross);
  check('worked days are IDENTICAL', s.totals.workedDays === BASE.totals.workedDays);
  check('the payable ROWS are byte-identical', JSON.stringify(s.rows) === JSON.stringify(BASE.rows));
  check('the excluded rows are byte-identical', JSON.stringify(s.excluded) === JSON.stringify(BASE.excluded));
  check('the rate lines are byte-identical — a bonus is NOT hours at a price',
    JSON.stringify(s.rateLines) === JSON.stringify(BASE.rateLines));
  check('no bonus money leaked into any rate line',
    s.rateLines.every((l) => cents(l.amount) === cents(l.hours * l.rate)));

  check('totalOwed = gross + bonusTotal, to the cent',
    cents(s.totals.totalOwed) === cents(s.totals.gross) + s.totals.bonusCents);
  check('...and totalOwedOf() is what computed it',
    s.totals.totalOwed === totalOwedOf(s.totals.gross, s.totals.bonusTotal));

  // The week grouping the screen and the PDF both read must still reconcile to WORKED pay only.
  const weeks = payPeriodWeeks(s);
  const weekHours = weeks.reduce((a, w) => a + w.hours, 0);
  const weekPay = weeks.reduce((a, w) => a + w.amount, 0);
  check('the week subtotals still add up to the worked hours', weekHours.toFixed(2) === '72.50');
  check('...and to worked pay, NOT to total owed — no bonus reached a week',
    cents(weekPay) === cents(s.totals.gross) && cents(weekPay) !== cents(s.totals.totalOwed));
  check('no day group gained an hour', JSON.stringify(payPeriodWeeks(BASE)) === JSON.stringify(weeks));

  // And computePay — the Pay tab's own function — is untouched by the presence of bonuses, because
  // it never sees them.
  const pay = computePay([CARLOS, OTHER], SHIFTS);
  const carlosPay = pay.find((p) => p.employee.id === 'e-carlos');
  check('computePay still reports the worked hours', carlosPay.hours.toFixed(2) === '72.50');
  check('computePay still reports worked pay, and equals the statement gross',
    cents(carlosPay.pay) === cents(s.totals.gross));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§5 EDIT and DELETE move the total by exactly the difference');
{
  const a = bonus('e-carlos', 10000, 'Performance bonus');
  const b = bonus('e-carlos', 5000, 'Attendance incentive');
  const before = stmt([a, b]);

  // EDIT: $100 → $125. The database updates the row; the statement is rebuilt from what it holds.
  const edited = stmt([{ ...a, amount_cents: 12500, description: 'Performance bonus (revised)' }, b]);
  check('editing $100 → $125 gives $175.00 of bonus pay', formatMoney(edited.totals.bonusTotal) === '$175.00');
  check('...TOTAL OWED moves by exactly $25.00',
    cents(edited.totals.totalOwed) - cents(before.totals.totalOwed) === 2500);
  check('...the new description is what renders', edited.bonusItems[0].label === 'Performance bonus (revised)');
  check('...worked pay did not move', edited.totals.gross === before.totals.gross);
  check('...and neither did a single worked row', JSON.stringify(edited.rows) === JSON.stringify(before.rows));

  // DELETE: the row is gone.
  const deleted = stmt([b]);
  check('deleting the $100 bonus leaves $50.00', formatMoney(deleted.totals.bonusTotal) === '$50.00');
  check('...TOTAL OWED drops by exactly $100.00',
    cents(before.totals.totalOwed) - cents(deleted.totals.totalOwed) === 10000);
  check('...the deleted line is gone from the list', !deleted.bonusItems.some((i) => i.id === a.id));
  check('...worked hours are untouched', deleted.totals.paidHours === BASE.totals.paidHours);
  check('...worked pay is untouched', deleted.totals.gross === BASE.totals.gross);

  // Deleting the LAST one returns the statement to the pre-bonus article exactly.
  const none = stmt([]);
  check('deleting every bonus restores the original statement, byte for byte',
    JSON.stringify(none) === JSON.stringify(BASE));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§6 MONEY — cents, never floats');
{
  // The canonical float failure, as money: 0.1 + 0.2 = 0.30000000000000004.
  const drift = stmt([bonus('e-carlos', 10, 'ten cents'), bonus('e-carlos', 20, 'twenty cents')]);
  check('$0.10 + $0.20 is exactly $0.30', drift.totals.bonusCents === 30 && formatMoney(drift.totals.bonusTotal) === '$0.30');
  check('...and the naive float sum would NOT have been',
    0.1 + 0.2 !== 0.3, 'the check above is not vacuous');

  // A hundred awkward bonuses — the kind of accumulation that drifts if it is done in dollars.
  const many = Array.from({ length: 100 }, (_, i) => bonus('e-carlos', 1007, `bonus ${i}`));
  check('100 × $10.07 is exactly $1,007.00', sumBonusCents(bonusItemsFor(many, 'e-carlos', PERIOD)) === 100700);
  check('...and reads as $1,007.00', formatMoney(centsToDollars(100700)) === '$1,007.00');

  check('centsToDollars is a pure divide', centsToDollars(12345) === 123.45 && centsToDollars(0) === 0);

  // Parsing what a manager types, on the way IN.
  check('"150" → 15000 cents', parseBonusAmount('150').cents === 15000);
  check('"150.5" → 15050 cents (fifty cents, not five)', parseBonusAmount('150.5').cents === 15050);
  check('"150.50" → 15050 cents', parseBonusAmount('150.50').cents === 15050);
  check('"$1,595.00" → 159500 cents', parseBonusAmount('$1,595.00').cents === 159500);
  check('" 12.34 " → 1234 cents', parseBonusAmount(' 12.34 ').cents === 1234);
  check('"19.99" → 1999 cents, which Number("19.99")*100 is not',
    parseBonusAmount('19.99').cents === 1999 && Number('19.99') * 100 !== 1999);
  for (const bad of ['', '   ', '0', '0.00', '-5', 'abc', '1.234', '1,2.3.4', '1e3']) {
    check(`"${bad}" is refused`, parseBonusAmount(bad).ok === false);
  }
  check('a refusal carries a sentence, not a token', /[a-z] [a-z]/.test(parseBonusAmount('abc').error));
  check('the cap matches the SQL cap', BONUS_MAX_CENTS === 100000000);
  check('$1,000,000.00 is allowed', parseBonusAmount('1000000').cents === BONUS_MAX_CENTS);
  check('$1,000,000.01 is refused', parseBonusAmount('1000000.01').ok === false);

  check('centsToInput round-trips', centsToInput(10050) === '100.50' && centsToInput(100) === '1.00' && centsToInput(5) === '0.05');
  check('an edit form opens on the stored amount', parseBonusAmount(centsToInput(12345)).cents === 12345);
  check('description normalization trims and collapses',
    normalizeBonusDescription('  Performance   bonus  ') === 'Performance bonus');
  check('...and an empty reason is no reason', normalizeBonusDescription('   ') === null);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§7 THE PAY TILE reads the same numbers the statement does');
{
  const items = [bonus('e-carlos', 10000, 'Performance bonus'), bonus('e-carlos', 5000, 'Attendance incentive')];
  const s = stmt(items);

  // Exactly what PayView does for a tile: computePay for worked pay, then the SAME two shared
  // functions the statement uses for the bonus and the addition.
  const pay = computePay([CARLOS, OTHER], SHIFTS);
  for (const p of pay) {
    const summary = bonusSummaryFor(items, p.employee.id, PERIOD);
    const tileTotal = totalOwedOf(p.pay, summary.total);
    const detail = stmt(items, p.employee);
    check(`${p.employee.name}: the tile's total owed IS the statement's total owed`,
      cents(tileTotal) === cents(detail.totals.totalOwed), formatMoney(tileTotal));
    check(`${p.employee.name}: the tile's bonus IS the statement's bonus`,
      summary.cents === detail.totals.bonusCents);
    check(`${p.employee.name}: the tile's worked pay IS the statement's gross`,
      cents(p.pay) === cents(detail.totals.gross));
  }
  check('Carlos\'s tile reads $1,745.00', formatMoney(s.totals.totalOwed) === '$1,745.00');
  check('Dana\'s tile carries no bonus and is unchanged',
    bonusSummaryFor(items, 'e-dana', PERIOD).cents === 0);

  // A roster total is the sum of the tiles, so it must include the bonuses.
  const rosterTotal = pay.reduce((acc, p) => acc + totalOwedOf(p.pay, bonusSummaryFor(items, p.employee.id, PERIOD).total), 0);
  const rosterWorked = pay.reduce((acc, p) => acc + p.pay, 0);
  check('the roster total exceeds worked pay by exactly the bonuses',
    cents(rosterTotal) - cents(rosterWorked) === 15000);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§8 THE RULES THE BONUS FEATURE MUST NOT HAVE TOUCHED');
{
  // MULTI-SHIFT: two clock sessions on one day stay two records and are both paid.
  const split = [
    punch('e-split', '2026-08-25', '06:00', '10:00'),
    punch('e-split', '2026-08-25', '14:00', '18:00'),
  ];
  const splitEmp = EMP({ id: 'e-split', name: 'Split Day', hourly_rate: 20 });
  const withBonus = buildPayStatement({
    employee: splitEmp, period: PERIOD, shifts: split,
    adjustments: [bonus('e-split', 25000, 'Weekend push')], generatedAtISO: 'x',
  });
  const withoutBonus = buildPayStatement({ employee: splitEmp, period: PERIOD, shifts: split, generatedAtISO: 'x' });
  check('a split day is still TWO payable records', withBonus.rows.length === 2);
  check('...still 8.00 h for the day', withBonus.totals.paidHours.toFixed(2) === '8.00');
  check('...and the bonus changed none of it',
    JSON.stringify(withBonus.rows) === JSON.stringify(withoutBonus.rows));
  check('...it only added to the total',
    cents(withBonus.totals.totalOwed) - cents(withoutBonus.totals.totalOwed) === 25000);

  // FULFILLMENT: a stored approved_minutes is still IGNORED, and the punch still pays.
  const ful = EMP({ id: 'e-ful', role: 'fulfillment', hourly_rate: 20 });
  const typo = [punch('e-ful', '2026-08-24', '06:06', '13:46', { approved_minutes: 1421 })];
  const fulS = buildPayStatement({
    employee: ful, period: PERIOD, shifts: typo,
    adjustments: [bonus('e-ful', 10000, 'Picker of the month')], generatedAtISO: 'x',
  });
  check('fulfillment still pays the CLOCKED 7.67 h, not the stored 23.68',
    fulS.totals.paidHours.toFixed(2) === '7.67', fulS.totals.paidHours.toFixed(2));
  check('...via the real paidShiftHours, unchanged',
    fulS.rows[0].paidHours === paidShiftHours(typo[0], payrollTeamOfRole('fulfillment')));
  check('...and the bonus sits outside it entirely',
    cents(fulS.totals.gross) === cents(fulS.totals.paidHours * 20) &&
      cents(fulS.totals.totalOwed - fulS.totals.gross) === 10000);

  // LIVE HOST: the SAME row still pays its approved duration.
  const host = EMP({ id: 'e-ful', role: 'host', hourly_rate: 20 });
  const hostS = buildPayStatement({
    employee: host, period: PERIOD, shifts: typo,
    adjustments: [bonus('e-ful', 10000, 'Top seller')], generatedAtISO: 'x',
  });
  check('a live host still pays the APPROVED 23.68 h', hostS.totals.paidHours.toFixed(2) === '23.68');
  check('...so the two teams still differ, and neither check is vacuous',
    hostS.totals.paidHours !== fulS.totals.paidHours);
  check('...and its bonus is still exactly $100.00 on top',
    cents(hostS.totals.totalOwed - hostS.totals.gross) === 10000);

  // An UNCONFIRMED punch is still unpaid — a bonus must not make an excluded row payable.
  const unconf = [punch('e-u', '2026-08-24', '08:00', '16:00', { confirmed_at: null })];
  const uEmp = EMP({ id: 'e-u', hourly_rate: 20 });
  const uS = buildPayStatement({
    employee: uEmp, period: PERIOD, shifts: unconf,
    adjustments: [bonus('e-u', 10000, 'Bonus anyway')], generatedAtISO: 'x',
  });
  check('an unconfirmed punch still pays nothing', uS.totals.paidHours === 0 && uS.totals.gross === 0);
  check('...it is still listed as excluded', uS.excluded.length === 1);
  check('...and the bonus alone is owed', formatMoney(uS.totals.totalOwed) === '$100.00');
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§9 THE GUARANTEES THAT LIVE IN SQL — asserted over the real migration');
{
  const sql = src('../../../supabase/migrations/150_employee_pay_adjustments.sql');
  // Strip SQL comments so the assertions match EXECUTABLE SQL, never the explanation above it.
  const ddl = sql.replace(/^\s*--[^\n]*$/gm, '');

  check('the table is created', /create table if not exists public\.employee_pay_adjustments/.test(ddl));

  // OWNER: taken from the session, never from the request body.
  check('user_id DEFAULTS to auth.uid() — the client never names an owner',
    /user_id uuid not null default auth\.uid\(\)/.test(ddl));
  check('...and the hook does not send one either', (() => {
    const hook = strip(src('../../hooks/usePayAdjustments.ts'));
    return !/user_id/.test(hook);
  })());

  // TENANT: the composite FK is what makes cross-tenant impossible, not the UI.
  check('the FK target index on employees exists',
    /create unique index if not exists uq_employees_id_user\s+on public\.employees \(id, user_id\)/.test(ddl));
  check('the employee FK is COMPOSITE on (employee_id, user_id)',
    /foreign key \(employee_id, user_id\) references public\.employees \(id, user_id\)/.test(ddl));
  check('...so a bonus cannot point at another tenant\'s employee even with a valid owner',
    !/employee_id uuid not null references public\.employees\s*\(\s*id\s*\)/.test(ddl));

  // RLS.
  check('RLS is enabled', /alter table public\.employee_pay_adjustments enable row level security/.test(ddl));
  check('the own-row policy covers ALL verbs', /create policy employee_pay_adjustments_own_rows[\s\S]*?for all/.test(ddl));
  check('...it gates reads with auth.uid() = user_id', /using \(auth\.uid\(\) = user_id\)/.test(ddl));
  check('...and writes too — a forged owner id is refused', /with check \(auth\.uid\(\) = user_id\)/.test(ddl));
  check('authenticated is granted the four verbs it needs',
    /grant select, insert, update, delete on public\.employee_pay_adjustments to authenticated/.test(ddl));
  check('anon gets nothing', /revoke all on public\.employee_pay_adjustments from anon/.test(ddl));

  // AMOUNT.
  check('money is integer cents', /amount_cents integer not null/.test(ddl));
  check('...strictly positive', /check \(amount_cents > 0\)/.test(ddl));
  check('...and capped', /check \(amount_cents <= 100000000\)/.test(ddl));
  check('kind admits bonus and nothing else', /check \(kind = 'bonus'\)/.test(ddl));

  // PERIOD — the literal is DERIVED, and this is the pin.
  const m = /\(\(period_start - date '(\d{4}-\d{2}-\d{2})'\) % 14\) = 0/.exec(ddl);
  check('the period CHECK exists and carries a date literal', m !== null);
  const anchorStart = payPeriodFor(PAY_ANCHOR).start;
  check('...and that literal IS payPeriodFor(PAY_ANCHOR).start, computed by the real helper',
    m[1] === anchorStart, `${m[1]} vs ${anchorStart}`);
  check('...and a period is exactly 14 days', /period_end = period_start \+ 13/.test(ddl));

  // The predicate the SQL expresses, walked over ±40 REAL periods produced by the real helpers.
  const daysBetween = (a, b) =>
    Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
  let walked = 0;
  let ok = true;
  for (let off = -40; off <= 40; off++) {
    const payday = isoAdd(PAY_ANCHOR, off * 14);
    const p = payPeriodFor(payday);
    if (daysBetween(p.start, p.end) !== 13) ok = false;
    if (daysBetween(anchorStart, p.start) % 14 !== 0) ok = false;
    walked++;
  }
  check('every one of 81 real pay periods satisfies the SQL predicate', ok && walked === 81, `${walked} examined`);
  // Anti-vacuity: the predicate must be able to REFUSE something.
  check('...and an off-cycle window would be refused', daysBetween(anchorStart, isoAdd(anchorStart, 7)) % 14 !== 0);

  // The migration must not be recorded as applied while it has not been.
  check('the file does NOT claim to have been applied to production',
    /⛔ NOT APPLIED/.test(sql) && !/✅ APPLIED TO PRODUCTION/.test(sql));

  // It must not touch payroll.
  for (const forbidden of ['shifts', 'approved_minutes', 'hourly_rate', 'confirmed_at', 'break_minutes']) {
    check(`the migration never writes ${forbidden}`,
      !new RegExp(`(update|insert into|alter table)[^;]*\\b${forbidden}\\b`, 'i').test(ddl));
  }
  check('it writes no data at all — no backfill, no seed',
    !/\binsert\s+into\b/i.test(ddl) && !/\bupdate\s+public\./i.test(ddl) && !/\bdelete\s+from\b/i.test(ddl));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§10 THE UI RENDERS THE MODEL AND ADDS NOTHING UP');
{
  const panel = strip(src('../../components/employees/BonusPanel.tsx'));
  const modal = strip(src('../../components/employees/PayDetailModal.tsx'));
  const grid = strip(src('../../components/employees/PayGrid.tsx'));
  const view = strip(src('../../components/employees/PayView.tsx'));

  // PAY DETAILS.
  check('Pay Details renders the bonus section', /<BonusSection[\s\n]/.test(modal));
  check('...fed from statement.bonusItems', /items=\{statement\.bonusItems\}/.test(modal));
  check('...with the subtotal read off the statement', /bonusTotal=\{statement\.totals\.bonusTotal\}/.test(modal));
  check('...and the headline is TOTAL OWED', /fmt\(statement\.totals\.totalOwed\)/.test(modal));
  check('...which appears in BOTH the summary and the footer total',
    (modal.match(/statement\.totals\.totalOwed/g) || []).length >= 2);
  check('the + Add Bonus action sits by the summary', /<AddBonusButton/.test(modal));
  check('the bonus section comes AFTER the week tables and BEFORE the total',
    modal.indexOf('<BonusSection') > modal.lastIndexOf('<Week') &&
      modal.indexOf('<BonusSection') < modal.lastIndexOf('Total owed'));
  check('Pay Details still does no arithmetic — no + over money anywhere',
    !/totals\.gross\s*\+|\+\s*totals\.bonus|bonusItems\.reduce/.test(modal));

  // THE BONUS PANEL.
  check('the panel prints the subtotal it was handed, not one it worked out',
    /\{fmt\(bonusTotal\)\}/.test(panel) && !/reduce\(/.test(panel) && !/amountCents\s*\+/.test(panel));
  check('the empty case renders nothing at all', /if \(items\.length === 0\) return null;/.test(panel));
  check('edit and delete are offered per line, wired to the caller\'s handlers',
    /onClick=\{\(\) => onEditItem\(item\)\}/.test(panel) && /onClick=\{\(\) => onDeleteItem\(item\)\}/.test(panel));
  check('...and both are omitted entirely when no write path was given',
    /onEditItem &&/.test(panel) && /onDeleteItem &&/.test(panel));
  check('the delete dialog names the bonus and the amount',
    /Delete bonus\?/.test(panel) && /\['Amount', fmt\(item\.amount\)\]/.test(panel));
  check('both dialogs go through OverlayLayer, above the z-50 panel that opened them',
    (panel.match(/<OverlayLayer>/g) || []).length === 2);
  check('the form parses money through the shared parser, never with Number()',
    /parseBonusAmount\(/.test(panel) && !/Number\(/.test(panel) && !/parseFloat/.test(panel));

  // THE TILE.
  check('the tile headline is total owed', /\{fmt\(totalOwed\)\}/.test(grid));
  check('...and the bonus note is conditional, so the grid does not change shape',
    /bonusTotal > 0 &&/.test(grid));
  check('the tile still computes nothing', !/computePay|paidShiftHours|hourly_rate\s*\*/.test(grid));

  // THE PAY TAB.
  check('PayView still feeds computePay the period rows only',
    /computePay\(employees, periodShifts\)/.test(view));
  check('...and fetches bonuses for exactly the selected period',
    /usePayAdjustments\(period\.start, period\.end\)/.test(view));
  check('...passing them into the ONE statement build', /adjustments,/.test(view) && /buildPayStatement\(\{/.test(view));
  check('...and deriving tiles from the SHARED functions, not its own sum',
    /bonusSummaryFor\(adjustments, p\.employee\.id, period\)/.test(view) &&
      /totalOwedOf\(p\.pay, bonus\.total\)/.test(view));
  check('PayView never adds bonus money by hand',
    !/p\.pay \+ bonus|\+ bonusTotal\b|amount_cents\s*\+/.test(view));

  // THE HOOK.
  const hook = strip(src('../../hooks/usePayAdjustments.ts'));
  check('every mutation refetches instead of patching a cached total',
    (hook.match(/onSuccess: refetchAll/g) || []).length === 3 && !/setQueryData/.test(hook));
  check('the query is keyed on the period, so switching periods refetches',
    /queryKey = \['pay_adjustments', user\?\.id, periodStart, periodEnd\]/.test(hook));
  check('the hook does no payroll maths', !/hourly_rate|paidShiftHours|computePay|\* 100|\/ 100/.test(hook));
  check('an edit cannot move a bonus to another person or period',
    !/employee_id:/.test(hook.split('const updateBonus')[1].split('const deleteBonus')[0]));
}

console.log(`\n${passed} checks passed`);
