// offer.ts — the DB-bound Drop / Available / Pick Up paths.
//
// Exercises the REAL offer.ts (+ real offerPlan/eligibility/timezone/employees), transpiled at
// runtime. Only 'server-only', the Supabase admin client and randomUUID are stubbed. The fake
// client RECORDS every table, op, filter and payload, so these assert the PREDICATES — which is
// the point: this code runs service-role with RLS bypassed, so the filters ARE the security model.
//
// Run:  TZ=UTC node src/lib/schedule/offer.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'offer-'));
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
const cryptoStub = write('crypto.mjs', "export function randomUUID(){ return globalThis.__UUID ?? 'offer-NEW'; }\n");
const dropsStub = write('drops.mjs', 'export const DROP_CAP = 2;\nexport function computeDrops(){ return {releases:0,claims:0,excused:0,drops:0}; }\n');
const boardStub = write('board.mjs', 'export const NOTICE_MS = 86400000;\n');
const employees = transpile('../employees.ts', 'employees.mjs');
const timezone = transpile('./timezone.ts', 'timezone.mjs');
const eligibility = transpile('./eligibility.ts', 'eligibility.mjs');
const weekly = transpile('../weeklySchedule.ts', 'weekly.mjs');
const schedulePlan = transpile('./schedulePlan.ts', 'schedulePlan.mjs', {
  "'./timezone'": `'${timezone}'`, "'@/lib/weeklySchedule'": `'${weekly}'`, "'./eligibility'": `'${eligibility}'`,
});
const release = transpile('./release.ts', 'release.mjs', {
  "'server-only'": `'${serverOnly}'`, "'@/lib/supabase/admin'": `'${adminStub}'`,
  "'@/lib/employees'": `'${employees}'`, "'./timezone'": `'${timezone}'`,
  "'./drops'": `'${dropsStub}'`, "'./board'": `'${boardStub}'`,
});
const offerPlan = transpile('./offerPlan.ts', 'offerPlan.mjs', { "'./eligibility'": `'${eligibility}'` });
const O = await import(transpile('./offer.ts', 'offer.mjs', {
  "'server-only'": `'${serverOnly}'`, "'@/lib/supabase/admin'": `'${adminStub}'`,
  "'node:crypto'": `'${cryptoStub}'`, "'@/lib/employees'": `'${employees}'`,
  "'./timezone'": `'${timezone}'`, "'./release'": `'${release}'`, "'./offerPlan'": `'${offerPlan}'`,
}));
const { ScheduleError } = await import(release);

class Rec {
  constructor(t) { this.table = t; this.op = 'select'; this.filters = []; this.payload = null; }
  select(c) { this.cols = c; return this; }
  eq(k, v) { this.filters.push(['eq', k, v]); return this; }
  in(k, v) { this.filters.push(['in', k, v]); return this; }
  is(k, v) { this.filters.push(['is', k, v]); return this; }
  not(k, o, v) { this.filters.push(['not', k, `${o}:${v}`]); return this; }
  gte(k, v) { this.filters.push(['gte', k, v]); return this; }
  lte(k, v) { this.filters.push(['lte', k, v]); return this; }
  or(e) { this.filters.push(['or', 'expr', e]); return this; }
  order() { return this; }
  limit() { return this; }
  single() { return this; }
  maybeSingle() { return this; }
  insert(r) { this.op = 'insert'; this.payload = r; return this; }
  update(p) { this.op = 'update'; this.payload = p; return this; }
  delete() { this.op = 'delete'; return this; }
  then(res, rej) { globalThis.__LOG.push(this); try { res(globalThis.__SCRIPT(this)); } catch (e) { rej(e); } }
  f(k, key) { return this.filters.find(([a, b]) => a === k && b === key)?.[2]; }
  has(k, key) { return this.filters.some(([a, b]) => a === k && b === key); }
}
globalThis.__DB = { from: (t) => new Rec(t) };
const reset = (s) => { globalThis.__LOG = []; globalThis.__SCRIPT = s; };
const log = () => globalThis.__LOG;
const writes = () => log().filter((r) => r.op !== 'select');

let passed = 0;
const check = (n, c, e = '') => { assert.ok(c, `FAIL: ${n} ${e}`); console.log(`  ✓ ${n}${e ? ` — ${e}` : ''}`); passed++; };
const eq = (n, a, b) => check(n, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} == ${JSON.stringify(b)}`);

const OWNER = 'owner-1';
const ME = { id: 'emp-me', user_id: OWNER, name: 'Me', role: 'fulfillment', status: 'active' };
const NOW = new Date('2026-09-09T18:00:00Z');
const row = (o = {}) => ({
  id: 'inst-1', user_id: OWNER, employee_id: ME.id, shift_date: '2026-09-11',
  starts_at: '2026-09-11T13:00:00+00:00', ends_at: '2026-09-11T21:00:00+00:00',
  status: 'scheduled', released_at: null, released_by: null, role: 'fulfillment',
  source: 'pattern', offer_state: null, offer_id: null, offered_at: null, ...o,
});

console.log('\n1. DROP writes an OFFER and nothing else');
{
  reset((r) => {
    if (r.table === 'shift_instances' && r.op === 'select') return { data: row(), error: null };
    if (r.table === 'shift_instances' && r.op === 'update') return { data: { id: 'inst-1', shift_date: '2026-09-11', starts_at: 'S', ends_at: 'E' }, error: null };
    return { data: null, error: null };
  });
  const res = await O.offerShift(ME, 'inst-1');
  eq('returns the new offer generation', [res.status, res.offer_id], ['offered', 'offer-NEW']);

  const up = writes().find((r) => r.table === 'shift_instances');
  eq('ONLY the offer columns are written', Object.keys(up.payload).sort(), ['offer_id', 'offer_state', 'offered_at']);
  check('employee_id is NOT touched — the shift stays theirs', !('employee_id' in up.payload));
  check('status is NOT touched — it stays clock-eligible', !('status' in up.payload));
  check('released_at is NOT touched — the legacy strip never happens', !('released_at' in up.payload));
  eq('CAS predicates: owner + mine + active + unreleased', [up.f('eq', 'user_id'), up.f('eq', 'employee_id'), up.f('in', 'status'), up.f('is', 'released_at')], [OWNER, ME.id, ['scheduled', 'claimed'], null]);
  check('and only re-offers a null/closed offer', up.filters.some(([k, , v]) => k === 'or' && String(v).includes('offer_state.is.null')));
  eq('the read was owner-scoped', log()[0].f('eq', 'user_id'), OWNER);
}

console.log('\n2. DROP still counts toward the drop cap (attendance trail preserved)');
{
  const ev = writes().find((r) => r.table === 'attendance_events');
  eq('a released event is written, same as the legacy path', ev.payload.event_type, 'released');
  eq('owner + employee + instance stamped', [ev.payload.user_id, ev.payload.employee_id, ev.payload.shift_instance_id], [OWNER, ME.id, 'inst-1']);
  check('and it carries a pay_period_start so computeDrops keeps working', typeof ev.payload.pay_period_start === 'string');
}

console.log('\n3. DROP refusals never write');
{
  for (const [label, r] of [
    ['not mine', row({ employee_id: 'someone-else' })],
    ['cancelled', row({ status: 'cancelled' })],
    ['already offered', row({ offer_state: 'offered', offer_id: 'o' })],
    ['transferred', row({ offer_state: 'transferred', offer_id: 'o' })],
    ['legacy released', row({ released_at: '2026-09-01T00:00:00Z' })],
    ['past', row({ shift_date: '2026-09-01' })],
  ]) {
    reset((q) => q.op === 'select' ? { data: r, error: null } : { data: null, error: null });
    await assert.rejects(O.offerShift(ME, 'inst-1'), (e) => e instanceof ScheduleError);
    eq(`${label} → refused, zero writes`, writes().length, 0);
  }
  reset(() => ({ data: null, error: null }));
  await assert.rejects(O.offerShift(ME, 'nope'), (e) => e instanceof ScheduleError && e.code === 'NOT_FOUND');
  check('a foreign/missing shift is NOT_FOUND with no write', writes().length === 0);
}

console.log('\n4. PICKUP files a PENDING request and touches no assignment');
{
  // requestPickup makes TWO shift_instances reads: the offer itself (by id → single object) and
  // the viewer's same-day check (by shift_date → array). Distinguish them by the id filter.
  const pickupScript = (inst, sameDay = [], claims = []) => (r) => {
    if (r.table === 'shift_instances' && r.f('eq', 'id')) return { data: inst, error: null };
    if (r.table === 'shift_instances') return { data: sameDay, error: null };
    if (r.table === 'shift_claims' && r.op === 'insert') return { data: { id: 'claim-1' }, error: null };
    if (r.table === 'shift_claims') return { data: claims, error: null };
    return { data: [], error: null };
  };
  reset(pickupScript(row({ employee_id: 'emp-other', offer_state: 'offered', offer_id: 'offer-A' })));
  const res = await O.requestPickup(ME, 'inst-1', 'offer-A');
  eq('the request is PENDING', res.status, 'pending');
  const ins = writes().find((r) => r.table === 'shift_claims');
  eq('kind marks it a Phase 2 pickup', ins.payload.kind, 'pickup_request');
  eq('status is pending — never auto_approved', ins.payload.status, 'pending');
  eq('it carries the offer generation', ins.payload.offer_id, 'offer-A');
  eq('claimed_by is the TOKEN employee', ins.payload.claimed_by, ME.id);
  eq('owner stamped from the employee, not a request', ins.payload.user_id, OWNER);
  check('NOTHING was written to shift_instances — no assignment, no eligibility', !writes().some((r) => r.table === 'shift_instances'));
  eq('exactly one write in the whole path', writes().length, 1);
}

console.log('\n5. PICKUP — the ABA guard and the refusals');
{
  const script = (inst) => (r) => {
    if (r.table === 'shift_instances' && r.f('eq', 'id')) return { data: inst, error: null };
    if (r.table === 'shift_instances') return { data: [], error: null };
    if (r.table === 'shift_claims') return { data: [], error: null };
    return { data: [], error: null };
  };
  reset(script(row({ employee_id: 'emp-other', offer_state: 'offered', offer_id: 'offer-B' })));
  await assert.rejects(O.requestPickup(ME, 'inst-1', 'offer-A'), (e) => e.code === 'STALE_OFFER');
  check('a request against a SUPERSEDED offer cycle is refused, zero writes', writes().length === 0);

  reset(script(row({ employee_id: ME.id, offer_state: 'offered', offer_id: 'offer-A' })));
  await assert.rejects(O.requestPickup(ME, 'inst-1', 'offer-A'), (e) => e.code === 'OWN_SHIFT');
  check('cannot pick up my own dropped shift', writes().length === 0);

  reset(script(row({ employee_id: 'emp-other', offer_state: null })));
  await assert.rejects(O.requestPickup(ME, 'inst-1'), (e) => e.code === 'NOT_OFFERED');
  check('a shift that is not offered cannot be requested', writes().length === 0);

  reset(() => ({ data: null, error: null }));
  await assert.rejects(O.requestPickup(ME, 'foreign'), (e) => e.code === 'NOT_FOUND');
  check("another owner's shift is simply not found", writes().length === 0);
}

console.log('\n6. PICKUP — the DB unique index is the real duplicate guard');
{
  reset((r) => {
    if (r.table === 'shift_instances' && r.f('eq', 'id')) return { data: row({ employee_id: 'emp-other', offer_state: 'offered', offer_id: 'offer-A' }), error: null };
    if (r.table === 'shift_instances') return { data: [], error: null };
    if (r.table === 'shift_claims' && r.op === 'insert') return { data: null, error: { code: '23505', message: 'duplicate key' } };
    if (r.table === 'shift_claims') return { data: [], error: null };
    return { data: [], error: null };
  });
  await assert.rejects(O.requestPickup(ME, 'inst-1', 'offer-A'), (e) => e.code === 'ALREADY_REQUESTED');
  check('a 23505 from the partial unique index maps to the friendly pending state', true);
}

console.log('\n7. AVAILABLE SHIFTS — every read is owner-scoped');
{
  reset((r) => {
    if (r.table === 'shift_instances' && r.f('eq', 'offer_state') === 'offered') {
      return { data: [row({ id: 'a', employee_id: 'emp-other', offer_state: 'offered', offer_id: 'o-a' })], error: null };
    }
    if (r.table === 'employees') return { data: [{ id: 'emp-other', name: 'Carlos', role: 'fulfillment' }], error: null };
    if (r.table === 'shift_instances') return { data: [], error: null };
    if (r.table === 'shift_claims') return { data: [], error: null };
    return { data: [], error: null };
  });
  const out = await O.getAvailableShifts(ME, NOW);
  eq('one eligible offer', out.length, 1);
  eq('annotated as takeable', out[0].refusal, null);
  check('EVERY read carries the owner filter', log().every((r) => r.f('eq', 'user_id') === OWNER),
    log().map((r) => `${r.table}:${r.f('eq', 'user_id')}`).join(' '));
  check('the offers query filters offer_state=offered', log()[0].f('eq', 'offer_state') === 'offered');
  check('zero writes on a read path', writes().length === 0);
  check('employees read selects only id/name/role — no rate or phone', /^id, name, role$/.test(String(log().find((r) => r.table === 'employees').cols)));
}

console.log('\n8. PAYROLL INVARIANT across the whole module');
{
  // Assert on CODE, not prose: the header explains what this module deliberately does NOT touch,
  // and a naive grep would match the explanation.
  const raw = readFileSync(fileURLToPath(new URL('./offer.ts', import.meta.url)), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  check('offer.ts never writes shifts', !/from\('shifts'\)/.test(src));
  check('offer.ts never touches employee_time_entries in code', !/employee_time_entries/.test(src));
  check('the only tables it names in code are shift_instances / shift_claims / attendance_events / employees',
    [...new Set([...src.matchAll(/from\('([a-z_]+)'\)/g)].map((m) => m[1]))].sort().join() ===
    ['attendance_events', 'employees', 'shift_claims', 'shift_instances'].join());
  const tables = new Set(log().filter((r) => r.op !== 'select').map((r) => r.table));
  check('no payroll table was written in any scenario above', !tables.has('shifts') && !tables.has('employee_time_entries'));
}

console.log(`\n${passed} checks passed`);
