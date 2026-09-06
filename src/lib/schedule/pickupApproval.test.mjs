// Manager APPROVE / DECLINE of a shift pickup, plus the migration-129 invariants the approval
// depends on. Exercises the REAL adminShifts.ts helpers; the RPC itself is stubbed at the client
// boundary so the ARGUMENTS and the refusal mapping are what get asserted — the SQL body is
// reviewed separately and cannot run here (no local Postgres).
//
// Run:  TZ=UTC node src/lib/schedule/pickupApproval.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'pickupapp-'));
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
const release = transpile('./release.ts', 'release.mjs', {
  "'server-only'": `'${serverOnly}'`, "'@/lib/supabase/admin'": `'${adminStub}'`,
  "'@/lib/employees'": `'${employees}'`, "'./timezone'": `'${timezone}'`,
  "'./drops'": `'${dropsStub}'`, "'./board'": `'${boardStub}'`,
});
const A = await import(transpile('./adminShifts.ts', 'adminShifts.mjs', {
  "'server-only'": `'${serverOnly}'`, "'@/lib/supabase/admin'": `'${adminStub}'`,
  "'@/lib/employees'": `'${employees}'`, "'./timezone'": `'${timezone}'`,
  "'./release'": `'${release}'`, "'./eligibility'": `'${eligibility}'`,
}));
const { ScheduleError } = await import(release);

class Rec {
  constructor(t) { this.table = t; this.op = 'select'; this.filters = []; this.payload = null; }
  select(c) { this.cols = c; return this; }
  eq(k, v) { this.filters.push(['eq', k, v]); return this; }
  in(k, v) { this.filters.push(['in', k, v]); return this; }
  order() { return this; } limit() { return this; } single() { return this; } maybeSingle() { return this; }
  update(p) { this.op = 'update'; this.payload = p; return this; }
  insert(p) { this.op = 'insert'; this.payload = p; return this; }
  delete() { this.op = 'delete'; return this; }
  then(res, rej) { globalThis.__LOG.push(this); try { res(globalThis.__SCRIPT(this)); } catch (e) { rej(e); } }
  f(k, key) { return this.filters.find(([a, b]) => a === k && b === key)?.[2]; }
}
globalThis.__DB = {
  from: (t) => new Rec(t),
  rpc: (fn, args) => { globalThis.__RPC.push({ fn, args }); return Promise.resolve(globalThis.__RPC_REPLY); },
};
const reset = (s, rpc) => { globalThis.__LOG = []; globalThis.__RPC = []; globalThis.__SCRIPT = s ?? (() => ({ data: [], error: null })); globalThis.__RPC_REPLY = rpc ?? { data: { ok: true, employee_id: 'emp-b', superseded: 0 }, error: null }; };
const writes = () => globalThis.__LOG.filter((r) => r.op !== 'select');

let passed = 0;
const check = (n, c, e = '') => { assert.ok(c, `FAIL: ${n} ${e}`); console.log(`  ✓ ${n}${e ? ` — ${e}` : ''}`); passed++; };
const eq = (n, a, b) => check(n, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} == ${JSON.stringify(b)}`);

const OWNER = 'owner-1';
const FOREIGN = 'owner-2';

console.log('\n1. APPROVE delegates to the transactional RPC with the full CAS tuple');
{
  reset();
  const r = await A.approvePickup({ ownerId: OWNER, claimId: 'claim-1', shiftInstanceId: 'inst-1', offerId: 'offer-A' });
  eq('exactly one RPC call', globalThis.__RPC.length, 1);
  eq('the transactional function', globalThis.__RPC[0].fn, 'lensed_approve_shift_pickup');
  eq('owner comes from the SESSION, not the body', globalThis.__RPC[0].args.p_owner, OWNER);
  eq('and it carries shift + claim + offer generation', [globalThis.__RPC[0].args.p_shift_instance_id, globalThis.__RPC[0].args.p_claim_id, globalThis.__RPC[0].args.p_offer_id], ['inst-1', 'claim-1', 'offer-A']);
  // The 5th argument (migration 130). pay_period_start is computed in TypeScript because the
  // biweekly PAY_ANCHOR arithmetic lives only in src/lib/employees.ts — if the RPC ever computed it
  // in SQL instead, drops could silently land in the wrong pay period.
  check('a pay_period_start is passed to the RPC',
    typeof globalThis.__RPC[0].args.p_pay_period_start === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(globalThis.__RPC[0].args.p_pay_period_start),
    String(globalThis.__RPC[0].args.p_pay_period_start));
  eq('the new assignee is returned', r.employee_id, 'emp-b');
  check('NO direct table write happens in the helper — the RPC owns the transaction', writes().length === 0);
}

console.log('\n2. APPROVE refusals become manager-readable sentences, never a 500');
{
  for (const [reason, needle] of [
    ['STALE_OFFER', /re-offered/i],
    ['OFFER_NOT_OPEN', /no longer being offered/i],   // covers cancelled AND already-taken
    ['OFFER_CHANGED', /changed while you were deciding/i],
    ['CLAIM_NOT_PENDING', /no longer open/i],
    ['ALREADY_APPROVED', /already approved/i],
    ['EMPLOYEE_DOUBLE_BOOKED', /already scheduled that day/i],
    ['EMPLOYEE_UNAVAILABLE', /no longer active/i],
    ['CLAIM_NOT_FOUND', /no longer exists/i],
  ]) {
    reset(null, { data: { ok: false, reason }, error: null });
    await assert.rejects(
      A.approvePickup({ ownerId: OWNER, claimId: 'c', shiftInstanceId: 'i', offerId: 'o' }),
      (e) => e instanceof ScheduleError && e.code === reason && needle.test(e.message),
    );
    check(`${reason} → friendly copy`, true);
  }
  reset(null, { data: null, error: { message: 'connection reset' } });
  await assert.rejects(A.approvePickup({ ownerId: OWNER, claimId: 'c', shiftInstanceId: 'i', offerId: 'o' }), (e) => e.code === 'APPROVE_FAILED');
  check('a transport error is APPROVE_FAILED', true);
}

console.log('\n3. THE ABA GUARD is carried end to end');
{
  reset(null, { data: { ok: false, reason: 'STALE_OFFER' }, error: null });
  await assert.rejects(A.approvePickup({ ownerId: OWNER, claimId: 'claim-old', shiftInstanceId: 'inst-1', offerId: 'offer-A' }), (e) => e.code === 'STALE_OFFER');
  eq('the offer id the manager saw is what the RPC checks', globalThis.__RPC[0].args.p_offer_id, 'offer-A');
  check('an approval from a dead cycle transfers nothing', writes().length === 0);
}

console.log('\n4. DECLINE rejects ONE request and leaves everything else alone');
{
  reset((r) => (r.table === 'shift_claims' && r.op === 'update' ? { data: { id: 'claim-1' }, error: null } : { data: null, error: null }));
  await A.declinePickup({ ownerId: OWNER, claimId: 'claim-1' });
  const up = writes()[0];
  eq('one write, on shift_claims', [writes().length, up.table], [1, 'shift_claims']);
  eq('status → rejected, stamped by the manager', [up.payload.status, up.payload.approved_by], ['rejected', OWNER]);
  eq('scoped: this claim, this owner, pickup kind, still pending', [up.f('eq', 'id'), up.f('eq', 'user_id'), up.f('eq', 'kind'), up.f('eq', 'status')], ['claim-1', OWNER, 'pickup_request', 'pending']);
  check('shift_instances is NOT touched — the original employee keeps the shift', !writes().some((r) => r.table === 'shift_instances'));
  check('no sibling claim is touched — declining one is not withdrawing the offer', writes().length === 1);
}

console.log('\n5. DECLINE — foreign owner and already-decided both refuse with no write');
{
  reset(() => ({ data: null, error: null }));   // owner filter matches nothing
  await assert.rejects(A.declinePickup({ ownerId: FOREIGN, claimId: 'claim-1' }), (e) => e.code === 'NOT_PENDING');
  const up = writes()[0];
  eq("a foreign manager's update is owner-filtered so it matches 0 rows", up.f('eq', 'user_id'), FOREIGN);
  check('and the helper reports it rather than pretending success', true);
}

console.log('\n6. THE MANAGER QUEUE is owner-scoped and pickup-only');
{
  reset((r) => {
    if (r.table === 'shift_claims') return { data: [{ id: 'claim-1', shift_instance_id: 'inst-1', claimed_by: 'emp-b', claimed_at: 'T', offer_id: 'offer-A' }], error: null };
    if (r.table === 'shift_instances') return { data: [{ id: 'inst-1', shift_date: '2026-09-11', starts_at: 'S', ends_at: 'E', employee_id: 'emp-a', offer_id: 'offer-A', offer_state: 'offered' }], error: null };
    if (r.table === 'employees') return { data: [{ id: 'emp-a', name: 'Carlos' }, { id: 'emp-b', name: 'Juan' }], error: null };
    return { data: [], error: null };
  });
  const rows = await A.listPickupRequests(OWNER);
  eq('one actionable request', rows.length, 1);
  eq('it names BOTH sides of the swap', [rows[0].offered_by_name, rows[0].requester_name], ['Carlos', 'Juan']);
  eq('and carries the CAS identifiers the approve call needs', [rows[0].shift_instance_id, rows[0].offer_id], ['inst-1', 'offer-A']);
  check('every read is owner-scoped', globalThis.__LOG.every((r) => r.f('eq', 'user_id') === OWNER));
  const cq = globalThis.__LOG.find((r) => r.table === 'shift_claims');
  eq('the queue filters kind=pickup_request and status=pending', [cq.f('eq', 'kind'), cq.f('eq', 'status')], ['pickup_request', 'pending']);
  check('the employees read selects only id/name — no rate, no phone', /^id, name$/.test(String(globalThis.__LOG.find((r) => r.table === 'employees').cols)));
}

console.log('\n7. THE QUEUE hides requests whose offer cycle has moved on');
{
  const stale = (instOffer, state) => (r) => {
    if (r.table === 'shift_claims') return { data: [{ id: 'c', shift_instance_id: 'inst-1', claimed_by: 'emp-b', claimed_at: 'T', offer_id: 'offer-A' }], error: null };
    if (r.table === 'shift_instances') return { data: [{ id: 'inst-1', shift_date: 'D', starts_at: 'S', ends_at: 'E', employee_id: 'emp-a', offer_id: instOffer, offer_state: state }], error: null };
    if (r.table === 'employees') return { data: [{ id: 'emp-a', name: 'C' }, { id: 'emp-b', name: 'J' }], error: null };
    return { data: [], error: null };
  };
  reset(stale('offer-B', 'offered'));
  eq('a request from a superseded cycle is not offered for approval', (await A.listPickupRequests(OWNER)).length, 0);
  reset(stale('offer-A', 'transferred'));
  eq('nor is one whose shift already transferred', (await A.listPickupRequests(OWNER)).length, 0);
  reset(stale('offer-A', 'closed'));
  eq('nor one whose offer was closed', (await A.listPickupRequests(OWNER)).length, 0);
}

console.log('\n8. MIGRATION 129 — the invariants the code relies on are actually in the DDL');
{
  const sql = readFileSync(fileURLToPath(new URL('../../../supabase/migrations/129_schedule_phase2_offer_lifecycle.sql', import.meta.url)), 'utf8');
  const code = sql.replace(/--[^\n]*/g, '');
  check('offered ⇒ employee_id NOT NULL', /offered_is_owned[\s\S]*?employee_id is not null/.test(code));
  check('offered ⇒ released_at IS NULL', /offered_is_owned[\s\S]*?released_at is null/.test(code));
  check('offered ⇒ offer_id + offered_at present', /offered_is_owned[\s\S]*?offer_id is not null[\s\S]*?offered_at is not null/.test(code));
  // The offer columns are all-or-nothing, so the two malformed shapes an earlier draft allowed —
  // a stray offered_at under a NULL offer_state, and a terminal state with no offered_at — are
  // both unrepresentable.
  check('offer_state / offer_id / offered_at are ALL-OR-NOTHING',
    /offer_triple_consistent[\s\S]*?\(offer_state is null and offer_id is null and offered_at is null\)[\s\S]*?or \(offer_state is not null and offer_id is not null and offered_at is not null\)/.test(code));
  check("offered ⇒ status in ('scheduled','claimed')", /offered_is_owned[\s\S]*?status in \('scheduled', 'claimed'\)/.test(code));
  check('pickup_request ⇒ offer_id NOT NULL', /pickup_has_offer[\s\S]*?kind = 'pickup_request' and offer_id is not null/.test(code));
  check('pickup_request can NEVER be auto_approved', /pickup_never_auto[\s\S]*?status <> 'auto_approved'/.test(code));
  check("status vocabulary gains 'superseded' and keeps all four legacy values",
    /status in \('auto_approved', 'pending', 'approved', 'rejected', 'superseded'\)/.test(code));
  check('ONE effective approved pickup per shift (partial unique)',
    /unique index[\s\S]*?one_approved_pickup[\s\S]*?\(shift_instance_id\)[\s\S]*?kind = 'pickup_request' and status in \('approved', 'auto_approved'\)/.test(code));
  check('ONE pending pickup per employee per shift (partial unique)',
    /unique index[\s\S]*?one_pending_pickup_per_employee[\s\S]*?\(shift_instance_id, claimed_by\)[\s\S]*?status = 'pending'/.test(code));
  check('both unique indexes are scoped to pickup_request, sparing the OT flow',
    (code.match(/where kind = 'pickup_request'/g) || []).length >= 3);
  check('UNIQUE(employee_id, shift_date) is never dropped or altered', !/drop constraint[\s\S]*?employee_date_unique/.test(code));
  check('the RPC is SECURITY DEFINER with a pinned search_path', /security definer[\s\S]*?set search_path = public/.test(code));
  check('and granted to service_role ONLY', /revoke execute on function public\.lensed_approve_shift_pickup[\s\S]*?from public, anon, authenticated/.test(code) && /grant\s+execute on function public\.lensed_approve_shift_pickup[\s\S]*?to service_role/.test(code));
  check('the RPC supersedes rivals in the same statement set', /status = 'superseded'[\s\S]*?kind = 'pickup_request'/.test(code));
  check('the RPC re-asserts the offer CAS on the transfer', /offer_state = 'offered'[\s\S]*?offer_id = p_offer_id/.test(code));
  check('the RPC clears released_at on transfer (the #217 invariant)', /released_at = null/.test(code));
  // Every mutation must check its own row count. A predicate matching nothing must never read as
  // success — and past the assignment update a refusal would be a torn state, so it RAISES instead.
  check('the winner update checks row count and RAISES rather than returning',
    /set status = 'approved'[\s\S]*?if not found then[\s\S]*?raise exception 'PICKUP_WINNER_VANISHED/.test(code));
  check('the rivals update captures its row count', /status = 'superseded'[\s\S]*?get diagnostics v_superseded = row_count/.test(code));
  check('the assignment update checks row count before continuing', /offer_state = 'transferred'[\s\S]*?if not found then[\s\S]*?OFFER_CHANGED/.test(code));
  check('the only post-transfer failure path is a RAISE, never a silent refusal',
    !/OFFER_CHANGED[\s\S]*?set status = 'approved'[\s\S]*?return jsonb_build_object\('ok', false/.test(code));
  check('the migration writes NO payroll table', !/from\s+shifts|into\s+shifts|update\s+public\.shifts/.test(code));
  check('and is additive — no DROP COLUMN / DROP TABLE anywhere', !/drop column|drop table/i.test(code));
}

console.log(`\n${passed} checks passed`);
