// schedulePlan: the pure kernels behind the employee Schedule Builder and the bulk write path.
//
// Exercises the REAL schedulePlan.ts (and the real timezone / weeklySchedule / eligibility
// modules), transpiled at runtime — the repo's .test.mjs pattern. No stubs: this module is pure.
//
// What is pinned here, because each was a real design decision:
//   • overnight shifts end on the NEXT LA day (16:00→02:00 is a 10h span, UTC-correct)
//   • edits UPDATE the existing (employee, date) row — never a second row for the same day
//   • "Off" on an admin_open row deletes; on a pattern row it cancels; on a CLAIMED row it is
//     refused outright (nothing in the schema un-does an approved claim)
//   • repeat sends the visible week in FULL and later weeks as WORKING DAYS ONLY
//   • past days are shown, never sent
//   • nothing the planner emits can ever be a `shifts` write (it only knows shift_instances)
//
// Run:  TZ=UTC node src/lib/schedule/schedulePlan.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'schedplan-'));
const write = (name, src) => { const p = join(dir, name); writeFileSync(p, src); return pathToFileURL(p).href; };
function transpile(srcRel, outName, rewrites = {}) {
  const srcPath = fileURLToPath(new URL(srcRel, import.meta.url));
  let { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  for (const [from, to] of Object.entries(rewrites)) outputText = outputText.split(from).join(to);
  return write(outName, outputText);
}

const timezone = transpile('./timezone.ts', 'timezone.mjs');
const weekly = transpile('../weeklySchedule.ts', 'weeklySchedule.mjs');
const eligibility = transpile('./eligibility.ts', 'eligibility.mjs');
const planUrl = transpile('./schedulePlan.ts', 'schedulePlan.mjs', {
  "'./timezone'": `'${timezone}'`,
  "'@/lib/weeklySchedule'": `'${weekly}'`,
  "'./eligibility'": `'${eligibility}'`,
});
const P = await import(planUrl);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} == ${JSON.stringify(b)}`);

// Fixtures. 2026-09-07 is a Monday. "Today" is Wed 2026-09-09 so Mon/Tue are past.
const USER = 'owner-1';
const EMP = { id: 'emp-a', role: 'fulfillment', status: 'active', store_id: 'store-1' };
const HOST = { id: 'emp-h', role: 'host', status: 'active', store_id: null };
const TODAY = '2026-09-09';
const NOW = Date.parse('2026-09-09T18:00:00Z'); // 11:00 LA on the 9th
const WEEK = P.weekDatesFor('2026-09-07');
const base = (over = {}) => ({
  userId: USER, employees: [EMP, HOST], existing: [], workedKeys: new Set(), clockedInEmployees: new Set(),
  todayISO: TODAY, nowMs: NOW, entries: [], ...over,
});
const existingRow = (over = {}) => ({
  id: 'inst-1', employee_id: EMP.id, shift_date: '2026-09-10', starts_at: '2026-09-10T13:00:00+00:00',
  ends_at: '2026-09-10T21:00:00+00:00', status: 'scheduled', source: 'admin_open', shift_rule_id: null,
  store_id: 'store-1', role: 'fulfillment', ...over,
});

console.log('\nweek + instants');
eq('weekDatesFor is Mon→Sun', WEEK, ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13']);
eq('weekDatesFor from a Sunday rolls back to its Monday', P.weekDatesFor('2026-09-13')[0], '2026-09-07');
{
  const s = P.instantsFor('2026-09-10', '06:00', '14:00');
  eq('same-day 06:00–14:00 PDT → 13:00Z–21:00Z', [s.starts_at, s.ends_at], ['2026-09-10T13:00:00.000Z', '2026-09-10T21:00:00.000Z']);
  const o = P.instantsFor('2026-09-10', '16:00', '02:00');
  eq('OVERNIGHT 16:00–02:00 ends the NEXT LA day', [o.starts_at, o.ends_at], ['2026-09-10T23:00:00.000Z', '2026-09-11T09:00:00.000Z']);
  check('overnight span is 10h', (Date.parse(o.ends_at) - Date.parse(o.starts_at)) / 3.6e6 === 10);
  // US DST ends Sun 2026-11-01 at 02:00 PDT → 01:00 PST. The shift that CROSSES it starts the
  // evening before: Sat Oct 31 22:00 PDT → Sun Nov 1 06:00 PST is 9 real hours on an 8h wall clock.
  const dst = P.instantsFor('2026-10-31', '22:00', '06:00');
  check('DST fall-back overnight is 9 real hours (the repeated hour exists)', (Date.parse(dst.ends_at) - Date.parse(dst.starts_at)) / 3.6e6 === 9);
  const dstAfter = P.instantsFor('2026-11-01', '22:00', '06:00'); // entirely in PST
  check('the night AFTER the transition is a plain 8h', (Date.parse(dstAfter.ends_at) - Date.parse(dstAfter.starts_at)) / 3.6e6 === 8);
  const spring = P.instantsFor('2026-03-07', '22:00', '06:00'); // crosses 2026-03-08 02:00 PST → 03:00 PDT
  check('DST spring-forward overnight is 7 real hours (the skipped hour is gone)', (Date.parse(spring.ends_at) - Date.parse(spring.starts_at)) / 3.6e6 === 7);
}

console.log('\nparseScheduleEntries');
{
  eq('rejects non-array', P.parseScheduleEntries({}).error, 'entries must be an array');
  eq('rejects empty', P.parseScheduleEntries([]).error, 'entries is empty');
  check('rejects > MAX', 'error' in P.parseScheduleEntries(Array.from({ length: P.MAX_SCHEDULE_ENTRIES + 1 }, () => ({ employeeId: 'x', date: '2026-09-10', off: true }))));
  check('rejects bad date', 'error' in P.parseScheduleEntries([{ employeeId: 'x', date: '2026-02-30', startTime: '06:00', endTime: '14:00' }]));
  check('rejects bad time', 'error' in P.parseScheduleEntries([{ employeeId: 'x', date: '2026-09-10', startTime: '25:00', endTime: '14:00' }]));
  check('rejects missing employeeId', 'error' in P.parseScheduleEntries([{ date: '2026-09-10', off: true }]));
  const ok = P.parseScheduleEntries([{ employeeId: ' x ', date: '2026-09-10', off: true }, { employeeId: 'y', date: '2026-09-11', startTime: '06:00', endTime: '14:00' }]);
  eq('accepts + trims a mixed batch', ok.entries, [{ employeeId: 'x', date: '2026-09-10', off: true }, { employeeId: 'y', date: '2026-09-11', startTime: '06:00', endTime: '14:00' }]);
}

console.log('\nplan: create / update / unchanged');
{
  const plan = P.planScheduleBatch(base({ entries: [{ employeeId: EMP.id, date: '2026-09-10', startTime: '06:00', endTime: '14:00' }] }));
  eq('1 new day → created', plan.counts, { created: 1, updated: 0, removed: 0, unchanged: 0 });
  eq('no refusals', plan.refusals, []);
  const row = plan.upserts[0];
  eq('new row is a non-payable admin_open scheduled shift_instance', [row.source, row.status, row.shift_rule_id], ['admin_open', 'scheduled', null]);
  eq('new row carries owner, employee, store, role', [row.user_id, row.employee_id, row.store_id, row.role], [USER, EMP.id, 'store-1', 'fulfillment']);
  check('upsert rows have the exact uniform key set PostgREST needs',
    Object.keys(row).sort().join() === ['user_id', 'employee_id', 'shift_date', 'starts_at', 'ends_at', 'status', 'source', 'shift_rule_id', 'store_id', 'role'].sort().join());
}
{
  const plan = P.planScheduleBatch(base({
    existing: [existingRow()],
    entries: [{ employeeId: EMP.id, date: '2026-09-10', startTime: '06:00', endTime: '14:00' }],
  }));
  eq('same times as existing → unchanged, no write', [plan.counts.unchanged, plan.upserts.length], [1, 0]);
}
{
  const plan = P.planScheduleBatch(base({
    existing: [existingRow({ source: 'pattern', shift_rule_id: 'rule-9', role: null })],
    entries: [{ employeeId: EMP.id, date: '2026-09-10', startTime: '07:00', endTime: '15:00' }],
  }));
  eq('changed times → updated (one upsert, no second row)', [plan.counts.updated, plan.upserts.length], [1, 1]);
  eq('update PRESERVES source/rule/role — editing a time does not reclassify the shift',
    [plan.upserts[0].source, plan.upserts[0].shift_rule_id, plan.upserts[0].role], ['pattern', 'rule-9', null]);
  eq('update keeps the (employee, date) key so ON CONFLICT hits the same row', [plan.upserts[0].employee_id, plan.upserts[0].shift_date], [EMP.id, '2026-09-10']);
}
{
  const plan = P.planScheduleBatch(base({
    existing: [existingRow({ status: 'claimed', source: 'claim' })],
    entries: [{ employeeId: EMP.id, date: '2026-09-10', startTime: '07:00', endTime: '15:00' }],
  }));
  eq('editing a CLAIMED shift is REFUSED, not re-spanned', [plan.refusals.map((x) => x.code), plan.upserts.length], [['SHIFT_CLAIMED'], 0]);
}
{
  const plan = P.planScheduleBatch(base({
    existing: [existingRow({ status: 'cancelled' })],
    entries: [{ employeeId: EMP.id, date: '2026-09-10', startTime: '06:00', endTime: '14:00' }],
  }));
  eq('re-scheduling a cancelled day REVIVES the row as scheduled (updated, not created)', [plan.counts.updated, plan.upserts[0].status], [1, 'scheduled']);
  eq('a revived day is reported as an updated DATE for the repeat confirmation', plan.updatedDates, ['2026-09-10']);
}

console.log('\nplan: multiple days + crew');
{
  const entries = ['2026-09-09', '2026-09-10', '2026-09-11'].flatMap((date) => [
    { employeeId: EMP.id, date, startTime: '06:00', endTime: '14:00' },
    { employeeId: HOST.id, date, startTime: '16:00', endTime: '02:00' },
  ]);
  const plan = P.planScheduleBatch(base({ entries }));
  eq('3 days × 2 people → 6 created', plan.counts, { created: 6, updated: 0, removed: 0, unchanged: 0 });
  check('every upsert is for the right person/date pair', plan.upserts.every((r) => entries.some((e) => e.employeeId === r.employee_id && e.date === r.shift_date)));
  eq('host role passes the CHECK vocabulary', plan.upserts.find((r) => r.employee_id === HOST.id).role, 'host');
}
{
  const plan = P.planScheduleBatch(base({
    employees: [{ ...EMP, role: 'Manager' }],
    entries: [{ employeeId: EMP.id, date: '2026-09-10', startTime: '06:00', endTime: '14:00' }],
  }));
  eq('a role outside host/fulfillment is written as NULL (CHECK-safe), not rejected', plan.upserts[0].role, null);
}

console.log('\nplan: off → delete or cancel');
{
  const plan = P.planScheduleBatch(base({ existing: [existingRow()], entries: [{ employeeId: EMP.id, date: '2026-09-10', off: true }] }));
  eq('Off on an admin_open scheduled row → hard delete', [plan.deleteIds, plan.cancelIds, plan.counts.removed], [['inst-1'], [], 1]);
}
{
  const plan = P.planScheduleBatch(base({ existing: [existingRow({ source: 'pattern' })], entries: [{ employeeId: EMP.id, date: '2026-09-10', off: true }] }));
  eq('Off on a PATTERN row → cancel (slot stays occupied; materializer cannot regenerate)', [plan.deleteIds, plan.cancelIds], [[], ['inst-1']]);
}
{
  const plan = P.planScheduleBatch(base({ existing: [existingRow({ status: 'claimed', source: 'claim' })], entries: [{ employeeId: EMP.id, date: '2026-09-10', off: true }] }));
  eq('Off on a CLAIMED row → REFUSED; no delete, no cancel, no stale claim state', [plan.refusals.map((x) => x.code), plan.deleteIds, plan.cancelIds, plan.counts.removed], [['SHIFT_CLAIMED'], [], [], 0]);
}
{
  const plan = P.planScheduleBatch(base({ entries: [{ employeeId: EMP.id, date: '2026-09-10', off: true }] }));
  eq('Off with nothing planned → unchanged, no writes', [plan.counts.unchanged, plan.deleteIds.length, plan.cancelIds.length], [1, 0, 0]);
}
{
  const plan = P.planScheduleBatch(base({ existing: [existingRow({ status: 'cancelled' })], entries: [{ employeeId: EMP.id, date: '2026-09-10', off: true }] }));
  eq('Off on an already-cancelled row → unchanged', plan.counts.unchanged, 1);
}

console.log('\nplan: refusals (collected, never thrown)');
{
  const r = (over, entry) => P.planScheduleBatch(base({ ...over, entries: [entry] })).refusals.map((x) => x.code);
  eq('unknown employee', r({}, { employeeId: 'ghost', date: '2026-09-10', startTime: '06:00', endTime: '14:00' }), ['EMPLOYEE_NOT_FOUND']);
  eq('former employee cannot be scheduled', r({ employees: [{ ...EMP, status: 'former' }] }, { employeeId: EMP.id, date: '2026-09-10', startTime: '06:00', endTime: '14:00' }), ['EMPLOYEE_FORMER']);
  eq('working on a PAST date', r({}, { employeeId: EMP.id, date: '2026-09-08', startTime: '06:00', endTime: '14:00' }), ['PAST_DATE']);
  eq('start == end', r({}, { employeeId: EMP.id, date: '2026-09-10', startTime: '06:00', endTime: '06:00' }), ['BAD_TIMES']);
  eq('Off on a past date is a no-op, NOT a refusal', P.planScheduleBatch(base({ existing: [existingRow({ shift_date: '2026-09-08', starts_at: '2026-09-08T13:00:00Z', ends_at: '2026-09-08T21:00:00Z' })], entries: [{ employeeId: EMP.id, date: '2026-09-08', off: true }] })).counts.unchanged, 1);
  eq('Off on a shift that already STARTED today', r({ existing: [existingRow({ shift_date: TODAY, starts_at: '2026-09-09T13:00:00Z', ends_at: '2026-09-09T21:00:00Z' })] }, { employeeId: EMP.id, date: TODAY, off: true }), ['ALREADY_STARTED']);
  eq('Off when worked time exists that day', r({ existing: [existingRow()], workedKeys: new Set([`${EMP.id}|2026-09-10`]) }, { employeeId: EMP.id, date: '2026-09-10', off: true }), ['WORKED_TIME_EXISTS']);
  eq('Off while clocked in', r({ existing: [existingRow()], clockedInEmployees: new Set([EMP.id]) }, { employeeId: EMP.id, date: '2026-09-10', off: true }), ['EMPLOYEE_CLOCKED_IN']);
  eq('editing a WORKED (final) row', r({ existing: [existingRow({ status: 'worked' })] }, { employeeId: EMP.id, date: '2026-09-10', startTime: '07:00', endTime: '15:00' }), ['SHIFT_FINAL']);
  const dup = P.planScheduleBatch(base({ entries: [
    { employeeId: EMP.id, date: '2026-09-10', startTime: '06:00', endTime: '14:00' },
    { employeeId: EMP.id, date: '2026-09-10', startTime: '07:00', endTime: '15:00' },
  ] }));
  eq('same person+date twice → DUPLICATE_ENTRY, first one still planned', [dup.refusals.map((x) => x.code), dup.counts.created], [['DUPLICATE_ENTRY'], 1]);
  check('every refusal carries a manager-readable message', Object.values(P.SCHEDULE_REFUSAL_MESSAGES).every((m) => typeof m === 'string' && m.length > 10));
}

console.log('\nweek state ↔ instances');
{
  const rows = [
    existingRow({ id: 'a', shift_date: '2026-09-07', starts_at: '2026-09-07T13:00:00Z', ends_at: '2026-09-07T21:00:00Z' }),
    existingRow({ id: 'b', shift_date: '2026-09-09', starts_at: '2026-09-09T23:00:00Z', ends_at: '2026-09-10T09:00:00Z' }), // 16:00–02:00 overnight
    existingRow({ id: 'c', shift_date: '2026-09-11', status: 'cancelled' }),
    existingRow({ id: 'd', shift_date: '2026-09-12', employee_id: null, status: 'released' }),
  ];
  const st = P.weekStateFromInstances(rows, WEEK);
  eq('scheduled row → working with LA wall-clock times', st['2026-09-07'], { working: true, start: '06:00', end: '14:00' });
  eq('overnight row → 16:00 / 02:00 (end shown as next-day wall clock)', st['2026-09-09'], { working: true, start: '16:00', end: '02:00' });
  eq('cancelled row → Off', st['2026-09-11'].working, false);
  eq('released row (no employee) → Off', st['2026-09-12'].working, false);
  eq('untouched day → Off', st['2026-09-13'], { working: false, start: '', end: '' });
}

console.log('\ncopy previous week');
{
  const PREV = P.weekDatesFor('2026-08-31');
  const prevRows = [
    existingRow({ id: 'p1', shift_date: '2026-09-01', starts_at: '2026-09-01T13:00:00Z', ends_at: '2026-09-01T21:00:00Z' }), // Tue
    existingRow({ id: 'p2', shift_date: '2026-09-05', starts_at: '2026-09-05T23:00:00Z', ends_at: '2026-09-06T09:00:00Z' }), // Sat overnight
  ];
  const copied = P.copyWeekPattern(prevRows, PREV, WEEK);
  eq('Tue pattern lands on Tue of the target week', copied['2026-09-08'], { working: true, start: '06:00', end: '14:00' });
  eq('Sat overnight pattern lands on Sat', copied['2026-09-12'], { working: true, start: '16:00', end: '02:00' });
  eq('other days Off', [copied['2026-09-07'].working, copied['2026-09-13'].working], [false, false]);
  check('copy carries TIMES only — no ids leak into the state', !JSON.stringify(copied).includes('p1'));
  check('empty previous week is detectable', P.weekStateIsEmpty(P.copyWeekPattern([], PREV, WEEK)));
}

console.log('\nrepeat');
{
  const state = P.weekStateFromInstances([], WEEK);
  for (const d of ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11']) state[d] = { working: true, start: '06:00', end: '14:00' };
  eq('repeatWeekStarts(4) → four consecutive Mondays', P.repeatWeekStarts('2026-09-07', 4), ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
  eq('repeatCountUntil counts weeks inclusive', [P.repeatCountUntil('2026-09-07', '2026-09-27'), P.repeatCountUntil('2026-09-07', '2026-09-28'), P.repeatCountUntil('2026-09-07', '2026-09-01')], [3, 4, 1]);

  const one = P.expandRepeat(EMP.id, '2026-09-07', state, 1);
  eq('this week only: 7 entries — 5 working + 2 explicit off', [one.length, one.filter((e) => e.off).length], [7, 2]);

  const two = P.expandRepeat(EMP.id, '2026-09-07', state, 2);
  eq('2 weeks: week 1 full (7) + week 2 WORKING ONLY (5) = 12', two.length, 12);
  check('week 2 carries no off entries — never removes what the manager did not see', !two.some((e) => e.off && e.date >= '2026-09-14'));
  eq('week 2 dates are +7', two.filter((e) => e.date >= '2026-09-14').map((e) => e.date), ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18']);

  const four = P.expandRepeat(EMP.id, '2026-09-07', state, 4);
  eq('4 weeks: 7 + 5×3 = 22 entries', four.length, 22);

  const gated = P.expandRepeat(EMP.id, '2026-09-07', state, 1, TODAY);
  eq('with todayISO, PAST days (Mon, Tue) are omitted entirely', gated.map((e) => e.date), ['2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13']);
  const incomplete = P.expandRepeat(EMP.id, '2026-09-07', { ...state, '2026-09-10': { working: true, start: '06:00', end: '' } }, 1);
  check('incomplete working row (missing end) is skipped, not sent as off either', !incomplete.some((e) => e.date === '2026-09-10'));
}

console.log('\nrepeat + existing future conflict (end to end through the planner)');
{
  const state = P.weekStateFromInstances([], WEEK);
  state['2026-09-10'] = { working: true, start: '06:00', end: '14:00' };
  const entries = P.expandRepeat(EMP.id, '2026-09-07', state, 2, TODAY);
  // Week 2's Thursday already has a DIFFERENT shift.
  const clash = existingRow({ id: 'future', shift_date: '2026-09-17', starts_at: '2026-09-17T15:00:00Z', ends_at: '2026-09-17T23:00:00Z' });
  const plan = P.planScheduleBatch(base({ existing: [clash], entries }));
  eq('existing future shift is UPDATED in place (deterministic), reported as updated', [plan.counts.created, plan.counts.updated], [1, 1]);
  eq('the update targets the existing (employee, date) key, not a new row', plan.upserts.filter((r) => r.shift_date === '2026-09-17').length, 1);
  eq('no refusals', plan.refusals, []);
}

console.log('\nrange helpers');
eq('entryDateRange spans min..max', P.entryDateRange([{ employeeId: 'x', date: '2026-09-10', off: true }, { employeeId: 'x', date: '2026-09-03', off: true }, { employeeId: 'y', date: '2026-09-21', off: true }]), { from: '2026-09-03', to: '2026-09-21' });
eq('uniqueEmployeeIds dedupes', P.uniqueEmployeeIds([{ employeeId: 'x', date: '2026-09-10', off: true }, { employeeId: 'x', date: '2026-09-11', off: true }, { employeeId: 'y', date: '2026-09-10', off: true }]), ['x', 'y']);

console.log('\nHARDENING — claimed shifts are inviolable to the builder');
{
  const claimed = existingRow({ status: 'claimed', source: 'claim' });
  for (const [label, entry] of [
    ['set Off', { employeeId: EMP.id, date: '2026-09-10', off: true }],
    ['change the times', { employeeId: EMP.id, date: '2026-09-10', startTime: '05:00', endTime: '13:00' }],
    ['re-send the SAME times', { employeeId: EMP.id, date: '2026-09-10', startTime: '06:00', endTime: '14:00' }],
  ]) {
    const plan = P.planScheduleBatch(base({ existing: [claimed], entries: [entry] }));
    if (label === 're-send the SAME times') {
      // Identical times are a no-op BEFORE the claim check — nothing changes, so nothing to refuse.
      eq(`claimed + ${label} → unchanged, still no writes`, [plan.counts.unchanged, plan.upserts.length, plan.deleteIds.length, plan.cancelIds.length], [1, 0, 0, 0]);
    } else {
      eq(`claimed + ${label} → SHIFT_CLAIMED and zero writes`, [plan.refusals.map((x) => x.code), plan.upserts.length, plan.deleteIds.length, plan.cancelIds.length], [['SHIFT_CLAIMED'], 0, 0, 0]);
    }
  }
  eq('the refusal names the claim and tells the manager what to do', P.SCHEDULE_REFUSAL_MESSAGES.SHIFT_CLAIMED, 'This shift has already been claimed by someone. Resolve the claim before changing it.');
  check('UNEDITABLE_STATUS_REASON maps claimed → SHIFT_CLAIMED for the UI', P.UNEDITABLE_STATUS_REASON.claimed === 'SHIFT_CLAIMED');
  // An ordinary scheduled/admin_open day in the SAME batch still saves — a claim on one day does
  // not have to block the rest, and the route's all-or-nothing rule is what decides that.
  const mixed = P.planScheduleBatch(base({
    existing: [claimed, existingRow({ id: 'inst-9', shift_date: '2026-09-11', source: 'admin_open' })],
    entries: [{ employeeId: EMP.id, date: '2026-09-10', off: true }, { employeeId: EMP.id, date: '2026-09-11', off: true }],
  }));
  eq('mixed batch: the claimed day refuses, the admin_open day still plans its delete', [mixed.refusals.map((x) => x.code), mixed.deleteIds], [['SHIFT_CLAIMED'], ['inst-9']]);
}

console.log('\nHARDENING — claimedDatesFor drives the locked builder row');
{
  const rows = [
    existingRow({ id: 'c1', shift_date: '2026-09-10', status: 'claimed' }),
    existingRow({ id: 's1', shift_date: '2026-09-11', status: 'scheduled' }),
    existingRow({ id: 'x1', shift_date: '2026-09-12', status: 'cancelled' }),
    existingRow({ id: 'r1', shift_date: '2026-09-13', status: 'claimed', employee_id: null }),
    existingRow({ id: 'o1', shift_date: '2026-09-20', status: 'claimed' }), // outside the week
  ];
  eq('only in-week claimed rows WITH an assignee are locked', [...P.claimedDatesFor(rows, WEEK)], ['2026-09-10']);
  eq('a claimed row still reads as working in the week state (times shown, row locked by the UI)', P.weekStateFromInstances(rows, WEEK)['2026-09-10'], { working: true, start: '06:00', end: '14:00' });
}

console.log('\nHARDENING — affected dates for the repeat confirmation');
{
  const state = P.weekStateFromInstances([], WEEK);
  state['2026-09-10'] = { working: true, start: '06:00', end: '14:00' };
  state['2026-09-11'] = { working: false, start: '', end: '' };
  const entries = P.expandRepeat(EMP.id, '2026-09-07', state, 3, TODAY);
  const plan = P.planScheduleBatch(base({ existing: [
    existingRow({ id: 'f1', shift_date: '2026-09-17', starts_at: '2026-09-17T15:00:00Z', ends_at: '2026-09-17T23:00:00Z' }),
    existingRow({ id: 'f2', shift_date: '2026-09-24', starts_at: '2026-09-24T16:00:00Z', ends_at: '2026-09-25T00:00:00Z' }),
    existingRow({ id: 'f3', shift_date: '2026-09-11', source: 'admin_open' }),
  ], entries }));
  eq('updatedDates names every future day whose times get replaced', plan.updatedDates, ['2026-09-17', '2026-09-24']);
  eq('removedDates names the day being removed', plan.removedDates, ['2026-09-11']);
  eq('counts agree with the date lists', [plan.counts.updated, plan.counts.removed], [2, 1]);
  check('dates are sorted so the dialog reads chronologically', JSON.stringify(plan.updatedDates) === JSON.stringify([...plan.updatedDates].sort()));
}

console.log('\nPAYROLL INVARIANT');
{
  const src = readFileSync(fileURLToPath(new URL('./schedulePlan.ts', import.meta.url)), 'utf8');
  check("schedulePlan.ts never names the `shifts` table as a write target", !/from\('shifts'\)|into\s+shifts|shifts\.insert/.test(src));
  const plan = P.planScheduleBatch(base({ entries: [{ employeeId: EMP.id, date: '2026-09-10', startTime: '06:00', endTime: '14:00' }] }));
  check('a plan has only shift_instances-shaped outputs + reporting metadata', Object.keys(plan).sort().join() === ['cancelIds', 'counts', 'deleteIds', 'refusals', 'removedDates', 'updatedDates', 'upserts'].join());
  check('the only id-bearing outputs are shift_instances ids', ['upserts', 'deleteIds', 'cancelIds'].every((k) => Array.isArray(plan[k])));
}

console.log(`\n${passed} checks passed`);
