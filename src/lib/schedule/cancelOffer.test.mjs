// CANCEL OFFER — the employee-facing half of the Phase 2 lifecycle, plus the migration-130
// invariants it depends on. Exercises the REAL offer.ts helper; the RPC is stubbed at the client
// boundary so the ARGUMENTS and the refusal mapping are what get asserted. The SQL body itself is
// executed for real by supabase/tests/schedule_phase2/run.sh against a disposable Postgres.
//
// Run:  TZ=UTC node src/lib/schedule/cancelOffer.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'cancoffer-'));
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
const dropsStub = write('drops.mjs', 'export const DROP_CAP=2;\nexport function computeDrops(){return{releases:0,claims:0,excused:0,drops:0};}\n');
const boardStub = write('board.mjs', 'export const NOTICE_MS=86400000;\n');
const employees = transpile('../employees.ts', 'employees.mjs');
const timezone = transpile('./timezone.ts', 'timezone.mjs');
const eligibility = transpile('./eligibility.ts', 'eligibility.mjs');
const offerPlan = transpile('./offerPlan.ts', 'offerPlan.mjs', {
  "'./timezone'": `'${timezone}'`, "'./eligibility'": `'${eligibility}'`, "'@/lib/employees'": `'${employees}'`,
});
const release = transpile('./release.ts', 'release.mjs', {
  "'server-only'": `'${serverOnly}'`, "'@/lib/supabase/admin'": `'${adminStub}'`,
  "'@/lib/employees'": `'${employees}'`, "'./timezone'": `'${timezone}'`,
  "'./drops'": `'${dropsStub}'`, "'./board'": `'${boardStub}'`,
  "'./eligibility'": `'${eligibility}'`,
});
const O = await import(transpile('./offer.ts', 'offer.mjs', {
  "'server-only'": `'${serverOnly}'`, "'@/lib/supabase/admin'": `'${adminStub}'`,
  "'@/lib/employees'": `'${employees}'`, "'./timezone'": `'${timezone}'`,
  "'./release'": `'${release}'`, "'./offerPlan'": `'${offerPlan}'`,
}));
const { ScheduleError } = await import(release);

globalThis.__DB = {
  from: () => { throw new Error('cancelOffer must not touch tables directly — the RPC owns the transaction'); },
  rpc: (fn, args) => { globalThis.__RPC.push({ fn, args }); return Promise.resolve(globalThis.__RPC_REPLY); },
};
const reset = (reply) => { globalThis.__RPC = []; globalThis.__RPC_REPLY = reply ?? { data: { ok: true, superseded: 0 }, error: null }; };

let passed = 0;
const check = (n, c, e = '') => { assert.ok(c, `FAIL: ${n} ${e}`); console.log(`  ✓ ${n}${e ? ` — ${e}` : ''}`); passed++; };
const eq = (n, a, b) => check(n, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} == ${JSON.stringify(b)}`);

const ME = { id: 'emp-me', user_id: 'owner-1', name: 'Carlos', role: 'host', status: 'active' };

console.log('\n1. CANCEL delegates to the transactional RPC with the full CAS tuple');
{
  reset({ data: { ok: true, superseded: 2 }, error: null });
  const r = await O.cancelOffer(ME, 'inst-1', 'offer-A');
  eq('exactly one RPC call', globalThis.__RPC.length, 1);
  eq('the transactional function', globalThis.__RPC[0].fn, 'lensed_cancel_shift_offer');
  // THE SECURITY ASSERTION. Both identities come from the token-resolved employee object — the
  // route never reads them from the request body, and the RPC re-asserts them server-side.
  eq('owner comes from the TOKEN-resolved employee', globalThis.__RPC[0].args.p_owner, ME.user_id);
  eq('acting employee comes from the TOKEN-resolved employee', globalThis.__RPC[0].args.p_employee_id, ME.id);
  eq('and it carries shift + offer generation',
    [globalThis.__RPC[0].args.p_shift_instance_id, globalThis.__RPC[0].args.p_offer_id], ['inst-1', 'offer-A']);
  eq('the superseded count is surfaced', r.superseded, 2);
  eq('status reported as cancelled', r.status, 'cancelled');
}

console.log('\n2. CANCEL refusals become worker-readable sentences, never a 500');
{
  for (const [reason, needle] of [
    ['NOT_YOUR_SHIFT', /not yours/i],
    ['SHIFT_NOT_FOUND', /no longer exists/i],
    ['STALE_OFFER', /re-offered/i],
    ['OFFER_CHANGED', /changed while you were deciding/i],
  ]) {
    reset({ data: { ok: false, reason }, error: null });
    await assert.rejects(
      O.cancelOffer(ME, 'inst-1', 'offer-A'),
      (e) => e instanceof ScheduleError && e.code === reason && needle.test(e.message),
    );
    check(`${reason} → friendly copy`, true);
  }

  // A transferred offer is NOT a generic "not open": the shift is gone, and the worker needs to be
  // told that specifically rather than being invited to retry.
  reset({ data: { ok: false, reason: 'OFFER_NOT_OPEN', offer_state: 'transferred' }, error: null });
  await assert.rejects(
    O.cancelOffer(ME, 'inst-1', 'offer-A'),
    (e) => e.code === 'ALREADY_TRANSFERRED' && /manager already approved/i.test(e.message),
  );
  check('a TRANSFERRED offer is reported as already-approved, not "not open"', true);

  // An already-closed offer stays the plain not-open message — it is a harmless double-tap.
  reset({ data: { ok: false, reason: 'OFFER_NOT_OPEN', offer_state: 'closed' }, error: null });
  await assert.rejects(
    O.cancelOffer(ME, 'inst-1', 'offer-A'),
    (e) => e.code === 'OFFER_NOT_OPEN' && /not currently offered/i.test(e.message),
  );
  check('an already-CLOSED offer is a plain no-op message', true);

  reset({ data: null, error: { message: 'connection reset' } });
  await assert.rejects(O.cancelOffer(ME, 'i', 'o'), (e) => e.code === 'CANCEL_FAILED');
  check('a transport error never leaks the driver message as a refusal', true);
}

console.log('\n3. OFFER.TS SOURCE INVARIANTS (comments stripped — prose must not satisfy a guard)');
{
  const raw = readFileSync(fileURLToPath(new URL('./offer.ts', import.meta.url)), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  check('offering writes NO attendance event', !/from\('attendance_events'\)/.test(src));
  check('offer.ts never writes shifts', !/from\('shifts'\)/.test(src));
  check('offer.ts never touches employee_time_entries', !/employee_time_entries/.test(src));
  check('cancel goes through the RPC, not table writes', /rpc\('lensed_cancel_shift_offer'/.test(src));
  check('cancelOffer takes the employee object, never an id from a body',
    /export async function cancelOffer\(\s*employee: Employee/.test(src));
  check('it is registered for the rpc-grants checker', /rpc-grants: lensed_cancel_shift_offer/.test(raw));
}

console.log('\n4. THE CANCEL ROUTE derives identity from the TOKEN, never the body');
{
  const raw = readFileSync(fileURLToPath(new URL('../../app/s/[token]/cancel-offer/route.ts', import.meta.url)), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  check('the route resolves the employee via guardPublicWrite(token)', /guardPublicWrite\(token, req\)/.test(src));
  check('it passes the RESOLVED employee to cancelOffer', /cancelOffer\(employee,/.test(src));
  // The only client-supplied values are which shift and which cycle. An employee id from the body
  // would be an impersonation vector; assert it is never read.
  check('it never reads an employee id from the body', !/body\.(employee|employeeId|employee_id)/.test(src));
  check('it requires an instanceId', /Missing instanceId/.test(src));
  check('it requires an offerId (so a stale tab cannot cancel a cycle it never saw)', /Missing offerId/.test(src));
  check('refusals are 4xx with a code, never a bare 500', /status: e\.code === 'SHIFT_NOT_FOUND' \? 404 : 409/.test(src));
}

console.log('\n5. MIGRATION 130 — the DDL the lifecycle depends on');
{
  const sql = readFileSync(fileURLToPath(new URL('../../../supabase/migrations/130_schedule_phase2_attendance_and_cancel.sql', import.meta.url)), 'utf8');
  const code = sql.replace(/--[^\n]*/g, '');

  // 129 IS FROZEN — production ran it. 130 must not re-issue any of its structural statements.
  check('130 adds NO columns (129 is frozen)', !/alter table[\s\S]*?add column/i.test(code));
  check('130 creates NO indexes (129 is frozen)', !/create\s+(unique\s+)?index/i.test(code));
  check('130 adds NO constraints (129 is frozen)', !/add constraint/i.test(code));
  check('130 drops no table or column', !/drop\s+(table|column)/i.test(code));

  // The approval RPC is REPLACED, and its stale 4-arg overload must be removed — a leftover
  // overload would still be callable and would write no attendance rows at all.
  check('the 4-arg approval overload is explicitly dropped',
    /drop function if exists public\.lensed_approve_shift_pickup\(uuid, uuid, uuid, uuid\)/.test(code));
  check('the replacement takes a pay period', /lensed_approve_shift_pickup\([\s\S]*?p_pay_period_start\s+date/.test(code));

  // The attendance pair, and WHOSE ledger each row lands on.
  check('approval inserts into attendance_events', /insert into public\.attendance_events/.test(code));
  check('the released row is stamped with the OUTGOING employee', /v_prev_employee,\s+p_shift_instance_id,[^,]+,\s*'released'/.test(code));
  check('the claimed row is stamped with the INCOMING employee', /v_claim\.claimed_by,\s+p_shift_instance_id,[^,]+,\s*'claimed'/.test(code));

  // Cancel: the whole point is what it does NOT do.
  const cancelFn = code.slice(code.indexOf('function public.lensed_cancel_shift_offer'));
  check('cancel writes no attendance event', !/attendance_events/.test(cancelFn));
  check('cancel writes no payroll row', !/from\s+public\.shifts|into public\.shifts/.test(cancelFn));
  check('cancel closes the offer', /set offer_state = 'closed'/.test(cancelFn));
  // Assert against the SET clauses ONLY. A naive scan would match `employee_id = p_employee_id` in
  // the WHERE predicate — which is the ownership CHECK, the opposite of a reassignment — and pass
  // or fail for entirely the wrong reason.
  // Anchored on `update <table> set ... where` so the function's own `set search_path = public`
  // is not mistaken for a column assignment.
  const setClauses = [...cancelFn.matchAll(/update\s+public\.\w+\s+set\s+([\s\S]*?)\s+where\b/g)].map((m) => m[1]);
  check('cancel has exactly the SET clauses we expect', setClauses.length === 2, setClauses.join(' || '));
  const assigned = setClauses.join(' , ');
  check('cancel never reassigns employee_id', !/\bemployee_id\s*=/.test(assigned), assigned);
  check('cancel never changes status of the SHIFT', !/\bstatus\s*=\s*'(scheduled|claimed|released|cancelled|worked|missed)'/.test(assigned), assigned);
  check('cancel never touches released_at', !/\breleased_at\s*=/.test(assigned), assigned);
  check('the only shift column it sets is offer_state', /offer_state = 'closed'/.test(setClauses[0]) && !/,/.test(setClauses[0]), setClauses[0]);
  check('cancel supersedes the cycle\'s pending requests',
    /set status = 'superseded'[\s\S]*?offer_id = p_offer_id[\s\S]*?status = 'pending'/.test(cancelFn));
  check('cancel asserts the acting employee owns the shift', /employee_id is distinct from p_employee_id/.test(cancelFn));
  check('cancel CAS-guards the offer generation', /and offer_id = p_offer_id/.test(cancelFn));

  // Both RPCs serialize on the SAME key — that is what makes approve/cancel mutually exclusive.
  const locks = [...code.matchAll(/pg_advisory_xact_lock\(hashtextextended\(p_shift_instance_id::text, 0\)\)/g)];
  check('both functions take the SAME per-shift advisory lock', locks.length === 2, `${locks.length} lock calls`);

  // House posture for every lensed_* write RPC.
  for (const fn of ['lensed_approve_shift_pickup', 'lensed_cancel_shift_offer']) {
    check(`${fn}: security definer + pinned search_path`,
      new RegExp(`function public\\.${fn}\\([\\s\\S]*?security definer[\\s\\S]*?set search_path = public`).test(code));
    check(`${fn}: revoked from public/anon/authenticated, granted ONLY service_role`,
      new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated`).test(code)
      && new RegExp(`grant  execute on function public\\.${fn}\\([^)]*\\) to service_role`).test(code));
  }
  check('the whole migration is ONE transaction', /^begin;/m.test(code) && /^commit;/m.test(code));
}

console.log(`\n${passed} checks passed`);
