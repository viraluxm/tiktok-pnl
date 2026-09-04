// claimShift: race guard, owner scope, refusal codes, OT non-effects, duplicate-pending guard.
//
// Exercises the REAL claim.ts (and the real timezone/otGate/eligibility/hours/board/release/
// employees/format modules), transpiled at runtime — the repo's .test.mjs pattern. Only
// 'server-only', the Supabase admin client and the SMS sender are stubbed: the first two are
// environment, the third would send a text message.
//
// The fake client RECORDS every filter, so these tests assert the PREDICATE, not just the
// outcome. That is the point: a green suite that still passes with the race guard deleted is
// worthless, so the guard's shape is asserted directly (and mutation-checked in CI-by-hand:
// remove either UPDATE guard and "race guard predicate" must fail).
//
// Run:  TZ=UTC node src/lib/schedule/claim.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'claim-'));
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
const smsStub    = write('smsStub.mjs',
  'export async function sendAlertSms(){ globalThis.__SMS = (globalThis.__SMS||0)+1; }\n');
// release.ts now imports DROP_CAP alongside computeDrops for its cap gate, so the stub must
// provide both. computeDrops returns a full ZERO summary rather than {}: with `{}`, drops.drops is
// undefined and `undefined >= DROP_CAP` is false, so the gate would appear to pass for the wrong
// reason. A real zero makes these claim tests run against "no drops used", which is what they mean.
const dropsStub  = write('dropsStub.mjs',
  'export const DROP_CAP = 2;\n' +
  'export function computeDrops(){ return { releases: 0, claims: 0, excused: 0, drops: 0 }; }\n');

// ── real modules ──
const employees   = transpile('../employees.ts',  'employees.mjs');
const timezone    = transpile('./timezone.ts',    'timezone.mjs');
const otGate      = transpile('./otGate.ts',      'otGate.mjs');
const eligibility = transpile('./eligibility.ts', 'eligibility.mjs');
const format      = transpile('./format.ts',      'format.mjs',   { "'./timezone'": `'${timezone}'` });
const hours       = transpile('./hours.ts',       'hours.mjs',    { "'@/lib/employees'": `'${employees}'`, "'./timezone'": `'${timezone}'` });
const boardBase   = { "'server-only'": `'${serverOnly}'`, "'@/lib/supabase/admin'": `'${adminStub}'`,
                      "'@/lib/employees'": `'${employees}'`, "'./timezone'": `'${timezone}'`,
                      "'./drops'": `'${dropsStub}'`, "'./eligibility'": `'${eligibility}'` };
const board       = transpile('./board.ts',   'board.mjs',   boardBase);
const release     = transpile('./release.ts', 'release.mjs', { ...boardBase, "'./board'": `'${board}'` });
const claimUrl    = transpile('./claim.ts',   'claim.mjs',   {
  ...boardBase,
  "'./board'": `'${board}'`, "'./hours'": `'${hours}'`, "'./release'": `'${release}'`,
  "'./otGate'": `'${otGate}'`, "'./eligibility'": `'${eligibility}'`,
  "'@/lib/live/alertSms'": `'${smsStub}'`, "'./format'": `'${format}'`,
});
const { claimShift } = await import(claimUrl);

// ─────────────────────────────────────────────────────────────────────────────
// Fake PostgREST builder. Every filter is recorded; `script(rec)` decides the reply.
// `or()` exists ONLY so that misuse is detectable — claim.ts must never call it on an update.
// ─────────────────────────────────────────────────────────────────────────────
function makeDb(script) {
  const calls = [];
  const from = (table) => {
    const rec = { table, op: 'select', filters: [], payload: null, cols: null, single: false, limit: null };
    calls.push(rec);
    const push = (kind, col, val) => { rec.filters.push([kind, col, val]); return api; };
    const settle = () => Promise.resolve(script(rec, calls) ?? { data: null, error: null });
    const api = {
      select: (c) => { rec.cols = c; return api; },
      update: (p) => { rec.op = 'update'; rec.payload = p; return api; },
      insert: (p) => { rec.op = 'insert'; rec.payload = p; return settle(); },
      eq: (c, v) => push('eq', c, v),
      is: (c, v) => push('is', c, v),
      in: (c, v) => push('in', c, v),
      gte: (c, v) => push('gte', c, v),
      lte: (c, v) => push('lte', c, v),
      or: (x) => push('or', x, null),
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

const HOUR = 3600_000;
const EMP = { id: 'emp-claimer', user_id: 'owner-1', name: 'Cass', role: 'fulfillment', hourly_rate: 20 };
const FAR = () => new Date(Date.now() + 96 * HOUR).toISOString();   // well outside the 24h notice
const inst = (o = {}) => ({
  id: 'inst-1', status: 'released', starts_at: FAR(),
  ends_at: new Date(Date.parse(FAR()) + 8 * HOUR).toISOString(),
  shift_date: '2026-09-14', user_id: 'owner-1', released_by: 'emp-releaser',
  source: 'release', role: null, ...o,
});

// Default happy-path script: released instance, matching releaser role, no same-day, no week hours.
function baseScript(over = {}) {
  const o = { instance: inst(), releaserRole: 'fulfillment', sameDay: [], weekRows: [], won: { id: 'inst-1', shift_date: '2026-09-14', user_id: 'owner-1' }, dupe: [], ...over };
  return (rec) => {
    if (rec.table === 'shift_instances' && rec.op === 'select' && rec.single) return { data: o.instance, error: null };
    if (rec.table === 'employees') return { data: o.releaserRole ? { role: o.releaserRole } : null, error: null };
    if (rec.table === 'shift_instances' && rec.op === 'select' && rec.limit === 1) return { data: o.sameDay, error: null };
    if (rec.table === 'shift_instances' && rec.op === 'select') return { data: o.weekRows, error: null };
    if (rec.table === 'shift_instances' && rec.op === 'update') return { data: o.won, error: null };
    if (rec.table === 'shift_claims' && rec.op === 'select') return { data: o.dupe, error: null };
    return { data: null, error: null };
  };
}
const run = async (over) => { const { db, calls } = makeDb(baseScript(over)); globalThis.__DB = db; globalThis.__SMS = 0; return { calls, out: await claimShift(EMP, 'inst-1').then((r) => ({ ok: r }), (e) => ({ err: e })) }; };

let n = 0; const ok = (m) => { n++; console.log('  ✓', m); };

// ── 1. THE RACE GUARD PREDICATE. Mutation target: delete either UPDATE guard → this fails. ──
{
  const { calls, out } = await run();
  assert.ok(out.ok, 'happy path should claim');
  const [u] = find(calls, 'shift_instances', 'update');
  assert.ok(u, 'an UPDATE must be issued');
  assert.ok(has(u, 'eq', 'status', 'released'), 'GUARD: UPDATE must carry .eq(status,released)');
  assert.ok(has(u, 'is', 'employee_id', null), 'GUARD: UPDATE must carry .is(employee_id,null)');
  assert.ok(has(u, 'eq', 'user_id', 'owner-1'), 'GUARD: UPDATE must be owner-scoped');
  assert.ok(has(u, 'eq', 'id', 'inst-1'), 'UPDATE must target the instance');
  assert.ok(u.single, 'UPDATE must use maybeSingle (0 rows = lost race, not a throw)');
  assert.ok(u.cols, 'UPDATE must .select() or the loser is undetectable');
  assert.ok(!u.filters.some(([k]) => k === 'or'), 'NEVER .or() on an update (PostgREST 42703)');
  ok('race guard predicate: status+employee_id-null+owner scope, select/maybeSingle, no .or()');
}
// ── 2. Lost race: UPDATE matches 0 rows → clean ALREADY_CLAIMED, not a 500 ──
{
  const { out } = await run({ won: null });
  assert.equal(out.err?.code, 'ALREADY_CLAIMED');
  ok('lost race (0 rows matched) -> ALREADY_CLAIMED');
}
// ── 3. Won race: claimed + both bookkeeping writes ──
{
  const { calls, out } = await run();
  assert.deepEqual(out.ok, { result: 'claimed', projected_week_hours: 8 });
  assert.equal(find(calls, 'shift_claims', 'insert').length, 1);
  assert.equal(find(calls, 'shift_claims', 'insert')[0].payload.status, 'auto_approved');
  assert.equal(find(calls, 'attendance_events', 'insert').length, 1);
  assert.equal(find(calls, 'attendance_events', 'insert')[0].payload.event_type, 'claimed');
  ok('auto-approve: claimed + shift_claims(auto_approved) + attendance_events(claimed)');
}
// ── 4. Owner scoping on BOTH reads ──
{
  const { calls } = await run();
  const r = find(calls, 'shift_instances', 'select')[0];
  assert.ok(has(r, 'eq', 'user_id', 'owner-1'), 'instance read must be owner-scoped');
  const e = find(calls, 'employees', 'select')[0];
  assert.ok(has(e, 'eq', 'user_id', 'owner-1'), 'releaser read must be owner-scoped');
  ok('owner scope on the instance read AND the releaser read');
}
// ── 5. OT path: pending, instance NOT flipped, NO attendance_event ──
{
  const wk = Array.from({ length: 4 }, () => ({ starts_at: FAR(), ends_at: new Date(Date.parse(FAR()) + 9 * HOUR).toISOString() }));
  const { calls, out } = await run({ weekRows: wk });
  assert.equal(out.ok.result, 'pending_approval');
  assert.equal(find(calls, 'shift_instances', 'update').length, 0, 'OT must NOT flip the instance');
  assert.equal(find(calls, 'attendance_events', 'insert').length, 0,
    'LOAD-BEARING: an unapproved claim must write NO claimed event (drop netting)');
  assert.equal(find(calls, 'shift_claims', 'insert')[0].payload.status, 'pending');
  ok('OT: pending_approval, no instance flip, NO claimed attendance_event');
}
// ── 6. Duplicate pending: no second insert, and no second manager SMS ──
{
  const wk = Array.from({ length: 4 }, () => ({ starts_at: FAR(), ends_at: new Date(Date.parse(FAR()) + 9 * HOUR).toISOString() }));
  const { calls, out } = await run({ weekRows: wk, dupe: [{ id: 'claim-existing' }] });
  assert.equal(out.ok.result, 'pending_approval', 'duplicate must return idempotently, not throw');
  assert.equal(find(calls, 'shift_claims', 'insert').length, 0, 'must NOT file a second pending row');
  assert.equal(globalThis.__SMS, 0, 'must NOT re-alert the manager for a duplicate');
  ok('duplicate pending: idempotent return, no second row, no second alert');
}
// ── 7. 40h is the TOP of straight time -> auto-approves ──
{
  const wk = Array.from({ length: 4 }, () => ({ starts_at: FAR(), ends_at: new Date(Date.parse(FAR()) + 8 * HOUR).toISOString() }));
  const { out } = await run({ weekRows: wk });
  assert.equal(out.ok.result, 'claimed', 'exactly 40h must auto-approve, not queue');
  assert.equal(out.ok.projected_week_hours, 40);
  ok('exactly 40h auto-approves (40 is straight time, OT begins above it)');
}
// ── 8. Refusal codes ──
for (const [label, over, code] of [
  ['own release',        { instance: inst({ released_by: EMP.id }) },        'OWN_RELEASE'],
  ['role mismatch',      { releaserRole: 'host' },                            'WRONG_ROLE'],
  ['not released',       { instance: inst({ status: 'scheduled' }) },         'ALREADY_CLAIMED'],
  ['missing instance',   { instance: null },                                  'NOT_FOUND'],
  ['inside notice',      { instance: inst({ starts_at: new Date(Date.now() + 2 * HOUR).toISOString() }) }, 'TOO_LATE'],
  ['already that day',   { sameDay: [{ id: 'other' }] },                      'ALREADY_WORKING_THAT_DAY'],
]) {
  const { out } = await run(over);
  assert.equal(out.err?.code, code, `${label} -> ${code}`);
  ok(`refusal: ${label} -> ${code}`);
}
// ── 9. REGRESSION GUARD for main's deliberate removal: an admin-posted open shift has
//        released_by = NULL and must still be claimable (role comes from the row itself). ──
{
  const { out } = await run({ instance: inst({ released_by: null, source: 'admin_open', role: 'fulfillment' }), releaserRole: null });
  assert.ok(out.ok, `admin_open shift must be claimable, got ${out.err?.code}`);
  assert.equal(out.ok.result, 'claimed');
  ok('admin_open (released_by NULL) is claimable — main’s removed !released_by throw stays removed');
}
console.log(`\nclaim.test.mjs: ${n} checks passed`);
