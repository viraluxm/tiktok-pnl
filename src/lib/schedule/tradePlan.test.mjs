// tradePlan: the pure kernels behind Request Trade (v1, one-for-one swap).
//
// THE RULE THIS FILE PROTECTS: a trade proposal can never touch a shift the requester does not
// own, a shift that is offered/released/started, a shift in another pending trade, or a swap that
// would double-book either person — and it can never cross owners or roles. Ownership only ever
// changes in the approval RPC (tested in supabase/tests/shift_trades).
//
// Run:  TZ=UTC node src/lib/schedule/tradePlan.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'tradeplan-'));
const write = (n, s) => { const p = join(dir, n); writeFileSync(p, s); return pathToFileURL(p).href; };
function transpile(rel, out, rw = {}) {
  const sp = fileURLToPath(new URL(rel, import.meta.url));
  let { outputText } = ts.transpileModule(readFileSync(sp, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  for (const [f, t] of Object.entries(rw)) outputText = outputText.split(f).join(t);
  return write(out, outputText);
}
const eligibility = transpile('./eligibility.ts', 'eligibility.mjs');
const P = await import(transpile('./tradePlan.ts', 'tradePlan.mjs', { "'./eligibility'": `'${eligibility}'` }));

let passed = 0;
const check = (n, c, e = '') => { assert.ok(c, `FAIL: ${n} ${e}`); console.log(`  ✓ ${n}${e ? ` — ${e}` : ''}`); passed++; };
const eq = (n, a, b) => check(n, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} == ${JSON.stringify(b)}`);

const NOW = Date.parse('2026-09-08T18:00:00Z');
const OWNER = 'owner-1';
const me = { id: 'carlos', role: 'host', status: 'active' };
const juan = { id: 'juan', role: 'host', status: 'active' };
const inst = (o = {}) => ({
  id: 'A', user_id: OWNER, employee_id: 'carlos', shift_date: '2026-09-10',
  starts_at: '2026-09-11T01:00:00Z', ends_at: '2026-09-11T09:00:00Z', // Thu 6 PM – 2 AM PDT
  status: 'scheduled', released_at: null, role: null, offer_state: null, ...o,
});
const theirs = (o = {}) => inst({ id: 'B', employee_id: 'juan', shift_date: '2026-09-11', starts_at: '2026-09-11T13:00:00Z', ends_at: '2026-09-11T21:00:00Z', ...o });
const base = (o = {}) => ({
  mine: inst(), theirs: theirs(), me, them: juan,
  myOtherDates: new Set(), theirOtherDates: new Set(), activeTradeInstanceIds: new Set(), nowMs: NOW, ...o,
});
const plan = (o = {}) => P.planTradeRequest(base(o));

console.log('\n1. THE HAPPY PATH and its variations');
{
  eq('two future owned shifts, same role → OK', plan(), { ok: true });
  eq('a CLAIMED shift is tradeable', plan({ mine: inst({ status: 'claimed' }) }), { ok: true });
  eq('a previously CLOSED offer is tradeable again', plan({ mine: inst({ offer_state: 'closed' }) }), { ok: true });
  eq('same-day swap (my PM for their AM) is legal', plan({ theirs: theirs({ shift_date: '2026-09-10', starts_at: '2026-09-10T13:00:00Z', ends_at: '2026-09-10T21:00:00Z' }) }), { ok: true });
  eq('row roles that match the people are fine', plan({ mine: inst({ role: 'host' }), theirs: theirs({ role: 'host' }) }), { ok: true });
}

console.log('\n2. OWNERSHIP AND TENANCY');
{
  eq('not my shift', plan({ mine: inst({ employee_id: 'juan' }) }), { ok: false, code: 'NOT_YOUR_SHIFT' });
  eq('their shift no longer theirs', plan({ theirs: theirs({ employee_id: 'carol' }) }), { ok: false, code: 'TARGET_NOT_OWNED' });
  eq('cross-owner shift refused before anything else about it is read', plan({ theirs: theirs({ user_id: 'owner-2' }) }), { ok: false, code: 'CROSS_OWNER' });
  eq('same shift both sides', plan({ theirs: inst() }), { ok: false, code: 'SAME_SHIFT' });
  eq('trading with yourself', plan({ them: me, theirs: theirs({ employee_id: 'carlos' }) }), { ok: false, code: 'SAME_EMPLOYEE' });
  eq('former employee', plan({ them: { ...juan, status: 'former' } }), { ok: false, code: 'INACTIVE_EMPLOYEE' });
  eq('probation is not active either', plan({ me: { ...me, status: 'probation' } }), { ok: false, code: 'INACTIVE_EMPLOYEE' });
}

console.log('\n3. SHIFT STATE — only live, owned, un-offered, future rows');
{
  eq('cancelled shift', plan({ mine: inst({ status: 'cancelled' }) }), { ok: false, code: 'SHIFT_NOT_ACTIVE' });
  eq('worked shift', plan({ theirs: theirs({ status: 'worked' }) }), { ok: false, code: 'SHIFT_NOT_ACTIVE' });
  eq('legacy released row (released_at set)', plan({ mine: inst({ released_at: '2026-09-01T00:00:00Z' }) }), { ok: false, code: 'SHIFT_RELEASED' });
  eq('OFFERED shift must have its offer cancelled first', plan({ mine: inst({ offer_state: 'offered' }) }), { ok: false, code: 'SHIFT_OFFERED' });
  eq('their offered shift too', plan({ theirs: theirs({ offer_state: 'offered' }) }), { ok: false, code: 'SHIFT_OFFERED' });
  eq('already started', plan({ mine: inst({ starts_at: '2026-09-08T17:00:00Z' }) }), { ok: false, code: 'ALREADY_STARTED' });
  eq('starting this very second counts as started', plan({ theirs: theirs({ starts_at: new Date(NOW).toISOString() }) }), { ok: false, code: 'ALREADY_STARTED' });
  eq('unparseable start fails closed', plan({ mine: inst({ starts_at: 'garbage' }) }), { ok: false, code: 'ALREADY_STARTED' });
}

console.log('\n4. ROLE — same role on both people and both rows');
{
  eq('host ↔ fulfillment refused', plan({ them: { ...juan, role: 'fulfillment' } }), { ok: false, code: 'ROLE_MISMATCH' });
  eq('a row role that disagrees with the person refused', plan({ theirs: theirs({ role: 'fulfillment' }) }), { ok: false, code: 'ROLE_MISMATCH' });
  eq('no role at all refused', plan({ me: { ...me, role: null }, them: { ...juan, role: null } }), { ok: false, code: 'ROLE_MISMATCH' });
  eq('shiftRole: row role wins, else owner role', [P.shiftRole({ role: 'fulfillment' }, 'host'), P.shiftRole({ role: null }, 'host'), P.shiftRole({ role: null }, null)], ['fulfillment', 'host', null]);
}

console.log('\n5. CONFLICTS — one live trade per shift, no double booking after the swap');
{
  eq('my shift already in a trade', plan({ activeTradeInstanceIds: new Set(['A']) }), { ok: false, code: 'IN_ACTIVE_TRADE' });
  eq('their shift already in a trade', plan({ activeTradeInstanceIds: new Set(['B']) }), { ok: false, code: 'IN_ACTIVE_TRADE' });
  eq('I already work their day', plan({ myOtherDates: new Set(['2026-09-11']) }), { ok: false, code: 'REQUESTER_DOUBLE_BOOKED' });
  eq('they already work my day', plan({ theirOtherDates: new Set(['2026-09-10']) }), { ok: false, code: 'TARGET_DOUBLE_BOOKED' });
  eq('otherDates drops the shift being given up', [...P.otherDates(['2026-09-10', '2026-09-12'], '2026-09-10')], ['2026-09-12']);
  // The caller must exclude the given-up date; the kernel then sees a same-day swap as legal.
  eq('same-day swap with dates correctly excluded → OK', plan({
    theirs: theirs({ shift_date: '2026-09-10', starts_at: '2026-09-10T13:00:00Z', ends_at: '2026-09-10T21:00:00Z' }),
    myOtherDates: P.otherDates(['2026-09-10', '2026-09-12'], '2026-09-10'),
    theirOtherDates: P.otherDates(['2026-09-10'], '2026-09-10'),
  }), { ok: true });
}

console.log('\n6. TRADE OPTIONS — who I could swap with, and which of their shifts');
{
  const carol = { id: 'carol', role: 'host', status: 'active', name: 'Carol' };
  const frank = { id: 'frank', role: 'fulfillment', status: 'active', name: 'Frank' };
  const juanN = { ...juan, name: 'Juan Perez' };
  const opts = P.buildTradeOptions({
    mine: inst(), me,
    myDates: new Set(['2026-09-10', '2026-09-12']),
    candidates: [
      { employee: juanN, instances: [
        theirs(),                                                                                   // Fri → OK
        theirs({ id: 'B2', shift_date: '2026-09-12', starts_at: '2026-09-12T13:00:00Z', ends_at: '2026-09-12T21:00:00Z' }), // Sat — I already work Sat → refused
        theirs({ id: 'B3', shift_date: '2026-09-14', starts_at: '2026-09-14T13:00:00Z', ends_at: '2026-09-14T21:00:00Z', offer_state: 'offered' }), // offered → refused
        theirs({ id: 'B4', shift_date: '2026-09-15', starts_at: '2026-09-15T13:00:00Z', ends_at: '2026-09-15T21:00:00Z' }), // in another trade
      ] },
      { employee: carol, instances: [theirs({ id: 'C1', employee_id: 'carol', shift_date: '2026-09-10', starts_at: '2026-09-10T13:00:00Z', ends_at: '2026-09-10T21:00:00Z' })] }, // same-day OK
      { employee: frank, instances: [theirs({ id: 'F1', employee_id: 'frank', shift_date: '2026-09-16' })] },   // wrong role → dropped entirely
      { employee: { ...me, name: 'Me' }, instances: [inst({ id: 'A2', shift_date: '2026-09-12' })] },            // myself → dropped
    ],
    activeTradeInstanceIds: new Set(['B4']),
    nowMs: NOW,
  });
  eq('coworkers sorted by name, only those with an eligible shift', opts.map((c) => c.name), ['Carol', 'Juan Perez']);
  eq('Juan offers exactly the Friday shift', opts[1].shifts.map((s) => s.instance_id), ['B']);
  eq('Carol\'s same-day shift is offered', opts[0].shifts.map((s) => s.instance_id), ['C1']);
  eq('option rows carry only instance facts (no employee ids, no pay)', Object.keys(opts[1].shifts[0]).sort(), ['ends_at', 'instance_id', 'shift_date', 'starts_at']);
}

console.log('\n7. RESPONSES AND CANCELS');
{
  eq('target may answer a pending_coworker trade', P.planCoworkerResponse({ target_employee_id: 'juan', status: 'pending_coworker' }, 'juan'), { ok: true });
  eq('someone else may not', P.planCoworkerResponse({ target_employee_id: 'juan', status: 'pending_coworker' }, 'carol'), { ok: false, code: 'NOT_TARGET' });
  eq('already answered', P.planCoworkerResponse({ target_employee_id: 'juan', status: 'pending_manager' }, 'juan'), { ok: false, code: 'NOT_PENDING_COWORKER' });
  eq('requester may cancel while waiting for coworker', P.planCancel({ requester_employee_id: 'carlos', status: 'pending_coworker' }, 'carlos'), { ok: true });
  eq('…and while waiting for manager', P.planCancel({ requester_employee_id: 'carlos', status: 'pending_manager' }, 'carlos'), { ok: true });
  eq('not after approval', P.planCancel({ requester_employee_id: 'carlos', status: 'approved' }, 'carlos'), { ok: false, code: 'NOT_CANCELLABLE' });
  eq('target may not cancel', P.planCancel({ requester_employee_id: 'carlos', status: 'pending_coworker' }, 'juan'), { ok: false, code: 'NOT_REQUESTER' });
  check('every refusal has a sentence', Object.values(P.TRADE_REFUSAL_MESSAGES).every((m) => typeof m === 'string' && m.length > 10));
  check('every RPC reason has a manager sentence', ['TRADE_NOT_FOUND', 'REQUESTER_NO_LONGER_OWNS', 'EMPLOYEE_DOUBLE_BOOKED', 'CONFLICTING_TRADE', 'SHIFT_OFFERED'].every((k) => k in P.TRADE_APPROVE_MESSAGES));
}

console.log(`\n${passed} checks passed`);
