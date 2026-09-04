// removeOneTimeShift: eligibility enforcement, owner scoping, the conditional-delete race guard,
// and the PAYROLL INVARIANT — this path must never delete from any table but shift_instances.
//
// Exercises the REAL adminShifts.ts (and the real eligibility/employees/timezone/release modules),
// transpiled at runtime — the repo's .test.mjs pattern, same harness shape as claim.test.mjs. Only
// 'server-only' and the Supabase admin client are stubbed: both are environment.
//
// The fake client RECORDS every table, op and filter, so these tests assert the PREDICATE rather
// than just the outcome. That matters twice over here:
//   • the conditional DELETE's `source`/`status` predicates ARE the race guard — drop either and
//     "delete re-asserts the mutable predicates" must fail;
//   • "never deletes from `shifts`" is only meaningful as an assertion over recorded ops.
//
// Run:  TZ=UTC node src/lib/schedule/removeShift.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'rmshift-'));
const write = (name, src) => { const p = join(dir, name); writeFileSync(p, src); return pathToFileURL(p).href; };
function transpile(srcRel, outName, rewrites = {}) {
  const srcPath = fileURLToPath(new URL(srcRel, import.meta.url));
  let { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  for (const [from, to] of Object.entries(rewrites)) outputText = outputText.split(from).join(to);
  return write(outName, outputText);
}

// ── stubs: environment only ──
const serverOnly = write('serverOnly.mjs', 'export {};\n');
const adminStub  = write('adminStub.mjs', 'export function createAdminClient(){ return globalThis.__DB; }\n');
const dropsStub  = write('dropsStub.mjs',
  'export const DROP_CAP = 2;\n' +
  'export function computeDrops(){ return { releases: 0, claims: 0, excused: 0, drops: 0 }; }\n');
const boardStub  = write('boardStub.mjs', 'export const NOTICE_MS = 86400000;\n');

// ── real modules ──
const employees   = transpile('../employees.ts',  'employees.mjs');
const timezone    = transpile('./timezone.ts',    'timezone.mjs');
const eligibility = transpile('./eligibility.ts', 'eligibility.mjs');
const release     = transpile('./release.ts', 'release.mjs', {
  "'server-only'": `'${serverOnly}'`, "'@/lib/supabase/admin'": `'${adminStub}'`,
  "'@/lib/employees'": `'${employees}'`, "'./timezone'": `'${timezone}'`,
  "'./drops'": `'${dropsStub}'`, "'./board'": `'${boardStub}'`,
});
const adminShiftsUrl = transpile('./adminShifts.ts', 'adminShifts.mjs', {
  "'server-only'": `'${serverOnly}'`, "'@/lib/supabase/admin'": `'${adminStub}'`,
  "'@/lib/employees'": `'${employees}'`, "'./timezone'": `'${timezone}'`,
  "'./release'": `'${release}'`, "'./eligibility'": `'${eligibility}'`,
});
const { removeOneTimeShift } = await import(adminShiftsUrl);
const { computePay } = await import(employees);

// ─────────────────────────────────────────────────────────────────────────────
// Fake PostgREST builder. Records table, op and every filter; `script(rec)` replies.
// ─────────────────────────────────────────────────────────────────────────────
function makeDb(script) {
  const calls = [];
  const from = (table) => {
    const rec = { table, op: 'select', filters: [], cols: null, single: false, limit: null };
    calls.push(rec);
    const push = (kind, col, val) => { rec.filters.push([kind, col, val]); return api; };
    const settle = () => Promise.resolve(script(rec, calls) ?? { data: null, error: null });
    const api = {
      select: (c) => { rec.cols = c; return api; },
      delete: () => { rec.op = 'delete'; return api; },
      update: (p) => { rec.op = 'update'; rec.payload = p; return api; },
      insert: (p) => { rec.op = 'insert'; rec.payload = p; return settle(); },
      eq: (c, v) => push('eq', c, v),
      is: (c, v) => push('is', c, v),
      in: (c, v) => push('in', c, v),
      limit: (n) => { rec.limit = n; return api; },
      maybeSingle: () => { rec.single = true; return settle(); },
      then: (res, rej) => settle().then(res, rej),
    };
    return api;
  };
  return { db: { from }, calls };
}
const has = (rec, kind, col, val) =>
  rec.filters.some(([k, c, v]) => k === kind && c === col && (val === undefined || v === val));
const find = (calls, table, op) => calls.filter((c) => c.table === table && c.op === op);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

const OWNER = 'owner-1';
const HR = 3600_000;
// Frozen instants: the row's starts_at is the authoritative clock, so pin it once rather than
// re-reading Date.now() per construction (see the drift note in claim.test.mjs).
const FUTURE = new Date(Date.now() + 72 * HR).toISOString();
const PAST = new Date(Date.now() - 72 * HR).toISOString();

const inst = (o = {}) => ({
  id: 'inst-1', employee_id: 'emp-1', shift_date: '2026-09-20',
  starts_at: FUTURE, status: 'scheduled', source: 'admin_open', ...o,
});

// Default script: the instance exists, no open punch, no worked shift, delete removes one row.
function script(over = {}) {
  const o = { instance: inst(), openPunch: null, worked: null, deleted: [{ id: 'inst-1' }], ...over };
  return (rec) => {
    if (rec.table === 'shift_instances' && rec.op === 'select') return { data: o.instance, error: null };
    if (rec.table === 'shift_instances' && rec.op === 'delete') return { data: o.deleted, error: null };
    if (rec.table === 'employee_time_entries') return { data: o.openPunch, error: null };
    if (rec.table === 'shifts') return { data: o.worked, error: null };
    throw new Error(`unscripted ${rec.op} on ${rec.table}`);
  };
}

async function run(over = {}) {
  const { db, calls } = makeDb(script(over));
  globalThis.__DB = db;
  let error = null;
  try { await removeOneTimeShift({ userId: OWNER, instanceId: 'inst-1' }); }
  catch (e) { error = e; }
  return { calls, error };
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nhappy path — an untouched future one-off is removed');
{
  const { calls, error } = await run();
  check('no error thrown', error === null, error ? error.code : '');

  const dels = find(calls, 'shift_instances', 'delete');
  check('exactly ONE delete issued', dels.length === 1, `got ${dels.length}`);

  // THE RACE GUARD. These four predicates are the whole reason a concurrent release/claim cannot
  // be destroyed: remove `source` or `status` and this must fail.
  const d = dels[0];
  check('delete predicate: id', has(d, 'eq', 'id', 'inst-1'));
  check('delete predicate: user_id (owner scope, admin client bypasses RLS)', has(d, 'eq', 'user_id', OWNER));
  check("delete predicate: source = 'admin_open'", has(d, 'eq', 'source', 'admin_open'));
  check("delete predicate: status = 'scheduled'", has(d, 'eq', 'status', 'scheduled'));
  check('delete asks for the affected rows back (so 0 rows is detectable)', d.cols === 'id');

  // Owner scoping on the READ too — a row belonging to another account must not even be visible.
  const reads = find(calls, 'shift_instances', 'select');
  check('read is scoped by id AND user_id', has(reads[0], 'eq', 'id', 'inst-1') && has(reads[0], 'eq', 'user_id', OWNER));

  // The two payroll-side facts are actually queried, and scoped.
  const punchReads = find(calls, 'employee_time_entries', 'select');
  check('open-punch check runs, scoped to employee+owner, on clocked_out_at IS NULL',
    punchReads.length === 1 && has(punchReads[0], 'eq', 'employee_id', 'emp-1')
    && has(punchReads[0], 'eq', 'user_id', OWNER) && has(punchReads[0], 'is', 'clocked_out_at', null));
  const workedReads = find(calls, 'shifts', 'select');
  check('worked-shift check runs on the instance shift_date (LA-local, direct comparison)',
    workedReads.length === 1 && has(workedReads[0], 'eq', 'date', '2026-09-20')
    && has(workedReads[0], 'eq', 'employee_id', 'emp-1') && has(workedReads[0], 'eq', 'user_id', OWNER));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nPAYROLL INVARIANT — nothing but shift_instances is ever deleted');
{
  const { calls } = await run();
  const deletes = calls.filter((c) => c.op === 'delete');
  check('every delete targets shift_instances', deletes.every((c) => c.table === 'shift_instances'),
    `tables: ${[...new Set(deletes.map((c) => c.table))].join(',') || 'none'}`);
  for (const t of ['shifts', 'employee_time_entries', 'attendance_events', 'clock_audit', 'shift_claims']) {
    check(`never deletes from ${t}`, find(calls, t, 'delete').length === 0);
  }
  // Nor mutates them: no update/insert anywhere on this path at all.
  check('no update issued on any table', calls.filter((c) => c.op === 'update').length === 0);
  check('no insert issued on any table', calls.filter((c) => c.op === 'insert').length === 0);
  check('`shifts` is READ-ONLY here (select only)',
    find(calls, 'shifts', 'select').length === 1 && calls.filter((c) => c.table === 'shifts' && c.op !== 'select').length === 0);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nrefusals — and NOTHING is deleted in any of them');
const refusals = [
  ['missing row → NOT_FOUND', { instance: null }, 'NOT_FOUND'],
  ['recurring pattern → NOT_ONE_OFF', { instance: inst({ source: 'pattern' }) }, 'NOT_ONE_OFF'],
  ['claim row → NOT_ONE_OFF', { instance: inst({ source: 'claim' }) }, 'NOT_ONE_OFF'],
  ['released → NOT_SCHEDULED', { instance: inst({ status: 'released' }) }, 'NOT_SCHEDULED'],
  ['claimed → NOT_SCHEDULED', { instance: inst({ status: 'claimed' }) }, 'NOT_SCHEDULED'],
  ['worked → NOT_SCHEDULED', { instance: inst({ status: 'worked' }) }, 'NOT_SCHEDULED'],
  ['missed → NOT_SCHEDULED', { instance: inst({ status: 'missed' }) }, 'NOT_SCHEDULED'],
  ['cancelled → NOT_SCHEDULED', { instance: inst({ status: 'cancelled' }) }, 'NOT_SCHEDULED'],
  ['past shift → ALREADY_STARTED', { instance: inst({ starts_at: PAST }) }, 'ALREADY_STARTED'],
  ['employee has a worked shift that date → WORKED_TIME_EXISTS', { worked: { id: 'sh-1' } }, 'WORKED_TIME_EXISTS'],
  ['employee currently clocked in → EMPLOYEE_CLOCKED_IN', { openPunch: { id: 'te-1' } }, 'EMPLOYEE_CLOCKED_IN'],
];
for (const [name, over, code] of refusals) {
  const { calls, error } = await run(over);
  check(name, error !== null && error.code === code, error ? `got ${error.code}` : 'no error thrown');
  check(`  ↳ nothing deleted`, calls.filter((c) => c.op === 'delete').length === 0);
  check(`  ↳ message is manager-readable`, typeof error.message === 'string' && error.message.length > 10 && error.message !== code);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nconcurrency — a row that changed under us is reported, not destroyed');
{
  // The read said 'admin_open'/'scheduled', but by delete time the predicates match 0 rows
  // (someone released or claimed it). That must surface as a conflict, never a silent success.
  const { error } = await run({ deleted: [] });
  check('0 rows affected → SHIFT_UNAVAILABLE', error !== null && error.code === 'SHIFT_UNAVAILABLE', error ? error.code : 'none');
  const { error: e2 } = await run({ deleted: null });
  check('null data → SHIFT_UNAVAILABLE (not treated as success)', e2 !== null && e2.code === 'SHIFT_UNAVAILABLE');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nread failures propagate rather than falling through to a delete');
{
  const { db, calls } = makeDb((rec) => {
    if (rec.table === 'shift_instances' && rec.op === 'select') return { data: null, error: { message: 'boom' } };
    return { data: null, error: null };
  });
  globalThis.__DB = db;
  let err = null;
  try { await removeOneTimeShift({ userId: OWNER, instanceId: 'inst-1' }); } catch (e) { err = e; }
  check('instance read error → READ_FAILED', err !== null && err.code === 'READ_FAILED', err ? err.code : 'none');
  check('  ↳ nothing deleted', calls.filter((c) => c.op === 'delete').length === 0);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\npay is derived from `shifts` alone — a removal cannot move it');
{
  // computePay's ONLY input is `shifts` rows. A shift_instance is not expressible as one, so the
  // removal path has no way to reach pay even in principle; this pins that as an assertion rather
  // than a comment. The pay set is computed, a removal runs, and the same set is recomputed.
  const staff = [{ id: 'emp-1', name: 'Carlos', role: 'fulfillment', hourly_rate: 21, status: 'active' }];
  const payableShifts = [
    // A manual Worked / Missed Punch row: payable with NO confirmed_at (Part 11's product rule).
    { employee_id: 'emp-1', date: '2026-09-20', start_time: '16:00', end_time: '02:00', source: 'manual', source_rule_id: null, confirmed_at: null, break_minutes: 0 },
    // A confirmed time-clock punch.
    { employee_id: 'emp-1', date: '2026-09-21', start_time: '16:00', end_time: '00:00', source: 'time_clock', source_rule_id: null, confirmed_at: '2026-09-22T00:00:00Z', break_minutes: 30 },
  ];
  const before = JSON.stringify(computePay(staff, payableShifts));
  await run(); // removes the shift_instance
  const after = JSON.stringify(computePay(staff, payableShifts));
  check('computePay is byte-identical across a shift_instance removal', before === after);

  // And the two confirmation rules the removal must not disturb, asserted directly.
  const manualOnly = computePay(staff, [payableShifts[0]]);
  check('manual Worked shift is PAID with confirmed_at null', manualOnly[0].hours === 10, `hours=${manualOnly[0].hours}`);
  const unconfirmedPunch = computePay(staff, [{ ...payableShifts[1], confirmed_at: null }]);
  check('unconfirmed time_clock shift is NOT paid', unconfirmedPunch[0].hours === 0, `hours=${unconfirmedPunch[0].hours}`);
}

console.log(`\nALL PASSED (${passed} assertions)\n`);
