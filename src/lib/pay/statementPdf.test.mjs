// THE PAYROLL HOURS STATEMENT: a real US-Letter PDF, byte-deterministic, carrying the statement's
// own numbers and nothing it worked out for itself — every calendar day of the period present,
// each week subtotalled, and those subtotals adding back up to the payable total.
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
const stmtUrl = transpile('./statement.ts', 'statement.mjs', {
  "'@/lib/employees'": `'${employeesUrl}'`,
  "'@/lib/schedule/timezone'": `'${tzUrl}'`,
});
const pdfUrl = transpile('./statementPdf.ts', 'statementPdf.mjs', {
  "'./statement'": `'${stmtUrl}'`,
  "'pdf-lib'": `'${pathToFileURL(shim).href}'`,
});

// The brand mark is a normal file under public/, fetched at render time because the document is
// built in the browser. Node has no origin to fetch a root-relative path from, so the tests hand
// the renderer the very bytes that ship — which also proves the asset exists and is a real PNG.
const LOCKUP_PATH = fileURLToPath(new URL('../../../public/viralux-lockup.png', import.meta.url));
const LOCKUP_BYTES = readFileSync(LOCKUP_PATH);
const loadLogo = async () => new Uint8Array(LOCKUP_BYTES);

const punchUrl = transpile('../shifts/punchEdit.ts', 'punchEdit.mjs', {
  "'@/lib/schedule/timezone'": `'${tzUrl}'`,
  "'@/lib/weeklySchedule'": `'${transpile('../weeklySchedule.ts', 'weeklySchedule.mjs')}'`,
});
const { buildPayStatement, formatMoney, payPeriodWeeks } = await import(stmtUrl);
const { buildShiftEditPatch } = await import(punchUrl);
const { renderPayStatementPdf, fitText, dayLines, formatLongDate, formatPeriodRange } = await import(pdfUrl);
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
// Every render in this file goes through the same seam, so no test silently drops the branding.
const render = (statement) => renderPayStatementPdf(statement, { loadLogo });

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
  manual('2026-08-26', '15:00', '19:00'), // a SECOND record on the same day
  punch('2026-08-27', '06:04', '14:02', { break_minutes: 62 }),
  manual('2026-08-31', '17:00', '01:00'), // overnight, into September
  punch('2026-09-01', '06:15', '13:58'),
  manual('2026-09-02', '09:00', null), // open → not payable, so its day prints as Off
];

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§1 It is a real PDF, on US Letter paper');
{
  const statement = build(SHIFTS);
  const bytes = await render(statement);
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
  const a = await render(s);
  const b = await render(build(SHIFTS)); // rebuilt statement, same inputs
  check('two renders are byte-identical', Buffer.from(a).equals(Buffer.from(b)),
    `${a.length} vs ${b.length} bytes`);

  const later = await render(build(SHIFTS, EMP(), '2026-09-09T09:00:00.000Z'));
  check('a different generated-at DOES change the document', !Buffer.from(a).equals(Buffer.from(later)),
    'the timestamp is real, not decorative');
  check('the document carries the caller\'s date, not today\'s',
    textOf(a).includes('2026-09-08') && textOf(later).includes('2026-09-09'));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§3 The document says who, when and on what terms');
{
  const statement = build(SHIFTS);
  const text = textOf(await render(statement));

  check('it is titled as a payroll hours statement', text.includes('EMPLOYEE PAYROLL HOURS STATEMENT'));
  check('the employee is named', text.includes('Employee Name:') && text.includes('Carlos Medina'));
  check('the department is the person\'s team', text.includes('Department:') && text.includes('Fulfillment'));
  check('the pay schedule is stated', text.includes('Pay Schedule:') && text.includes('Biweekly'));
  check('the pay period is stated',
    text.includes('Pay Period:') && text.includes(formatPeriodRange(PERIOD.start, PERIOD.end)),
    formatPeriodRange(PERIOD.start, PERIOD.end));

  // The reference statement carries these; this product stores none of them, so the document
  // must not pretend to.
  check('nothing is invented that the product does not store', (() => {
    const t = text.toLowerCase();
    return !/(cash paid|payment method|net pay|withhold|deduction|\btax\b)/.test(t);
  })(), 'gross hours and money only');
  check('no Lensed branding on the employee document', !/lensed/i.test(text));

  // The Viralux mark is the SUPPLIED lockup, shipped as a normal public asset and embedded as an
  // image — so the assertion is that the document actually carries one, at the supplied proportions.
  check('the brand asset ships in public/', LOCKUP_BYTES.length > 1000 &&
    LOCKUP_BYTES.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    `${LOCKUP_PATH.split('/').pop()}, ${LOCKUP_BYTES.length} bytes`);
  const withLogo = await render(statement);
  const withoutLogo = await renderPayStatementPdf(statement, { loadLogo: async () => null });
  check('the lockup is embedded in the document', withLogo.length > withoutLogo.length + 5000,
    `${withLogo.length} vs ${withoutLogo.length} bytes`);
  check('a lockup that fails to load does not deny anyone their statement',
    textOf(withoutLogo).includes('EMPLOYEE PAYROLL HOURS STATEMENT') &&
      textOf(withoutLogo).includes(formatMoney(statement.totals.gross)));
  check('the renderer points at the public asset, not an inlined blob', (() => {
    // Comments stripped: this file explains at length WHY the asset is not base64, and matching the
    // explanation instead of the code is how a guard silently rots.
    const raw = readFileSync(fileURLToPath(new URL('./statementPdf.ts', import.meta.url)), 'utf8');
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    return src.includes("'/viralux-lockup.png'") && !/base64/i.test(src);
  })());

  // The excluded records live on screen, folded away — never on the employee's document.
  check('the fixture really has excluded records', statement.excluded.length > 0, `${statement.excluded.length}`);
  check('none of them reach the PDF', (() => {
    const t = text.toLowerCase();
    return !t.includes('not included in pay') && !t.includes('unconfirmed punch') &&
      !t.includes('open clock-in') && !t.includes('scheduled only') && !t.includes('not paid');
  })(), 'the statement states payable hours; the panel explains what is missing');

  check('the totals block is present and reads off the statement',
    text.includes('Total Hours This Pay Period:') &&
      text.includes(statement.totals.paidHours.toFixed(2)) &&
      text.includes('Hourly Rate:') && text.includes(formatMoney(statement.rate)) &&
      text.includes('Gross Pay:') && text.includes(formatMoney(statement.totals.gross)),
    `${statement.totals.paidHours.toFixed(2)}h / ${formatMoney(statement.totals.gross)}`);
  check('the signature block survived', text.includes('Employee Signature:') && text.includes('Employer/Manager Signature:'));
  check('and the notes line', text.includes('Notes:'));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§4 Two weeks, every calendar day, subtotals that reconcile');
{
  const statement = build(SHIFTS);
  const weeks = payPeriodWeeks(statement);
  const text = textOf(await render(statement));

  check('both week headings are printed with their own ranges',
    text.includes(`Week 1: ${formatPeriodRange(weeks[0].start, weeks[0].end)}`) &&
      text.includes(`Week 2: ${formatPeriodRange(weeks[1].start, weeks[1].end)}`));
  check('the table header is the agreed set of columns',
    ['Date', 'Day', 'Time In', 'Time Out', 'Break', 'Hours'].every((h) => text.includes(h)));

  // EVERY calendar day in the period must appear — that is the point of the layout.
  const allDays = weeks.flatMap((w) => w.days);
  check('the period really is 14 days (not a vacuous check)', allDays.length === 14);
  const missing = allDays.filter((d) => !text.includes(formatLongDate(d.dateISO)));
  check('all 14 dates are printed', missing.length === 0, missing.map((d) => d.dateISO).join(','));
  const missingNames = [...new Set(allDays.map((d) => d.dayName))].filter((n) => !text.includes(n));
  check('every weekday name is printed', missingNames.length === 0, missingNames.join(','));

  // Days with no payable record read "Off", per the reference statement.
  const offDays = allDays.filter((d) => d.rows.length === 0);
  check('the fixture really has days off', offDays.length >= 5, `${offDays.length}`);
  check('a day with no payable record prints as Off', text.includes('Off'));
  check('...and as 0.00 hours', text.includes('0.00'));

  // Subtotals.
  check('each week prints its own subtotal',
    text.includes('Week 1 Total Hours:') && text.includes('Week 2 Total Hours:'));
  check('the printed subtotals are the model\'s subtotals',
    text.includes(weeks[0].hours.toFixed(2)) && text.includes(weeks[1].hours.toFixed(2)),
    `${weeks[0].hours.toFixed(2)} / ${weeks[1].hours.toFixed(2)}`);
  check('WEEK 1 + WEEK 2 == total payable hours',
    Math.abs(weeks[0].hours + weeks[1].hours - statement.totals.paidHours) < 1e-9,
    `${weeks[0].hours.toFixed(2)} + ${weeks[1].hours.toFixed(2)} = ${statement.totals.paidHours.toFixed(2)}`);
  check('...and neither week is empty here', weeks[0].hours > 0 && weeks[1].hours > 0);

  // Multiple records on one date stay as separate lines.
  const twoRecordDay = allDays.find((d) => d.rows.length > 1);
  check('the fixture has a day with two records', !!twoRecordDay, twoRecordDay?.dateISO);
  const lines = dayLines(twoRecordDay);
  check('that day emits one line per record, not a merged one', lines.length === twoRecordDay.rows.length);
  check('the date and day name are printed once, on the first line',
    lines[0].date !== '' && lines[0].day !== '' && lines[1].date === '' && lines[1].day === '');
  check('both records\' own hours reach the page',
    twoRecordDay.rows.every((r) => text.includes(r.paidHours.toFixed(2))),
    twoRecordDay.rows.map((r) => r.paidHours.toFixed(2)).join(' + '));

  // An overnight record names the day it ended on.
  check('an end on a later calendar day is labelled', text.includes('(Sep 1)'), 'the Aug 31 17:00-01:00 record');

  // A scheduled-only day contributes nothing.
  const withPlan = build([...SHIFTS, manual('2026-09-04', '09:00', '17:00', { source_rule_id: 'r1' })]);
  const planWeeks = payPeriodWeeks(withPlan);
  const planDay = planWeeks.flatMap((w) => w.days).find((d) => d.dateISO === '2026-09-04');
  check('a scheduled-only day carries no payable record', planDay.rows.length === 0 && planDay.hours === 0);
  check('...and does not change the total',
    withPlan.totals.paidHours === build(SHIFTS).totals.paidHours,
    'the plan is never pay');
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§5 It says nothing about whether a record looks wrong');
{
  // Two records covering the same hours, and a 47.75h punch: both are printed plainly and neither
  // is flagged, capped or excluded. Reading them is the manager's job.
  const dup = [
    punch('2026-08-26', '06:06', '14:01'),
    manual('2026-08-26', '06:00', '14:00'),
    punch('2026-08-24', '05:59', '05:44', {
      clock_out_at: laWallTimeToUtc('2026-08-26', '05:44').toISOString(),
      break_minutes: 2417,
    }),
  ];
  const statement = build(dup);
  const text = textOf(await render(statement));

  check('no review or anomaly section anywhere', (() => {
    const t = text.toLowerCase();
    return !/needs review|review|overlapping|unusually long|warning|anomaly/.test(t);
  })());
  check('both same-day records are still printed', dayLines(
    payPeriodWeeks(statement).flatMap((w) => w.days).find((d) => d.dateISO === '2026-08-26'),
  ).length === 2);
  check('the long record is printed at its real hours, uncapped',
    text.includes(statement.rows.find((r) => r.dateISO === '2026-08-24').paidHours.toFixed(2)));
  check('and its break reads in hours', text.includes('40h 17m'));
  check('the total still equals the model\'s total', text.includes(formatMoney(statement.totals.gross)));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§6 One page when it reasonably can be, and it holds up at the edges');
{
  // The ordinary case: a two-week period, one record most days. Must be a single sheet.
  const ordinary = [];
  for (const d of ['24', '25', '26', '27', '28']) ordinary.push(punch(`2026-08-${d}`, '09:00', '17:00'));
  for (const d of ['31']) ordinary.push(punch(`2026-08-${d}`, '09:00', '17:00'));
  for (const d of ['01', '02', '03', '04']) ordinary.push(punch(`2026-09-${d}`, '09:00', '17:00'));
  const ordinaryPages = await pageSizes(await render(build(ordinary)));
  check('a normal two-week statement is ONE Letter page', ordinaryPages.length === 1,
    `${ordinaryPages.length} pages, 10 worked days`);

  // The fixture with a second record on a day still fits.
  const fixturePages = await pageSizes(await render(build(SHIFTS)));
  check('...and so does one with a doubled-up day', fixturePages.length === 1, `${fixturePages.length}`);

  const empty = build([]);
  const emptyText = textOf(await render(empty));
  check('a period with no worked time still renders every day as Off',
    emptyText.includes('Off') && emptyText.includes('August 24') && emptyText.includes('September 6'));
  check('...and reads as zero owed', emptyText.includes('$0.00') && emptyText.includes('0.00'));

  // Genuinely many records: pagination is allowed, but every row must survive it.
  const many = [];
  for (let d = 24; d <= 30; d++) {
    many.push(punch(`2026-08-${d}`, '06:00', '10:00'));
    many.push(manual(`2026-08-${d}`, '11:00', '15:00'));
    many.push(manual(`2026-08-${d}`, '16:00', '20:00'));
  }
  for (let d = 31; d <= 31; d++) many.push(punch(`2026-08-${d}`, '06:00', '14:00'));
  for (let d = 1; d <= 6; d++) {
    const dd = String(d).padStart(2, '0');
    many.push(punch(`2026-09-${dd}`, '06:00', '10:00'));
    many.push(manual(`2026-09-${dd}`, '11:00', '15:00'));
  }
  const big = build(many);
  const bytes = await render(big);
  const boxes = await pageSizes(bytes);
  const text = textOf(bytes);
  check('a genuinely crowded period paginates rather than overflowing', boxes.length >= 2,
    `${big.rows.length} records -> ${boxes.length} pages`);
  check('every spilled page is still Letter', boxes.every(([w, h]) => w === 612 && h === 792));
  check('pages are numbered with the real total', text.includes(`Page ${boxes.length} of ${boxes.length}`));
  check('the total survives pagination', text.includes(formatMoney(big.totals.gross)), formatMoney(big.totals.gross));
  const bigWeeks = payPeriodWeeks(big);
  check('the week subtotals still reconcile across pages',
    Math.abs(bigWeeks[0].hours + bigWeeks[1].hours - big.totals.paidHours) < 1e-9);
  check('every one of the 14 dates still appears',
    bigWeeks.flatMap((w) => w.days).every((d) => text.includes(formatLongDate(d.dateISO))));

  // A name long enough to collide with the period block must be trimmed, not overlapped.
  const longName = build(SHIFTS, EMP({ name: 'Bartholomew Fitzgerald-Montgomery III of the Warehouse' }));
  const longText = textOf(await render(longName));
  check('an over-long name is truncated with an ellipsis rather than overrunning',
    longText.includes('Bartholomew') && /…/.test(longText));

  const font = { widthOfTextAtSize: (t, sz) => t.length * sz * 0.5 };
  check('fitText leaves short text alone', fitText('abc', font, 10, 100) === 'abc');
  check('fitText result actually fits', font.widthOfTextAtSize(fitText('a'.repeat(80), font, 10, 50), 10) <= 50);
  check('a period spanning a year boundary names both years',
    formatPeriodRange('2026-12-28', '2027-01-10') === 'December 28, 2026 - January 10, 2027',
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
  const beforeText = textOf(await render(before));
  check('the original document shows the original figures',
    beforeText.includes(formatMoney(before.totals.gross)) && beforeText.includes('2:02 PM'),
    formatMoney(before.totals.gross));

  const patch = buildShiftEditPatch(row, { start_time: '06:04', end_time: '13:02' });
  check('the edit patched the punch instant, which is what pay reads', patch.clock_out_at !== undefined);
  const after = build([{ ...row, ...patch }]);
  const afterText = textOf(await render(after));

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

console.log('\nA LEGACY FULFILLMENT OVERRIDE NEVER REACHES THE PRINTED STATEMENT');
{
  // Roberto's real production row, reduced to this fixture's shape: a 7h39m punch carrying a
  // 1421-minute (23h41m) approved figure typed before approved hours became live-host-only.
  // The PDF renders buildPayStatement's rows and computes nothing itself, so what it prints is
  // the proof that the model, the screen and the paper all read one number.
  const overridden = punch('2026-08-25', '16:55', '01:00', { break_minutes: 25, approved_minutes: 1421 });

  const fulPdf = textOf(await render(build([overridden])));                        // EMP() is fulfillment
  const hostPdf = textOf(await render(build([overridden], EMP({ role: 'host' }))));

  check('fulfillment: the printed hours are the clocked 7.67, not 23.68',
    fulPdf.includes('7.67') && !fulPdf.includes('23.68'), 'row + total');
  check('fulfillment: the printed gross is the clocked one',
    fulPdf.includes(formatMoney(build([overridden]).totals.gross))
    && !fulPdf.includes(formatMoney(build([overridden], EMP({ role: 'host' })).totals.gross)));
  check('live host: the SAME row still prints its approved 23.68 hours',
    hostPdf.includes('23.68'), 'unchanged host behaviour');
  check('...so the two documents differ, and neither check is vacuous', fulPdf !== hostPdf);
  check('both print the real punch times — the override never rewrote the attendance record',
    fulPdf.includes('4:55 PM') && hostPdf.includes('4:55 PM'));
  check('the paper agrees with the model it was handed, for both teams',
    fulPdf.includes(build([overridden]).totals.paidHours.toFixed(2))
    && hostPdf.includes(build([overridden], EMP({ role: 'host' })).totals.paidHours.toFixed(2)));
  const pdfSrc = readFileSync(fileURLToPath(new URL('./statementPdf.ts', import.meta.url)), 'utf8');
  check('the renderer still imports no payroll function of its own',
    !pdfSrc.includes('@/lib/employees') && !pdfSrc.includes('paidShiftHours'));
}

console.log(`\n${passed} checks passed`);
