// offerPlan: the pure kernels behind Drop Shift, Available Shifts and Pick Up Shift.
//
// Exercises the REAL offerPlan.ts (and the real eligibility.ts), transpiled at runtime.
//
// THE RULE THIS FILE EXISTS TO PROTECT: dropping a shift OFFERS it, it does not hand it back. The
// original employee stays assigned and stays clock-eligible until a manager approves someone else.
// Every kernel here is written so that rule cannot be quietly broken.
//
// Run:  TZ=UTC node src/lib/schedule/offerPlan.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'offerplan-'));
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
const P = await import(transpile('./offerPlan.ts', 'offerPlan.mjs', { "'./eligibility'": `'${eligibility}'` }));

let passed = 0;
const check = (n, c, e = '') => { assert.ok(c, `FAIL: ${n} ${e}`); console.log(`  ✓ ${n}${e ? ` — ${e}` : ''}`); passed++; };
const eq = (n, a, b) => check(n, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} == ${JSON.stringify(b)}`);

const TODAY = '2026-09-09';
const NOW = Date.parse('2026-09-09T18:00:00Z');
const ME = 'emp-me';
const OTHER = 'emp-other';
const OFFER = 'offer-A';
const inst = (o = {}) => ({
  id: 'inst-1', user_id: 'owner-1', employee_id: OTHER, shift_date: '2026-09-11',
  starts_at: '2026-09-11T13:00:00+00:00', ends_at: '2026-09-11T21:00:00+00:00',
  status: 'scheduled', released_at: null, released_by: null, role: 'fulfillment',
  source: 'pattern', offer_state: null, offer_id: null, ...o,
});

console.log('\n1. DROP — what may be offered');
{
  eq('a future scheduled shift I own → OK', P.planDrop({ inst: inst({ employee_id: ME }), employeeId: ME, nowMs: NOW, todayISO: TODAY }), { ok: true });
  eq('a CLAIMED shift I own is also droppable', P.planDrop({ inst: inst({ employee_id: ME, status: 'claimed' }), employeeId: ME, nowMs: NOW, todayISO: TODAY }), { ok: true });
  eq('a previously CLOSED offer can be re-offered', P.planDrop({ inst: inst({ employee_id: ME, offer_state: 'closed', offer_id: 'old' }), employeeId: ME, nowMs: NOW, todayISO: TODAY }), { ok: true });
  const r = (o, id = ME) => P.planDrop({ inst: inst(o), employeeId: id, nowMs: NOW, todayISO: TODAY }).code;
  eq('not my shift', r({ employee_id: OTHER }), 'NOT_YOUR_SHIFT');
  eq('past date', r({ employee_id: ME, shift_date: '2026-09-08' }), 'PAST_SHIFT');
  eq('already started today', r({ employee_id: ME, shift_date: TODAY, starts_at: '2026-09-09T13:00:00Z' }), 'ALREADY_STARTED');
  eq('cancelled', r({ employee_id: ME, status: 'cancelled' }), 'NOT_ACTIVE');
  eq('worked', r({ employee_id: ME, status: 'worked' }), 'NOT_ACTIVE');
  eq('missed', r({ employee_id: ME, status: 'missed' }), 'NOT_ACTIVE');
  eq('already offered', r({ employee_id: ME, offer_state: 'offered', offer_id: OFFER }), 'ALREADY_OFFERED');
  eq('already transferred away', r({ employee_id: ME, offer_state: 'transferred', offer_id: OFFER }), 'OFFER_CLOSED');
  eq('a legacy RELEASED row is not mine to drop', r({ employee_id: ME, released_at: '2026-09-01T00:00:00Z' }), 'RELEASED_LEGACY');
  check('every refusal has employee-facing copy', Object.values(P.DROP_REFUSAL_MESSAGES).every((m) => typeof m === 'string' && m.length > 8));
  check('no refusal copy says "release"', !Object.values(P.DROP_REFUSAL_MESSAGES).some((m) => /releas/i.test(m) && !/open-shift board/i.test(m)));
}

console.log('\n2. THE PRODUCT RULE — an offer never disturbs assignment or eligibility');
{
  const src = readFileSync(fileURLToPath(new URL('./offerPlan.ts', import.meta.url)), 'utf8');
  // These kernels are PURE: they decide, they never describe a write. Assert that directly rather
  // than grepping for field names, which also appear in the row interface they read.
  check('no DB access of any kind', !/\.from\(|\.update\(|\.insert\(|createAdminClient/.test(src));
  check('planDrop returns only {ok} / {ok,code} — no write payload',
    /export function planDrop[\s\S]*?return \{ ok: true \};/.test(src));
  // `released_at` and `employee_id` may appear ONLY as fields of the row being READ, never as a
  // property being assigned a new value in an object literal the caller would write.
  const assignments = [...src.matchAll(/(released_at|employee_id|status)\s*:\s*([^;\n]+)/g)]
    .filter(([, , v]) => !/string|null;|\|/.test(v.trim().slice(0, 12)));
  check('no field of a shift row is ever assigned a new value here', assignments.length === 0,
    assignments.map((a) => a[0]).join(' | '));
  // The offered row must still satisfy the clock gate, which is what keeps the owner punchable.
  const E = await import(eligibility);
  for (const s of ['scheduled', 'claimed']) {
    check(`an offered ${s} shift is still clock-eligible by status`, E.isClockEligibleStatus(s));
  }
  check('and cancelled still is not', !E.isClockEligibleStatus('cancelled'));
}

console.log('\n3. PICKUP — who may request');
{
  const base = {
    inst: inst({ offer_state: 'offered', offer_id: OFFER }),
    employeeId: ME, employeeRole: 'fulfillment', employeeStatus: 'active',
    myDatesInUse: new Set(), alreadyRequested: false, nowMs: NOW, todayISO: TODAY,
  };
  eq('same-role coworker → OK', P.planPickup(base), { ok: true });
  eq('matching expected offer id → OK', P.planPickup({ ...base, expectedOfferId: OFFER }), { ok: true });
  const c = (o) => P.planPickup({ ...base, ...o }).code;
  eq('not offered', c({ inst: inst() }), 'NOT_OFFERED');
  eq('offered but no offer_id (impossible via DB CHECK, still refused)', c({ inst: inst({ offer_state: 'offered', offer_id: null }) }), 'NOT_OFFERED');
  eq('STALE offer id → refused', c({ expectedOfferId: 'offer-B' }), 'STALE_OFFER');
  eq('my own dropped shift', c({ inst: inst({ employee_id: ME, offer_state: 'offered', offer_id: OFFER }) }), 'OWN_SHIFT');
  eq('wrong role', c({ employeeRole: 'host' }), 'WRONG_ROLE');
  eq('no role at all', c({ employeeRole: null }), 'WRONG_ROLE');
  eq('already working that day', c({ myDatesInUse: new Set(['2026-09-11']) }), 'ALREADY_SCHEDULED_THAT_DAY');
  eq('already requested', c({ alreadyRequested: true }), 'ALREADY_REQUESTED');
  eq('inactive employee', c({ employeeStatus: 'former' }), 'INACTIVE_EMPLOYEE');
  eq('past shift', c({ inst: inst({ offer_state: 'offered', offer_id: OFFER, shift_date: '2026-09-08' }) }), 'PAST_SHIFT');
  eq('started already', c({ inst: inst({ offer_state: 'offered', offer_id: OFFER, shift_date: TODAY, starts_at: '2026-09-09T13:00:00Z' }) }), 'ALREADY_STARTED');
  check('every pickup refusal has employee-facing copy', Object.values(P.PICKUP_REFUSAL_MESSAGES).every((m) => typeof m === 'string' && m.length > 4));
}

console.log('\n4. ROLE derivation for an offered shift');
{
  eq("uses the row's own role", P.offerRole({ role: 'host' }, 'fulfillment'), 'host');
  eq('falls back to the assignee when the row has none', P.offerRole({ role: null }, 'fulfillment'), 'fulfillment');
  eq('null when neither is known', P.offerRole({ role: null }, null), null);
}

console.log('\n5. AVAILABLE SHIFTS board');
{
  const offers = [
    inst({ id: 'a', employee_id: OTHER, offer_state: 'offered', offer_id: 'o-a', role: 'fulfillment', shift_date: '2026-09-11' }),
    inst({ id: 'b', employee_id: 'emp-h', offer_state: 'offered', offer_id: 'o-b', role: 'host', shift_date: '2026-09-12' }),
    inst({ id: 'c', employee_id: ME, offer_state: 'offered', offer_id: 'o-c', role: 'fulfillment', shift_date: '2026-09-13' }),
    inst({ id: 'd', employee_id: OTHER, offer_state: 'offered', offer_id: 'o-d', role: 'fulfillment', shift_date: '2026-09-14' }),
  ];
  const out = P.buildAvailableShifts({
    offers,
    assigneeRoleById: new Map([[OTHER, 'fulfillment'], ['emp-h', 'host'], [ME, 'fulfillment']]),
    assigneeNameById: new Map([[OTHER, 'Carlos'], ['emp-h', 'Adriana'], [ME, 'Me']]),
    employeeId: ME, employeeRole: 'fulfillment', employeeStatus: 'active',
    myDatesInUse: new Set(['2026-09-14']),
    requestedInstanceIds: new Set(),
    nowMs: NOW, todayISO: TODAY,
  });
  eq('my OWN dropped shift is not listed as available to me', out.find((x) => x.id === 'c'), undefined);
  eq('a HOST shift is hidden from a fulfillment viewer entirely', out.find((x) => x.id === 'b'), undefined);
  eq('an eligible offer is takeable', out.find((x) => x.id === 'a').refusal, null);
  eq('a same-day conflict is SHOWN but annotated, not hidden', out.find((x) => x.id === 'd').refusal, 'ALREADY_SCHEDULED_THAT_DAY');
  eq('offers carry who dropped them', out.find((x) => x.id === 'a').offered_by_name, 'Carlos');
  eq('and the offer generation id, for the ABA guard', out.find((x) => x.id === 'a').offer_id, 'o-a');
  eq('sorted by start time', out.map((x) => x.id), ['a', 'd']);
  const req = P.buildAvailableShifts({
    offers: [offers[0]],
    assigneeRoleById: new Map([[OTHER, 'fulfillment']]), assigneeNameById: new Map([[OTHER, 'Carlos']]),
    employeeId: ME, employeeRole: 'fulfillment', employeeStatus: 'active',
    myDatesInUse: new Set(), requestedInstanceIds: new Set(['a']), nowMs: NOW, todayISO: TODAY,
  });
  eq('an already-requested offer shows the pending state', req[0].refusal, 'ALREADY_REQUESTED');
  eq('and its copy is the friendly one', P.PICKUP_REFUSAL_MESSAGES[req[0].refusal], 'Pickup requested');
  check('the board never exposes a rate/phone/payroll field', !JSON.stringify(out).match(/hourly|rate|phone|payroll|wage/i));
}

console.log('\n6. NO PAYROLL, EVER');
{
  const src = readFileSync(fileURLToPath(new URL('./offerPlan.ts', import.meta.url)), 'utf8');
  check('offerPlan never names the shifts table', !/'shifts'/.test(src));
  check('nor employee_time_entries', !/employee_time_entries/.test(src));
}

console.log(`\n${passed} checks passed`);
