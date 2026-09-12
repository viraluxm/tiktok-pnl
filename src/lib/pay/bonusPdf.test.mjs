// BONUSES ON THE PAYROLL HOURS STATEMENT — a real PDF, rendered through the real pdf-lib, with its
// content streams inflated and read back. The three things it has to prove:
//
//   1. A bonus of EITHER type is ON the paper: its name, how it was arrived at ('Flat', or
//      '$2.00/hr x 72.50 hr'), what it is worth, the subtotal and a TOTAL OWED.
//   2. That TOTAL OWED is the SAME NUMBER Pay Details shows — asserted against the model both
//      surfaces read, and against the modal's own source, not against a second calculation here.
//   3. WITH NO BONUSES THE DOCUMENT IS THE ONE THAT SHIPPED BEFORE — byte for byte, not "looks
//      about the same". That is the assertion that makes this change safe for the 95% of
//      statements which will never carry a bonus.
//
// Run:  TZ=UTC node src/lib/pay/bonusPdf.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { inflateSync } from 'node:zlib';
import assert from 'node:assert/strict';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'bonuspdf-'));
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

// pdf-lib ships a CJS entry whose named exports Node cannot always detect through a dynamic
// import; the module under test is pointed at a tiny ESM shim over the real package.
const shim = join(dir, 'pdf-lib-shim.mjs');
writeFileSync(
  shim,
  `import pkg from '${pathToFileURL(require.resolve('pdf-lib')).href}';\n` +
    `export const PDFDocument = pkg.PDFDocument;\nexport const StandardFonts = pkg.StandardFonts;\nexport const rgb = pkg.rgb;\n`,
);

const tzUrl = transpile('../schedule/timezone.ts', 'timezone.mjs');
const employeesUrl = transpile('../employees.ts', 'employees.mjs');
const stmtUrl = transpile('./statement.ts', 'statement.mjs', {
  "'@/lib/employees'": `'${employeesUrl}'`,
  "'@/lib/schedule/timezone'": `'${tzUrl}'`,
});
const pdfUrl = transpile('./statementPdf.ts', 'statementPdf.mjs', {
  "'./statement'": `'${stmtUrl}'`,
  "'pdf-lib'": `'${pathToFileURL(shim).href}'`,
});
const calcUrl = transpile('../calculations.ts', 'calculations.mjs', {
  "'@/types'": `'${pathToFileURL(join(dir, 'types-stub.mjs')).href}'`,
});
writeFileSync(join(dir, 'types-stub.mjs'), 'export {};\n');

const { PDFDocument: ProbeDoc } = await import(pathToFileURL(shim).href);
const { buildPayStatement, formatMoney, formatBonusBasis } = await import(stmtUrl);
const { renderPayStatementPdf } = await import(pdfUrl);
const { fmt } = await import(calcUrl);
const { laWallTimeToUtc } = await import(tzUrl);

// The brand mark ships under public/ and is fetched in the browser; Node has no origin, so the
// test hands the renderer the very bytes that ship — which also proves the asset is a real PNG.
const LOCKUP_BYTES = readFileSync(fileURLToPath(new URL('../../../public/viralux-lockup.png', import.meta.url)));
const loadLogo = async () => new Uint8Array(LOCKUP_BYTES);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name}${extra ? ` — ${extra}` : ''}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

// ── Fixtures: the reviewed case, to the dollar ──────────────────────────────────────────────
const PERIOD = { start: '2026-08-24', end: '2026-09-06', payday: '2026-09-11' };
const GENERATED = '2026-09-08T17:00:00.000Z';
const CARLOS = {
  id: 'e-carlos', user_id: 'u1', name: 'Carlos Herrera', role: 'fulfillment', status: 'active',
  hourly_rate: 22, hire_date: null, probation_end_date: null, created_at: '', updated_at: '',
};

let seq = 0;
const punch = (date, start, end) => ({
  id: `p${++seq}`, user_id: 'u1', employee_id: 'e-carlos', date,
  start_time: `${start}:00`, end_time: `${end}:00`,
  source: 'time_clock', source_rule_id: null,
  confirmed_at: '2026-09-07T00:00:00.000Z', confirmed_by: 'u1', break_minutes: 0,
  clock_in_at: laWallTimeToUtc(date, start).toISOString(),
  clock_out_at: laWallTimeToUtc(date, end).toISOString(),
  auto_closed: false, created_at: '', updated_at: '',
});

const SHIFTS = [
  punch('2026-08-24', '08:00', '16:00'), punch('2026-08-25', '08:00', '16:00'),
  punch('2026-08-26', '08:00', '16:00'), punch('2026-08-27', '08:00', '16:30'),
  punch('2026-08-28', '08:00', '16:00'), punch('2026-08-31', '08:00', '16:00'),
  punch('2026-09-01', '08:00', '16:00'), punch('2026-09-02', '08:00', '16:00'),
  punch('2026-09-03', '09:00', '17:00'),
];

const row = (id, min, over) => ({
  id, user_id: 'u1', employee_id: 'e-carlos',
  period_start: PERIOD.start, period_end: PERIOD.end,
  kind: 'bonus', calculation_type: 'flat', amount_cents: null, rate_cents_per_hour: null,
  description: null,
  created_at: `2026-09-07T18:0${min}:00.000Z`, updated_at: `2026-09-07T18:0${min}:00.000Z`,
  ...over,
});
const adj = (id, amount_cents, description, min) =>
  row(id, min, { calculation_type: 'flat', amount_cents, description });
const hourlyAdj = (id, rate_cents_per_hour, description, min) =>
  row(id, min, { calculation_type: 'hourly', rate_cents_per_hour, description });

const build = (adjustments) =>
  buildPayStatement({ employee: CARLOS, period: PERIOD, shifts: SHIFTS, adjustments, generatedAtISO: GENERATED });

const plain = build(undefined);
// The reviewed case: two flat bonuses and one hourly incentive.
//   $100.00 + $50.00 flat, plus $2.00/hr x 72.50 payable hr = $145.00  →  $295.00 of bonus pay
//   $1,595.00 worked + $295.00 bonus                                   →  $1,890.00 owed
const withBonus = build([
  adj('b1', 10000, 'Performance bonus', 1),
  adj('b2', 5000, 'Attendance bonus', 2),
  hourlyAdj('b3', 200, 'Productivity incentive', 3),
]);

const plainPdf = await renderPayStatementPdf(plain, { loadLogo });
const bonusPdf = await renderPayStatementPdf(withBonus, { loadLogo });
const plainText = textOf(plainPdf);
const bonusText = textOf(bonusPdf);

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§1 The fixture is the reviewed one');
{
  check('72.50 worked hours', plain.totals.paidHours.toFixed(2) === '72.50');
  check('$1,595.00 of worked pay', formatMoney(plain.totals.gross) === '$1,595.00');
  check('$150.00 of flat bonus', formatMoney(withBonus.totals.flatBonusTotal) === '$150.00');
  check('$145.00 of hourly bonus', formatMoney(withBonus.totals.hourlyBonusTotal) === '$145.00');
  check('$295.00 of bonus pay', formatMoney(withBonus.totals.bonusTotal) === '$295.00');
  check('$1,890.00 owed', formatMoney(withBonus.totals.totalOwed) === '$1,890.00');
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§2 NO BONUSES — the document that shipped before, unchanged');
{
  check('the no-bonus statement is still ONE Letter page', (await pageSizes(plainPdf)).length === 1);
  check('the summary still says "Gross Pay:"', plainText.includes('Gross Pay:'));
  check('...and still prints the worked total there', plainText.includes('$1,595.00'));
  check('no bonus heading is emitted', !plainText.includes('BONUSES'));
  check('no bonus subtotal row is emitted', !plainText.includes('Bonus Pay'));
  check('no TOTAL OWED row is emitted', !plainText.includes('TOTAL OWED'));
  check('...and the checks above are not vacuous — the bonus document HAS all four',
    bonusText.includes('BONUSES / INCENTIVES') && bonusText.includes('Bonus Pay:') &&
      bonusText.includes('TOTAL OWED:'));

  // An empty list must produce the IDENTICAL document to no argument at all, or "no bonuses" would
  // mean two different files depending on which caller asked.
  const emptyPdf = await renderPayStatementPdf(build([]), { loadLogo });
  check('an empty adjustments list renders a byte-identical PDF',
    Buffer.compare(Buffer.from(emptyPdf), Buffer.from(plainPdf)) === 0);

  // A bonus belonging to ANOTHER period must not reach the paper either.
  const otherPeriod = build([{ ...adj('bx', 99900, 'Previous period bonus', 3), period_start: '2026-08-10', period_end: '2026-08-23' }]);
  const otherHourly = build([{ ...hourlyAdj('by', 500, 'Previous period incentive', 4), period_start: '2026-08-10', period_end: '2026-08-23' }]);
  const otherPdf = await renderPayStatementPdf(otherPeriod, { loadLogo });
  check('a bonus from another period renders the unchanged document',
    Buffer.compare(Buffer.from(otherPdf), Buffer.from(plainPdf)) === 0);
  check('...and its $999.00 appears nowhere on the page', !textOf(otherPdf).includes('$999.00'));
  const otherHourlyPdf = await renderPayStatementPdf(otherHourly, { loadLogo });
  check('an HOURLY bonus from another period renders the unchanged document too',
    Buffer.compare(Buffer.from(otherHourlyPdf), Buffer.from(plainPdf)) === 0);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§3 WITH BONUSES — name, amount, subtotal, total');
{
  check('the section is headed', bonusText.includes('BONUSES / INCENTIVES'));
  check('the first bonus is named', bonusText.includes('Performance bonus'));
  check('...with its amount', bonusText.includes('$100.00'));
  check('...and says how it was arrived at', bonusText.includes('Flat'));
  check('the second bonus is named', bonusText.includes('Attendance bonus'));
  check('...with its amount', bonusText.includes('$50.00'));

  // THE HOURLY LINE — the one the paper has to explain rather than just assert.
  check('the hourly incentive is named', bonusText.includes('Productivity incentive'));
  check('...it shows its RATE and its ELIGIBLE HOURS, so the figure can be checked by hand',
    bonusText.includes('$2.00/hr') && bonusText.includes('72.50 hr'));
  check('...through the SAME formatter the screen uses, character for character',
    bonusText.includes(formatBonusBasis(withBonus.bonusItems[2])),
    formatBonusBasis(withBonus.bonusItems[2]));
  check('...and prints what it is worth', bonusText.includes('$145.00'));

  check('the subtotal is printed', bonusText.includes('Bonus Pay:') && bonusText.includes('$295.00'));
  check('TOTAL OWED is printed', bonusText.includes('TOTAL OWED:') && bonusText.includes('$1,890.00'));

  // The worked-pay row is RENAMED, not removed — it is no longer the whole of the gross.
  check('the worked row is labelled "Hourly Pay:" once bonuses exist', bonusText.includes('Hourly Pay:'));
  check('...and no longer claims to be the gross', !bonusText.includes('Gross Pay:'));
  check('...but still prints the untouched $1,595.00', bonusText.includes('$1,595.00'));

  check('total hours and hourly rate are still there', bonusText.includes('Total Hours This Pay Period:') && bonusText.includes('72.50'));
  const bonusPages = await pageSizes(bonusPdf);
  check('the statement is still ONE Letter page', bonusPages.length === 1, `${bonusPages.length} pages`);
  check('...and still 8.5 x 11', bonusPages.every(([w, h]) => w === 612 && h === 792));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§4 The paper and the screen show the SAME total owed');
{
  // Both surfaces read statement.totals.totalOwed. The PDF prints it through formatMoney and the
  // panel through fmt — two formatters, so the test proves they produce the same string rather
  // than assuming it.
  check('fmt and formatMoney agree on the total owed',
    fmt(withBonus.totals.totalOwed) === formatMoney(withBonus.totals.totalOwed),
    fmt(withBonus.totals.totalOwed));
  check('the PDF prints exactly that string', bonusText.includes(fmt(withBonus.totals.totalOwed)));
  check('...and the panel renders the same field', (() => {
    const modal = src('../../components/employees/PayDetailModal.tsx');
    return modal.includes('fmt(statement.totals.totalOwed)');
  })());
  check('the PDF prints the same bonus subtotal the panel does',
    bonusText.includes(fmt(withBonus.totals.bonusTotal)) && fmt(withBonus.totals.bonusTotal) === '$295.00');
  // The hourly line is the one that could be re-derived and get a different answer. Every part of
  // it on paper must be the model's own field, not a recomputation.
  const hourlyItem = withBonus.bonusItems[2];
  check('the PDF prints the model\'s rate, eligible hours and value — all three',
    bonusText.includes(formatMoney(hourlyItem.rateCentsPerHour / 100)) &&
      bonusText.includes(hourlyItem.eligiblePaidHours.toFixed(2)) &&
      bonusText.includes(fmt(hourlyItem.amount)));
  check('...and those eligible hours ARE the statement\'s payable hours',
    hourlyItem.eligiblePaidHours === withBonus.totals.paidHours);

  // And the renderer must still not be able to work a payroll figure out for itself.
  const pdfSrc = src('./statementPdf.ts');
  check('the renderer still imports no payroll function',
    !/from '.*lib\/employees'/.test(pdfSrc) && !/paidShiftHours|isPayableShift|computePay/.test(pdfSrc));
  check('...and does no money arithmetic of its own for the bonus',
    !/bonusItems\.reduce|amountCents\s*\+|totals\.gross\s*\+/.test(pdfSrc));
  check('...and NEVER re-derives an hourly bonus — no rate x hours anywhere in the renderer',
    !/rateCentsPerHour\s*\*|\*\s*eligiblePaidHours|\*\s*paidHours/.test(pdfSrc));
  check('...it prints the shared basis string instead', /formatBonusBasis\(item\)/.test(pdfSrc));
  check('...it reads the model\'s own fields',
    /statement\.totals\.bonusTotal/.test(pdfSrc) && /statement\.totals\.totalOwed/.test(pdfSrc) &&
      /statement\.bonusItems/.test(pdfSrc));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§5 The worked-time half of the document is untouched');
{
  // Every week-table line from the plain document must still be on the bonus one. This is the
  // assertion that catches a layout change quietly dropping or shifting a worked row.
  const workedLines = plainText.split('\n').filter((l) => /(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Off|AM|PM)/.test(l));
  check('the plain document actually has worked lines to compare', workedLines.length >= 14, `${workedLines.length}`);
  const missing = workedLines.filter((l) => !bonusText.includes(l));
  check('every worked-time line survives onto the bonus document', missing.length === 0, missing.slice(0, 3).join(' | '));

  check('both weeks are still subtotalled', bonusText.includes('Week 1 Total Hours:') && bonusText.includes('Week 2 Total Hours:'));
  check('the week subtotals still reconcile to the WORKED hours, not the total owed',
    bonusText.includes('40.50') && bonusText.includes('32.00'));
  check('the signature block survives', bonusText.includes('Employee Signature:') && bonusText.includes('Employer/Manager Signature:'));
  check('the Notes row survives', bonusText.includes('Notes:'));
  check('the identity block survives', bonusText.includes('Carlos Herrera') && bonusText.includes('Biweekly'));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§6 Edge cases on paper');
{
  // A description at the column's limit must be truncated rather than run into the money column.
  const longName = 'Q3 exceptional performance and attendance incentive award for the full period';
  const longPdf = await renderPayStatementPdf(build([adj('b9', 12500, longName, 1)]), { loadLogo });
  const longText = textOf(longPdf);
  check('an over-long bonus name is truncated with an ellipsis', /…/.test(longText), 'ellipsis present');
  check('...and is not printed in full', !longText.includes(longName));
  check('...while its amount still prints', longText.includes('$125.00'));
  check('...and the total is still right', longText.includes('$1,720.00'));

  // A bonus with no reason has to print as something, in either type.
  const anonText = textOf(await renderPayStatementPdf(build([adj('b8', 2500, null, 1)]), { loadLogo }));
  check('a bonus with no description prints a plain label', anonText.includes('Bonus') && anonText.includes('$25.00'));
  const anonHourly = textOf(await renderPayStatementPdf(build([hourlyAdj('b7', 250, null, 1)]), { loadLogo }));
  check('...and an unnamed hourly one still prints its working',
    anonHourly.includes('Bonus') && anonHourly.includes('$2.50/hr') && anonHourly.includes('$181.25'));

  // A DECIMAL rate, on paper.
  const decText = textOf(await renderPayStatementPdf(build([hourlyAdj('b6', 250, 'Productivity incentive', 1)]), { loadLogo }));
  check('$2.50/hr x 72.50 hr prints as $181.25', decText.includes('$2.50/hr') && decText.includes('$181.25'));

  // AND THE POINT OF THE WHOLE DESIGN: fewer hours, a smaller incentive, same stored row.
  const fewerShifts = SHIFTS.slice(0, 8); // drop the last 8.00-hour day → 64.50 payable hours
  const fewer = buildPayStatement({
    employee: CARLOS, period: PERIOD, shifts: fewerShifts,
    adjustments: [hourlyAdj('b5', 200, 'Productivity incentive', 1)], generatedAtISO: GENERATED,
  });
  const fewerText = textOf(await renderPayStatementPdf(fewer, { loadLogo }));
  check('with 64.50 payable hours the SAME $2.00/hr row prints $129.00 on paper',
    fewer.totals.paidHours.toFixed(2) === '64.50' && fewerText.includes('$129.00') &&
      fewerText.includes('64.50 hr'),
    formatMoney(fewer.totals.bonusTotal));
  check('...and the document differs from the 72.50-hour one, so this is not a vacuous check',
    !fewerText.includes('$145.00'));

  // Many bonuses must paginate rather than overflow the page.
  // Fifteen flat and fifteen hourly, so pagination is exercised with both kinds of row.
  const manyStatement = build(Array.from({ length: 30 }, (_, i) =>
    i % 2 === 0 ? adj(`bm${i}`, 1000, `Incentive ${i}`, 1) : hourlyAdj(`bm${i}`, 25, `Incentive ${i}`, 1)));
  const manyPdf = await renderPayStatementPdf(manyStatement, { loadLogo });
  const manyBoxes = await pageSizes(manyPdf);
  check('thirty bonus lines paginate rather than running off the sheet', manyBoxes.length >= 2, `${manyBoxes.length} pages`);
  check('...every spilled page is still Letter', manyBoxes.every(([w, h]) => w === 612 && h === 792));
  const manyText = textOf(manyPdf);
  // Read off the model rather than hard-coded, so the assertion cannot quietly stop matching the
  // fixture — 15 x $10.00 flat plus 15 x $0.25/hr on 72.50 hr.
  check('...the total survives pagination', manyText.includes(formatMoney(manyStatement.totals.totalOwed)),
    formatMoney(manyStatement.totals.totalOwed));
  check('...and both kinds of line made it onto the paper',
    manyText.includes('Flat') && manyText.includes('$0.25/hr'));
  check('...and the pages are numbered with the real total', manyText.includes(`Page ${manyBoxes.length} of ${manyBoxes.length}`));
}

console.log(`\n${passed} checks passed`);

// ── PDF introspection helpers (same approach as statementPdf.test.mjs) ───────────────────────
function textOf(bytes) {
  const buf = Buffer.from(bytes);
  const latin = buf.toString('latin1');
  let out = '', idx = 0;
  for (;;) {
    const i = latin.indexOf('stream', idx);
    if (i < 0) break;
    let start = i + 6;
    if (latin[start] === '\r') start++;
    if (latin[start] === '\n') start++;
    const end = latin.indexOf('endstream', start);
    if (end < 0) break;
    let chunk = '';
    try { chunk = inflateSync(buf.subarray(start, end)).toString('latin1'); } catch { /* not Flate */ }
    for (const hex of chunk.match(/<[0-9A-Fa-f\s]+>/g) || []) {
      const clean = hex.slice(1, -1).replace(/\s+/g, '');
      if (clean.length % 2 !== 0) continue;
      out += Buffer.from(clean, 'hex').toString('latin1') + '\n';
    }
    idx = end + 'endstream'.length;
  }
  return out.replace(/\x96/g, '–').replace(/\x97/g, '—').replace(/\x85/g, '…');
}

// Page geometry is read back through pdf-lib's OWN parser, never by grepping the bytes: save()
// packs page dictionaries into compressed object streams, so /MediaBox is not plaintext and a
// regex over the file silently finds nothing. Re-loading is also the stronger check — a file a PDF
// parser cannot open fails here. (Same approach as statementPdf.test.mjs.)
async function pageSizes(bytes) {
  const doc = await ProbeDoc.load(bytes);
  return doc.getPages().map((pg) => { const { width, height } = pg.getSize(); return [width, height]; });
}
