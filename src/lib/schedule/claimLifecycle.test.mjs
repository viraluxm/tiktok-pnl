// THE RELEASE → CLAIM → CLOCK LIFECYCLE, end to end, against a STATEFUL fake database.
//
// WHY THIS FILE EXISTS. clockEligibility.test.mjs asserts "a CLAIMED shift passes the clock gates"
// using a hand-written fixture that sets released_at: null. No lifecycle could actually produce
// that row: release.ts is the only writer of released_at, nothing cleared it, and all three gates
// reject a non-null released_at INDEPENDENTLY of status. So the fixture asserted a state the
// system could not reach, and the real bug — a claimed shift that can never clock in — passed
// green underneath it.
//
// The fix is not a better fixture, it is not using one. This file runs the REAL releaseShift and
// the REAL claimShift against an in-memory row store, then feeds THE ROW THEY ACTUALLY PRODUCED
// into the REAL clock gates. Nothing here hard-codes released_at.
//
// Run:  TZ=UTC node src/lib/schedule/claimLifecycle.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'claimlc-'));
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
const nextStub = write('next.mjs', 'export const NextResponse = { json: (b, i) => ({ body: b, status: (i && i.status) || 200 }) };\n');
const smsStub = write('sms.mjs', `
export async function broadcastShiftReleased(){ return { recipients: 0, sent: 0 }; }
export async function sendSms(){ return true; }
export function tokenLink(){ return ''; }
export function claimApprovedMessage(){ return ''; }
`);
const otStub = write('ot.mjs', `
export const OT_THRESHOLD_HOURS = 40;
export function claimAutoApproves(p){ return globalThis.__AUTO !== false && p <= 40; }
`);

const timezone   = transpile('./timezone.ts', 'tz.mjs');
const employees  = transpile('../employees.ts', 'emp.mjs');
const eligibility= transpile('./eligibility.ts', 'elig.mjs');
const drops      = transpile('./drops.ts', 'drops.mjs');
const hours      = transpile('./hours.ts', 'hours.mjs', { "'@/lib/employees'": `'${employees}'`, "'./timezone'": `'${timezone}'` });
const board      = transpile('./board.ts', 'board.mjs', {
  "'server-only'": `'${serverOnly}'`, "'@/lib/supabase/admin'": `'${adminStub}'`,
  "'@/lib/employees'": `'${employees}'`, "'./timezone'": `'${timezone}'`,
  "'./drops'": `'${drops}'`, "'./eligibility'": `'${eligibility}'`,
});
const release    = transpile('./release.ts', 'rel.mjs', {
  "'server-only'": `'${serverOnly}'`, "'@/lib/supabase/admin'": `'${adminStub}'`,
  "'@/lib/employees'": `'${employees}'`, "'./timezone'": `'${timezone}'`,
  "'./drops'": `'${drops}'`, "'./board'": `'${board}'`,
});
const claim      = transpile('./claim.ts', 'claim.mjs', {
  "'server-only'": `'${serverOnly}'`, "'@/lib/supabase/admin'": `'${adminStub}'`,
  "'@/lib/employees'": `'${employees}'`, "'./timezone'": `'${timezone}'`,
  "'./board'": `'${board}'`, "'./hours'": `'${hours}'`, "'./release'": `'${release}'`,
  "'./otGate'": `'${otStub}'`, "'./eligibility'": `'${eligibility}'`,
});
const adminShifts = transpile('./adminShifts.ts', 'as.mjs', {
  "'server-only'": `'${serverOnly}'`, "'@/lib/supabase/admin'": `'${adminStub}'`,
  "'@/lib/employees'": `'${employees}'`, "'./timezone'": `'${timezone}'`,
  "'./release'": `'${release}'`, "'./eligibility'": `'${eligibility}'`, "'./sms'": `'${smsStub}'`,
});
const publicRouteStub = write('pr.mjs', `
export async function guardPublicWrite(){ return { resolved: globalThis.__RESOLVED }; }
export function guardPublicReadAllowed(){ return true; }
export function clientIp(){ return '1.1.1.1'; }
`);
const tokensStub = write('tok.mjs', 'export async function resolveEmployeeByToken(){ return globalThis.__RESOLVED; }\n');
const rlStub = write('rl.mjs', 'const ok={check:()=>({success:true})};export const clockCodeLimiter=ok;\n');
const clockRoute = transpile('../../app/s/[token]/clock/route.ts', 'clock.mjs', {
  "'next/server'": `'${nextStub}'`,
  "'@/lib/schedule/publicRoute'": `'${publicRouteStub}'`,
  "'@/lib/schedule/tokens'": `'${tokensStub}'`,
  "'@/lib/supabase/admin'": `'${adminStub}'`,
  "'@/lib/schedule/eligibility'": `'${eligibility}'`,
  "'@/lib/rate-limit'": `'${rlStub}'`,
});
const kioskGuardStub = write('kg.mjs', `
export async function requireTimeclockScope(){ return { ok: true, admin: globalThis.__DB, ownerId: globalThis.__OWNER }; }
export function clientIp(){ return '1.1.1.1'; }
`);
const rl2Stub = write('rl2.mjs', 'const ok={check:()=>({success:true})};export const kioskIpLimiter=ok;\n');
const windowRoute = transpile('../../app/api/kiosk/window-state/route.ts', 'win.mjs', {
  "'next/server'": `'${nextStub}'`,
  "'@/lib/kiosk/guard'": `'${kioskGuardStub}'`,
  "'@/lib/schedule/eligibility'": `'${eligibility}'`,
  "'@/lib/rate-limit'": `'${rl2Stub}'`,
});
const qrScan = transpile('../kiosk/qrScan.ts', 'qr.mjs', {
  "'server-only'": `'${serverOnly}'`, "'next/server'": `'${nextStub}'`,
  "'@/lib/schedule/eligibility'": `'${eligibility}'`,
});

const { releaseShift } = await import(release);
const { claimShift } = await import(claim);
const { approveClaim, rejectClaim, listPendingClaims } = await import(adminShifts);
const { POST: issueQr } = await import(clockRoute);
const { GET: windowState } = await import(windowRoute);
const { consumeQrClockCode } = await import(qrScan);

// ── stateful in-memory DB: rows really mutate, so later steps see earlier writes ──
const DB = { shift_instances: [], shift_claims: [], attendance_events: [], employees: [], employee_time_entries: [], shifts: [], kiosk_tokens: [], clock_codes: [], clock_audit: [], employee_access_tokens: [], stores: [] };
const match = (row, fs) => fs.every(([k, col, v]) => {
  const cur = row[col];
  if (k === 'eq') return cur === v;
  if (k === 'in') return v.includes(cur);
  if (k === 'is') return v === null ? cur == null : cur === v;
  if (k === 'not') return !(cur == null);
  if (k === 'gt') return cur > v; if (k === 'gte') return cur >= v;
  if (k === 'lt') return cur < v; if (k === 'lte') return cur <= v;
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
  upsert(r, o) { this.op = 'upsert'; this.rows = Array.isArray(r) ? r : [r]; this.onConflict = (o?.onConflict ?? '').split(',').filter(Boolean); return this; }
  update(p) { this.op = 'update'; this.patch = p; return this; }
  delete() { this.op = 'delete'; return this; }
  single() { this.one = true; return this; } maybeSingle() { this.one = true; return this; }
  then(res) {
    const tbl = DB[this.t] ?? (DB[this.t] = []);
    let out;
    if (this.op === 'upsert') {
      const out2 = [];
      for (const r of this.rows) {
        const hit = this.onConflict.length ? tbl.find((x) => this.onConflict.every((c) => x[c] === r[c])) : null;
        if (hit) { Object.assign(hit, r); out2.push(hit); }
        else { const n = { id: r.id ?? `gen-${this.t}-${tbl.length + 1}`, ...r }; tbl.push(n); out2.push(n); }
      }
      out = out2;
    } else if (this.op === 'insert') {
      const added = this.rows.map((r) => ({ id: r.id ?? `gen-${this.t}-${tbl.length + 1}`, ...r }));
      tbl.push(...added); out = added;
    } else if (this.op === 'update') {
      const hit = tbl.filter((r) => match(r, this.f));
      hit.forEach((r) => Object.assign(r, this.patch)); out = hit;
    } else if (this.op === 'delete') {
      const hit = tbl.filter((r) => match(r, this.f));
      for (const r of hit) tbl.splice(tbl.indexOf(r), 1); out = hit;
    } else {
      out = tbl.filter((r) => match(r, this.f));
      if (this.lim) out = out.slice(0, this.lim);
    }
    res({ data: this.one ? (out[0] ?? null) : out, error: null });
  }
}
globalThis.__DB = { from: (t) => new Q(t), rpc: async () => ({ data: { employee_name: 'x', result: 'clocked_in' }, error: null }) };

let passed = 0;
const check = (n, c, e = '') => { assert.ok(c, `FAIL: ${n} ${e}`); console.log(`  ✓ ${n}${e ? ` — ${e}` : ''}`); passed++; };
const eq = (n, a, b) => check(n, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} == ${JSON.stringify(b)}`);

const OWNER = 'owner-1';
const A = { id: 'emp-a', user_id: OWNER, name: 'Ana', role: 'fulfillment', status: 'active' };
const B = { id: 'emp-b', user_id: OWNER, name: 'Ben', role: 'fulfillment', status: 'active' };
const FUTURE = new Date(Date.now() + 5 * 86400_000);
const soon = (h) => new Date(FUTURE.getTime() + h * 3600_000).toISOString();

function seed() {
  for (const k of Object.keys(DB)) DB[k] = [];
  DB.employees.push({ ...A }, { ...B });
  DB.shift_instances.push({
    id: 'inst-1', user_id: OWNER, employee_id: A.id, shift_date: FUTURE.toISOString().slice(0, 10),
    starts_at: soon(0), ends_at: soon(8), status: 'scheduled', source: 'pattern',
    released_at: null, released_by: null, shift_rule_id: 'r1', store_id: null, role: null,
  });
  return DB.shift_instances[0];
}
const inst = () => DB.shift_instances.find((r) => r.id === 'inst-1');

console.log('\n1. scheduled → the assignee is clock-eligible');
{
  seed();
  const { isClockEligibleStatus } = await import(eligibility);
  check('status scheduled is eligible', isClockEligibleStatus(inst().status));
  eq('released_at starts null', inst().released_at, null);
  eq('assignee is A', inst().employee_id, A.id);
}

console.log('\n2. release → nobody is assigned and nobody is eligible');
{
  await releaseShift({ ...A }, 'inst-1', 'family emergency');
  const r = inst();
  const { isClockEligibleStatus } = await import(eligibility);
  eq('status is released', r.status, 'released');
  eq('employee_id vacated', r.employee_id, null);
  check('released_at is SET by the real release path', typeof r.released_at === 'string' && r.released_at.length > 0);
  eq('released_by records the original owner', r.released_by, A.id);
  check('released status is NOT clock-eligible', !isClockEligibleStatus(r.status));
}

console.log('\n3. claim → B is assigned AND released_at is cleared  ← THE FIX');
{
  const res = await claimShift({ ...B }, 'inst-1');
  const r = inst();
  eq('auto-approved claim returns claimed', res.result, 'claimed');
  eq('status is claimed', r.status, 'claimed');
  eq('assignee transferred to B', r.employee_id, B.id);
  eq('released_at CLEARED by the lifecycle (not by a fixture)', r.released_at, null);
  eq('released_by PRESERVED as audit history of who dropped it', r.released_by, A.id);
  eq('a claim record was written', DB.shift_claims.length, 1);
  eq('and it is owner-stamped', DB.shift_claims[0].user_id, OWNER);
}

console.log('\n4. the row the lifecycle produced passes all three REAL clock gates');
{
  const r = inst();
  check('precondition: this row was produced by release+claim, not hand-written', r.status === 'claimed' && r.released_at === null && r.employee_id === B.id);

  // (a) QR issuance — the worker's phone.
  globalThis.__RESOLVED = { employee: { ...B }, tokenId: 't' };
  DB.shift_instances[0].starts_at = new Date(Date.now() - 10 * 60_000).toISOString();
  DB.shift_instances[0].ends_at = new Date(Date.now() + 3 * 3600_000).toISOString();
  const issued = await issueQr({ json: async () => ({ shift_instance_id: 'inst-1', purpose: 'clock_in' }) }, { params: Promise.resolve({ token: 'tok' }) });
  eq('(a) QR issuance ACCEPTS the claimed shift', issued.status, 200);
  check('    a code was minted', typeof issued.body.code === 'string' && issued.body.code.startsWith('LNS1'));

  // (b) station scan — re-verified at punch time.
  globalThis.__OWNER = OWNER;
  DB.kiosk_tokens.push({ id: 'kt', user_id: OWNER, active: true });
  DB.clock_codes.push({ code: 'LNS1x', user_id: OWNER, employee_id: B.id, shift_instance_id: 'inst-1', purpose: 'clock_in', consumed_at: null, expires_at: new Date(Date.now() + 60_000).toISOString() });
  const scanned = await consumeQrClockCode(globalThis.__DB, OWNER, 'LNS1x');
  eq('(b) station scan ACCEPTS it', scanned.status, 200);

  // (c) kiosk idle gate.
  const win = await windowState({ headers: { get: () => '1.1.1.1' } });
  eq('(c) kiosk window treats it as active coverage', [win.body.locked, win.body.reason], [false, 'scheduled_window']);
}

console.log('\n5. REGRESSION PROOF — the same three gates reject the pre-fix row shape');
{
  // Exactly what the old code produced: claimed, but released_at never cleared.
  DB.shift_instances[0].released_at = '2026-01-01T00:00:00.000Z';
  const issued = await issueQr({ json: async () => ({ shift_instance_id: 'inst-1', purpose: 'clock_in' }) }, { params: Promise.resolve({ token: 'tok' }) });
  eq('QR issuance REJECTS a claimed row with stale released_at', issued.status, 403);
  DB.clock_codes.push({ code: 'LNS1y', user_id: OWNER, employee_id: B.id, shift_instance_id: 'inst-1', purpose: 'clock_in', consumed_at: null, expires_at: new Date(Date.now() + 60_000).toISOString() });
  const scanned = await consumeQrClockCode(globalThis.__DB, OWNER, 'LNS1y');
  eq('station scan REJECTS it', scanned.status, 409);
  const win = await windowState({ headers: { get: () => '1.1.1.1' } });
  eq('kiosk window does NOT count it as coverage', win.body.locked, true);
  check('→ this is the exact bug; step 4 passes only because the lifecycle now clears it', true);
  DB.shift_instances[0].released_at = null;
}

console.log('\n6. cancelled is still refused (Phase 1 invariant intact)');
{
  DB.shift_instances[0].status = 'cancelled';
  const issued = await issueQr({ json: async () => ({ shift_instance_id: 'inst-1', purpose: 'clock_in' }) }, { params: Promise.resolve({ token: 'tok' }) });
  eq('cancelled → 403', issued.status, 403);
  const win = await windowState({ headers: { get: () => '1.1.1.1' } });
  eq('cancelled is not coverage', win.body.locked, true);
}

console.log('\n7. the MANAGER approval path clears released_at too');
{
  seed();
  await releaseShift({ ...A }, 'inst-1', 'family emergency');
  globalThis.__AUTO = false;
  const res = await claimShift({ ...B }, 'inst-1');
  eq('OT branch leaves the request pending', res.result, 'pending_approval');
  eq('instance NOT transferred while pending', [inst().status, inst().employee_id], ['released', null]);
  check('released_at still set while pending', inst().released_at !== null);

  const pending = DB.shift_claims.find((c) => c.status === 'pending');
  await approveClaim(pending.id, OWNER);
  const r = inst();
  eq('approval transfers the assignment', [r.status, r.employee_id], ['claimed', B.id]);
  eq('approval CLEARS released_at  ← same fix, manager path', r.released_at, null);
  eq('released_by preserved', r.released_by, A.id);
  globalThis.__AUTO = true;
}

console.log(`\n${passed} checks passed`);
