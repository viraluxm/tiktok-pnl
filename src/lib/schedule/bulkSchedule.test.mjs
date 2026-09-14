// applyScheduleBatch: the ONE bulk write path for planned shifts — owner scoping on every query,
// the exact upsert/delete/cancel shapes, write ORDER, dry-run, refusal → nothing written, and the
// PAYROLL INVARIANT: this path can never write to `shifts` (or any table but shift_instances).
//
// Exercises the REAL bulkSchedule.ts + schedulePlan.ts (+ timezone / weeklySchedule / eligibility),
// transpiled at runtime — the repo's .test.mjs pattern. Only 'server-only' and the Supabase admin
// client are stubbed. The fake client RECORDS every table, op, filter and payload so these tests
// assert the PREDICATES, not just the outcome.
//
// Run:  TZ=UTC node src/lib/schedule/bulkSchedule.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'bulksched-'));
const write = (name, src) => { const p = join(dir, name); writeFileSync(p, src); return pathToFileURL(p).href; };
function transpile(srcRel, outName, rewrites = {}) {
  const srcPath = fileURLToPath(new URL(srcRel, import.meta.url));
  let { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  for (const [from, to] of Object.entries(rewrites)) outputText = outputText.split(from).join(to);
  return write(outName, outputText);
}

const serverOnly = write('serverOnly.mjs', 'export {};\n');
const adminStub = write('adminStub.mjs', 'export function createAdminClient(){ return globalThis.__DB; }\n');
const timezone = transpile('./timezone.ts', 'timezone.mjs');
const weekly = transpile('../weeklySchedule.ts', 'weeklySchedule.mjs');
const eligibility = transpile('./eligibility.ts', 'eligibility.mjs');
const plan = transpile('./schedulePlan.ts', 'schedulePlan.mjs', {
  "'./timezone'": `'${timezone}'`, "'@/lib/weeklySchedule'": `'${weekly}'`, "'./eligibility'": `'${eligibility}'`,
});
const __employees = transpile('../employees.ts', '__emp.mjs');

// 157 — the capacity write guard. `capacityGuard` is transpiled so the module under test can import
// it; `__RPC` below decides what the guard's RPC replies. It defaults to "function does not exist",
// which is the state until migrations 156/157 are hand-applied, so every assertion in this file
// keeps exercising the SAME pre-157 statement sequence it always did. The guarded path gets its own
// tests in capacityWriteGuard.test.mjs.
const capacity = transpile('./capacity.ts', '__cap.mjs', {
  "'@/lib/employees'": `'${__employees}'`, "'./timezone'": `'${timezone}'`, "'./eligibility'": `'${eligibility}'`,
});
const capacityGuard = transpile('./capacityGuard.ts', '__capGuard.mjs', {
  "'server-only'": `'${serverOnly}'`, "'./capacity'": `'${capacity}'`,
});
globalThis.__RPC = async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });

const bulkUrl = transpile('./bulkSchedule.ts', 'bulkSchedule.mjs', {
  "'./capacityGuard'": `'${capacityGuard}'`,
  "'server-only'": `'${serverOnly}'`, "'@/lib/supabase/admin'": `'${adminStub}'`,
  "'./timezone'": `'${timezone}'`, "'./schedulePlan'": `'${plan}'`,
});
const { applyScheduleBatch, ScheduleBatchError } = await import(bulkUrl);

// ─────────────────────────────────────────────────────────────────────────────
// Fake PostgREST builder. Thenable; records table, op, filters and payload; `script(rec)` replies.
// ─────────────────────────────────────────────────────────────────────────────
class Rec {
  constructor(table) { this.table = table; this.op = 'select'; this.filters = []; this.payload = null; this.opts = null; }
  select(cols) { this.cols = cols; return this; }
  eq(k, v) { this.filters.push(['eq', k, v]); return this; }
  in(k, v) { this.filters.push(['in', k, v]); return this; }
  gte(k, v) { this.filters.push(['gte', k, v]); return this; }
  lte(k, v) { this.filters.push(['lte', k, v]); return this; }
  is(k, v) { this.filters.push(['is', k, v]); return this; }
  order() { return this; }
  insert(rows) { this.op = 'insert'; this.payload = rows; return this; }
  upsert(rows, opts) { this.op = 'upsert'; this.payload = rows; this.opts = opts; return this; }
  update(patch) { this.op = 'update'; this.payload = patch; return this; }
  delete() { this.op = 'delete'; return this; }
  then(resolve, reject) {
    globalThis.__LOG.push(this);
    try { resolve(globalThis.__SCRIPT(this)); } catch (e) { reject(e); }
  }
  f(kind, key) { return this.filters.find(([k, kk]) => k === kind && kk === key)?.[2]; }
}
globalThis.__DB = { from: (t) => new Rec(t), rpc: (...a) => globalThis.__RPC(...a) };
const reset = (script) => { globalThis.__LOG = []; globalThis.__SCRIPT = script; };
const log = () => globalThis.__LOG;
const writes = () => log().filter((r) => r.op !== 'select');

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} == ${JSON.stringify(b)}`);

const USER = 'owner-1';
const EMP = { id: 'emp-a', role: 'fulfillment', status: 'active', store_id: 'store-1' };
const EMP2 = { id: 'emp-b', role: 'host', status: 'active', store_id: null };
const EMP3 = { id: 'emp-c', role: 'fulfillment', status: 'active', store_id: null };
const NOW = new Date('2026-09-09T18:00:00Z'); // Wed 11:00 LA
const existing = (over = {}) => ({
  id: 'inst-1', employee_id: EMP.id, shift_date: '2026-09-10', starts_at: '2026-09-10T13:00:00+00:00',
  ends_at: '2026-09-10T21:00:00+00:00', status: 'scheduled', source: 'admin_open', shift_rule_id: null,
  store_id: 'store-1', role: 'fulfillment', ...over,
});

// Default script: employees exist, given instances, no worked time, nobody clocked in, writes ok.
const scriptWith = ({ employees = [EMP, EMP2, EMP3], instances = [], worked = [], open = [], fail = null } = {}) => (rec) => {
  if (fail && rec.op === fail) return { data: null, error: { message: `boom ${fail}` } };
  if (rec.table === 'employees') return { data: employees.filter((e) => rec.f('in', 'id')?.includes(e.id)), error: null };
  if (rec.table === 'shift_instances' && rec.op === 'select') return { data: instances, error: null };
  if (rec.table === 'shifts') return { data: worked, error: null };
  if (rec.table === 'employee_time_entries') return { data: open, error: null };
  return { data: null, error: null };
};

console.log('\n1. happy path: create + update + off(delete) + off(cancel) in one batch');
{
  reset(scriptWith({ instances: [
    existing(), // Thu 10th admin_open scheduled → will be UPDATED (new times)
    existing({ id: 'inst-2', shift_date: '2026-09-11', source: 'admin_open' }), // Fri → OFF → delete
    existing({ id: 'inst-3', shift_date: '2026-09-12', source: 'pattern', shift_rule_id: 'r1', role: null, starts_at: '2026-09-12T13:00:00+00:00', ends_at: '2026-09-12T21:00:00+00:00' }), // Sat → OFF → cancel
  ] }));
  const res = await applyScheduleBatch({ userId: USER, now: NOW, entries: [
    { employeeId: EMP.id, date: '2026-09-09', startTime: '06:00', endTime: '14:00' }, // today → create
    { employeeId: EMP.id, date: '2026-09-10', startTime: '07:00', endTime: '15:00' }, // update
    { employeeId: EMP.id, date: '2026-09-11', off: true }, // delete
    { employeeId: EMP.id, date: '2026-09-12', off: true }, // cancel
    { employeeId: EMP.id, date: '2026-09-13', off: true }, // nothing there → unchanged
  ] });
  eq('result counts', [res.ok, res.dryRun, res.counts], [true, false, { created: 1, updated: 1, removed: 2, unchanged: 1 }]);
  eq('affected dates are reported for the repeat confirmation', [res.updatedDates, res.removedDates], [['2026-09-10'], ['2026-09-11', '2026-09-12']]);

  const ops = writes().map((r) => `${r.table}:${r.op}`);
  eq('WRITE ORDER: upsert → delete → cancel(update), all on shift_instances', ops, ['shift_instances:upsert', 'shift_instances:delete', 'shift_instances:update']);

  const up = writes()[0];
  eq('upsert conflict target is the (employee_id, shift_date) unique key', up.opts, { onConflict: 'employee_id,shift_date' });
  eq('upsert carries exactly the 2 rows that changed (created + updated)', up.payload.map((r) => r.shift_date), ['2026-09-09', '2026-09-10']);
  check('every upsert row is owner-stamped', up.payload.every((r) => r.user_id === USER));
  eq('created row is admin_open/scheduled with role+store from the employee', [up.payload[0].source, up.payload[0].status, up.payload[0].role, up.payload[0].store_id], ['admin_open', 'scheduled', 'fulfillment', 'store-1']);
  eq('updated row keeps its own source and the new instants', [up.payload[1].source, up.payload[1].starts_at], ['admin_open', '2026-09-10T14:00:00.000Z']);

  const del = writes()[1];
  eq('delete re-asserts owner + source + status as predicates (race guard) and targets ids', [del.f('eq', 'user_id'), del.f('eq', 'source'), del.f('eq', 'status'), del.f('in', 'id')], [USER, 'admin_open', 'scheduled', ['inst-2']]);

  const can = writes()[2];
  eq('cancel sets ONLY status=cancelled', can.payload, { status: 'cancelled' });
  eq('cancel is owner-scoped, guarded on status=scheduled, targets ids', [can.f('eq', 'user_id'), can.f('eq', 'status'), can.f('in', 'id')], [USER, 'scheduled', ['inst-3']]);
  check('the cancel predicate cannot touch a CLAIMED row even if one slipped into cancelIds', can.f('eq', 'status') === 'scheduled');
}

console.log('\n2. PAYROLL INVARIANT — `shifts` and punches are read for guards, never written');
{
  reset(scriptWith({ instances: [existing()] }));
  await applyScheduleBatch({ userId: USER, now: NOW, entries: [
    { employeeId: EMP.id, date: '2026-09-10', off: true },
    { employeeId: EMP.id, date: '2026-09-11', startTime: '06:00', endTime: '14:00' },
  ] });
  const tables = new Set(writes().map((r) => r.table));
  eq('the only table ever written is shift_instances', [...tables], ['shift_instances']);
  check('`shifts` was only SELECTed', log().filter((r) => r.table === 'shifts').every((r) => r.op === 'select'));
  check('`employee_time_entries` was only SELECTed', log().filter((r) => r.table === 'employee_time_entries').every((r) => r.op === 'select'));
  check('no insert op anywhere (upsert is the only create path, and only on shift_instances)', !log().some((r) => r.op === 'insert'));
}

console.log('\n3. owner scoping on EVERY read');
{
  reset(scriptWith());
  await applyScheduleBatch({ userId: USER, now: NOW, entries: [{ employeeId: EMP.id, date: '2026-09-10', startTime: '06:00', endTime: '14:00' }] });
  const reads = log().filter((r) => r.op === 'select');
  eq('four guard reads: employees, shift_instances, shifts, employee_time_entries', reads.map((r) => r.table).sort(), ['employee_time_entries', 'employees', 'shift_instances', 'shifts']);
  check('every read filters eq user_id = owner', reads.every((r) => r.f('eq', 'user_id') === USER));
  check('every read is narrowed to the batch employees', reads.every((r) => JSON.stringify(r.f('in', 'employee_id') ?? r.f('in', 'id')) === JSON.stringify([EMP.id])));
  const inst = reads.find((r) => r.table === 'shift_instances');
  eq('instance read is bounded to the entry date range', [inst.f('gte', 'shift_date'), inst.f('lte', 'shift_date')], ['2026-09-10', '2026-09-10']);
  const open = reads.find((r) => r.table === 'employee_time_entries');
  eq('open-punch read is clocked_out_at IS NULL', open.f('is', 'clocked_out_at'), null);
}

console.log('\n4. dry run writes NOTHING and still reports the plan');
{
  reset(scriptWith({ instances: [existing()] }));
  const res = await applyScheduleBatch({ userId: USER, now: NOW, dryRun: true, entries: [
    { employeeId: EMP.id, date: '2026-09-10', off: true },
    { employeeId: EMP.id, date: '2026-09-11', startTime: '06:00', endTime: '14:00' },
  ] });
  eq('dryRun counts', [res.ok, res.dryRun, res.counts], [true, true, { created: 1, updated: 0, removed: 1, unchanged: 0 }]);
  eq('dryRun still reports the affected dates', res.removedDates, ['2026-09-10']);
  eq('zero write ops', writes().length, 0);
}

console.log('\n5. any refusal → ok:false with every refusal, and NOTHING written');
{
  reset(scriptWith({ instances: [existing()], worked: [{ employee_id: EMP.id, date: '2026-09-10' }] }));
  const res = await applyScheduleBatch({ userId: USER, now: NOW, entries: [
    { employeeId: EMP.id, date: '2026-09-10', off: true }, // refused: worked time exists
    { employeeId: EMP.id, date: '2026-09-11', startTime: '06:00', endTime: '14:00' }, // fine on its own
    { employeeId: EMP.id, date: '2026-09-08', startTime: '06:00', endTime: '14:00' }, // refused: past
  ] });
  eq('refused, both reasons reported', [res.ok, res.refusals.map((r) => r.code).sort()], [false, ['PAST_DATE', 'WORKED_TIME_EXISTS']]);
  check('refusals name the day', res.refusals.every((r) => r.employeeId === EMP.id && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.message.length > 0));
  eq('the valid day was NOT written either (all-or-nothing)', writes().length, 0);
}

console.log('\n6. crew: three people, one date → ONE upsert statement, no per-person loop');
{
  reset(scriptWith());
  const res = await applyScheduleBatch({ userId: USER, now: NOW, entries: [EMP, EMP2, EMP3].map((e) => ({ employeeId: e.id, date: '2026-09-10', startTime: '16:00', endTime: '02:00' })) });
  eq('3 created', res.counts.created, 3);
  eq('exactly one write op', writes().length, 1);
  eq('with 3 rows', writes()[0].payload.length, 3);
  check('overnight instants: every row ends the next UTC day', writes()[0].payload.every((r) => r.starts_at === '2026-09-10T23:00:00.000Z' && r.ends_at === '2026-09-11T09:00:00.000Z'));
  eq('roles per person', writes()[0].payload.map((r) => r.role), ['fulfillment', 'host', 'fulfillment']);
}

console.log('\n7. unknown employee in a crew batch → refused as a whole (no cross-owner leakage possible)');
{
  reset(scriptWith({ employees: [EMP] })); // EMP2 "belongs to someone else" → the owner-scoped read does not return it
  const res = await applyScheduleBatch({ userId: USER, now: NOW, entries: [
    { employeeId: EMP.id, date: '2026-09-10', startTime: '06:00', endTime: '14:00' },
    { employeeId: EMP2.id, date: '2026-09-10', startTime: '06:00', endTime: '14:00' },
  ] });
  eq('EMPLOYEE_NOT_FOUND for the foreign id', [res.ok, res.refusals.map((r) => r.code)], [false, ['EMPLOYEE_NOT_FOUND']]);
  eq('nothing written', writes().length, 0);
}

console.log('\n8. write failure surfaces as ScheduleBatchError(WRITE_FAILED); read failure as READ_FAILED');
{
  reset(scriptWith({ fail: 'upsert' }));
  await assert.rejects(
    applyScheduleBatch({ userId: USER, now: NOW, entries: [{ employeeId: EMP.id, date: '2026-09-10', startTime: '06:00', endTime: '14:00' }] }),
    (e) => e instanceof ScheduleBatchError && e.code === 'WRITE_FAILED',
  );
  check('upsert error → WRITE_FAILED', true);
  reset((rec) => rec.table === 'employees' ? { data: null, error: { message: 'db down' } } : { data: [], error: null });
  await assert.rejects(
    applyScheduleBatch({ userId: USER, now: NOW, entries: [{ employeeId: EMP.id, date: '2026-09-10', startTime: '06:00', endTime: '14:00' }] }),
    (e) => e instanceof ScheduleBatchError && e.code === 'READ_FAILED',
  );
  check('read error → READ_FAILED, before any write', writes().length === 0);
}

console.log('\n9. editing an existing day never produces a second row for that (employee, date)');
{
  reset(scriptWith({ instances: [existing()] }));
  await applyScheduleBatch({ userId: USER, now: NOW, entries: [{ employeeId: EMP.id, date: '2026-09-10', startTime: '08:00', endTime: '16:00' }] });
  const up = writes()[0];
  eq('one upsert row, keyed to the existing (employee, date)', [up.payload.length, up.payload[0].employee_id, up.payload[0].shift_date], [1, EMP.id, '2026-09-10']);
  check('no delete/insert accompanies an edit', writes().length === 1 && up.op === 'upsert');
}

console.log('\n10. HARDENING — a claimed shift is refused end to end, and nothing is written');
{
  const claimedRow = existing({ id: 'cl-1', status: 'claimed', source: 'claim' });
  for (const [label, entry] of [
    ['Off', { employeeId: EMP.id, date: '2026-09-10', off: true }],
    ['time edit', { employeeId: EMP.id, date: '2026-09-10', startTime: '05:00', endTime: '13:00' }],
  ]) {
    reset(scriptWith({ instances: [claimedRow] }));
    const res = await applyScheduleBatch({ userId: USER, now: NOW, entries: [entry] });
    eq(`claimed + ${label} → ok:false SHIFT_CLAIMED`, [res.ok, res.refusals.map((r) => r.code)], [false, ['SHIFT_CLAIMED']]);
    eq(`claimed + ${label} → ZERO writes (no cancel, no delete, no upsert)`, writes().length, 0);
  }
  // The whole batch is refused, so a valid sibling day is not written either — the manager fixes
  // the claimed day and saves again. This is the all-or-nothing contract, not an accident.
  reset(scriptWith({ instances: [claimedRow] }));
  const mixed = await applyScheduleBatch({ userId: USER, now: NOW, entries: [
    { employeeId: EMP.id, date: '2026-09-10', off: true },
    { employeeId: EMP.id, date: '2026-09-11', startTime: '06:00', endTime: '14:00' },
  ] });
  eq('a claimed day refuses the whole batch', [mixed.ok, writes().length], [false, 0]);
}

console.log('\n11. HARDENING — the ATOMICITY property survives the changes');
{
  // Property: a mid-operation failure may leave a requested-OFF day still scheduled, but must never
  // silently remove a requested-WORKING day and must never create payroll time. Writes run
  // upsert → delete → cancel, so a failure at step 2 or 3 has already persisted every working day.
  reset(scriptWith({ instances: [existing({ id: 'del-me', source: 'admin_open' })], fail: 'delete' }));
  await assert.rejects(applyScheduleBatch({ userId: USER, now: NOW, entries: [
    { employeeId: EMP.id, date: '2026-09-10', off: true },
    { employeeId: EMP.id, date: '2026-09-11', startTime: '06:00', endTime: '14:00' },
  ] }), (e) => e instanceof ScheduleBatchError && e.code === 'WRITE_FAILED');
  const ops = writes().map((r) => `${r.table}:${r.op}`);
  eq('the working day was upserted BEFORE the failing delete', ops[0], 'shift_instances:upsert');
  check('the requested-working day is present in that upsert', writes()[0].payload.some((r) => r.shift_date === '2026-09-11'));
  check('no payroll table was touched even on the failure path', !writes().some((r) => r.table !== 'shift_instances'));
  // And the inverse: an upsert failure at step 1 means NOTHING was removed.
  reset(scriptWith({ instances: [existing({ id: 'del-me', source: 'admin_open' })], fail: 'upsert' }));
  await assert.rejects(applyScheduleBatch({ userId: USER, now: NOW, entries: [
    { employeeId: EMP.id, date: '2026-09-10', off: true },
    { employeeId: EMP.id, date: '2026-09-11', startTime: '06:00', endTime: '14:00' },
  ] }), (e) => e instanceof ScheduleBatchError);
  check('an upsert failure aborts before any delete/cancel — nothing removed', !writes().some((r) => r.op === 'delete' || r.op === 'update'));
}

console.log('\n12. THE CAPACITY WRITE GUARD (157) — the seam, not the arithmetic');
{
  // The arithmetic and the races are proven against a real Postgres in
  // supabase/tests/schedule_capacity/. What is asserted HERE is the seam: what the app hands the
  // function, what it does with the reply, and that the fallback is reached ONLY when the function
  // is genuinely absent.
  const MISSING = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
  const rpcCalls = [];
  const withRpc = (reply) => { rpcCalls.length = 0; globalThis.__RPC = async (fn, args) => { rpcCalls.push({ fn, args }); return reply; }; };
  const restoreMissing = () => { globalThis.__RPC = async (fn, args) => { rpcCalls.push({ fn, args }); return MISSING; }; };

  // ── The guarded path: the app issues NO shift_instances statements of its own.
  withRpc({ data: { ok: true, created: 1, updated: 0, removed: 0, refusals: [] }, error: null });
  reset(scriptWith({}));
  let res = await applyScheduleBatch({ userId: USER, now: NOW, entries: [
    { employeeId: EMP.id, date: '2026-09-11', startTime: '06:00', endTime: '14:00' },
  ] });
  eq('the batch is written by the locked function', rpcCalls[0].fn, 'lensed_apply_schedule_batch');
  check('and the app writes NO shift_instances statement itself', !writes().some((r) => r.table === 'shift_instances'));
  eq('the owner is the session uid, never a client value', rpcCalls[0].args.p_owner, USER);
  eq("the planner's upserts are handed over verbatim", rpcCalls[0].args.p_upserts.length, 1);
  eq('…with the row the planner built', rpcCalls[0].args.p_upserts[0].shift_date, '2026-09-11');
  // CAPACITY IS EXPLICIT: nothing is handed to SQL as a default, so an unconfigured team cannot be
  // gated against a number nobody chose.
  check('no default capacity is handed to SQL', !('p_default_capacity' in rpcCalls[0].args), Object.keys(rpcCalls[0].args).join(','));
  eq('counts come from what the function actually wrote', res.counts.created, 1);
  eq('no refusals when nothing was full', res.refusals.length, 0);

  // ── Removals are handed over too, so a swap inside one batch frees its own setup.
  withRpc({ data: { ok: true, created: 1, updated: 0, removed: 1, refusals: [] }, error: null });
  reset(scriptWith({ instances: [existing({ id: 'del-me', source: 'admin_open' })] }));
  res = await applyScheduleBatch({ userId: USER, now: NOW, entries: [
    { employeeId: EMP.id, date: '2026-09-10', off: true },
    { employeeId: EMP.id, date: '2026-09-11', startTime: '06:00', endTime: '14:00' },
  ] });
  eq('the removals travel with the upserts, in ONE call', rpcCalls.length, 1);
  eq('…as delete ids', rpcCalls[0].args.p_delete_ids, ['del-me']);
  eq('…and the reported removal count is the function\'s', res.counts.removed, 1);

  // ── A capacity refusal is PER ROW: the batch still succeeded for everything else.
  withRpc({ data: { ok: true, created: 0, updated: 0, removed: 0, refusals: [
    { employee_id: EMP.id, shift_date: '2026-09-11', code: 'OVER_CAPACITY', block_id: 'blk', staffed: 10, capacity: 10 },
  ] }, error: null });
  reset(scriptWith({}));
  res = await applyScheduleBatch({ userId: USER, now: NOW, entries: [
    { employeeId: EMP.id, date: '2026-09-11', startTime: '06:00', endTime: '14:00' },
  ] });
  check('a full block does NOT fail the whole save', res.ok === true);
  eq('it comes back as a per-row refusal', res.refusals.length, 1);
  eq('…with the shared code', res.refusals[0].code, 'OVER_CAPACITY');
  eq('…naming the day', res.refusals[0].date, '2026-09-11');
  check('…and a manager-readable sentence', /fully staffed/i.test(res.refusals[0].message), res.refusals[0].message);
  check('the refusal message has no em dash', !res.refusals[0].message.includes('\u2014'));

  // ── A REAL error must surface, never silently downgrade to an unguarded write.
  withRpc({ data: null, error: { code: '40001', message: 'serialization failure' } });
  reset(scriptWith({}));
  await assert.rejects(applyScheduleBatch({ userId: USER, now: NOW, entries: [
    { employeeId: EMP.id, date: '2026-09-11', startTime: '06:00', endTime: '14:00' },
  ] }), (e) => e instanceof ScheduleBatchError && e.code === 'WRITE_FAILED');
  check('a real RPC error throws instead of falling back unguarded', !writes().some((r) => r.table === 'shift_instances'));

  // ── The fallback fires ONLY for a missing function, and reproduces the pre-157 sequence.
  restoreMissing();
  reset(scriptWith({}));
  res = await applyScheduleBatch({ userId: USER, now: NOW, entries: [
    { employeeId: EMP.id, date: '2026-09-11', startTime: '06:00', endTime: '14:00' },
  ] });
  eq('an absent function falls back to the upsert', writes()[0].op, 'upsert');
  eq('…on shift_instances', writes()[0].table, 'shift_instances');
  eq('…and reports no capacity refusals, because nothing was checked', res.refusals.length, 0);

  // ── A dry run answers "what would change" and must not take a capacity lock to do it.
  rpcCalls.length = 0;
  reset(scriptWith({}));
  res = await applyScheduleBatch({ userId: USER, now: NOW, dryRun: true, entries: [
    { employeeId: EMP.id, date: '2026-09-11', startTime: '06:00', endTime: '14:00' },
  ] });
  eq('a dry run calls no function at all', rpcCalls.length, 0);
  check('…and writes nothing', writes().length === 0);
  eq('…and carries an empty refusal list', res.refusals.length, 0);
}

console.log(`\n${passed} checks passed`);
