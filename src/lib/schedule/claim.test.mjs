// claimShift: race guard, owner scope, refusal codes, and the OT branch's non-effects.
// Exercises the REAL claim.ts (transpiled at runtime, same pattern as labor.test.mjs) against a
// recording fake Supabase client. Pure dependencies (timezone, otGate, hours, employees) are the
// REAL modules; only the I/O edges — 'server-only' and the admin client — are stubbed.
//
// The point of this suite is the invariants that fail SILENTLY:
//   • the guard lives in the UPDATE's WHERE, not in the read-time status check
//   • the UPDATE is owner-scoped and uses .select() + .maybeSingle(), never .or()
//   • the OT path writes NO 'claimed' attendance_event (drop-netting depends on it)
//
// Run:  node src/lib/schedule/claim.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'claim-'));
const write = (name, src) => {
  const p = join(dir, name);
  writeFileSync(p, src);
  return pathToFileURL(p).href;
};
function transpile(srcRel, outName, rewrites = {}) {
  const srcPath = fileURLToPath(new URL(srcRel, import.meta.url));
  let { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  for (const [from, to] of Object.entries(rewrites)) outputText = outputText.split(from).join(to);
  return write(outName, outputText);
}

// ── stubs for the I/O edges only ──
const serverOnlyUrl = write('server-only.mjs', 'export default {};\n');
const dropsUrl = write('drops.mjs', 'export function computeDrops() { return {}; }\n');
// The admin stub reads a mutable `current` handler set by each scenario.
const adminUrl = write('admin.mjs', `
export let current = null;
export function setClient(c) { current = c; }
export function createAdminClient() { return current; }
`);

// ── real modules ──
const timezoneUrl = transpile('./timezone.ts', 'timezone.mjs');
const otGateUrl = transpile('./otGate.ts', 'otGate.mjs');
const employeesUrl = transpile('../employees.ts', 'employees.mjs');
const hoursUrl = transpile('./hours.ts', 'hours.mjs', {
  "'@/lib/employees'": `'${employeesUrl}'`,
  "'./timezone'": `'${timezoneUrl}'`,
});
const commonRewrites = {
  "'server-only'": `'${serverOnlyUrl}'`,
  "'@/lib/supabase/admin'": `'${adminUrl}'`,
  "'@/lib/employees'": `'${employeesUrl}'`,
  "'./timezone'": `'${timezoneUrl}'`,
  "'./drops'": `'${dropsUrl}'`,
};
const boardUrl = transpile('./board.ts', 'board.mjs', commonRewrites);
const releaseUrl = transpile('./release.ts', 'release.mjs', { ...commonRewrites, "'./board'": `'${boardUrl}'` });
const claimUrl = transpile('./claim.ts', 'claim.mjs', {
  ...commonRewrites,
  "'./board'": `'${boardUrl}'`,
  "'./release'": `'${releaseUrl}'`,
  "'./hours'": `'${hoursUrl}'`,
  "'./otGate'": `'${otGateUrl}'`,
});

const { claimShift } = await import(claimUrl);
const { setClient } = await import(adminUrl);
const { NOTICE_MS } = await import(boardUrl);

// ── recording fake Supabase client ─────────────────────────────────────────
// Chainable + thenable, so it satisfies both `await q.maybeSingle()` and a bare `await q`.
// Every call is recorded so tests can assert on the PREDICATE, not just the outcome.
function makeClient(handlers) {
  const calls = [];
  const client = {
    from(table) {
      const rec = { table, op: 'select', filters: [], payload: null, terminal: null };
      calls.push(rec);
      const q = {
        select(cols) { rec.cols = cols; return q; },
        update(p) { rec.op = 'update'; rec.payload = p; return q; },
        insert(p) { rec.op = 'insert'; rec.payload = p; return q; },
        eq(c, v) { rec.filters.push(['eq', c, v]); return q; },
        is(c, v) { rec.filters.push(['is', c, v]); return q; },
        in(c, v) { rec.filters.push(['in', c, v]); return q; },
        gte(c, v) { rec.filters.push(['gte', c, v]); return q; },
        lte(c, v) { rec.filters.push(['lte', c, v]); return q; },
        or() { rec.filters.push(['or']); return q; }, // present ONLY so misuse is detectable
        limit(n) { rec.terminal = `limit(${n})`; return q.then.call(q, (x) => x); },
        maybeSingle() { rec.terminal = 'maybeSingle'; return Promise.resolve(resolve(rec)); },
        then(res, rej) { return Promise.resolve(resolve(rec)).then(res, rej); },
      };
      return q;
    },
  };
  function resolve(rec) {
    const h = handlers[`${rec.table}.${rec.op}`];
    const out = typeof h === 'function' ? h(rec) : h;
    return out ?? { data: null, error: null };
  }
  return { client, calls };
}

// Serialize explicitly: a bare join(':') renders null as '' and would make the
// `.is('employee_id', null)` guard indistinguishable from an absent value.
const filtersOf = (rec) =>
  rec.filters.map((f) => f.map((x) => (Array.isArray(x) ? x.join('|') : String(x))).join(':'));
const findCall = (calls, table, op) => calls.find((c) => c.table === table && c.op === op);

const EMPLOYEE = { id: 'emp-claimer', user_id: 'owner-1', name: 'Ada', role: 'fulfillment', hourly_rate: 20 };
const FAR = new Date(Date.now() + 10 * 24 * 3600 * 1000); // well outside the 24h notice window
const farISO = (h) => new Date(FAR.getTime() + h * 3600 * 1000).toISOString();
const shiftDate = FAR.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

// A released instance owned by owner-1, released by a DIFFERENT fulfillment employee.
const INSTANCE = {
  id: 'inst-1', status: 'released', starts_at: farISO(0), ends_at: farISO(8),
  shift_date: shiftDate, user_id: 'owner-1', released_by: 'emp-releaser',
};

// Default handler set: eligible claimer, no same-day conflict, light week, claim wins the race.
function baseHandlers(over = {}) {
  return {
    'shift_instances.select': (rec) => {
      const f = filtersOf(rec);
      if (f.some((x) => x.startsWith('eq:id:'))) return { data: INSTANCE, error: null };
      if (f.some((x) => x.startsWith('gte:shift_date'))) return { data: [], error: null }; // week rows
      return { data: [], error: null };                                                    // same-day
    },
    'employees.select': { data: { role: 'fulfillment' }, error: null },
    'shift_instances.update': { data: { id: 'inst-1', shift_date: shiftDate, user_id: 'owner-1' }, error: null },
    'shift_claims.select': { data: [], error: null },
    'shift_claims.insert': { data: null, error: null },
    'attendance_events.insert': { data: null, error: null },
    ...over,
  };
}

let passed = 0;
function check(label, cond) {
  assert.ok(cond, `FAIL: ${label}`);
  console.log(`  ✓ ${label}`);
  passed++;
}
async function rejectsWith(label, code, run) {
  let got = null;
  try { await run(); } catch (e) { got = e?.code ?? e?.message; }
  check(`${label} → ${code}`, got === code);
}

// ── 1. THE RACE GUARD lives in the UPDATE ──────────────────────────────────
console.log('1 — race guard predicate');
{
  const { client, calls } = makeClient(baseHandlers());
  setClient(client);
  const res = await claimShift(EMPLOYEE, 'inst-1');
  check('auto-approve returns claimed', res.result === 'claimed');

  const upd = findCall(calls, 'shift_instances', 'update');
  const f = filtersOf(upd);
  check("UPDATE carries eq:status:released (THE guard)", f.includes('eq:status:released'));
  check("UPDATE carries is:employee_id:null (second guard)", f.includes('is:employee_id:null'));
  check('UPDATE is owner-scoped', f.includes('eq:user_id:owner-1'));
  check('UPDATE targets the instance', f.includes('eq:id:inst-1'));
  check('UPDATE uses .select() (else no row count)', typeof upd.cols === 'string' && upd.cols.length > 0);
  check('UPDATE ends in maybeSingle, not single', upd.terminal === 'maybeSingle');
  check('UPDATE never uses .or()', !f.some((x) => x.startsWith('or')));
  check('UPDATE assigns the claimer', upd.payload.employee_id === 'emp-claimer' && upd.payload.status === 'claimed');
}

// ── 2. Losing the race is clean, not an overwrite ──────────────────────────
console.log('2 — lost race');
{
  // The read still sees 'released' (stale, as in a real race) but the UPDATE matches 0 rows.
  const { client } = makeClient(baseHandlers({ 'shift_instances.update': { data: null, error: null } }));
  setClient(client);
  await rejectsWith('read says released but UPDATE matches nothing', 'ALREADY_CLAIMED',
    () => claimShift(EMPLOYEE, 'inst-1'));
}

// ── 3. Owner scoping on the reads ──────────────────────────────────────────
console.log('3 — owner scope');
{
  const { client, calls } = makeClient(baseHandlers());
  setClient(client);
  await claimShift(EMPLOYEE, 'inst-1');
  const read = calls.find((c) => c.table === 'shift_instances' && c.op === 'select');
  check('instance read is owner-scoped', filtersOf(read).includes('eq:user_id:owner-1'));
  const emp = findCall(calls, 'employees', 'select');
  check('releaser lookup is owner-scoped', filtersOf(emp).includes('eq:user_id:owner-1'));
}
{
  // A foreign instance is invisible under the owner filter → NOT_FOUND, never a cross-tenant claim.
  const { client } = makeClient(baseHandlers({ 'shift_instances.select': { data: null, error: null } }));
  setClient(client);
  await rejectsWith("another owner's instance", 'NOT_FOUND', () => claimShift(EMPLOYEE, 'inst-1'));
}

// ── 4. OT path: pending, and NO attendance event ───────────────────────────
console.log('4 — OT path non-effects');
{
  // 36h already scheduled + an 8h claim = 44h projected → over the 40h threshold.
  const weekRows = [{ starts_at: farISO(-100), ends_at: farISO(-100 + 36) }];
  const { client, calls } = makeClient(baseHandlers({
    'shift_instances.select': (rec) => {
      const f = filtersOf(rec);
      if (f.some((x) => x.startsWith('eq:id:'))) return { data: INSTANCE, error: null };
      if (f.some((x) => x.startsWith('gte:shift_date'))) return { data: weekRows, error: null };
      return { data: [], error: null };
    },
  }));
  setClient(client);
  const res = await claimShift(EMPLOYEE, 'inst-1');
  check('over 40h returns pending_approval', res.result === 'pending_approval');
  check('projected hours reported', res.projected_week_hours === 44);
  check('instance is NOT flipped', !findCall(calls, 'shift_instances', 'update'));
  check('NO claimed attendance_event (drop-netting)', !findCall(calls, 'attendance_events', 'insert'));
  const cl = findCall(calls, 'shift_claims', 'insert');
  check('pending claim recorded', cl && cl.payload.status === 'pending');
}

// ── 5. Duplicate pending OT claim is idempotent ────────────────────────────
console.log('5 — duplicate pending guard');
{
  const weekRows = [{ starts_at: farISO(-100), ends_at: farISO(-100 + 36) }];
  const { client, calls } = makeClient(baseHandlers({
    'shift_instances.select': (rec) => {
      const f = filtersOf(rec);
      if (f.some((x) => x.startsWith('eq:id:'))) return { data: INSTANCE, error: null };
      if (f.some((x) => x.startsWith('gte:shift_date'))) return { data: weekRows, error: null };
      return { data: [], error: null };
    },
    'shift_claims.select': { data: [{ id: 'claim-existing' }], error: null }, // already queued
  }));
  setClient(client);
  const res = await claimShift(EMPLOYEE, 'inst-1');
  check('still reports pending_approval', res.result === 'pending_approval');
  check('does NOT insert a second pending row', !findCall(calls, 'shift_claims', 'insert'));
  const dup = findCall(calls, 'shift_claims', 'select');
  check('dup check keys on the CLAIMER too', filtersOf(dup).includes('eq:claimed_by:emp-claimer'));
}

// ── 6. Auto-approve boundary: exactly 40h is straight time ─────────────────
console.log('6 — 40h boundary');
{
  const weekRows = [{ starts_at: farISO(-100), ends_at: farISO(-100 + 32) }]; // 32 + 8 = exactly 40
  const { client, calls } = makeClient(baseHandlers({
    'shift_instances.select': (rec) => {
      const f = filtersOf(rec);
      if (f.some((x) => x.startsWith('eq:id:'))) return { data: INSTANCE, error: null };
      if (f.some((x) => x.startsWith('gte:shift_date'))) return { data: weekRows, error: null };
      return { data: [], error: null };
    },
  }));
  setClient(client);
  const res = await claimShift(EMPLOYEE, 'inst-1');
  check('exactly 40h auto-approves', res.result === 'claimed' && res.projected_week_hours === 40);
  check('claim recorded as auto_approved', findCall(calls, 'shift_claims', 'insert').payload.status === 'auto_approved');
  check('claimed attendance_event written', !!findCall(calls, 'attendance_events', 'insert'));
}

// ── 7. Refusal codes ───────────────────────────────────────────────────────
console.log('7 — refusals');
{
  const own = { ...INSTANCE, released_by: EMPLOYEE.id };
  const { client } = makeClient(baseHandlers({ 'shift_instances.select': { data: own, error: null } }));
  setClient(client);
  await rejectsWith('claiming your own release', 'OWN_RELEASE', () => claimShift(EMPLOYEE, 'inst-1'));
}
{
  const { client } = makeClient(baseHandlers({ 'employees.select': { data: { role: 'host' }, error: null } }));
  setClient(client);
  await rejectsWith('releaser is a different role', 'WRONG_ROLE', () => claimShift(EMPLOYEE, 'inst-1'));
}
{
  // Exactly at the notice boundary — the check is `<=`, so this must refuse.
  const soon = { ...INSTANCE, starts_at: new Date(Date.now() + NOTICE_MS).toISOString() };
  const { client } = makeClient(baseHandlers({ 'shift_instances.select': { data: soon, error: null } }));
  setClient(client);
  await rejectsWith('starts exactly at the 24h boundary', 'TOO_LATE', () => claimShift(EMPLOYEE, 'inst-1'));
}
{
  const { client } = makeClient(baseHandlers({
    'shift_instances.select': (rec) => {
      const f = filtersOf(rec);
      if (f.some((x) => x.startsWith('eq:id:'))) return { data: INSTANCE, error: null };
      if (f.some((x) => x.startsWith('gte:shift_date'))) return { data: [], error: null };
      return { data: [{ id: 'other' }], error: null }; // same-day conflict
    },
  }));
  setClient(client);
  await rejectsWith('already working that day', 'ALREADY_WORKING_THAT_DAY', () => claimShift(EMPLOYEE, 'inst-1'));
}
{
  const gone = { ...INSTANCE, status: 'claimed' };
  const { client } = makeClient(baseHandlers({ 'shift_instances.select': { data: gone, error: null } }));
  setClient(client);
  await rejectsWith('already claimed at read time (fast path)', 'ALREADY_CLAIMED', () => claimShift(EMPLOYEE, 'inst-1'));
}
{
  const { client } = makeClient(baseHandlers({
    'shift_instances.select': { data: null, error: { message: 'boom' } },
  }));
  setClient(client);
  await rejectsWith('read failure', 'READ_FAILED', () => claimShift(EMPLOYEE, 'inst-1'));
}

// ── 8. Post-flip tail failures are LOUD, never swallowed ───────────────────
console.log('8 — post-flip tail');
{
  const { client } = makeClient(baseHandlers({
    'shift_claims.insert': { data: null, error: { message: 'claims table down' } },
  }));
  setClient(client);
  await rejectsWith('shift_claims insert fails after the flip', 'CLAIM_RECORD_FAILED',
    () => claimShift(EMPLOYEE, 'inst-1'));
}
{
  const { client } = makeClient(baseHandlers({
    'attendance_events.insert': { data: null, error: { message: 'events table down' } },
  }));
  setClient(client);
  await rejectsWith('attendance_events insert fails after the flip', 'EVENT_WRITE_FAILED',
    () => claimShift(EMPLOYEE, 'inst-1'));
}

console.log(`\nclaim.test.mjs — ${passed} assertions passed`);
