// postOneTimeShift: TENANT OWNERSHIP on the legacy single-instance write path.
//
// This endpoint (POST /api/admin/schedule/instances) runs service-role, so RLS is not the boundary —
// the explicit `user_id` filter is. It previously looked the employee up by id ALONE, so an admin
// could post a shift onto another owner's employee: the row would carry OUR user_id and THEIR
// employee_id, and would surface on that person's /s page. This file pins the fix and matches the
// discipline the bulk route already uses.
//
// Exercises the REAL adminShifts.ts (+ real eligibility/employees/timezone/release), transpiled at
// runtime. The fake client RECORDS every filter so the ownership PREDICATE itself is asserted —
// deleting it must fail here, not merely change an outcome.
//
// Run:  TZ=UTC node src/lib/schedule/adminShiftsOwner.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'adminown-'));
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
const dropsStub = write('drops.mjs', 'export const DROP_CAP = 2;\nexport function computeDrops(){ return { releases:0, claims:0, excused:0, drops:0 }; }\n');
const boardStub = write('board.mjs', 'export const NOTICE_MS = 86400000;\n');
const employees = transpile('../employees.ts', 'employees.mjs');
const timezone = transpile('./timezone.ts', 'timezone.mjs');
const eligibility = transpile('./eligibility.ts', 'eligibility.mjs');
const release = transpile('./release.ts', 'release.mjs', {
  "'server-only'": `'${serverOnly}'`, "'@/lib/supabase/admin'": `'${adminStub}'`,
  "'@/lib/employees'": `'${employees}'`, "'./timezone'": `'${timezone}'`,
  "'./drops'": `'${dropsStub}'`, "'./board'": `'${boardStub}'`,
});
const adminShifts = transpile('./adminShifts.ts', 'adminShifts.mjs', {
  "'server-only'": `'${serverOnly}'`, "'@/lib/supabase/admin'": `'${adminStub}'`,
  "'@/lib/employees'": `'${employees}'`, "'./timezone'": `'${timezone}'`,
  "'./release'": `'${release}'`, "'./eligibility'": `'${eligibility}'`,
});
const { postOneTimeShift, removeOneTimeShift } = await import(adminShifts);
const { ScheduleError } = await import(release);

class Rec {
  constructor(table) { this.table = table; this.op = 'select'; this.filters = []; this.payload = null; }
  select(c) { this.cols = c; return this; }
  eq(k, v) { this.filters.push(['eq', k, v]); return this; }
  in(k, v) { this.filters.push(['in', k, v]); return this; }
  is(k, v) { this.filters.push(['is', k, v]); return this; }
  limit() { return this; }
  order() { return this; }
  single() { return this; }
  maybeSingle() { return this; }
  insert(r) { this.op = 'insert'; this.payload = r; return this; }
  update(p) { this.op = 'update'; this.payload = p; return this; }
  delete() { this.op = 'delete'; return this; }
  then(res, rej) { globalThis.__LOG.push(this); try { res(globalThis.__SCRIPT(this)); } catch (e) { rej(e); } }
  f(kind, key) { return this.filters.find(([k, kk]) => k === kind && kk === key)?.[2]; }
}
globalThis.__DB = { from: (t) => new Rec(t) };
const reset = (script) => { globalThis.__LOG = []; globalThis.__SCRIPT = script; };
const log = () => globalThis.__LOG;

let passed = 0;
const check = (name, cond, extra = '') => { assert.ok(cond, `FAIL: ${name} ${extra}`); console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`); passed++; };
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} == ${JSON.stringify(b)}`);

const OWNER_A = 'owner-a';
const OWNER_B = 'owner-b';
const EMP_OF_B = 'emp-of-b';
const input = (over = {}) => ({
  userId: OWNER_A, date: '2026-09-10', startTime: '06:00', endTime: '14:00',
  role: null, employeeId: 'emp-of-a', note: null, ...over,
});

console.log('\npostOneTimeShift — employee lookup is owner-scoped');
{
  // The fake DB models the real thing: the employees row exists, but only for OWNER_B. A query
  // filtered by user_id = OWNER_A therefore returns nothing.
  const script = (rec) => {
    if (rec.table === 'employees') {
      const wantsId = rec.f('eq', 'id');
      const wantsOwner = rec.f('eq', 'user_id');
      const row = { id: EMP_OF_B, role: 'fulfillment', store_id: 'store-b', user_id: OWNER_B };
      if (wantsId !== EMP_OF_B) return { data: null, error: null };
      if (wantsOwner !== undefined && wantsOwner !== OWNER_B) return { data: null, error: null };
      return { data: row, error: null };
    }
    if (rec.table === 'shift_instances') return { data: { id: 'new-1' }, error: null };
    return { data: null, error: null };
  };

  reset(script);
  await assert.rejects(
    postOneTimeShift(input({ employeeId: EMP_OF_B })),
    (e) => e instanceof ScheduleError && e.code === 'EMPLOYEE_NOT_FOUND',
  );
  check('admin A posting onto owner B\'s employee → EMPLOYEE_NOT_FOUND', true);
  check('and NO shift_instances row is written', !log().some((r) => r.table === 'shift_instances' && r.op === 'insert'));
  const q = log().find((r) => r.table === 'employees');
  eq('the employee lookup carries BOTH id and user_id predicates', [q.f('eq', 'id'), q.f('eq', 'user_id')], [EMP_OF_B, OWNER_A]);

  // Same request from the RIGHTFUL owner still works — the fix must not break the contract.
  reset(script);
  const ok = await postOneTimeShift(input({ userId: OWNER_B, employeeId: EMP_OF_B }));
  eq('owner B posting onto their OWN employee still succeeds', ok, { id: 'new-1' });
  const ins = log().find((r) => r.table === 'shift_instances' && r.op === 'insert');
  eq('the row is stamped with the calling owner', ins.payload.user_id, OWNER_B);
  eq('and carries the employee + derived role/store', [ins.payload.employee_id, ins.payload.role, ins.payload.store_id], [EMP_OF_B, 'fulfillment', 'store-b']);
  eq('non-payable admin_open scheduled instance, as before', [ins.payload.source, ins.payload.status], ['admin_open', 'scheduled']);
}

console.log('\npostOneTimeShift — UNASSIGNED (board) posts are unaffected');
{
  reset((rec) => rec.table === 'shift_instances' ? { data: { id: 'open-1' }, error: null } : { data: null, error: null });
  const ok = await postOneTimeShift(input({ employeeId: null, role: 'host' }));
  eq('an unassigned open shift still posts', ok, { id: 'open-1' });
  check('no employees lookup happens at all when unassigned', !log().some((r) => r.table === 'employees'));
  const ins = log().find((r) => r.table === 'shift_instances');
  eq('released straight to the board with its own role', [ins.payload.status, ins.payload.role, ins.payload.employee_id], ['released', 'host', null]);
}

console.log('\nremoveOneTimeShift — the DELETE path of the same route was ALREADY scoped');
{
  const script = (rec) => {
    if (rec.table === 'shift_instances' && rec.op === 'select') {
      return rec.f('eq', 'user_id') === OWNER_A
        ? { data: { id: 'i1', employee_id: 'emp-of-a', shift_date: '2026-09-10', starts_at: '2999-01-01T00:00:00Z', status: 'scheduled', source: 'admin_open' }, error: null }
        : { data: null, error: null };
    }
    if (rec.table === 'shift_instances' && rec.op === 'delete') return { data: [{ id: 'i1' }], error: null };
    if (rec.table === 'employee_time_entries' || rec.table === 'shifts') return { data: null, error: null };
    return { data: null, error: null };
  };
  reset(script);
  await removeOneTimeShift({ userId: OWNER_A, instanceId: 'i1' });
  const sel = log().find((r) => r.table === 'shift_instances' && r.op === 'select');
  const del = log().find((r) => r.table === 'shift_instances' && r.op === 'delete');
  eq('the read is owner-scoped', sel.f('eq', 'user_id'), OWNER_A);
  eq('the delete re-asserts owner + source + status', [del.f('eq', 'user_id'), del.f('eq', 'source'), del.f('eq', 'status')], [OWNER_A, 'admin_open', 'scheduled']);
  check('the guard reads are owner-scoped too', log().filter((r) => r.table === 'shifts' || r.table === 'employee_time_entries').every((r) => r.f('eq', 'user_id') === OWNER_A));

  reset(script);
  await assert.rejects(removeOneTimeShift({ userId: OWNER_B, instanceId: 'i1' }), (e) => e instanceof ScheduleError && e.code === 'NOT_FOUND');
  check('a foreign owner cannot remove another owner\'s shift', !log().some((r) => r.op === 'delete'));
}

console.log('\nPAYROLL INVARIANT — this module still never writes shifts');
{
  const src = readFileSync(fileURLToPath(new URL('./adminShifts.ts', import.meta.url)), 'utf8');
  check('no insert/update/upsert/delete against `shifts`', !/from\('shifts'\)\s*\.\s*(insert|update|upsert|delete)/.test(src));
  check('`shifts` appears only as a guard READ', /from\('shifts'\)\s*[\s\S]{0,40}\.select/.test(src));
}

console.log(`\n${passed} checks passed`);
