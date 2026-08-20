// Punch-derived labor: reconciliation + invariants. Exercises the REAL computeLaborByDateRole
// (labor.ts) and computePay (employees.ts), transpiled at runtime. labor.ts's value-import of
// employees.ts is rewired to the transpiled module; its '@/types' import is type-only (erased).
//
// Run:  TZ=UTC node src/lib/labor.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'labor-'));
function transpile(srcRel, outName, rewrites = {}) {
  const srcPath = fileURLToPath(new URL(srcRel, import.meta.url));
  let { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  for (const [from, to] of Object.entries(rewrites)) outputText = outputText.split(from).join(to);
  const outFile = join(dir, outName);
  writeFileSync(outFile, outputText);
  return pathToFileURL(outFile).href;
}
const employeesUrl = transpile('./employees.ts', 'employees.mjs');
const laborUrl = transpile('./labor.ts', 'labor.mjs', { "'@/lib/employees'": `'${employeesUrl}'` });
const { computeLaborByDateRole, pacificDate } = await import(laborUrl);
const { computePay } = await import(employeesUrl);

let passed = 0;
const check = (name, cond, extra = '') => { assert.ok(cond, `FAIL: ${name} ${extra}`); console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`); passed++; };
const cents = (n) => Math.round(n * 100);

// ── Fixture: covers punch, manual (null clock_in), unconfirmed, overnight, materialized,
//    zero-rate host, punch+session same day (must not double-count), and fallback guards. ──
const EMP = [
  { id: 'H1', role: 'host', hourly_rate: 25 },
  { id: 'H2', role: 'host', hourly_rate: 25 },
  { id: 'F1', role: 'fulfillment', hourly_rate: 22 },
  { id: 'HZ', role: 'host', hourly_rate: 0 }, // zero-rate host (the six real ones)
];
const SHIFTS = [
  // H1: confirmed 8h punch on 07-20
  { employee_id: 'H1', date: '2026-07-20', start_time: '07:00', end_time: '15:00', source: 'time_clock', confirmed_at: '2026-07-21T00:00:00Z', break_minutes: 0, clock_in_at: '2026-07-20T14:00:00Z', clock_out_at: '2026-07-20T22:00:00Z' },
  // F1: confirmed 8.5h span − 30min break = 8h on 07-20
  { employee_id: 'F1', date: '2026-07-20', start_time: '06:00', end_time: '14:30', source: 'time_clock', confirmed_at: '2026-07-21T00:00:00Z', break_minutes: 30, clock_in_at: '2026-07-20T13:00:00Z', clock_out_at: '2026-07-20T21:30:00Z' },
  // H2: MANUAL shift, null clock_in_at → buckets by shifts.date, scheduled-time path (jose-like)
  { employee_id: 'H2', date: '2026-07-21', start_time: '09:00', end_time: '17:00', source: 'manual', break_minutes: 0 },
  // H1: UNCONFIRMED time-clock punch on 07-22 → excluded from pay, surfaced as pending
  { employee_id: 'H1', date: '2026-07-22', start_time: '07:00', end_time: '15:00', source: 'time_clock', confirmed_at: null, break_minutes: 0, clock_in_at: '2026-07-22T14:00:00Z', clock_out_at: '2026-07-22T22:00:00Z' },
  // F1: OVERNIGHT punch clocking in 07-23 22:00 PT → business date 07-23 (clock-in Pacific)
  { employee_id: 'F1', date: '2026-07-23', start_time: '22:00', end_time: '06:00', source: 'time_clock', confirmed_at: '2026-07-25T00:00:00Z', break_minutes: 0, clock_in_at: '2026-07-24T05:00:00Z', clock_out_at: '2026-07-24T13:00:00Z' },
  // H1: MATERIALIZED recurring (source_rule_id) on 07-20 → excluded (plan, never pay)
  { employee_id: 'H1', date: '2026-07-20', start_time: '07:00', end_time: '15:00', source: 'time_clock', source_rule_id: 'rule-1', confirmed_at: '2026-07-21T00:00:00Z', break_minutes: 0 },
];
const SESSIONS = [
  { host_id: 'HZ', started_at: '2026-07-20T18:00:00Z', ended_at: '2026-07-20T21:00:00Z' }, // 3h → fallback (rate 0 → flag)
  { host_id: 'H1', started_at: '2026-07-20T19:00:00Z', ended_at: '2026-07-21T00:00:00Z' }, // 5h but H1 PUNCHED 07-20 → must skip
  { host_id: 'H2', started_at: '2026-07-24T18:00:00Z', ended_at: '2026-07-24T22:00:00Z' }, // 4h → fallback (no punch 07-24)
  { host_id: 'HZ', started_at: '2026-07-25T18:00:00Z', ended_at: null },                   // null ended → excluded
  { host_id: 'HZ', started_at: '2026-07-26T18:00:00Z', ended_at: '2026-07-26T18:05:00Z' }, // 5min → excluded
  { host_id: 'HZ', started_at: '2026-07-27T18:00:00Z', ended_at: '2026-07-28T06:00:00Z' }, // 12h → excluded
];

// ═══ 2a — RECONCILIATION GATE: punch labor == computePay, per employee, to the cent ═══
// sessions=[] isolates the punch path (computePay has no session fallback).
console.log('2a — reconciliation gate (punch == computePay)');
{
  const { contributions } = computeLaborByDateRole(EMP, SHIFTS, []);
  const pay = computePay(EMP, SHIFTS);
  let failures = 0;
  for (const e of EMP) {
    const laborHours = contributions.filter((c) => c.employee_id === e.id && c.basis === 'punch').reduce((s, c) => s + c.hours, 0);
    const laborPayCents = cents(laborHours * e.hourly_rate);
    const payCents = cents(pay.find((p) => p.employee.id === e.id).pay);
    const ok = laborPayCents === payCents;
    if (!ok) failures++;
    check(`reconcile ${e.id}`, ok, `labor ${laborPayCents}¢ vs computePay ${payCents}¢`);
  }
  check('ALL employees reconcile to the cent', failures === 0, `${failures} failure(s)`);
}

// ═══ 2b — INVARIANT: clock-in Pacific date always equals shifts.date (bucket agreement) ═══
console.log('2b — bucket invariant (clock_in Pacific date == shifts.date)');
{
  const mismatches = SHIFTS.filter((s) => s.clock_in_at && pacificDate(s.clock_in_at) !== s.date);
  check('zero clock_in/date mismatches in fixture', mismatches.length === 0, `${mismatches.length} found`);
  // (Verified separately against live DB for the window: 0 mismatches.)
}

// ═══ 2c — DOUBLE-COUNT: no (employee, date) contributes both punch and session_fallback ═══
console.log('2c — no punch+fallback for the same (host, date)');
{
  const { contributions } = computeLaborByDateRole(EMP, SHIFTS, SESSIONS);
  const bases = new Map();
  for (const c of contributions) {
    const k = `${c.employee_id}|${c.date}`;
    (bases.get(k) ?? bases.set(k, new Set()).get(k)).add(c.basis);
  }
  const doubled = [...bases.entries()].filter(([, set]) => set.has('punch') && set.has('session_fallback'));
  check('no (employee,date) has both bases', doubled.length === 0, `${doubled.length} doubled`);
  // H1 punched AND had a session on 07-20 → session must have been dropped
  check('H1 07-20 is punch-only (session dropped)', bases.get('H1|2026-07-20').size === 1 && bases.get('H1|2026-07-20').has('punch'));
}

// ═══ 2d — EDIT PROPAGATION: changing clock_out_at changes labor (no cached derivation) ═══
console.log('2d — punch-time edit flows through');
{
  const base = [{ employee_id: 'F1', date: '2026-07-20', start_time: '06:00', end_time: '14:00', source: 'time_clock', confirmed_at: '2026-07-21T00:00:00Z', break_minutes: 0, clock_in_at: '2026-07-20T13:00:00Z', clock_out_at: '2026-07-20T21:00:00Z' }];
  const before = computeLaborByDateRole([EMP[2]], base, []).cells.find((c) => c.role === 'fulfillment').cents;
  const edited = [{ ...base[0], clock_out_at: '2026-07-20T22:00:00Z' }]; // +1h
  const after = computeLaborByDateRole([EMP[2]], edited, []).cells.find((c) => c.role === 'fulfillment').cents;
  check('edit +1h raises labor by rate×1h', after - before === cents(22), `Δ ${after - before}¢ (expected ${cents(22)}¢)`);
}

// ═══ Behaviour checks: fallback, flags, unconfirmed surfacing, basis, guards ═══
console.log('behaviour — fallback / flags / unconfirmed / basis / guards');
{
  const { cells, contributions } = computeLaborByDateRole(EMP, SHIFTS, SESSIONS);
  const cell = (d, r) => cells.find((c) => c.date === d && c.role === r);
  const contrib = (id, d) => contributions.filter((c) => c.employee_id === id && c.date === d);

  // HZ zero-rate host fallback: hours emitted, cents 0, flagged
  const hz = contrib('HZ', '2026-07-20')[0];
  check('HZ fallback: 3h emitted, $0, flagged', hz && hz.basis === 'session_fallback' && Math.abs(hz.hours - 3) < 1e-9 && hz.cents === 0 && hz.zero_rate_flag === true);
  // 07-20 host cell = H1 punch (8h,$200) + HZ fallback (3h,$0) → mixed, flagged
  const h2020 = cell('2026-07-20', 'host');
  check('07-20 host cell is mixed + flagged', h2020.labor_basis === 'mixed' && h2020.zero_rate_flag === true, `basis=${h2020.labor_basis}`);
  check('07-20 host cents = $200 (punch only; fallback is $0)', h2020.cents === cents(200), `${h2020.cents}¢`);
  // H2 fallback on 07-24 (no punch that day): 4h × $25 = $100
  const h224 = contrib('H2', '2026-07-24')[0];
  check('H2 07-24 fallback = 4h/$100', h224 && h224.basis === 'session_fallback' && h224.cents === cents(100));
  // 07-20 fulfillment cell = F1 punch only
  check('07-20 fulfillment cell = $176, basis punch', cell('2026-07-20', 'fulfillment').cents === cents(176) && cell('2026-07-20', 'fulfillment').labor_basis === 'punch');
  // Overnight F1 books to 07-23 (clock-in Pacific), not 07-24
  check('overnight punch books to clock-in date 07-23', cell('2026-07-23', 'fulfillment').cents === cents(176) && !cell('2026-07-24', 'fulfillment'));
  // Unconfirmed H1 07-22: surfaced, not counted
  const h222 = cell('2026-07-22', 'host');
  check('07-22 host: 8h unconfirmed surfaced, 0 counted', Math.abs(h222.unconfirmed_hours_excluded - 8) < 1e-9 && h222.cents === 0, `pending=${h222.unconfirmed_hours_excluded}`);
  // Fallback guards: HZ has NO fallback on 07-25 (null end), 07-26 (<10m), 07-27 (>11h)
  check('fallback guards drop null-end / <10m / >11h', contrib('HZ', '2026-07-25').length === 0 && contrib('HZ', '2026-07-26').length === 0 && contrib('HZ', '2026-07-27').length === 0);
}

console.log(`\n${passed} checks passed.`);
