// getWeekSchedule / resolveWeekStart: the worker's MY SCHEDULE week on /s/[token].
//
// Exercises the REAL mySchedule.ts + schedulePlan.ts (+ timezone / weeklySchedule / eligibility),
// transpiled at runtime. Only 'server-only' and the Supabase admin client are stubbed; the fake
// client RECORDS the query so the test asserts the PREDICATES — this read runs service-role, so the
// employee_id/user_id filters ARE the boundary that keeps one worker from seeing another's week.
//
// Run:  TZ=UTC node src/lib/schedule/mySchedule.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'mysched-'));
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
const url = transpile('./mySchedule.ts', 'mySchedule.mjs', {
  "'server-only'": `'${serverOnly}'`, "'@/lib/supabase/admin'": `'${adminStub}'`,
  "'./timezone'": `'${timezone}'`, "'./schedulePlan'": `'${plan}'`,
});
const { getWeekSchedule, resolveWeekStart } = await import(url);

class Rec {
  constructor(table) { this.table = table; this.filters = []; }
  select(c) { this.cols = c; return this; }
  eq(k, v) { this.filters.push(['eq', k, v]); return this; }
  in(k, v) { this.filters.push(['in', k, v]); return this; }
  gte(k, v) { this.filters.push(['gte', k, v]); return this; }
  lte(k, v) { this.filters.push(['lte', k, v]); return this; }
  order() { return this; }
  then(res) { globalThis.__LOG.push(this); res(globalThis.__REPLY); }
  f(kind, key) { return this.filters.find(([k, kk]) => k === kind && kk === key)?.[2]; }
}
globalThis.__DB = { from: (t) => new Rec(t) };
const reset = (rows) => { globalThis.__LOG = []; globalThis.__REPLY = { data: rows, error: null }; };

let passed = 0;
const check = (name, cond, extra = '') => { assert.ok(cond, `FAIL: ${name} ${extra}`); console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`); passed++; };
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} == ${JSON.stringify(b)}`);

const EMP = { id: 'emp-a', user_id: 'owner-1', name: 'A', role: 'host', status: 'active' };

console.log('\nresolveWeekStart');
eq('undefined → this week (Monday)', resolveWeekStart(undefined, '2026-09-09'), '2026-09-07');
eq('a mid-week date → its Monday', resolveWeekStart('2026-09-17', '2026-09-09'), '2026-09-14');
eq('a Sunday → the Monday that started that week', resolveWeekStart('2026-09-20', '2026-09-09'), '2026-09-14');
eq('array param → first value', resolveWeekStart(['2026-09-21', 'x'], '2026-09-09'), '2026-09-21');
eq('garbage → this week', resolveWeekStart("2026-09-17' OR 1=1", '2026-09-09'), '2026-09-07');
eq('impossible date → this week', resolveWeekStart('2026-02-31', '2026-09-09'), '2026-09-07');

console.log('\ngetWeekSchedule — the query IS the security boundary');
{
  reset([]);
  const ws = await getWeekSchedule(EMP, '2026-09-07');
  const q = globalThis.__LOG[0];
  eq('reads shift_instances', q.table, 'shift_instances');
  eq('scoped to THIS employee', q.f('eq', 'employee_id'), EMP.id);
  eq('AND to the owning account', q.f('eq', 'user_id'), EMP.user_id);
  eq('only live plan statuses (cancelled/released/missed never show)', q.f('in', 'status'), ['scheduled', 'claimed']);
  eq('bounded to the Mon→Sun week', [q.f('gte', 'shift_date'), q.f('lte', 'shift_date')], ['2026-09-07', '2026-09-13']);
  eq('always 7 days, Off when empty', [ws.start, ws.end, ws.days.length, ws.days.every((d) => d.instance === null)], ['2026-09-07', '2026-09-13', 7, true]);
}
{
  const row = (id, date, s, e, status = 'scheduled') => ({ id, employee_id: EMP.id, user_id: EMP.user_id, shift_date: date, starts_at: s, ends_at: e, status, source: 'admin_open' });
  reset([
    row('a', '2026-09-08', '2026-09-08T13:00:00+00:00', '2026-09-08T21:00:00+00:00'),
    row('b', '2026-09-10', '2026-09-10T23:00:00+00:00', '2026-09-11T09:00:00+00:00', 'claimed'),
    row('dup', '2026-09-10', '2026-09-10T13:00:00+00:00', '2026-09-10T21:00:00+00:00'), // cannot happen (UNIQUE) — first wins defensively
  ]);
  const ws = await getWeekSchedule(EMP, '2026-09-09'); // any date in the week normalises to its Monday
  eq('week normalised to Monday', ws.start, '2026-09-07');
  eq('rows land on their dates; other days are Off', ws.days.map((d) => d.instance?.id ?? null), [null, 'a', null, 'b', null, null, null]);
  eq('claimed shifts are part of MY schedule', ws.days[3].instance.status, 'claimed');
}
{
  globalThis.__LOG = []; globalThis.__REPLY = { data: null, error: { message: 'nope' } };
  await assert.rejects(getWeekSchedule(EMP, '2026-09-07'), /getWeekSchedule: nope/);
  check('read error is surfaced, not swallowed', true);
}

console.log('\nPRIVACY — the module never reads pay or punches');
{
  const src = readFileSync(fileURLToPath(new URL('./mySchedule.ts', import.meta.url)), 'utf8');
  check('no hourly_rate / shifts / employee_time_entries in the read path', !/hourly_rate|from\('shifts'\)|employee_time_entries|clock_audit/.test(src));
}

console.log(`\n${passed} checks passed`);
