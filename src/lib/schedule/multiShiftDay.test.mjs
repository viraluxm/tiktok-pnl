// TWO WORKED SHIFTS ON ONE CALENDAR DAY, end to end.
//
// A split day is normal here — a 6am–2pm fulfillment shift and a 5pm–1am live shift are two clock
// sessions and two `shifts` rows. Every clock-out RPC already wrote both; what hid the second was
// calendarModel's pickPunch(), which returned ONE punch per person-day (the open one, else the
// earliest) and dropped the rest. That is not cosmetic: the confirm queue lists people whose state
// is 'pending', so a punch that cannot appear there can never be confirmed — and an unconfirmed
// time_clock row is not payable. Production held 12 such rows worth 91.86 hours.
//
// These run the REAL modules: buildCalendarDays, the real isPayableShift/paidShiftHours/computePay,
// the real buildPayStatement/payPeriodWeeks and the real PDF renderer.
//   Run:  TZ=UTC node src/lib/schedule/multiShiftDay.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { inflateSync } from 'node:zlib';
import assert from 'node:assert/strict';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'multishift-'));
function transpile(rel, name, rewrites = {}) {
  const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  let { outputText } = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  for (const [from, to] of Object.entries(rewrites)) outputText = outputText.split(from).join(to);
  const p = join(dir, name);
  writeFileSync(p, outputText);
  return pathToFileURL(p).href;
}

const shim = join(dir, 'pdf-lib-shim.mjs');
writeFileSync(
  shim,
  `import pkg from '${pathToFileURL(require.resolve('pdf-lib')).href}';\n` +
    `export const PDFDocument = pkg.PDFDocument;\nexport const StandardFonts = pkg.StandardFonts;\nexport const rgb = pkg.rgb;\n`,
);

const tzUrl = transpile('./timezone.ts', 'timezone.mjs');
const empUrl = transpile('../employees.ts', 'employees.mjs');
const cmUrl = transpile('./calendarModel.ts', 'cm.mjs', { "'@/lib/employees'": `'${empUrl}'` });
const stmtUrl = transpile('../pay/statement.ts', 'statement.mjs', {
  "'@/lib/employees'": `'${empUrl}'`,
  "'@/lib/schedule/timezone'": `'${tzUrl}'`,
});
const pdfUrl = transpile('../pay/statementPdf.ts', 'statementPdf.mjs', {
  "'./statement'": `'${stmtUrl}'`,
  "'pdf-lib'": `'${pathToFileURL(shim).href}'`,
});
const weeklyUrl = transpile('../weeklySchedule.ts', 'weeklySchedule.mjs');
const punchUrl = transpile('../shifts/punchEdit.ts', 'punchEdit.mjs', {
  "'@/lib/schedule/timezone'": `'${tzUrl}'`,
  "'@/lib/weeklySchedule'": `'${weeklyUrl}'`,
});
const mwUrl = transpile('../shifts/manualWorked.ts', 'manualWorked.mjs', {
  "'@/lib/schedule/timezone'": `'${tzUrl}'`,
  "'./punchEdit'": `'${punchUrl}'`,
  "'@/lib/shifts/punchEdit'": `'${punchUrl}'`,
});

const { buildCalendarDays } = await import(cmUrl);
const { computePay, paidShiftHours, clockedShiftHours, isPayableShift } = await import(empUrl);
const { buildPayStatement, workedDayGroups, payPeriodWeeks } = await import(stmtUrl);
const { renderPayStatementPdf, dayLines } = await import(pdfUrl);
const { canAddWorkedTimeAt } = await import(mwUrl);
const { laWallTimeToUtc } = await import(tzUrl);

let passed = 0;
const check = (n, c, x = '') => {
  assert.ok(c, `FAIL: ${n}${x ? ` — ${x}` : ''}`);
  console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`);
  passed++;
};
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;

// ── Fixture: Juan works 6:00–10:00 and again 14:00–18:00 on Monday ──────────────────────────
const DATE = '2026-09-14'; // a Monday
const EMPS = [{ id: 'juan', name: 'Juan Reyes', role: 'fulfillment' }];
const DAYS = [DATE];

const calPunch = (o) => ({
  id: 'x', source: 'time_clock', employee_id: 'juan', date: DATE,
  start_time: '06:00', end_time: '10:00',
  clock_in_at: laWallTimeToUtc(DATE, '06:00').toISOString(),
  clock_out_at: laWallTimeToUtc(DATE, '10:00').toISOString(),
  break_minutes: 0, confirmed_at: null, approved_minutes: null, auto_closed: false, ...o,
});
const MORNING = calPunch({ id: 'am', start_time: '06:00', end_time: '10:00' });
const AFTERNOON = calPunch({
  id: 'pm', start_time: '14:00', end_time: '18:00',
  clock_in_at: laWallTimeToUtc(DATE, '14:00').toISOString(),
  clock_out_at: laWallTimeToUtc(DATE, '18:00').toISOString(),
});
const build = (o = {}) =>
  buildCalendarDays({ employees: EMPS, punches: [], scheduled: [], days: DAYS, view: 'all', todayISO: '2026-09-15', ...o });

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§1 The calendar keeps BOTH sessions — the bug that stranded 91.86 hours');
{
  const cell = build({ punches: [MORNING, AFTERNOON] }).get(DATE);
  check('two punches produce TWO entries, not one', cell.people.length === 2, `${cell.people.length}`);
  check('both punch ids survive',
    cell.people.map((p) => p.punch.id).sort().join(',') === 'am,pm',
    cell.people.map((p) => p.punch.id).join(','));
  check('neither entry was merged into the other',
    cell.people.some((p) => p.punch.start_time === '06:00') &&
      cell.people.some((p) => p.punch.start_time === '14:00'));
  check('each carries its own hours', cell.people.every((p) => near(p.punch.hours, 4)));

  // THE MONEY PATH: the confirm queue lists people whose state is 'pending'.
  const pending = cell.people.filter((p) => p.state === 'pending');
  check('BOTH unconfirmed sessions reach the confirm queue', pending.length === 2,
    'before the fix the afternoon one was unreachable and could never be paid');
  check('the day chip says 2 to confirm, not 1', cell.pendingCount === 2, `${cell.pendingCount}`);

  // Headcount is PEOPLE; a split day is still one person on the floor.
  check('headcount counts the person once', cell.headcount === 1, `${cell.headcount}`);
  check('clocked counts the sessions', cell.clockedCount === 2, `${cell.clockedCount}`);

  // Confirming one must not disturb the other.
  const half = build({ punches: [{ ...MORNING, confirmed_at: '2026-09-15T00:00:00Z' }, AFTERNOON] }).get(DATE);
  check('confirming the morning leaves the afternoon still pending',
    half.people.filter((p) => p.state === 'pending').length === 1 &&
      half.people.find((p) => p.punch.id === 'pm').state === 'pending');
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§2 Ordering, open sessions, and the one-per-day cases that must not regress');
{
  const cell = build({ punches: [AFTERNOON, MORNING] }).get(DATE); // deliberately out of order
  check('entries read earliest-first regardless of input order',
    cell.people[0].punch.id === 'am' && cell.people[1].punch.id === 'pm');

  // An OPEN session still sorts first — it is the live one.
  const open = calPunch({ id: 'live', start_time: '14:00', end_time: null, clock_out_at: null });
  const withOpen = build({ punches: [MORNING, open] }).get(DATE);
  check('an open session is listed first', withOpen.people[0].punch.id === 'live');
  check('...and is reported as open', withOpen.people[0].state === 'open' && withOpen.openCount === 1);
  check('the completed earlier session is still there', withOpen.people.length === 2);

  // A normal single-shift day is completely unchanged.
  const one = build({ punches: [MORNING] }).get(DATE);
  check('a single-shift day still yields exactly one entry', one.people.length === 1);
  check('...with headcount 1 and clocked 1', one.headcount === 1 && one.clockedCount === 1);
  const none = build({ scheduled: [{ id: 's1', employee_id: 'juan', date: DATE, start_time: '06:00', end_time: '14:00', origin: 'instance', source: 'admin_open' }] }).get(DATE);
  check('a scheduled-but-unworked day still yields one entry with no punch',
    none.people.length === 1 && none.people[0].punch === null);

  // The schedule rides on the FIRST entry only — otherwise a split day double-counts the plan.
  const sched = [{ id: 's1', employee_id: 'juan', date: DATE, start_time: '06:00', end_time: '14:00', origin: 'instance', source: 'admin_open' }];
  const both = build({ punches: [MORNING, AFTERNOON], scheduled: sched }).get(DATE);
  check('the plan is attached once, not to every session',
    both.people.filter((p) => p.scheduled != null).length === 1);
  check('...and the scheduled chip counts it once', both.scheduledCount === 1);
  check('the second session is not reported as a no-show against a phantom plan',
    both.people.find((p) => p.punch.id === 'pm').state !== 'no_show');
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§3 Payroll pays both, through the existing semantics');
{
  const PERIOD = { start: '2026-09-07', end: '2026-09-20', payday: '2026-09-25' };
  const EMP = (o = {}) => ({
    id: 'juan', user_id: 'u1', name: 'Juan Reyes', role: 'fulfillment', status: 'active',
    hourly_rate: 25, hire_date: null, probation_end_date: null, created_at: '', updated_at: '', ...o,
  });
  const shift = (id, a, b, o = {}) => ({
    id, user_id: 'u1', employee_id: 'juan', date: DATE,
    start_time: `${a}:00`, end_time: `${b}:00`, source: 'time_clock', source_rule_id: null,
    confirmed_at: '2026-09-15T00:00:00Z', confirmed_by: 'u1', break_minutes: 0,
    clock_in_at: laWallTimeToUtc(DATE, a).toISOString(),
    clock_out_at: laWallTimeToUtc(DATE, b).toISOString(),
    auto_closed: false, approved_minutes: null, created_at: '', updated_at: '', ...o,
  });
  const am = shift('s-am', '06:00', '10:00');
  const pm = shift('s-pm', '14:00', '18:00');

  check('each row is independently payable', isPayableShift(am) && isPayableShift(pm));
  check('each row is 4.00 h', near(paidShiftHours(am), 4) && near(paidShiftHours(pm), 4));
  const [row] = computePay([EMP()], [am, pm]);
  check('4.00 + 4.00 = 8.00 payable hours', near(row.hours, 8), `${row.hours.toFixed(2)}`);
  check('...and $200.00 at $25/hr', near(row.pay, 200), `$${row.pay.toFixed(2)}`);

  const s = buildPayStatement({ employee: EMP(), period: PERIOD, shifts: [am, pm], generatedAtISO: '2026-09-21T17:00:00.000Z' });
  check('the statement carries both rows', s.rows.length === 2);
  check('statement total === computePay', s.totals.paidHours === row.hours && s.totals.gross === row.pay);
  check('it counts as ONE worked day', s.totals.workedDays === 1, `${s.totals.workedDays}`);

  const days = workedDayGroups(s);
  check('both rows group under the same date', days.length === 1 && days[0].rows.length === 2);
  check('the day subtotal is both records', near(days[0].hours, 8) && near(days[0].amount, 200));
  const weeks = payPeriodWeeks(s);
  // Sep 14 is a Monday, so in a Sep 7-20 period it opens WEEK 2.
  check('the week containing the day subtotals both records',
    near(weeks[1].hours, 8) && near(weeks[0].hours, 0),
    `w1=${weeks[0].hours.toFixed(2)} w2=${weeks[1].hours.toFixed(2)}`);
  check('week 1 + week 2 still equals the period total',
    near(weeks[0].hours + weeks[1].hours, s.totals.paidHours));

  // approved_minutes applies PER ROW and must not leak between same-day rows.
  const amApproved = shift('s-am', '06:00', '10:00', { approved_minutes: 180 }); // 3.00h approved
  const s2 = buildPayStatement({ employee: EMP(), period: PERIOD, shifts: [amApproved, pm], generatedAtISO: '2026-09-21T17:00:00.000Z' });
  check('an approved figure applies only to its own row',
    near(s2.rows.find((r) => r.shiftId === 's-am').paidHours, 3) &&
      near(s2.rows.find((r) => r.shiftId === 's-pm').paidHours, 4));
  check('...and the day total follows it', near(workedDayGroups(s2)[0].hours, 7));
  check('the clocked span is still 4.00 — approval did not rewrite the punch',
    near(clockedShiftHours(amApproved), 4));
  check('approved totals match computePay exactly',
    s2.totals.paidHours === computePay([EMP()], [amApproved, pm])[0].hours);

  // A scheduled-only row on the same day stays out of pay.
  const plan = shift('s-plan', '20:00', '22:00', { source_rule_id: 'rule-1' });
  const s3 = buildPayStatement({ employee: EMP(), period: PERIOD, shifts: [am, pm, plan], generatedAtISO: '2026-09-21T17:00:00.000Z' });
  check('a scheduled row beside two worked rows adds nothing', near(s3.totals.paidHours, 8));
  check('...and is listed as not paid', s3.excluded.some((e) => e.reason === 'schedule_plan'));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§4 Both records reach the printed statement');
{
  const PERIOD = { start: '2026-09-07', end: '2026-09-20', payday: '2026-09-25' };
  const EMP = { id: 'juan', user_id: 'u1', name: 'Juan Reyes', role: 'fulfillment', status: 'active', hourly_rate: 25, hire_date: null, probation_end_date: null, created_at: '', updated_at: '' };
  const mk = (id, a, b) => ({
    id, user_id: 'u1', employee_id: 'juan', date: DATE, start_time: `${a}:00`, end_time: `${b}:00`,
    source: 'time_clock', source_rule_id: null, confirmed_at: '2026-09-15T00:00:00Z', confirmed_by: 'u1',
    break_minutes: 0, clock_in_at: laWallTimeToUtc(DATE, a).toISOString(),
    clock_out_at: laWallTimeToUtc(DATE, b).toISOString(), auto_closed: false, approved_minutes: null,
    created_at: '', updated_at: '',
  });
  const s = buildPayStatement({ employee: EMP, period: PERIOD, shifts: [mk('a', '06:00', '10:00'), mk('b', '14:00', '18:00')], generatedAtISO: '2026-09-21T17:00:00.000Z' });
  const bytes = await renderPayStatementPdf(s);
  const buf = Buffer.from(bytes);
  const latin = buf.toString('latin1');
  let text = '', idx = 0;
  for (;;) {
    const i = latin.indexOf('stream', idx); if (i < 0) break;
    let st = i + 6; if (latin[st] === '\r') st++; if (latin[st] === '\n') st++;
    const e = latin.indexOf('endstream', st); if (e < 0) break;
    try {
      const chunk = inflateSync(buf.subarray(st, e)).toString('latin1');
      for (const hex of chunk.match(/<[0-9A-Fa-f\s]+>/g) || []) {
        const c = hex.slice(1, -1).replace(/\s+/g, '');
        if (c.length % 2 === 0) text += Buffer.from(c, 'hex').toString('latin1') + '\n';
      }
    } catch { /* not a content stream */ }
    idx = e + 'endstream'.length;
  }
  check('both start times are printed', text.includes('6:00 AM') && text.includes('2:00 PM'));
  check('both end times are printed', text.includes('10:00 AM') && text.includes('6:00 PM'));
  check('each prints its own 4.00 hours', (text.match(/4\.00/g) || []).length >= 2,
    `${(text.match(/4\.00/g) || []).length} occurrences`);
  check('the period total is 8.00', text.includes('8.00'));
  check('gross pay is $200.00', text.includes('$200.00'));
  // The date labels the pair ONCE. Asserted on dayLines(), the unit that decides it — a
  // document-wide string count would also match the "Week 2: September 14 - September 20" heading.
  const dayGroup = payPeriodWeeks(s).flatMap((w) => w.days).find((d) => d.dateISO === DATE);
  const lines = dayLines(dayGroup);
  check('the day emits one line per record', lines.length === 2, `${lines.length}`);
  check('the date and weekday are printed on the first line only',
    lines[0].date === 'September 14' && lines[0].day === 'Monday' &&
      lines[1].date === '' && lines[1].day === '');
  check('...and each line carries its own times and hours',
    lines[0].in === '6:00 AM' && lines[0].hours === '4.00' &&
      lines[1].in === '2:00 PM' && lines[1].hours === '4.00',
    `${lines[0].in}/${lines[1].in}`);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n§5 The affordance that is deliberately NOT changed');
{
  // canAddWorkedTimeAt is the narrow "they were scheduled and never clocked in" shortcut. It still
  // refuses next to an existing punch, on purpose: its prefill copies the PLANNED span, which would
  // overlap the shift already there — and the RPC would refuse it anyway. Adding a genuine second
  // record goes through the Advanced "Record worked time" lane, which has no same-day gate.
  const after = new Date('2026-09-15T00:00:00Z');
  const plan = { start_time: '06:00', end_time: '14:00' };
  check('offered when the person was scheduled and never punched',
    canAddWorkedTimeAt({ punch: null, scheduled: plan }, DATE, after));
  check('still withheld when a punch already exists',
    !canAddWorkedTimeAt({ punch: { id: 'am' }, scheduled: plan }, DATE, after),
    'the general Add Worked Time lane is the path for a second record');
}

console.log(`\n${passed} checks passed`);
