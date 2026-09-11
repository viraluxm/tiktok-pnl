// EDIT, DELETE, AND THE WEEK LAYOUT — the three things this pass changed.
//
// The headline regression is the dead Edit button. Its cause was not logic but PAINT ORDER: the
// editor mounted and prefilled correctly, then was drawn underneath the panel that opened it,
// because both overlays were position:fixed at z-index 50 and the panel is portalled to the end of
// <body> while the editor sat deep inside body's first child. Nothing a value assertion could have
// caught — the earlier suite "verified" the editor by querying the DOM for its title, which passed
// while the user saw nothing. So the guards here are STRUCTURAL, over the real source: the editor
// must leave the dashboard's subtree and sit above the panel.
//
// Run:  TZ=UTC node src/lib/pay/payDetailActions.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { inflateSync } from 'node:zlib';
import assert from 'node:assert/strict';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'paydetail-actions-'));
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
// These files explain their own safety at length; match the code, not the prose.
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const shim = join(dir, 'pdf-lib-shim.mjs');
writeFileSync(
  shim,
  `import pkg from '${pathToFileURL(require.resolve('pdf-lib')).href}';\n` +
    `export const PDFDocument = pkg.PDFDocument;\nexport const StandardFonts = pkg.StandardFonts;\nexport const rgb = pkg.rgb;\n`,
);

const tzUrl = transpile('../schedule/timezone.ts', 'timezone.mjs');
const employeesUrl = transpile('../employees.ts', 'employees.mjs');
const weeklyUrl = transpile('../weeklySchedule.ts', 'weeklySchedule.mjs');
const stmtUrl = transpile('./statement.ts', 'statement.mjs', {
  "'@/lib/employees'": `'${employeesUrl}'`,
  "'@/lib/schedule/timezone'": `'${tzUrl}'`,
});
const delUrl = transpile('./deleteEligibility.ts', 'deleteEligibility.mjs');
const punchUrl = transpile('../shifts/punchEdit.ts', 'punchEdit.mjs', {
  "'@/lib/schedule/timezone'": `'${tzUrl}'`,
  "'@/lib/weeklySchedule'": `'${weeklyUrl}'`,
});
const pdfUrl = transpile('./statementPdf.ts', 'statementPdf.mjs', {
  "'./statement'": `'${stmtUrl}'`,
  "'pdf-lib'": `'${pathToFileURL(shim).href}'`,
});

const { buildPayStatement, payPeriodWeeks, formatMoney, formatDayLabel } = await import(stmtUrl);
const { canDeleteRecord, deleteBlockedReasonFor, TIME_CLOCK_DELETE_BLOCKED_REASON } = await import(delUrl);
const { buildShiftEditPatch, shiftEditPrefill } = await import(punchUrl);
const { indexWeekCards } = await import(weeklyUrl);
const { computePay } = await import(employeesUrl);
const { renderPayStatementPdf } = await import(pdfUrl);
const { laWallTimeToUtc } = await import(tzUrl);

const LOGO = new Uint8Array(readFileSync(fileURLToPath(new URL('../../../public/viralux-lockup.png', import.meta.url))));
const render = (s) => renderPayStatementPdf(s, { loadLogo: async () => LOGO });

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name}${extra ? ` — ${extra}` : ''}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;

const PERIOD = { start: '2026-08-24', end: '2026-09-06', payday: '2026-09-11' };
const EMP = (o = {}) => ({
  id: 'e1', user_id: 'u1', name: 'Juan Reyes', role: 'fulfillment', status: 'active',
  hourly_rate: 22, hire_date: null, probation_end_date: null, created_at: '', updated_at: '', ...o,
});
let n = 0;
const isoAdd = (d, k) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
const punch = (d, a, b, o = {}) => ({
  id: `p${++n}`, user_id: 'u1', employee_id: 'e1', date: d, start_time: a + ':00', end_time: b + ':00',
  source: 'time_clock', source_rule_id: null, confirmed_at: '2026-09-07T00:00:00.000Z', confirmed_by: 'u1',
  break_minutes: 0, clock_in_at: laWallTimeToUtc(d, a).toISOString(),
  clock_out_at: laWallTimeToUtc(b <= a ? isoAdd(d, 1) : d, b).toISOString(),
  auto_closed: false, created_at: '', updated_at: '', ...o,
});
const manual = (d, a, b, o = {}) => ({
  id: `m${++n}`, user_id: 'u1', employee_id: 'e1', date: d, start_time: a + ':00',
  end_time: b === null ? null : b + ':00', source: 'manual', source_rule_id: null,
  confirmed_at: null, confirmed_by: null, break_minutes: 0, clock_in_at: null, clock_out_at: null,
  auto_closed: false, created_at: '', updated_at: '', ...o,
});
const build = (sh, e = EMP()) => buildPayStatement({ employee: e, period: PERIOD, shifts: sh, generatedAtISO: '2026-09-08T17:00:00.000Z' });

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§1 The dead Edit button — the editor must be painted ABOVE the panel that opens it');
{
  const view = strip(src('../../components/employees/PayView.tsx'));
  const layer = strip(src('../../components/employees/OverlayLayer.tsx'));
  const modal = strip(src('../../components/employees/PayDetailModal.tsx'));
  const preview = strip(src('../../app/preview/pay-detail/PayDetailPreview.tsx'));

  check('the Pay tab still renders the ONE canonical editor, not a new one',
    /<ShiftEditorModal/.test(view) && /from '\.\/weekly\/ShiftEditorModal'/.test(view));
  check('...opened straight on the edit form', /initialScreen="edit"/.test(view));

  // THE FIX: the editor is wrapped in a body-level layer. Without this it renders inside the
  // dashboard subtree and loses to the portalled panel on DOM order.
  check('the editor is wrapped in OverlayLayer',
    /<OverlayLayer>[\s\S]{0,400}?<ShiftEditorModal/.test(view), 'this is the regression guard');
  check('OverlayLayer portals to document.body',
    /createPortal\([\s\S]*?document\.body\s*,?\s*\)/.test(layer));
  check('...and stacks above the panel', /level = 60/.test(layer) && /zIndex: level/.test(layer));
  check('the panel it must beat is at z-50', /fixed inset-0 z-50/.test(modal));
  check('the review preview uses the identical wiring',
    /<OverlayLayer>[\s\S]{0,400}?<ShiftEditorModal/.test(preview),
    'so what is approved in preview is what ships');

  // The card handed to the editor must be the row that was clicked.
  const rows = [punch('2026-08-26', '06:06', '14:01', { break_minutes: 27 }), manual('2026-08-26', '15:00', '19:00')];
  const dates = new Set(rows.map((r) => r.date));
  const cards = new Map();
  for (const arr of indexWeekCards(rows, [], dates).values()) for (const c of arr) cards.set(c.id, c);
  check('every payable record has an editable card', rows.every((r) => cards.has(r.id)), `${cards.size} cards`);
  check('clicking a row selects THAT record', cards.get(rows[0].id).id === rows[0].id && cards.get(rows[1].id).id === rows[1].id);

  // And it must open at the right values for BOTH sources.
  const punchPrefill = shiftEditPrefill(cards.get(rows[0].id));
  const manualPrefill = shiftEditPrefill(cards.get(rows[1].id));
  check('a Time Clock row opens at its PUNCH INSTANTS',
    punchPrefill.start === '06:06' && punchPrefill.end === '14:01', JSON.stringify(punchPrefill));
  check('a Manual Entry row opens at its wall clock',
    manualPrefill.start === '15:00' && manualPrefill.end === '19:00', JSON.stringify(manualPrefill));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§2 Editing saves through the canonical path and rebuilds the statement');
{
  const apply = (row, edit) => { const p = buildShiftEditPatch(row, edit); return p === null ? row : { ...row, ...p }; };

  // TIME CLOCK — the correction must land on the instants payroll reads.
  const p0 = punch('2026-08-26', '06:06', '14:01', { break_minutes: 27 });
  const before = build([p0]);
  const patch = buildShiftEditPatch(p0, { start_time: '06:06', end_time: '13:01' });
  check('a Time Clock edit writes the punch instant', patch.clock_out_at !== undefined, JSON.stringify(patch));
  const after = build([apply(p0, { start_time: '06:06', end_time: '13:01' })]);
  check('...and one hour comes off the statement', near(after.totals.paidHours, before.totals.paidHours - 1),
    `${before.totals.paidHours.toFixed(2)} -> ${after.totals.paidHours.toFixed(2)}`);
  check('...matching computePay on the saved row',
    after.totals.paidHours === computePay([EMP()], [apply(p0, { start_time: '06:06', end_time: '13:01' })])[0].hours);

  // MANUAL — the wall clock IS the pay basis.
  const m0 = manual('2026-08-27', '09:00', '17:00');
  const mBefore = build([m0]);
  const mPatch = buildShiftEditPatch(m0, { start_time: '09:00', end_time: '16:00' });
  check('a Manual edit writes the wall clock and no instants',
    mPatch.end_time === '16:00' && mPatch.clock_in_at === undefined && mPatch.clock_out_at === undefined);
  check('...and one hour comes off it too',
    near(build([apply(m0, { start_time: '09:00', end_time: '16:00' })]).totals.paidHours, mBefore.totals.paidHours - 1));

  // The regenerated document must follow.
  const t1 = textOf(await render(before)), t2 = textOf(await render(after));
  check('the regenerated PDF shows the corrected total',
    t2.includes(formatMoney(after.totals.gross)) && !t2.includes(formatMoney(before.totals.gross)),
    `${formatMoney(before.totals.gross)} -> ${formatMoney(after.totals.gross)}`);
  check('...and the corrected end time', t2.includes('1:01 PM') && !t1.includes('1:01 PM'));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§3 Delete — only where it actually removes the record for good');
{
  check('a Manual Entry record can be deleted', canDeleteRecord({ source: 'manual' }));
  check('a Time Clock record cannot', !canDeleteRecord({ source: 'time_clock' }));
  check('...and the block explains itself in the UI',
    deleteBlockedReasonFor({ source: 'time_clock' }) === TIME_CLOCK_DELETE_BLOCKED_REASON &&
      /punch/i.test(TIME_CLOCK_DELETE_BLOCKED_REASON) && /unconfirm/i.test(TIME_CLOCK_DELETE_BLOCKED_REASON));
  check('a deletable record offers no blocked reason', deleteBlockedReasonFor({ source: 'manual' }) === undefined);

  // The reason, restated as a guard: only the reconciler creates time_clock rows, so only those can
  // come back after a delete.
  const recon = src('../../../supabase/migrations/072_time_clock_robustness.sql');
  check('the reconciler recreates a shift from an orphaned punch',
    /clocked_out_at is not null and shift_id is null/.test(recon) && /insert into public\.shifts/.test(recon),
    'which is exactly why time_clock delete is refused');
  check('...and it only ever creates time_clock rows', /'time_clock'/.test(recon));
  const fk = src('../../../supabase/migrations/070_time_clock_attendance.sql');
  check('deleting a shift orphans its punch rather than removing it',
    /shift_id uuid references public\.shifts\(id\) on delete set null/.test(fk));

  // Deleting through the canonical path: the row leaves, and every total follows from DB truth.
  const keep = punch('2026-08-26', '06:00', '14:00');
  const doomed = manual('2026-08-26', '15:00', '19:00');
  const other = punch('2026-09-02', '09:00', '17:00');
  const beforeDel = build([keep, doomed, other]);
  const afterDel = build([keep, other]); // what a refetch returns once the row is gone
  check('the fixture really had the record', beforeDel.rows.some((r) => r.shiftId === doomed.id));
  check('after the delete + refetch it is gone', !afterDel.rows.some((r) => r.shiftId === doomed.id));
  check('hours drop by exactly the deleted record',
    near(afterDel.totals.paidHours, beforeDel.totals.paidHours - 4), `-${(beforeDel.totals.paidHours - afterDel.totals.paidHours).toFixed(2)}h`);
  check('amount owed drops by exactly its pay',
    near(afterDel.totals.gross, beforeDel.totals.gross - 88), `-${formatMoney(beforeDel.totals.gross - afterDel.totals.gross)}`);
  check('the totals still equal computePay', afterDel.totals.paidHours === computePay([EMP()], [keep, other])[0].hours);

  const wBefore = payPeriodWeeks(beforeDel), wAfter = payPeriodWeeks(afterDel);
  check('the affected week drops by that amount', near(wAfter[0].hours, wBefore[0].hours - 4));
  check('the other week is untouched', wAfter[1].hours === wBefore[1].hours);
  check('the day keeps its other record', wAfter[0].days.find((d) => d.dateISO === '2026-08-26').rows.length === 1);

  const tDel = textOf(await render(afterDel));
  check('the regenerated PDF no longer contains the deleted record',
    !tDel.includes(formatMoney(88)) && tDel.includes(formatMoney(afterDel.totals.gross)),
    'and carries the new total');

  // A delete must never promote something non-payable.
  const plan = manual('2026-09-04', '09:00', '17:00', { source_rule_id: 'rule-1' });
  const withPlan = build([keep, other, plan]);
  check('a scheduled-only row stays non-payable through a delete',
    withPlan.totals.paidHours === afterDel.totals.paidHours && !withPlan.rows.some((r) => r.shiftId === plan.id));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§4 The week-by-week layout the panel renders');
{
  const shifts = [
    punch('2026-08-24', '16:43', '02:00'),                    // overnight, into Aug 25
    punch('2026-08-31', '15:52', '01:52'),                    // overnight, into Sep 1
    manual('2026-08-31', '16:00', '02:00'),                   // SECOND record on the same day
    punch('2026-09-05', '06:02', '14:07', { break_minutes: 30 }),
  ];
  const s = build(shifts);
  const weeks = payPeriodWeeks(s);

  check('the period renders as exactly two weeks', weeks.length === 2);
  check('Week 1 has 7 days', weeks[0].days.length === 7);
  check('Week 2 has 7 days', weeks[1].days.length === 7);
  check('14 calendar days in total', weeks.flatMap((w) => w.days).length === 14);
  check('...covering the period end to end',
    weeks[0].days[0].dateISO === PERIOD.start && weeks[1].days[6].dateISO === PERIOD.end);

  const off = weeks.flatMap((w) => w.days).filter((d) => d.rows.length === 0);
  check('days with no payable record are present, not skipped', off.length === 11, `${off.length} off days`);
  check('...and read as zero', off.every((d) => d.hours === 0 && d.amount === 0));

  const doubled = weeks[1].days.find((d) => d.dateISO === '2026-08-31');
  check('two records on one date stay separate', doubled.rows.length === 2 &&
    doubled.rows[0].shiftId !== doubled.rows[1].shiftId);
  check('...and are not merged into one interval', doubled.rows[0].startLabel !== doubled.rows[1].startLabel);
  check('...while the day total is their sum',
    near(doubled.hours, doubled.rows[0].paidHours + doubled.rows[1].paidHours));

  const overnight = weeks[0].days.find((d) => d.dateISO === '2026-08-24').rows[0];
  check('an overnight record carries the date it ended on', overnight.endDateISO === '2026-08-25',
    formatDayLabel(overnight.endDateISO ?? ''));
  check('a same-day record carries none',
    weeks[1].days.find((d) => d.dateISO === '2026-09-05').rows[0].endDateISO === null);

  check('WEEK 1 + WEEK 2 hours = the period total',
    near(weeks[0].hours + weeks[1].hours, s.totals.paidHours),
    `${weeks[0].hours.toFixed(2)} + ${weeks[1].hours.toFixed(2)} = ${s.totals.paidHours.toFixed(2)}`);
  check('WEEK 1 + WEEK 2 pay = the period total',
    Math.round((weeks[0].amount + weeks[1].amount) * 100) === Math.round(s.totals.gross * 100),
    `${formatMoney(weeks[0].amount)} + ${formatMoney(weeks[1].amount)} = ${formatMoney(s.totals.gross)}`);
  check('...and neither week is empty here', weeks[0].hours > 0 && weeks[1].hours > 0);

  // The panel must not do its own arithmetic.
  const modal = strip(src('../../components/employees/PayDetailModal.tsx'));
  check('the panel reads week/day grouping from the model', /payPeriodWeeks\(statement\)/.test(modal));
  check('...and computes no payroll of its own',
    !/paidShiftHours|computePay|isPayableShift/.test(modal) && !/hourly_rate\s*\*|\*\s*rate\b/.test(modal));
  check('week totals are printed, not re-added',
    /week\.hours\.toFixed/.test(modal) && /fmt\(week\.amount\)/.test(modal) &&
      !/reduce\(\(a, ?d\) => a \+ d\.hours/.test(modal));
  check('the not-paid list is still a closed disclosure, last on the page',
    /<details/.test(modal) && !/<details[^>]*\bopen\b/.test(modal) &&
      modal.indexOf('payPeriodWeeks') < modal.indexOf('not included in pay'));
}

console.log(`\n${passed} checks passed`);

// Content-stream text of a PDF: streams are Flate-compressed and standard-font text is written as
// hex strings, with WinAnsi punctuation.
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
