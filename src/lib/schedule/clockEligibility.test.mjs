// THE CLOCK-IN ELIGIBILITY BOUNDARY — which shift_instances statuses may back a NEW punch.
//
// This is the file that stands behind "a cancelled shift can never allow a clock-in". The Schedule
// Builder can leave a removed recurring day as status='cancelled', so every path that turns a
// shift_instance into permission-to-punch must exclude it. Three such paths exist and all three are
// exercised here against the REAL modules, transpiled at runtime:
//
//   1. POST /s/[token]/clock          — QR issuance (the worker's phone)
//   2. lib/kiosk/qrScan consume       — the station scan, re-verified at punch time
//   3. GET /api/kiosk/window-state    — the kiosk's "is anyone scheduled" idle gate
//
// The fake Supabase client RECORDS every filter, so these tests assert the PREDICATE the query
// carries (a status filter that a refactor deletes must fail here), not merely the outcome.
//
// Run:  TZ=UTC node src/lib/schedule/clockEligibility.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'clockelig-'));
const write = (name, src) => { const p = join(dir, name); writeFileSync(p, src); return pathToFileURL(p).href; };
function transpile(srcRel, outName, rewrites = {}) {
  const srcPath = fileURLToPath(new URL(srcRel, import.meta.url));
  let { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  for (const [from, to] of Object.entries(rewrites)) outputText = outputText.split(from).join(to);
  return write(outName, outputText.replace(/^'use client';\s*/m, ''));
}

// ── shared stubs ──
const nextStub = write('next.mjs', `
export const NextResponse = { json: (body, init) => ({ body, status: (init && init.status) || 200 }) };
`);
const adminStub = write('admin.mjs', 'export function createAdminClient(){ return globalThis.__DB; }\n');
const serverOnly = write('serverOnly.mjs', 'export {};\n');
const limiterStub = write('limits.mjs', `
const ok = { check: () => ({ success: true }) };
export const clockCodeLimiter = ok, scheduleTokenLimiter = ok, scheduleIpLimiter = ok,
  scheduleWriteLimiter = ok, kioskIpLimiter = ok, kioskBadgeLimiter = ok, kioskSupervisorIpLimiter = ok;
`);
const tokensStub = write('tokens.mjs', `
export async function resolveEmployeeByToken() { return globalThis.__RESOLVED; }
export function generateAccessToken() { return 'tok'; }
`);
const publicRouteStub = write('publicRoute.mjs', `
export async function guardPublicWrite() { return { resolved: globalThis.__RESOLVED }; }
export function guardPublicReadAllowed() { return true; }
export function clientIp() { return '1.2.3.4'; }
export function scheduleErrorResponse(e) { return { body: { error: String(e) }, status: 500 }; }
`);
const kioskGuardStub = write('kioskGuard.mjs', `
export async function requireTimeclockScope() { return { ok: true, admin: globalThis.__DB, ownerId: globalThis.__OWNER, storeIds: [], actorId: 'kiosk' }; }
export async function resolveKioskToken() { return 'kt'; }
export function clientIp() { return '1.2.3.4'; }
`);

const eligibility = transpile('./eligibility.ts', 'eligibility.mjs');

// ── recording fake PostgREST ──
class Rec {
  constructor(table) { this.table = table; this.op = 'select'; this.filters = []; this.payload = null; }
  select(c) { this.cols = c; return this; }
  eq(k, v) { this.filters.push(['eq', k, v]); return this; }
  in(k, v) { this.filters.push(['in', k, v]); return this; }
  is(k, v) { this.filters.push(['is', k, v]); return this; }
  not(k, o, v) { this.filters.push(['not', k, `${o}:${v}`]); return this; }
  gt(k, v) { this.filters.push(['gt', k, v]); return this; }
  gte(k, v) { this.filters.push(['gte', k, v]); return this; }
  lte(k, v) { this.filters.push(['lte', k, v]); return this; }
  limit() { return this; }
  order() { return this; }
  insert(r) { this.op = 'insert'; this.payload = r; return this; }
  update(p) { this.op = 'update'; this.payload = p; return this; }
  upsert(r) { this.op = 'upsert'; this.payload = r; return this; }
  maybeSingle() { return this; }
  then(res, rej) { globalThis.__LOG.push(this); try { res(globalThis.__SCRIPT(this)); } catch (e) { rej(e); } }
  f(kind, key) { return this.filters.find(([k, kk]) => k === kind && kk === key)?.[2]; }
  has(kind, key) { return this.filters.some(([k, kk]) => k === kind && kk === key); }
}
globalThis.__DB = { from: (t) => new Rec(t), rpc: (fn, args) => { globalThis.__LOG.push({ table: `rpc:${fn}`, op: 'rpc', payload: args, filters: [], f: () => undefined, has: () => false }); return Promise.resolve(globalThis.__RPC ?? { data: { employee_name: 'A', result: 'clocked_in' }, error: null }); } };
const reset = (script) => { globalThis.__LOG = []; globalThis.__SCRIPT = script; };
const log = () => globalThis.__LOG;
const instQueries = () => log().filter((r) => r.table === 'shift_instances');

let passed = 0;
const check = (name, cond, extra = '') => { assert.ok(cond, `FAIL: ${name} ${extra}`); console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`); passed++; };
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} == ${JSON.stringify(b)}`);

const OWNER = 'owner-1';
const EMP = { id: 'emp-a', user_id: OWNER, name: 'A', status: 'active' };
const IN_WINDOW_START = new Date(Date.now() - 30 * 60_000).toISOString();
const IN_WINDOW_END = new Date(Date.now() + 3 * 3_600_000).toISOString();

console.log('\n0. the boundary itself');
{
  const E = await import(eligibility);
  eq('CLOCK_ELIGIBLE_STATUSES is exactly scheduled + claimed', [...E.CLOCK_ELIGIBLE_STATUSES], ['scheduled', 'claimed']);
  for (const s of ['scheduled', 'claimed']) check(`${s} is eligible`, E.isClockEligibleStatus(s) === true);
  for (const s of ['cancelled', 'released', 'worked', 'missed', '', null, undefined, 'CANCELLED', 'Cancelled']) {
    check(`${JSON.stringify(s)} is NOT eligible`, E.isClockEligibleStatus(s) === false);
  }
  // The DB CHECK vocabulary, so a new status added to the schema shows up here as un-triaged.
  const ALL = ['scheduled', 'released', 'claimed', 'worked', 'missed', 'cancelled'];
  eq('of every DB status, exactly two are eligible', ALL.filter((s) => E.isClockEligibleStatus(s)), ['scheduled', 'claimed']);
}

// ── 1. QR ISSUANCE ──────────────────────────────────────────────────────────
const clockRoute = transpile('../../app/s/[token]/clock/route.ts', 'clockRoute.mjs', {
  "'next/server'": `'${nextStub}'`,
  "'@/lib/schedule/publicRoute'": `'${publicRouteStub}'`,
  "'@/lib/schedule/tokens'": `'${tokensStub}'`,
  "'@/lib/supabase/admin'": `'${adminStub}'`,
  "'@/lib/schedule/eligibility'": `'${eligibility}'`,
  "'@/lib/rate-limit'": `'${limiterStub}'`,
});
const { POST: issueQr } = await import(clockRoute);

const issueScript = (status, over = {}) => (rec) => {
  if (rec.table === 'shift_instances') {
    return { data: status === null ? null : { id: 'inst-1', starts_at: IN_WINDOW_START, ends_at: IN_WINDOW_END, released_at: null, status, ...over }, error: null };
  }
  if (rec.table === 'employee_time_entries') return { data: null, error: null }; // clocked out
  if (rec.table === 'clock_codes') return { data: null, error: null };
  if (rec.table === 'clock_audit') return { data: null, error: null };
  return { data: null, error: null };
};
const issueReq = () => ({ json: async () => ({ shift_instance_id: 'inst-1', purpose: 'clock_in' }) });

console.log('\n1. QR issuance — POST /s/[token]/clock');
{
  globalThis.__RESOLVED = { employee: EMP, tokenId: 't1' };
  reset(issueScript('scheduled'));
  const okRes = await issueQr(issueReq(), { params: Promise.resolve({ token: 'tok' }) });
  eq('SCHEDULED → 200 and a code is minted', [okRes.status, typeof okRes.body.code === 'string' && okRes.body.code.startsWith('LNS1')], [200, true]);
  const q = instQueries()[0];
  eq('the query is scoped by id + employee + owner', [q.f('eq', 'id'), q.f('eq', 'employee_id'), q.f('eq', 'user_id')], ['inst-1', EMP.id, OWNER]);
  check('and it SELECTS status (the gate reads it)', String(q.cols).includes('status'));

  reset(issueScript('claimed'));
  const claimedRes = await issueQr(issueReq(), { params: Promise.resolve({ token: 'tok' }) });
  eq('CLAIMED → 200 (a picked-up shift is the claimer\'s to work — unchanged behaviour)', claimedRes.status, 200);

  for (const bad of ['cancelled', 'worked', 'missed']) {
    reset(issueScript(bad));
    const res = await issueQr(issueReq(), { params: Promise.resolve({ token: 'tok' }) });
    eq(`${bad.toUpperCase()} → 403, NO code minted`, [res.status, res.body.code], [403, undefined]);
    check(`${bad} attempt is audited with a status-specific reason`, log().some((r) => r.table === 'clock_audit' && r.payload?.reason === `not_eligible_${bad}`));
    check(`${bad} attempt writes NO clock_codes row`, !log().some((r) => r.table === 'clock_codes' && r.op !== 'select'));
  }

  reset(issueScript('scheduled', { released_at: new Date().toISOString() }));
  eq('RELEASED (status scheduled but released_at set) → still 403', (await issueQr(issueReq(), { params: Promise.resolve({ token: 'tok' }) })).status, 403);
  reset(issueScript(null));
  eq('someone else\'s / missing shift → 403 not_your_shift', (await issueQr(issueReq(), { params: Promise.resolve({ token: 'tok' }) })).status, 403);
}

// ── 2. STATION SCAN ─────────────────────────────────────────────────────────
const qrScan = transpile('../kiosk/qrScan.ts', 'qrScan.mjs', {
  "'server-only'": `'${serverOnly}'`,
  "'next/server'": `'${nextStub}'`,
  "'@/lib/schedule/eligibility'": `'${eligibility}'`,
});
const { consumeQrClockCode } = await import(qrScan);

const scanScript = (status) => (rec) => {
  if (rec.table === 'kiosk_tokens') return { data: { id: 'kt-1' }, error: null };
  if (rec.table === 'clock_codes' && rec.op === 'update') {
    return { data: { employee_id: EMP.id, shift_instance_id: 'inst-1', purpose: 'clock_in' }, error: null };
  }
  if (rec.table === 'shift_instances') return { data: status === null ? null : { status, released_at: null }, error: null };
  return { data: null, error: null };
};

console.log('\n2. station scan — consumeQrClockCode (re-verified AT PUNCH TIME)');
{
  reset(scanScript('scheduled'));
  const ok = await consumeQrClockCode(globalThis.__DB, OWNER, 'LNS1abc');
  eq('SCHEDULED → punches', [ok.status, ok.body.ok], [200, true]);
  check('the punch RPC was called', log().some((r) => r.table === 'rpc:lensed_kiosk_manual_punch_as'));
  const q = instQueries()[0];
  eq('the re-verify query is owner-scoped to the code\'s instance', [q.f('eq', 'id'), q.f('eq', 'user_id')], ['inst-1', OWNER]);

  reset(scanScript('claimed'));
  eq('CLAIMED → punches (unchanged)', (await consumeQrClockCode(globalThis.__DB, OWNER, 'LNS1abc')).status, 200);

  for (const bad of ['cancelled', 'worked', 'missed']) {
    reset(scanScript(bad));
    const res = await consumeQrClockCode(globalThis.__DB, OWNER, 'LNS1abc');
    eq(`${bad.toUpperCase()} → 409 SHIFT_NOT_ELIGIBLE`, [res.status, res.body.code], [409, 'SHIFT_NOT_ELIGIBLE']);
    check(`${bad}: the punch RPC is NEVER called`, !log().some((r) => r.op === 'rpc'));
    check(`${bad}: the rejection is audited`, log().some((r) => r.table === 'clock_audit' && r.payload?.reason === `not_eligible_${bad}`));
  }
  // THE RACE THIS CLOSES: a code minted while the shift was scheduled, cancelled by the manager
  // during its 45s life, then presented at the station.
  reset(scanScript('cancelled'));
  const raced = await consumeQrClockCode(globalThis.__DB, OWNER, 'LNS1abc');
  check('a code minted before a cancellation cannot punch after it', raced.status === 409 && !log().some((r) => r.op === 'rpc'));
  check('the code is still consumed (single-use) so it cannot be retried', log().some((r) => r.table === 'clock_codes' && r.op === 'update'));
}

// ── 3. KIOSK WINDOW STATE ───────────────────────────────────────────────────
const windowRoute = transpile('../../app/api/kiosk/window-state/route.ts', 'windowRoute.mjs', {
  "'next/server'": `'${nextStub}'`,
  "'@/lib/kiosk/guard'": `'${kioskGuardStub}'`,
  "'@/lib/schedule/eligibility'": `'${eligibility}'`,
  "'@/lib/rate-limit'": `'${limiterStub}'`,
});
const { GET: windowState } = await import(windowRoute);

console.log('\n3. kiosk idle gate — GET /api/kiosk/window-state');
{
  globalThis.__OWNER = OWNER;
  // No open punches anywhere; the only question is whether a scheduled window is open.
  const winScript = (rows) => (rec) => {
    if (rec.table === 'shift_instances') return { data: rows.length ? rows[0] : null, error: null };
    if (rec.table === 'employee_time_entries') return { data: null, error: null };
    return { data: null, error: null };
  };
  reset(winScript([{ id: 'inst-1' }]));
  const open = await windowState({ headers: { get: () => '1.2.3.4' } });
  eq('a matching window → unlocked', [open.status, open.body.locked, open.body.reason], [200, false, 'scheduled_window']);
  const q = instQueries()[0];
  eq('the query FILTERS status to the eligible pair', q.f('in', 'status'), ['scheduled', 'claimed']);
  check('it also requires an assignee and excludes released rows', q.has('not', 'employee_id') && q.f('is', 'released_at') === null);
  check('it is owner-scoped', q.f('eq', 'user_id') === OWNER);
  check('and bounded by the [start-45m, end+60m] window', q.has('lte', 'starts_at') && q.has('gte', 'ends_at'));

  // With the status filter in place, a cancelled row simply is not returned by the DB — the proof
  // that matters is the predicate above. This asserts the no-row outcome locks the kiosk.
  reset(winScript([]));
  const locked = await windowState({ headers: { get: () => '1.2.3.4' } });
  eq('no eligible window and nobody clocked in → locked', [locked.body.locked, locked.body.reason], [true, 'no_window']);
}

console.log('\n4. the builder cannot produce a status outside the DB vocabulary');
{
  const E = await import(eligibility);
  const src = readFileSync(fileURLToPath(new URL('./schedulePlan.ts', import.meta.url)), 'utf8');
  // The planner may only ever WRITE 'scheduled' or 'claimed' into a row it upserts, and 'cancelled'
  // via cancelIds. Anything else would be outside shift_instances_status_check.
  const written = [...src.matchAll(/status: '([a-z_]+)'/g)].map((m) => m[1]);
  eq('planner writes only scheduled (upsert)', [...new Set(written)], ['scheduled']);
  check('and every status it writes is a real DB status', [...new Set(written), 'cancelled'].every((s) => ['scheduled', 'released', 'claimed', 'worked', 'missed', 'cancelled'].includes(s)));
  check('cancelled is NOT clock-eligible — the whole point of this file', !E.isClockEligibleStatus('cancelled'));
}

console.log(`\n${passed} checks passed`);
