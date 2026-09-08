// THE PAY STATEMENT DOCUMENT: a real US-Letter PDF, byte-deterministic, carrying the statement's
// own numbers and nothing it worked out for itself.
//
// This renders through the REAL pdf-lib (already a production dependency) and inspects the bytes
// it produces — page geometry from the MediaBox, text from the content streams. Nothing is
// stubbed, so a layout change that silently drops the totals fails here.
//
// Run:  TZ=UTC node src/lib/pay/statementPdf.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { inflateSync } from 'node:zlib';
import assert from 'node:assert/strict';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'paystatementpdf-'));
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

// pdf-lib ships a CJS entry whose named exports Node cannot always detect through a dynamic
// import, so the module under test is pointed at a tiny ESM shim over the real package. The
// package itself is untouched — only how this test reaches it.
const pdfLibCjs = pathToFileURL(require.resolve('pdf-lib')).href;
const shim = join(dir, 'pdf-lib-shim.mjs');
writeFileSync(
  shim,
  `import pkg from '${pdfLibCjs}';\n` +
    `export const PDFDocument = pkg.PDFDocument;\n` +
    `export const StandardFonts = pkg.StandardFonts;\n` +
    `export const rgb = pkg.rgb;\n`,
);

const tzUrl = transpile('../schedule/timezone.ts', 'timezone.mjs');
const employeesUrl = transpile('../employees.ts', 'employees.mjs');
const pickerUrl = transpile('../shipping/pickerPerformance.ts', 'pickerPerformance.mjs');
const econUrl = transpile('../shipping/pickCostEconomics.ts', 'pickCostEconomics.mjs', {
  "'@/lib/employees'": `'${employeesUrl}'`,
  "'@/lib/shipping/pickerPerformance'": `'${pickerUrl}'`,
});
const stmtUrl = transpile('./statement.ts', 'statement.mjs', {
  "'@/lib/employees'": `'${employeesUrl}'`,
  "'@/lib/schedule/timezone'": `'${tzUrl}'`,
  "'@/lib/shipping/pickCostEconomics'": `'${econUrl}'`,
});
const pdfUrl = transpile('./statementPdf.ts', 'statementPdf.mjs', {
  "'./statement'": `'${stmtUrl}'`,
  "'pdf-lib'": `'${pathToFileURL(shim).href}'`,
});

const punchUrl = transpile('../shifts/punchEdit.ts', 'punchEdit.mjs', {
  "'@/lib/schedule/timezone'": `'${tzUrl}'`,
  "'@/lib/weeklySchedule'": `'${transpile('../weeklySchedule.ts', 'weeklySchedule.mjs')}'`,
});
const { buildPayStatement, formatMoney } = await import(stmtUrl);
const { buildShiftEditPatch } = await import(punchUrl);
const { renderPayStatementPdf, wrapText, fitText, rowCells, formatPeriodRange } = await import(pdfUrl);
const { laWallTimeToUtc } = await import(tzUrl);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name}${extra ? ` — ${extra}` : ''}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

// ── Fixture ─────────────────────────────────────────────────────────────────────────────────
const PERIOD = { start: '2026-08-24', end: '2026-09-06', payday: '2026-09-11' };
const EMP = (over = {}) => ({
  id: 'e1', user_id: 'u1', name: 'Carlos Medina', role: 'fulfillment', status: 'active',
  hourly_rate: 22, hire_date: null, probation_end_date: null, created_at: '', updated_at: '', ...over,
});
let seq = 0;
const punch = (date, s, e, over = {}) => ({
  id: `p${++seq}`, user_id: 'u1', employee_id: 'e1', date,
  start_time: `${s}:00`, end_time: `${e}:00`, source: 'time_clock', source_rule_id: null,
  confirmed_at: '2026-09-02T00:00:00.000Z', confirmed_by: 'u1', break_minutes: 0,
  clock_in_at: laWallTimeToUtc(date, s).toISOString(),
  clock_out_at: laWallTimeToUtc(e <= s ? isoAdd(date, 1) : date, e).toISOString(),
  auto_closed: false, created_at: '', updated_at: '', ...over,
});
const manual = (date, s, e, over = {}) => ({
  id: `m${++seq}`, user_id: 'u1', employee_id: 'e1', date,
  start_time: `${s}:00`, end_time: e === null ? null : `${e}:00`, source: 'manual',
  source_rule_id: null, confirmed_at: null, confirmed_by: null, break_minutes: 0,
  clock_in_at: null, clock_out_at: null, auto_closed: false, created_at: '', updated_at: '', ...over,
});
function isoAdd(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const build = (shifts, employee = EMP(), at = '2026-09-08T17:00:00.000Z') =>
  buildPayStatement({ employee, period: PERIOD, shifts, generatedAtISO: at });

// Pull every string drawn into the document, so assertions can be about what a reader actually
// sees rather than about the call sequence that produced it. Content streams are Flate-compressed,
// and pdf-lib writes standard-font text as HEX strings (<48656c…> Tj), not literals.
function textOf(bytes) {
  const buf = Buffer.from(bytes);
  const latin = buf.toString('latin1');
  let out = '';
  let idx = 0;
  for (;;) {
    const i = latin.indexOf('stream', idx);
    if (i < 0) break;
    let start = i + 6;
    if (latin[start] === '\r') start++;
    if (latin[start] === '\n') start++;
    const end = latin.indexOf('endstream', start);
    if (end < 0) break;
    let chunk = '';
    try {
      chunk = inflateSync(buf.subarray(start, end)).toString('latin1');
    } catch {
      /* not a Flate stream (xref/object streams we do not need) */
    }
    for (const hex of chunk.match(/<[0-9A-Fa-f\s]+>/g) || []) {
      const clean = hex.slice(1, -1).replace(/\s+/g, '');
      if (clean.length % 2 !== 0) continue;
      out += Buffer.from(clean, 'hex').toString('latin1') + '\n';
    }
    for (const lit of chunk.match(/\((?:\\.|[^\\)])*\)/g) || []) {
      out += lit.slice(1, -1).replace(/\\([()\\])/g, '$1') + '\n';
    }
    idx = end + 'endstream'.length;
  }
  // Standard-font text is stored WinAnsi-encoded, so the punctuation this document actually uses
  // comes back as single high bytes. Map them home before anything is compared against a real
  // string — otherwise an en dash in the period range silently fails to match itself.
  return out
    .replace(/\x96/g, '\u2013') // en dash
    .replace(/\x97/g, '\u2014') // em dash
    .replace(/\x85/g, '\u2026') // ellipsis
    .replace(/\x92/g, '\u2019'); // right single quote
}

// Page geometry is read back through pdf-lib's own parser rather than by grepping the bytes:
// save() packs page dictionaries into compressed object streams, so /MediaBox is not plaintext.
// Re-loading the document is also a stronger check — a file a PDF parser cannot open fails here.
const { PDFDocument: ProbeDoc } = await import(pathToFileURL(shim).href);
async function pageSizes(bytes) {
  const doc = await ProbeDoc.load(bytes);
  return doc.getPages().map((p) => { const { width, height } = p.getSize(); return [width, height]; });
}

const SHIFTS = [
  punch('2026-08-26', '06:06', '14:01', { break_minutes: 27 }),
  manual('2026-08-26', '06:00', '14:00'), // overlaps the punch → a review note
  punch('2026-08-27', '06:04', '14:02', { break_minutes: 62 }),
  manual('2026-08-31', '17:00', '01:00'), // overnight
  punch('2026-09-01', '06:15', '13:58'),
  manual('2026-09-02', '09:00', null), // open → excluded, listed as not paid
];

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§1 It is a real PDF, on US Letter paper');
{
  const statement = build(SHIFTS);
  const bytes = await renderPayStatementPdf(statement);
  check('the output is a PDF', Buffer.from(bytes.subarray(0, 5)).toString() === '%PDF-');
  check('and it is not empty', bytes.length > 2000, `${bytes.length} bytes`);
  const boxes = await pageSizes(bytes);
  check('a PDF parser can reopen it and finds pages', boxes.length >= 1, `${boxes.length} pages`);
  check('EVERY page is 8.5in x 11in (612 x 792 pt)',
    boxes.every(([w, h]) => w === 612 && h === 792), JSON.stringify(boxes));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§2 The same statement always produces the same bytes');
{
  const s = build(SHIFTS);
  const a = await renderPayStatementPdf(s);
  const b = await renderPayStatementPdf(build(SHIFTS)); // rebuilt statement, same inputs
  check('two renders are byte-identical', Buffer.from(a).equals(Buffer.from(b)),
    `${a.length} vs ${b.length} bytes`);

  const later = await renderPayStatementPdf(build(SHIFTS, EMP(), '2026-09-09T09:00:00.000Z'));
  check('a different generated-at DOES change the document', !Buffer.from(a).equals(Buffer.from(later)),
    'the timestamp is real, not decorative');
  check('the document carries the caller\'s date, not today\'s',
    textOf(a).includes('Generated 2026-09-08') && textOf(later).includes('Generated 2026-09-09'));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§3 What is on the page is what is on the screen');
{
  const statement = build(SHIFTS);
  const text = textOf(await renderPayStatementPdf(statement));

  check('the Lensed masthead is there', text.includes('LENSED'));
  check('it names itself', text.includes('Employee Pay Statement'));
  check('the employee is named', text.includes('Carlos Medina'));
  check('the role is shown', text.includes('Fulfillment'));
  check('the pay period is shown',
    text.includes(formatPeriodRange(PERIOD.start, PERIOD.end)), formatPeriodRange(PERIOD.start, PERIOD.end));

  // The totals must be the STATEMENT's totals, character for character.
  check('the total owed on paper is the statement total',
    text.includes(formatMoney(statement.totals.gross)), formatMoney(statement.totals.gross));
  check('the payable hours on paper are the statement hours',
    text.includes(statement.totals.paidHours.toFixed(2)), statement.totals.paidHours.toFixed(2));
  check('worked days are shown', text.includes(String(statement.totals.workedDays)));

  // Every payable row must appear, with its own cells.
  const missing = statement.rows.filter((r) => {
    const c = rowCells(r);
    return !text.includes(c.date) || !text.includes(c.hours) || !text.includes(c.amount);
  });
  check('every payable row is printed with its date, hours and amount',
    missing.length === 0 && statement.rows.length === 5,
    `${statement.rows.length} rows checked`);

  check('both source labels appear', text.includes('Time Clock') && text.includes('Manual Entry'));
  check('a break under an hour prints in minutes', text.includes('27m'));
  check('a break over an hour prints in hours and minutes', text.includes('1h 2m'),
    'the 62-minute break — 2417m would be unreadable');
  check('an overnight end names the day it lands on', text.includes('(Sep 1)'), 'the 17:00–01:00 row');
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§4 Review notes travel with the document');
{
  const statement = build(SHIFTS);
  const text = textOf(await renderPayStatementPdf(statement));
  check('the fixture really does have something to review', statement.totals.reviewCount >= 2,
    `${statement.totals.reviewCount}`);
  check('the review section is printed', text.includes('NEEDS REVIEW'));
  check('the overlap is named', text.includes('Overlapping Worked Time'));
  check('the open clock-in is named as not paid',
    text.includes('Open Clock-In') && text.includes('not paid'));
  check('the review copy is manager language, not schema',
    !/confirmed_at|source_rule_id|shift_instances|clock_in_at/.test(text));

  const clean = build([punch('2026-08-26', '09:00', '17:00')]);
  const cleanText = textOf(await renderPayStatementPdf(clean));
  check('a clean period prints no review section', !cleanText.includes('NEEDS REVIEW'));
  check('...and still prints its total', cleanText.includes(formatMoney(clean.totals.gross)));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§5 It holds up at the edges');
{
  const empty = build([]);
  const emptyText = textOf(await renderPayStatementPdf(empty));
  check('a period with no worked time still renders a statement',
    emptyText.includes('No payable worked time in this pay period.'));
  check('...and reads as zero owed', emptyText.includes('$0.00'));

  // Enough rows to force pagination.
  const many = [];
  for (let d = 24; d <= 31; d++) {
    many.push(punch(`2026-08-${d}`, '06:00', '14:00'));
    many.push(manual(`2026-08-${d}`, '15:00', '19:00'));
  }
  for (let d = 1; d <= 6; d++) {
    const dd = String(d).padStart(2, '0');
    many.push(punch(`2026-09-${dd}`, '06:00', '14:00'));
    many.push(manual(`2026-09-${dd}`, '15:00', '19:00'));
  }
  const big = build(many);
  const bytes = await renderPayStatementPdf(big);
  const boxes = await pageSizes(bytes);
  const text = textOf(bytes);
  check('a long period spills onto more than one page', boxes.length >= 2, `${big.rows.length} rows → ${boxes.length} pages`);
  check('every spilled page is still Letter', boxes.every(([w, h]) => w === 612 && h === 792));
  check('pages are numbered with the real total', text.includes(`Page ${boxes.length} of ${boxes.length}`));
  check('the total survives pagination', text.includes(formatMoney(big.totals.gross)),
    formatMoney(big.totals.gross));
  check('every row still made it onto paper',
    big.rows.every((r) => text.includes(rowCells(r).amount)), `${big.rows.length} rows`);

  // A name long enough to collide with the period block must be trimmed, not overlapped.
  const longName = build(SHIFTS, EMP({ name: 'Bartholomew Fitzgerald-Montgomery III of the Warehouse' }));
  const longText = textOf(await renderPayStatementPdf(longName));
  check('an over-long name is truncated with an ellipsis rather than overrunning',
    longText.includes('Bartholomew') && /…/.test(longText));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§6 The layout helpers');
{
  const font = { widthOfTextAtSize: (t, s) => t.length * s * 0.5 };
  check('fitText leaves short text alone', fitText('abc', font, 10, 100) === 'abc');
  check('fitText truncates with an ellipsis', fitText('a'.repeat(80), font, 10, 50).endsWith('…'));
  check('fitText result actually fits', font.widthOfTextAtSize(fitText('a'.repeat(80), font, 10, 50), 10) <= 50);
  const lines = wrapText('the quick brown fox jumps over the lazy dog', font, 10, 60);
  check('wrapText breaks into lines that fit', lines.length > 1 && lines.every((l) => font.widthOfTextAtSize(l, 10) <= 60));
  check('wrapText loses no words',
    lines.join(' ').split(/\s+/).join(' ') === 'the quick brown fox jumps over the lazy dog');
  check('wrapText hard-splits an unbreakable token',
    wrapText('x'.repeat(200), font, 10, 60).every((l) => font.widthOfTextAtSize(l, 10) <= 60));
  check('a period spanning a year boundary names both years',
    formatPeriodRange('2026-12-28', '2027-01-10') === 'Dec 28, 2026 – Jan 10, 2027',
    formatPeriodRange('2026-12-28', '2027-01-10'));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§7 A correction reaches the paper');
{
  // The full chain the manager actually exercises: edit a row through the canonical patch builder,
  // apply the patch as an UPDATE would, rebuild the statement, regenerate the document. The PDF
  // must show the corrected figures and must no longer show the old ones — that is the whole
  // "screen and PDF are one calculation" claim, end to end.
  const row = punch('2026-08-27', '06:04', '14:02', { break_minutes: 62 });
  const before = build([row]);
  const beforeText = textOf(await renderPayStatementPdf(before));
  check('the original document shows the original figures',
    beforeText.includes(formatMoney(before.totals.gross)) && beforeText.includes('2:02 PM'),
    formatMoney(before.totals.gross));

  const patch = buildShiftEditPatch(row, { start_time: '06:04', end_time: '13:02' });
  check('the edit patched the punch instant, which is what pay reads', patch.clock_out_at !== undefined);
  const after = build([{ ...row, ...patch }]);
  const afterText = textOf(await renderPayStatementPdf(after));

  check('one hour came off the statement',
    Math.abs(after.totals.paidHours - (before.totals.paidHours - 1)) < 1e-9,
    `${before.totals.paidHours.toFixed(2)} -> ${after.totals.paidHours.toFixed(2)}`);
  check('the regenerated PDF shows the CORRECTED total',
    afterText.includes(formatMoney(after.totals.gross)), formatMoney(after.totals.gross));
  check('...and no longer shows the old total',
    !afterText.includes(formatMoney(before.totals.gross)), formatMoney(before.totals.gross));
  check('...and shows the corrected end time', afterText.includes('1:02 PM') && !afterText.includes('2:02 PM'));
  check('the document changed', beforeText !== afterText);
}

console.log(`\n${passed} checks passed`);
