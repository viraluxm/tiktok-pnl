// TEAM SCHEDULE — the surface that widens what an employee can see, so the tests are about
// TENANCY and FIELD EXPOSURE as much as behaviour.
//
// Exercises the REAL teamSchedule.ts; the fake client records every filter and select list.
//
// Run:  TZ=UTC node src/lib/schedule/teamSchedule.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'teamsched-'));
const write = (n, s) => { const p = join(dir, n); writeFileSync(p, s); return pathToFileURL(p).href; };
function transpile(rel, out, rw = {}) {
  const sp = fileURLToPath(new URL(rel, import.meta.url));
  let { outputText } = ts.transpileModule(readFileSync(sp, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  for (const [f, t] of Object.entries(rw)) outputText = outputText.split(f).join(t);
  return write(out, outputText);
}
const serverOnly = write('so.mjs', 'export {};\n');
const adminStub = write('admin.mjs', 'export function createAdminClient(){ return globalThis.__DB; }\n');
const timezone = transpile('./timezone.ts', 'timezone.mjs');
const weekly = transpile('../weeklySchedule.ts', 'weekly.mjs');
const eligibility = transpile('./eligibility.ts', 'eligibility.mjs');
const schedulePlan = transpile('./schedulePlan.ts', 'schedulePlan.mjs', {
  "'./timezone'": `'${timezone}'`, "'@/lib/weeklySchedule'": `'${weekly}'`, "'./eligibility'": `'${eligibility}'`,
});
const T = await import(transpile('./teamSchedule.ts', 'teamSchedule.mjs', {
  "'server-only'": `'${serverOnly}'`, "'@/lib/supabase/admin'": `'${adminStub}'`,
  "'./timezone'": `'${timezone}'`, "'./schedulePlan'": `'${schedulePlan}'`,
}));

class Rec {
  constructor(t) { this.table = t; this.filters = []; }
  select(c) { this.cols = c; return this; }
  eq(k, v) { this.filters.push(['eq', k, v]); return this; }
  in(k, v) { this.filters.push(['in', k, v]); return this; }
  not(k, o, v) { this.filters.push(['not', k, `${o}:${v}`]); return this; }
  gte(k, v) { this.filters.push(['gte', k, v]); return this; }
  lte(k, v) { this.filters.push(['lte', k, v]); return this; }
  order() { return this; }
  then(res) { globalThis.__LOG.push(this); res(globalThis.__SCRIPT(this)); }
  f(k, key) { return this.filters.find(([a, b]) => a === k && b === key)?.[2]; }
  has(k, key) { return this.filters.some(([a, b]) => a === k && b === key); }
}
globalThis.__DB = { from: (t) => new Rec(t) };
const reset = (s) => { globalThis.__LOG = []; globalThis.__SCRIPT = s; };

let passed = 0;
const check = (n, c, e = '') => { assert.ok(c, `FAIL: ${n} ${e}`); console.log(`  ✓ ${n}${e ? ` — ${e}` : ''}`); passed++; };
const eq = (n, a, b) => check(n, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} == ${JSON.stringify(b)}`);

const OWNER = 'owner-1';
const ME = { id: 'emp-me', user_id: OWNER, name: 'Me', role: 'fulfillment', status: 'active' };
const inst = (o = {}) => ({
  id: 'i1', employee_id: 'emp-a', shift_date: '2026-09-07',
  starts_at: '2026-09-07T13:00:00+00:00', ends_at: '2026-09-07T21:00:00+00:00',
  status: 'scheduled', offer_state: null, role: 'fulfillment', ...o,
});
const script = (instances, emps) => (r) => {
  if (r.table === 'shift_instances') return { data: instances, error: null };
  if (r.table === 'employees') return { data: emps, error: null };
  return { data: [], error: null };
};

console.log('\n1. THE QUERY IS THE TENANT BOUNDARY');
{
  reset(script([], []));
  await T.getTeamSchedule(ME, '2026-09-07');
  const q = globalThis.__LOG[0];
  eq('reads shift_instances', q.table, 'shift_instances');
  eq('scoped to the TOKEN-derived owner', q.f('eq', 'user_id'), OWNER);
  eq('active planned coverage only', q.f('in', 'status'), ['scheduled', 'claimed']);
  check('assigned rows only', q.has('not', 'employee_id'));
  eq('bounded to the Mon→Sun week', [q.f('gte', 'shift_date'), q.f('lte', 'shift_date')], ['2026-09-07', '2026-09-13']);
}

console.log('\n2. FIELD EXPOSURE — an allow-list, never select(*)');
{
  reset(script([inst()], [{ id: 'emp-a', name: 'Carlos', role: 'fulfillment' }]));
  const w = await T.getTeamSchedule(ME, '2026-09-07');
  const iq = globalThis.__LOG.find((r) => r.table === 'shift_instances');
  const eq_ = globalThis.__LOG.find((r) => r.table === 'employees');
  check('shift_instances select is explicit, not *', !String(iq.cols).includes('*'));
  check('employees select is explicit, not *', !String(eq_.cols).includes('*'));
  eq('employees exposes ONLY id/name/role', String(eq_.cols), 'id, name, role');
  for (const forbidden of ['hourly_rate', 'phone', 'probation', 'hire_date', 'note', 'token', 'store_id', 'user_id']) {
    check(`employees select never asks for ${forbidden}`, !String(eq_.cols).includes(forbidden));
  }
  const body = JSON.stringify(w);
  for (const leak of ['hourly', 'rate', 'phone', 'payroll', 'wage', 'token', 'probation']) {
    check(`the returned week contains no "${leak}"`, !new RegExp(leak, 'i').test(body));
  }
  eq('the row shape is exactly the display fields', Object.keys(w.days[0].shifts[0]).sort(),
    ['employee_id', 'ends_at', 'instance_id', 'is_me', 'name', 'offered', 'role', 'starts_at'].sort());
}

console.log('\n3. CROSS-TENANT: a name that is not in this owner\'s roster is never rendered');
{
  // The instance read is owner-scoped, but belt-and-braces: if a foreign employee_id ever appeared,
  // the roster lookup (also owner-scoped) would not resolve it and the row is dropped.
  reset(script([inst({ id: 'i1', employee_id: 'emp-a' }), inst({ id: 'i2', employee_id: 'emp-FOREIGN' })],
               [{ id: 'emp-a', name: 'Carlos', role: 'fulfillment' }]));
  const w = await T.getTeamSchedule(ME, '2026-09-07');
  const shifts = w.days.flatMap((d) => d.shifts);
  eq('only the resolvable, same-owner row survives', shifts.map((s) => s.instance_id), ['i1']);
  check('the foreign employee id never reaches the output', !JSON.stringify(w).includes('emp-FOREIGN'));
  check('the roster lookup is itself owner-scoped', globalThis.__LOG.find((r) => r.table === 'employees').f('eq', 'user_id') === OWNER);
}

console.log('\n4. AN OFFERED SHIFT STAYS ASSIGNED — it is marked, not moved');
{
  reset(script([inst({ offer_state: 'offered' })], [{ id: 'emp-a', name: 'Carlos', role: 'fulfillment' }]));
  const w = await T.getTeamSchedule(ME, '2026-09-07');
  const s = w.days[0].shifts[0];
  eq('still listed under the person who dropped it', s.name, 'Carlos');
  eq('and flagged available for pickup', s.offered, true);
  check('the team is never told the shift is unassigned', s.employee_id === 'emp-a');
}

console.log('\n5. WEEK SHAPE, self-marking and overnight data');
{
  reset(script([
    inst({ id: 'a', employee_id: 'emp-me', shift_date: '2026-09-08' }),
    inst({ id: 'b', employee_id: 'emp-a', shift_date: '2026-09-09', starts_at: '2026-09-09T23:00:00+00:00', ends_at: '2026-09-10T09:00:00+00:00' }),
  ], [{ id: 'emp-me', name: 'Me', role: 'fulfillment' }, { id: 'emp-a', name: 'Carlos', role: 'host' }]));
  const w = await T.getTeamSchedule(ME, '2026-09-09');
  eq('week normalises to its Monday', [w.start, w.end], ['2026-09-07', '2026-09-13']);
  eq('always seven days', w.days.length, 7);
  eq('rows land on their own dates', w.days.map((d) => d.shifts.length), [0, 1, 1, 0, 0, 0, 0]);
  eq('the viewer is marked', w.days[1].shifts[0].is_me, true);
  eq('a teammate is not', w.days[2].shifts[0].is_me, false);
  const ov = w.days[2].shifts[0];
  check('overnight spans survive intact for the formatter', Date.parse(ov.ends_at) - Date.parse(ov.starts_at) === 10 * 3600_000);
  eq("role falls back to the row's own value", w.days[2].shifts[0].role, 'fulfillment');
}

console.log('\n6. NO RECURRING PROJECTION, NO PAYROLL — instance-only by construction');
{
  const raw = readFileSync(fileURLToPath(new URL('./teamSchedule.ts', import.meta.url)), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  check('never calls generateRecurringShifts', !/generateRecurringShifts/.test(src));
  check('never reads shift_rules or shift_exceptions', !/shift_(rules|exceptions)/.test(src));
  check('never reads shifts or punches', !/from\('(shifts|employee_time_entries)'\)/.test(src));
  eq('the only tables it touches', [...new Set([...src.matchAll(/from\('([a-z_]+)'\)/g)].map((m) => m[1]))].sort(), ['employees', 'shift_instances']);
  check('and it performs no write at all', !/\.(insert|update|upsert|delete)\(/.test(src));
}

console.log('\n7. resolveTeamWeek is injection-proof');
{
  eq('undefined → this week', T.resolveTeamWeek(undefined, '2026-09-09'), '2026-09-07');
  eq('a mid-week date → its Monday', T.resolveTeamWeek('2026-09-17', '2026-09-09'), '2026-09-14');
  eq('array param → first value', T.resolveTeamWeek(['2026-09-14'], '2026-09-09'), '2026-09-14');
  eq('SQL-ish junk → falls back, never interpolated', T.resolveTeamWeek("2026-09-14' OR 1=1--", '2026-09-09'), '2026-09-07');
  eq('impossible date → falls back', T.resolveTeamWeek('2026-02-31', '2026-09-09'), '2026-09-07');
  eq('empty string → falls back', T.resolveTeamWeek('', '2026-09-09'), '2026-09-07');
}

console.log(`\n${passed} checks passed`);
