// CROSS-TENANT ISOLATION for the release/claim subsystem.
//
// Two real leaks were found in the Phase 2 audit and are fixed here:
//   getBoard          — selected EVERY released instance in the database (no user_id filter at all,
//                       `grep -c user_id board.ts` returned 0), then narrowed in JS by role. Role is
//                       a global string, so another account's shift reached the board and its
//                       releaser's NAME was fetched to render beside it.
//   manager claim ops — listPendingClaims/approveClaim/rejectClaim took the manager's uid but used
//                       it only to STAMP approved_by, never to filter. Any admin could list,
//                       approve or reject any other account's claim by id.
//
// These run service-role (RLS bypassed), so the explicit user_id predicate IS the boundary. The
// fake client is STATEFUL and holds TWO accounts' rows at once, so a missing filter shows up as
// foreign data in the result — not as a mocked assumption.
//
// Run:  TZ=UTC node src/lib/schedule/tenantScope.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'tenant-'));
const write = (n, s) => { const p = join(dir, n); writeFileSync(p, s); return pathToFileURL(p).href; };
function transpile(rel, out, rw = {}) {
  const src = fileURLToPath(new URL(rel, import.meta.url));
  let { outputText } = ts.transpileModule(readFileSync(src, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  for (const [f, t] of Object.entries(rw)) outputText = outputText.split(f).join(t);
  return write(out, outputText);
}
const serverOnly = write('so.mjs', 'export {};\n');
const adminStub = write('admin.mjs', 'export function createAdminClient(){ return globalThis.__DB; }\n');
const smsStub = write('sms.mjs', `
export async function broadcastShiftReleased(){ return { recipients: 0, sent: 0 }; }
export async function sendSms(){ globalThis.__SMS.push([...arguments]); return true; }
export function tokenLink(){ return ''; }
export function claimApprovedMessage(){ return ''; }
`);
const timezone = transpile('./timezone.ts', 'tz.mjs');
const employees = transpile('../employees.ts', 'emp.mjs');
const eligibility = transpile('./eligibility.ts', 'elig.mjs');
const drops = transpile('./drops.ts', 'drops.mjs');
const board = transpile('./board.ts', 'board.mjs', {
  "'server-only'": `'${serverOnly}'`, "'@/lib/supabase/admin'": `'${adminStub}'`,
  "'@/lib/employees'": `'${employees}'`, "'./timezone'": `'${timezone}'`,
  "'./drops'": `'${drops}'`, "'./eligibility'": `'${eligibility}'`,
});
const release = transpile('./release.ts', 'rel.mjs', {
  "'server-only'": `'${serverOnly}'`, "'@/lib/supabase/admin'": `'${adminStub}'`,
  "'@/lib/employees'": `'${employees}'`, "'./timezone'": `'${timezone}'`,
  "'./drops'": `'${drops}'`, "'./board'": `'${board}'`,
});
const adminShifts = transpile('./adminShifts.ts', 'as.mjs', {
  "'server-only'": `'${serverOnly}'`, "'@/lib/supabase/admin'": `'${adminStub}'`,
  "'@/lib/employees'": `'${employees}'`, "'./timezone'": `'${timezone}'`,
  "'./release'": `'${release}'`, "'./eligibility'": `'${eligibility}'`, "'./sms'": `'${smsStub}'`,
});
const { getBoard, getMyShifts, getMyPendingClaims, getCurrentPeriodDrops } = await import(board);
const { listPendingClaims, approveClaim, rejectClaim } = await import(adminShifts);
const { ScheduleError } = await import(release);

const DB = {};
const match = (row, fs) => fs.every(([k, c, v]) => {
  const cur = row[c];
  if (k === 'eq') return cur === v;
  if (k === 'in') return v.includes(cur);
  if (k === 'is') return v === null ? cur == null : cur === v;
  if (k === 'not') return !(cur == null);
  if (k === 'gt') return cur > v; if (k === 'gte') return cur >= v;
  if (k === 'lte') return cur <= v;
  return true;
});
class Q {
  constructor(t) { this.t = t; this.f = []; this.op = 'select'; }
  select() { return this; } order() { return this; } limit(n) { this.lim = n; return this; }
  eq(c, v) { this.f.push(['eq', c, v]); return this; }
  in(c, v) { this.f.push(['in', c, v]); return this; }
  is(c, v) { this.f.push(['is', c, v]); return this; }
  not(c, _o, v) { this.f.push(['not', c, v]); return this; }
  gt(c, v) { this.f.push(['gt', c, v]); return this; }
  gte(c, v) { this.f.push(['gte', c, v]); return this; }
  lte(c, v) { this.f.push(['lte', c, v]); return this; }
  insert(r) { this.op = 'insert'; this.rows = Array.isArray(r) ? r : [r]; return this; }
  update(p) { this.op = 'update'; this.patch = p; return this; }
  single() { this.one = true; return this; } maybeSingle() { this.one = true; return this; }
  then(res) {
    const tbl = DB[this.t] ?? (DB[this.t] = []);
    globalThis.__Q.push({ t: this.t, op: this.op, f: this.f });
    let out;
    if (this.op === 'insert') { const a = this.rows.map((r, i) => ({ id: r.id ?? `g${tbl.length + i}`, ...r })); tbl.push(...a); out = a; }
    else if (this.op === 'update') { const h = tbl.filter((r) => match(r, this.f)); h.forEach((r) => Object.assign(r, this.patch)); out = h; }
    else { out = tbl.filter((r) => match(r, this.f)); if (this.lim) out = out.slice(0, this.lim); }
    res({ data: this.one ? (out[0] ?? null) : out, error: null });
  }
}
globalThis.__DB = { from: (t) => new Q(t) };

let passed = 0;
const check = (n, c, e = '') => { assert.ok(c, `FAIL: ${n} ${e}`); console.log(`  ✓ ${n}${e ? ` — ${e}` : ''}`); passed++; };
const eq = (n, a, b) => check(n, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} == ${JSON.stringify(b)}`);

const OWNER_A = 'owner-A', OWNER_B = 'owner-B';
const ANA  = { id: 'ana',  user_id: OWNER_A, name: 'Ana',  role: 'fulfillment', status: 'active' };
const BEN  = { id: 'ben',  user_id: OWNER_A, name: 'Ben',  role: 'fulfillment', status: 'active' };
const RIVAL= { id: 'rival',user_id: OWNER_B, name: 'RivalCorpEmployee', role: 'fulfillment', status: 'active' };
// A second person in the OTHER account: RIVAL released i-B, and getBoard excludes your own
// release, so the symmetry check needs a different viewer inside owner B.
const RIVAL2 = { id: 'rival2', user_id: OWNER_B, name: 'RivalCoworker', role: 'fulfillment', status: 'active' };
const soon = (d, h = 0) => new Date(Date.now() + d * 86400_000 + h * 3600_000).toISOString();
const day  = (d) => new Date(Date.now() + d * 86400_000).toISOString().slice(0, 10);

function seed({ withClaims = true } = {}) {
  for (const k of Object.keys(DB)) delete DB[k];
  globalThis.__Q = []; globalThis.__SMS = [];
  DB.employees = [{ ...ANA }, { ...BEN }, { ...RIVAL }, { ...RIVAL2 }];
  DB.shift_instances = [
    // A's own released shift — Ben should see it.
    { id: 'i-A', user_id: OWNER_A, employee_id: null, shift_date: day(5), starts_at: soon(5), ends_at: soon(5, 8),
      status: 'released', source: 'pattern', released_at: soon(-1), released_by: ANA.id, role: null, shift_rule_id: 'r' },
    // ANOTHER ACCOUNT's released shift, same role class, same window — must never appear.
    { id: 'i-B', user_id: OWNER_B, employee_id: null, shift_date: day(5), starts_at: soon(5), ends_at: soon(5, 8),
      status: 'released', source: 'pattern', released_at: soon(-1), released_by: RIVAL.id, role: null, shift_rule_id: 'r' },
  ];
  // getBoard deliberately hides a shift the viewer already has a pending claim on, so the board
  // blocks seed without them; the manager blocks need them.
  DB.shift_claims = withClaims ? [
    { id: 'c-A', user_id: OWNER_A, shift_instance_id: 'i-A', claimed_by: BEN.id,   status: 'pending', projected_week_hours: 44 },
    { id: 'c-B', user_id: OWNER_B, shift_instance_id: 'i-B', claimed_by: RIVAL.id, status: 'pending', projected_week_hours: 44 },
  ] : [];
  DB.attendance_events = [
    { id: 'e-A', user_id: OWNER_A, employee_id: ANA.id,   shift_date: day(5), event_type: 'released', pay_period_start: '2000-01-01' },
    { id: 'e-B', user_id: OWNER_B, employee_id: RIVAL.id, shift_date: day(5), event_type: 'released', pay_period_start: '2000-01-01' },
  ];
}

console.log('\nFIX 2 — the released-shift board is owner-scoped');
{
  seed({ withClaims: false });
  const rows = await getBoard({ ...BEN });
  eq('Ben sees his OWN account\'s released shift', rows.map((r) => r.id), ['i-A']);
  check('the FOREIGN shift is absent', !rows.some((r) => r.id === 'i-B'));
  check('no foreign employee NAME appears anywhere in the payload', !JSON.stringify(rows).includes('RivalCorpEmployee'));
  eq('the releaser name shown is the same-owner one', rows[0].releaser_name, 'Ana');
  const boardQs = globalThis.__Q.filter((q) => q.op === 'select');
  check('EVERY query getBoard issued carried a user_id predicate',
    boardQs.every((q) => q.f.some(([k, c]) => k === 'eq' && c === 'user_id')),
    `${boardQs.length} queries checked`);

  // The decisive one: with the owner filter removed the foreign row WOULD have matched.
  const wouldMatch = DB.shift_instances.filter((r) => r.status === 'released');
  eq('pre-fix, an unscoped scan would have returned BOTH accounts', wouldMatch.map((r) => r.id), ['i-A', 'i-B']);
}
{
  seed({ withClaims: false });
  const rows = await getBoard({ ...RIVAL2 });
  eq('the other account\'s employee sees only THEIR shift', rows.map((r) => r.id), ['i-B']);
  check('isolation holds symmetrically — no same-name leak the other way', !JSON.stringify(rows).includes('Ana'));
}
{
  seed({ withClaims: false });
  check('getBoard refuses an employee with no user_id rather than running unscoped',
    await getBoard({ ...BEN, user_id: undefined }).then(() => false).catch((e) => /no user_id/.test(e.message)));
}

console.log('\nFIX 2b — the rest of board.ts is scoped too');
{
  seed();
  DB.shift_instances.push({ id: 'mine', user_id: OWNER_A, employee_id: BEN.id, shift_date: day(3), starts_at: soon(3), ends_at: soon(3, 8), status: 'scheduled', source: 'pattern', released_at: null, released_by: null });
  DB.shift_instances.push({ id: 'theirs', user_id: OWNER_B, employee_id: BEN.id, shift_date: day(4), starts_at: soon(4), ends_at: soon(4, 8), status: 'scheduled', source: 'pattern', released_at: null, released_by: null });
  const mine = await getMyShifts({ ...BEN });
  eq('getMyShifts returns only same-owner rows even for a shared employee id', mine.map((r) => r.id), ['mine']);
  globalThis.__Q = [];
  const pend = await getMyPendingClaims({ ...BEN });
  eq('getMyPendingClaims returns the same-owner claim', pend.map((p) => p.claim_id), ['c-A']);
  check('and every query it issued was owner-scoped', globalThis.__Q.every((q) => q.f.some(([k, c]) => k === 'eq' && c === 'user_id')));
  globalThis.__Q = [];
  await getCurrentPeriodDrops({ ...ANA });
  check('getCurrentPeriodDrops is owner-scoped', globalThis.__Q.every((q) => q.f.some(([k, c]) => k === 'eq' && c === 'user_id')));
}

console.log('\nFIX 3 — manager claim operations are owner-scoped');
{
  seed();
  const listed = await listPendingClaims(OWNER_A);
  eq('manager A sees only their own pending claim', listed.map((c) => c.claim_id), ['c-A']);
  eq('with the same-owner claimer name', listed[0].claimer_name, 'Ben');
  check('no foreign claim or name leaks', !JSON.stringify(listed).includes('RivalCorpEmployee'));
  const listedB = await listPendingClaims(OWNER_B);
  eq('manager B sees only theirs', listedB.map((c) => c.claim_id), ['c-B']);
  eq('pre-fix, an unscoped list would have returned BOTH', DB.shift_claims.filter((c) => c.status === 'pending').length, 2);
  await assert.rejects(listPendingClaims(''), (e) => e instanceof ScheduleError && e.code === 'OWNER_REQUIRED');
  check('an empty owner is refused rather than running unscoped', true);
}
{
  seed();
  await assert.rejects(approveClaim('c-B', OWNER_A), (e) => e instanceof ScheduleError && e.code === 'NOT_FOUND');
  check('manager A CANNOT approve account B\'s claim', true);
  eq('and account B\'s instance was NOT mutated', [DB.shift_instances.find((r) => r.id === 'i-B').status, DB.shift_instances.find((r) => r.id === 'i-B').employee_id], ['released', null]);
  eq('and account B\'s claim is still pending', DB.shift_claims.find((c) => c.id === 'c-B').status, 'pending');
  check('zero mutations were issued at all', !globalThis.__Q.some((q) => q.op === 'update'));
  check('a foreign claim is reported as NOT_FOUND — the manager learns nothing about it', true);
}
{
  seed();
  await approveClaim('c-A', OWNER_A);
  const i = DB.shift_instances.find((r) => r.id === 'i-A');
  eq('same-owner approval still works', [i.status, i.employee_id], ['claimed', BEN.id]);
  eq('and clears released_at (Fix 1 holds on the manager path)', i.released_at, null);
  const c = DB.shift_claims.find((x) => x.id === 'c-A');
  eq('claim marked approved', c.status, 'approved');
  eq('approved_by still stamps the authenticated manager', c.approved_by, OWNER_A);
}
{
  seed();
  await assert.rejects(rejectClaim('c-B', OWNER_A), (e) => e instanceof ScheduleError && e.code === 'NOT_FOUND');
  check('manager A CANNOT reject account B\'s claim', true);
  eq('account B\'s claim untouched', DB.shift_claims.find((c) => c.id === 'c-B').status, 'pending');
  check('zero mutations', !globalThis.__Q.some((q) => q.op === 'update'));
}
{
  seed();
  await rejectClaim('c-A', OWNER_A);
  const c = DB.shift_claims.find((x) => x.id === 'c-A');
  eq('same-owner rejection still works', c.status, 'rejected');
  eq('approved_by stamps the manager', c.approved_by, OWNER_A);
  eq('the instance stays released, back on the board', DB.shift_instances.find((r) => r.id === 'i-A').status, 'released');
}
{
  seed();
  await assert.rejects(approveClaim('does-not-exist', OWNER_A), (e) => e instanceof ScheduleError && e.code === 'NOT_FOUND');
  check('a nonexistent claim id is a clean NOT_FOUND, not a crash', true);
  DB.shift_claims.push({ id: 'c-done', user_id: OWNER_A, shift_instance_id: 'i-A', claimed_by: BEN.id, status: 'approved' });
  await assert.rejects(approveClaim('c-done', OWNER_A), (e) => e instanceof ScheduleError && e.code === 'NOT_PENDING');
  check('an already-decided claim is NOT_PENDING', true);
  await assert.rejects(approveClaim('c-A', ''), (e) => e instanceof ScheduleError && e.code === 'OWNER_REQUIRED');
  await assert.rejects(rejectClaim('c-A', ''), (e) => e instanceof ScheduleError && e.code === 'OWNER_REQUIRED');
  check('both refuse an empty owner rather than running unscoped', true);
}
{
  // The ownership CHAIN: a claim whose user_id was somehow wrong must still fail, because the
  // instance is the authority.
  seed();
  DB.shift_claims.push({ id: 'c-forged', user_id: OWNER_A, shift_instance_id: 'i-B', claimed_by: BEN.id, status: 'pending' });
  await assert.rejects(approveClaim('c-forged', OWNER_A), (e) => e instanceof ScheduleError);
  eq('a claim mislabelled as ours cannot transfer ANOTHER account\'s instance', DB.shift_instances.find((r) => r.id === 'i-B').status, 'released');
  seed();
  DB.shift_claims.push({ id: 'c-forged2', user_id: OWNER_A, shift_instance_id: 'i-B', claimed_by: BEN.id, status: 'pending' });
  await assert.rejects(rejectClaim('c-forged2', OWNER_A), (e) => e instanceof ScheduleError && e.code === 'NOT_FOUND');
  check('reject proves the chain via the instance too', true);
}

console.log('\nPAYROLL — none of this touches pay');
{
  seed();
  await approveClaim('c-A', OWNER_A);
  check('no `shifts` write', !globalThis.__Q.some((q) => q.t === 'shifts' && q.op !== 'select'));
  check('no `employee_time_entries` write', !globalThis.__Q.some((q) => q.t === 'employee_time_entries' && q.op !== 'select'));
}

console.log(`\n${passed} checks passed`);
