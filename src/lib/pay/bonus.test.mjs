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
    description: null,
    created_at: `2026-09-07T18:0${bseq}:00.000Z`, updated_at: `2026-09-07T18:0${bseq}:00.000Z`,
    ...over,
  };
};
/** A FLAT bonus row, shaped as the CHECK constraints require. */
const flat = (employee_id, amount_cents, description, over = {}) =>
  row(employee_id, { calculation_type: 'flat', amount_cents, rate_cents_per_hour: null, description, ...over });
/** An HOURLY bonus row — a RATE, and deliberately no stored total anywhere. */
const hourly = (employee_id, rate_cents_per_hour, description, over = {}) =>
  row(employee_id, { calculation_type: 'hourly', amount_cents: null, rate_cents_per_hour, description, ...over });

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
  const foreign = stmt([flat('e-dana', 50000, 'Dana bonus'), hourly('e-dana', 500, 'Dana incentive')]);
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
console.log('\n§3 HOURLY — a rate times the CANONICAL payable hours');
{
  const s = stmt([hourly('e-carlos', 200, 'Productivity incentive')]);
  const item = s.bonusItems[0];
  check('the line is hourly', item.calculationType === 'hourly');
  check('...carrying its entered rate', item.rateCentsPerHour === 200);
  check('...and NO flat amount', item.amountCents === null);
  check('the eligible hours ARE the statement\'s payable hours — not a second definition',
    item.eligiblePaidHours === s.totals.paidHours && item.eligiblePaidHours.toFixed(2) === '72.50');
  check('72.50 hr x $2.00/hr = $145.00', item.calculatedBonusCents === 14500, formatMoney(item.amount));
  check('it shows its working as a duration that multiplies out correctly',
    formatBonusBasis(item) === '$2.00/hr × 72h 30m payable', formatBonusBasis(item));
  check('bonus pay is $145.00', formatMoney(s.totals.bonusTotal) === '$145.00');
  check('...all of it hourly', cents(s.totals.hourlyBonusTotal) === 14500 && s.totals.flatBonusTotal === 0);
  check('TOTAL OWED is $1,740.00', formatMoney(s.totals.totalOwed) === '$1,740.00');

  // A DECIMAL rate.
  const dec = stmt([hourly('e-carlos', 250, 'Productivity incentive')]);
  check('72.50 hr x $2.50/hr = $181.25', dec.bonusItems[0].calculatedBonusCents === 18125,
    formatMoney(dec.totals.bonusTotal));
  check('...and reads as $181.25', formatMoney(dec.totals.bonusTotal) === '$181.25');

  // The per-item rounding rule, exercised directly on hours that do not divide cleanly.
  check('rate x hours rounds to the nearest cent, once', hourlyBonusCents(250, 7.666666666666667) === 1917);
  check('...and never goes negative', hourlyBonusCents(200, 0) === 0);

  // A period with no payable hours earns no incentive.
  const none = buildPayStatement({
    employee: CARLOS, period: PREV_PERIOD, shifts: SHIFTS,
    adjustments: [hourly('e-carlos', 200, 'Incentive', { period_start: PREV_PERIOD.start, period_end: PREV_PERIOD.end })],
    generatedAtISO: 'x',
  });
  check('an hourly bonus on a period with no payable hours is worth $0.00',
    none.totals.paidHours === 0 && none.totals.bonusCents === 0);
  check('...and is still LISTED, so the manager can see it is there', none.bonusItems.length === 1);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§4 WHICH HOURS — the payroll rule, per team, unchanged');
{
  // BREAKS: unpaid break time is not payable, so it earns no incentive.
  const brk = [punch('e-b', '2026-08-24', '08:00', '17:00', { break_minutes: 60 })];
  const bEmp = EMP({ id: 'e-b', hourly_rate: 20 });
  const bS = stmt([hourly('e-b', 200, 'Incentive')], bEmp, PERIOD, brk);
  check('a 9-hour punch with a 60-minute break is 8.00 payable hours', bS.totals.paidHours.toFixed(2) === '8.00');
  check('...so a $2.00/hr incentive pays $16.00, not $18.00', bS.totals.bonusCents === 1600, formatMoney(bS.totals.bonusTotal));
  check('...the working says 8h, not 9h', formatBonusBasis(bS.bonusItems[0]) === '$2.00/hr × 8h payable',
    formatBonusBasis(bS.bonusItems[0]));

  // MULTI-SHIFT: two clock sessions on one day are two records and 8 payable hours between them.
  const split = [punch('e-s', '2026-08-25', '06:00', '10:00'), punch('e-s', '2026-08-25', '14:00', '18:00')];
  const sEmp = EMP({ id: 'e-s', hourly_rate: 20 });
  const sS = stmt([hourly('e-s', 200, 'Incentive')], sEmp, PERIOD, split);
  check('a split day is still TWO payable records', sS.rows.length === 2);
  check('...4.00 + 4.00 = 8.00 payable hours', sS.totals.paidHours.toFixed(2) === '8.00');
  check('...and the incentive is $16.00 across the pair, counted once', sS.totals.bonusCents === 1600);

  // FULFILLMENT: a stored approved_minutes is still IGNORED, so the incentive prices the punch.
  const typo = [punch('e-x', '2026-08-24', '06:06', '13:46', { approved_minutes: 1421 })];
  const ful = EMP({ id: 'e-x', role: 'fulfillment', hourly_rate: 20 });
  const fulS = stmt([hourly('e-x', 200, 'Incentive')], ful, PERIOD, typo);
  check('fulfillment still pays the CLOCKED 7.67 h, not the stored 23.68', fulS.totals.paidHours.toFixed(2) === '7.67');
  check('...via the real paidShiftHours, unchanged',
    fulS.rows[0].paidHours === paidShiftHours(typo[0], payrollTeamOfRole('fulfillment')));
  check('...so its incentive prices the CLOCKED hours', fulS.bonusItems[0].eligiblePaidHours === fulS.totals.paidHours);
  check('...$15.33, not $47.36', fulS.totals.bonusCents === 1533, formatMoney(fulS.totals.bonusTotal));

  // LIVE HOST: the SAME row still pays its approved duration, and the incentive follows it.
  const host = EMP({ id: 'e-x', role: 'host', hourly_rate: 20 });
  const hostS = stmt([hourly('e-x', 200, 'Incentive')], host, PERIOD, typo);
  check('a live host still pays the APPROVED 23.68 h', hostS.totals.paidHours.toFixed(2) === '23.68');
  check('...so its incentive prices the APPROVED hours', hostS.bonusItems[0].eligiblePaidHours === hostS.totals.paidHours);
  check('...$47.37, not $15.33', hostS.totals.bonusCents === 4737, formatMoney(hostS.totals.bonusTotal));
  check('...so the two teams differ, and neither check is vacuous',
    hostS.totals.bonusCents !== fulS.totals.bonusCents);

  // THE HOURS ARE NOT ROUNDED BEFORE THEY ARE MULTIPLIED, and that is a decision, not an oversight.
  // A live host on 30.4666 canonical payable hours at $3.00/hr is owed $91.40; the 30.47 shown
  // beside it multiplies out to $91.41. Rounding the hours first would pay the incentive on time
  // nobody worked — a second definition of a payable hour, which is the thing this feature is not
  // allowed to introduce. The same property already governs base pay on the same document.
  const oddHost = EMP({ id: 'e-odd', role: 'host', hourly_rate: 25 });
  const oddShift = [punch('e-odd', '2026-08-24', '06:00', '14:00', { approved_minutes: 1828 })];
  const oddS = stmt([hourly('e-odd', 300, 'Live show incentive')], oddHost, PERIOD, oddShift);
  check('the fixture really does have hours that are not exact at 2dp',
    oddS.totals.paidHours.toFixed(2) === '30.47' && oddS.totals.paidHours !== 30.47,
    String(oddS.totals.paidHours));
  check('the incentive is priced off the UNROUNDED canonical hours — $91.40',
    oddS.totals.bonusCents === 9140, formatMoney(oddS.totals.bonusTotal));
  check('...NOT off the rounded ones, which would have been $91.41',
    hourlyBonusCents(300, 30.47) === 9141 && oddS.totals.bonusCents !== hourlyBonusCents(300, 30.47));
  check('...and base pay on the same statement is rounded the same way, as it always has been',
    cents(oddS.totals.gross) === Math.round(oddS.totals.paidHours * 25 * 100) &&
      cents(oddS.totals.gross) !== Math.round(30.47 * 25 * 100));

  // The spec's own live-host example: 68.00 approved hours at $3.00/hr.
  const h68 = [punch('e-h', '2026-08-24', '06:00', '14:00', { approved_minutes: 4080 })];
  const hEmp = EMP({ id: 'e-h', role: 'host', hourly_rate: 25 });
  const h68S = stmt([hourly('e-h', 300, 'Live show incentive')], hEmp, PERIOD, h68);
  check('68.00 approved hours x $3.00/hr = $204.00', h68S.totals.bonusCents === 20400, formatMoney(h68S.totals.bonusTotal));

  // An UNCONFIRMED punch is not payable, so it earns no incentive either.
  const unconf = [punch('e-u', '2026-08-24', '08:00', '16:00', { confirmed_at: null })];
  const uS = stmt([hourly('e-u', 200, 'Incentive'), flat('e-u', 10000, 'Flat anyway')], EMP({ id: 'e-u', hourly_rate: 20 }), PERIOD, unconf);
  check('an unconfirmed punch still pays nothing', uS.totals.paidHours === 0 && uS.totals.gross === 0);
  check('...so the hourly incentive is worth $0.00', cents(uS.totals.hourlyBonusTotal) === 0);
  check('...while the flat bonus is still owed in full', formatMoney(uS.totals.totalOwed) === '$100.00');
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§5 HOURS CAN CHANGE — and the incentive follows, with nobody editing it');
{
  const incentive = hourly('e-carlos', 200, 'Productivity incentive');
  // A snapshot of the stored row, taken BEFORE anything reads it. The re-pricing below has to
  // happen without this object changing in any way — that is what "nobody edits the bonus" means.
  const storedBefore = JSON.stringify(incentive);
  const before = stmt([incentive]);
  check('before: 72.50 hr, incentive $145.00',
    before.totals.paidHours.toFixed(2) === '72.50' && before.totals.bonusCents === 14500);

  // A REAL correction, through the REAL patch builder: Thursday's 08:00-16:30 becomes 08:00-18:00.
  const target = SHIFTS.find((s) => s.date === '2026-08-27');
  const patch = buildShiftEditPatch(target, { end_time: '18:00' });
  check('the correction produced a patch', patch !== null && patch !== undefined);
  check('...and it moved the PUNCH INSTANT, which is what pay reads', patch.clock_out_at !== undefined);
  const corrected = SHIFTS.map((s) => (s.id === target.id ? { ...s, ...patch } : s));

  const after = stmt([incentive], CARLOS, PERIOD, corrected);
  check('after: 74.00 payable hours', after.totals.paidHours.toFixed(2) === '74.00', after.totals.paidHours.toFixed(2));
  check('THE INCENTIVE RE-PRICED ITSELF: $145.00 → $148.00', after.totals.bonusCents === 14800,
    formatMoney(after.totals.bonusTotal));
  check('...WITHOUT the stored row changing by a single byte — nobody edited the bonus',
    JSON.stringify(incentive) === storedBefore);
  check('...and the row still holds only a RATE, never a total',
    incentive.rate_cents_per_hour === 200 && incentive.amount_cents === null &&
      !Object.keys(incentive).some((k) => /calculated|total/i.test(k)),
    Object.keys(incentive).join(','));
  check('...its stated working moved too', formatBonusBasis(after.bonusItems[0]) === '$2.00/hr × 74h payable',
    formatBonusBasis(after.bonusItems[0]));
  check('...worked pay moved by the hour and a half as well',
    cents(after.totals.gross) - cents(before.totals.gross) === cents(1.5 * 22));
  check('...and total owed moved by both', cents(after.totals.totalOwed) - cents(before.totals.totalOwed) === 3300 + 300);

  // A FLAT bonus, by contrast, must NOT move.
  const flatBefore = stmt([flat('e-carlos', 10000, 'Performance bonus')]);
  const flatAfter = stmt([flat('e-carlos', 10000, 'Performance bonus', { id: 'bF' })], CARLOS, PERIOD, corrected);
  check('a FLAT bonus is unmoved by the same correction — it is not hours at a price',
    flatBefore.totals.bonusCents === flatAfter.totals.bonusCents && flatAfter.totals.bonusCents === 10000);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§6 MULTIPLE — the two types side by side');
{
  const items = [
    flat('e-carlos', 10000, 'Performance bonus'),
    flat('e-carlos', 5000, 'Attendance bonus'),
    hourly('e-carlos', 200, 'Productivity incentive'),
  ];
  const s = stmt(items);
  check('all three are present — none overwrote another', s.bonusItems.length === 3);
  check('each has its own id', new Set(s.bonusItems.map((b) => b.id)).size === 3);
  check('$100 + $50 flat = $150.00', cents(s.totals.flatBonusTotal) === 15000);
  check('$2.00/hr x 72.50 hr = $145.00 hourly', cents(s.totals.hourlyBonusTotal) === 14500);
  check('bonus pay is $295.00', formatMoney(s.totals.bonusTotal) === '$295.00');
  check('...and the components add up to it exactly',
    cents(s.totals.flatBonusTotal) + cents(s.totals.hourlyBonusTotal) === s.totals.bonusCents);
  check('TOTAL OWED is $1,890.00', formatMoney(s.totals.totalOwed) === '$1,890.00');
  check('...which is $1,595.00 worked + $295.00 bonus',
    cents(s.totals.gross) === 159500 && cents(s.totals.totalOwed) === 159500 + 29500);
  check('they are listed oldest first',
    s.bonusItems.map((b) => b.label).join(' | ') === 'Performance bonus | Attendance bonus | Productivity incentive');

  // NO BONUS OF EITHER TYPE REACHED A WEEK, A DAY OR AN HOURS COLUMN. This is the assertion that
  // catches an hourly incentive being mistaken for wages somewhere in the grouping — the week
  // subtotals the screen and the PDF both read must still reconcile to WORKED pay alone.
  const weeks = payPeriodWeeks(s);
  const weekHours = weeks.reduce((a, w) => a + w.hours, 0);
  const weekPay = weeks.reduce((a, w) => a + w.amount, 0);
  check('the week subtotals still add up to the worked hours', weekHours.toFixed(2) === '72.50');
  check('...and to worked pay, NOT to total owed',
    cents(weekPay) === cents(s.totals.gross) && cents(weekPay) !== cents(s.totals.totalOwed));
  check('...and the grouping is byte-identical to the no-bonus statement',
    JSON.stringify(payPeriodWeeks(BASE)) === JSON.stringify(weeks));
  check('the rate lines are untouched too — an hourly bonus is not a second wage',
    JSON.stringify(s.rateLines) === JSON.stringify(BASE.rateLines) &&
      s.rateLines.every((l) => cents(l.amount) === cents(l.hours * l.rate)));

  // Two bonuses saved in the same second still come out in a stable order.
  const tie = [
    flat('e-carlos', 100, 'B', { id: 'zzz', created_at: '2026-09-07T18:00:00.000Z' }),
    hourly('e-carlos', 100, 'A', { id: 'aaa', created_at: '2026-09-07T18:00:00.000Z' }),
  ];
  check('a created_at tie breaks on id, deterministically',
    stmt(tie).bonusItems.map((b) => b.id).join(',') === 'aaa,zzz');

  // A bonus with no reason still has to say something, in either type.
  check('a flat bonus with no description renders as a plain label',
    stmt([flat('e-carlos', 2500, null)]).bonusItems[0].label === BONUS_FALLBACK_LABEL);
  check('...and so does an hourly one',
    stmt([hourly('e-carlos', 250, '   ')]).bonusItems[0].label === BONUS_FALLBACK_LABEL);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§7 CREATE / EDIT / DELETE, and the scoping that keeps money where it was put');
{
  const b100 = flat('e-carlos', 10000, 'Performance bonus');
  const bHr = hourly('e-carlos', 200, 'Productivity incentive');

  // ANOTHER PERIOD must not see either type.
  for (const [label, r] of [['flat', b100], ['hourly', bHr]]) {
    const prev = stmt([r], CARLOS, PREV_PERIOD);
    const next = stmt([r], CARLOS, { start: '2026-09-07', end: '2026-09-20', payday: '2026-09-25' });
    check(`a ${label} bonus is invisible in the previous period`, prev.bonusItems.length === 0);
    check(`...and in the next one`, next.bonusItems.length === 0);
  }
  check('another employee sees neither', stmt([b100, bHr], OTHER).bonusItems.length === 0);
  check('...and still gets paid their own worked time', cents(stmt([b100, bHr], OTHER).totals.gross) === cents(8 * 22));
  check('a row with the right start and the wrong end is NOT selected',
    stmt([flat('e-carlos', 10000, 'Wrong end', { period_end: '2026-09-05' })]).bonusItems.length === 0);

  // EDIT a flat: $100 → $125.
  const before = stmt([b100, bHr]);
  const editedFlat = stmt([{ ...b100, amount_cents: 12500, description: 'Performance bonus (revised)' }, bHr]);
  check('editing a flat $100 → $125 moves TOTAL OWED by exactly $25.00',
    cents(editedFlat.totals.totalOwed) - cents(before.totals.totalOwed) === 2500);
  check('...the new description is what renders', editedFlat.bonusItems[0].label === 'Performance bonus (revised)');
  check('...and the hourly line beside it did not move', editedFlat.totals.hourlyBonusTotal === before.totals.hourlyBonusTotal);

  // EDIT an hourly: $2.00/hr → $2.50/hr.
  const editedRate = stmt([b100, { ...bHr, rate_cents_per_hour: 250 }]);
  check('editing a rate $2.00 → $2.50/hr re-prices the line to $181.25',
    cents(editedRate.totals.hourlyBonusTotal) === 18125);
  check('...moving TOTAL OWED by exactly $36.25',
    cents(editedRate.totals.totalOwed) - cents(before.totals.totalOwed) === 3625);
  check('...and the flat line beside it did not move', editedRate.totals.flatBonusTotal === before.totals.flatBonusTotal);

  // Neither edit touched worked time.
  for (const [label, s] of [['flat edit', editedFlat], ['rate edit', editedRate]]) {
    check(`a ${label} left the payable rows byte-identical`, JSON.stringify(s.rows) === JSON.stringify(BASE.rows));
    check(`...and worked pay untouched`, s.totals.gross === BASE.totals.gross);
  }

  // DELETE.
  const deleted = stmt([bHr]);
  check('deleting the flat bonus drops TOTAL OWED by exactly $100.00',
    cents(before.totals.totalOwed) - cents(deleted.totals.totalOwed) === 10000);
  check('...the deleted line is gone', !deleted.bonusItems.some((i) => i.id === b100.id));
  check('...the hourly line survives, still worth $145.00', cents(deleted.totals.hourlyBonusTotal) === 14500);
  check('...and worked hours are untouched', deleted.totals.paidHours === BASE.totals.paidHours);
  check('deleting every bonus restores the original statement, byte for byte',
    JSON.stringify(stmt([])) === JSON.stringify(BASE));
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
  const items = [
    flat('e-carlos', 10000, 'Performance bonus'),
    flat('e-carlos', 5000, 'Attendance bonus'),
    hourly('e-carlos', 200, 'Productivity incentive'),
  ];

  // Exactly what PayView does for a tile: computePay for worked pay and HOURS, then the SAME
  // shared functions the statement uses for the bonus and the addition.
  const pay = computePay([CARLOS, OTHER], SHIFTS);
  for (const p of pay) {
    const summary = bonusSummaryFor(items, p.employee.id, PERIOD, p.hours);
    const tileTotal = totalOwedOf(p.pay, summary.total);
    const detail = stmt(items, p.employee);
    check(`${p.employee.name}: the tile's total owed IS the statement's total owed`,
      cents(tileTotal) === cents(detail.totals.totalOwed), formatMoney(tileTotal));
    check(`${p.employee.name}: the tile's bonus IS the statement's bonus`,
      summary.cents === detail.totals.bonusCents);
    check(`${p.employee.name}: computePay's hours ARE the statement's payable hours`,
      p.hours === detail.totals.paidHours);
  }
  check('Carlos\'s tile reads $1,890.00', formatMoney(stmt(items).totals.totalOwed) === '$1,890.00');

  // The hours a tile passes in are what price the incentive, so the tile cannot price it differently.
  const carlos = pay.find((p) => p.employee.id === 'e-carlos');
  check('the tile prices the incentive off the SAME hours the drawer does',
    bonusSummaryFor(items, 'e-carlos', PERIOD, carlos.hours).hourlyCents === stmt(items).totals.bonusCents - 15000);

  const rosterTotal = pay.reduce((a, p) => a + totalOwedOf(p.pay, bonusSummaryFor(items, p.employee.id, PERIOD, p.hours).total), 0);
  const rosterWorked = pay.reduce((a, p) => a + p.pay, 0);
  check('the roster total exceeds worked pay by exactly the bonuses',
    cents(rosterTotal) - cents(rosterWorked) === 29500);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§9b THE PRINTED WORKING MUST MULTIPLY OUT TO THE PRINTED MONEY');
{
  // THE CASE THAT PROMPTED THIS. A live host on 1828 approved minutes at $3.00/hr is owed exactly
  // $91.40. Stated as '30.47 hr' the expression read 30.47 x 3.00 = $91.41, so a CORRECT payroll
  // figure was printed beside arithmetic that made it look a penny short.
  const oddHost = EMP({ id: 'e-odd', role: 'host', hourly_rate: 25 });
  const oddShift = [punch('e-odd', '2026-08-24', '06:00', '14:00', { approved_minutes: 1828 })];
  const oddS = stmt([hourly('e-odd', 300, 'Live show incentive')], oddHost, PERIOD, oddShift);
  const oddItem = oddS.bonusItems[0];

  check('the exact payable duration is still 30.4666… hours',
    Math.abs(oddItem.eligiblePaidHours - 1828 / 60) < 1e-12, String(oddItem.eligiblePaidHours));
  check('the money is unchanged — still $91.40', oddItem.calculatedBonusCents === 9140);
  check('the basis now reads as a duration', formatBonusBasis(oddItem) === '$3.00/hr × 30h 28m payable',
    formatBonusBasis(oddItem));
  check('...and 30h 28m x $3.00 IS $91.40 — the visible arithmetic reconciles',
    Math.round(300 * (30 + 28 / 60)) === 9140);
  check('...the misleading "30.47" appears nowhere in it', !formatBonusBasis(oddItem).includes('30.47'));
  check('...nor any bare 2-decimal hour figure at all', !/\d+\.\d\d\s*hr/.test(formatBonusBasis(oddItem)));

  // The clean case still reads cleanly.
  const clean = stmt([hourly('e-carlos', 200, 'Productivity incentive')]).bonusItems[0];
  check('72.50 payable hours reads as 72h 30m', formatBonusBasis(clean) === '$2.00/hr × 72h 30m payable',
    formatBonusBasis(clean));
  check('...and 72h 30m x $2.00 IS $145.00', Math.round(200 * 72.5) === 14500 && clean.calculatedBonusCents === 14500);

  // ── THE PROPERTY ITSELF, not just two examples ───────────────────────────────────────────────
  // Parse the rendered duration back out of the string and multiply it by the rendered rate. That
  // is exactly what a reader checking the line by hand would do, so it must come out at the
  // rendered money — unless the line carries the '~' that says the figure is rounded.
  const parseBasis = (basis) => {
    const m = /^\$([\d,]+\.\d\d)\/hr × (~?)((?:\d+h ?)?(?:\d+m ?)?(?:\d+s ?)?) payable$/.exec(basis);
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
        calculationType: 'hourly', rateCentsPerHour: rateCents, eligiblePaidHours: h,
        calculatedBonusCents: hourlyBonusCents(rateCents, h),
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
  const secs = { calculationType: 'hourly', rateCentsPerHour: 200, eligiblePaidHours: 7 + 40 / 60 + 23 / 3600 };
  secs.calculatedBonusCents = hourlyBonusCents(200, secs.eligiblePaidHours);
  check('tier 2 — whole seconds, for an ordinary clocked punch',
    formatBonusBasis(secs) === '$2.00/hr × 7h 40m 23s payable', formatBonusBasis(secs));
  const wild = { calculationType: 'hourly', rateCentsPerHour: 90000, eligiblePaidHours: 7.6730872 };
  wild.calculatedBonusCents = hourlyBonusCents(90000, wild.eligiblePaidHours);
  check('tier 3 — a rate so high that even seconds cannot reconcile says so with "~"',
    formatBonusBasis(wild).startsWith('$900.00/hr × ~'), formatBonusBasis(wild));

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

  // Not applied, and it touches no payroll.
  check('the file does NOT claim to have been applied to production',
    /⛔ NOT APPLIED/.test(sql) && !/✅ APPLIED TO PRODUCTION/.test(sql));
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
  check('the form is told the payable hours rather than working them out',
    /paidHours=\{statement\.totals\.paidHours\}/.test(modal));
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
  check('...pricing each tile off THAT employee\'s own payable hours',
    /bonusSummaryFor\(adjustments, p\.employee\.id, period, p\.hours\)/.test(view));
  check('...and adding with the shared rule', /totalOwedOf\(p\.pay, bonus\.total\)/.test(view));
  check('PayView never prices an hourly bonus by hand',
    !/rate_cents_per_hour\s*\*|\*\s*p\.hours/.test(view));

  // THE HOOK.
  check('every mutation refetches instead of patching a cached total',
    (hook.match(/onSuccess: refetchAll/g) || []).length === 3 && !/setQueryData/.test(hook));
  check('the query is keyed on the period, so switching periods refetches',
    /queryKey = \['pay_adjustments', user\?\.id, periodStart, periodEnd\]/.test(hook));
  check('the hook does no payroll maths', !/hourly_rate|paidShiftHours|computePay|\* 100|\/ 100/.test(hook));
  check('both money columns are ALWAYS named on a write, one of them null',
    /amount_cents: hourly \? null : fields\.amount_cents/.test(hook) &&
      /rate_cents_per_hour: hourly \? fields\.rate_cents_per_hour : null/.test(hook));
  check('an edit cannot move a bonus to another person, period, or calculation type', (() => {
    const update = hook.split('const updateBonus')[1].split('const deleteBonus')[0];
    return !/employee_id:/.test(update) && !/period_start/.test(update) && /calculation_type, \.\.\.patch/.test(update);
  })());
}

console.log(`\n${passed} checks passed`);
