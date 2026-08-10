// Payroll-integration proof for the time clock: an unconfirmed time-clock shift is kept OUT
// of pay, a confirmed one is counted (net of breaks) EXACTLY ONCE, and manual/recurring
// shifts are unaffected. This exercises the REAL isPayableShift / paidShiftHours / computePay
// from employees.ts (transpiled at runtime; its only import is type-only, erased).
//
// Run:  TZ=UTC node src/lib/employees.timeclock.test.mjs

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./employees.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'tcp-')), 'employees.mjs');
writeFileSync(outFile, outputText);
const { isPayableShift, paidShiftHours, computePay } = await import(pathToFileURL(outFile).href);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

const EMP = { id: 'e1', hourly_rate: 20 };
const hoursFor = (shifts) => computePay([EMP], shifts)[0].hours;
const payFor = (shifts) => computePay([EMP], shifts)[0].pay;
const CONFIRMED = '2026-07-20T18:00:00Z';

// ── paidShiftHours: span minus unpaid break, floored at 0 (maps to shift test 7) ──
console.log('\npaidShiftHours');
{
  check('8h shift, no break → 8', paidShiftHours({ employee_id: 'e1', start_time: '09:00', end_time: '17:00' }) === 8);
  check('8h shift, 30m break → 7.5', paidShiftHours({ employee_id: 'e1', start_time: '09:00', end_time: '17:00', break_minutes: 30 }) === 7.5);
  check('overnight 23:00→02:00 → 3', paidShiftHours({ employee_id: 'e1', start_time: '23:00', end_time: '02:00' }) === 3);
  check('break larger than span → floored at 0', paidShiftHours({ employee_id: 'e1', start_time: '09:00', end_time: '09:15', break_minutes: 60 }) === 0);
}

// ── isPayableShift: the confirmation gate (maps to shift test 8 + pay integration) ──
console.log('\nisPayableShift');
{
  check('open shift (no end) excluded', isPayableShift({ employee_id: 'e1', start_time: '09:00', end_time: null }) === false);
  check('manual completed shift payable', isPayableShift({ employee_id: 'e1', start_time: '09:00', end_time: '17:00', source: 'manual', confirmed_at: null }) === true);
  check('recurring-like (no source field) payable', isPayableShift({ employee_id: 'e1', start_time: '09:00', end_time: '17:00' }) === true);
  check('UNCONFIRMED time_clock excluded', isPayableShift({ employee_id: 'e1', start_time: '09:00', end_time: '17:00', source: 'time_clock', confirmed_at: null }) === false);
  check('CONFIRMED time_clock payable', isPayableShift({ employee_id: 'e1', start_time: '09:00', end_time: '17:00', source: 'time_clock', confirmed_at: CONFIRMED }) === true);
}

// ── isPayableShift: PUNCHES ARE TRUTH — materialized-from-schedule rows never pay (Deploy C) ──
console.log('\nisPayableShift — source_rule_id guard (schedule is plan, not pay)');
{
  check('manual + source_rule_id SET + end_time → NOT payable (materialized plan row)',
    isPayableShift({ employee_id: 'e1', start_time: '16:00', end_time: '02:00', source: 'manual', source_rule_id: 'rule-1' }) === false);
  check('manual + source_rule_id NULL + end_time → payable (hand-entered correction)',
    isPayableShift({ employee_id: 'e1', start_time: '09:00', end_time: '17:00', source: 'manual', source_rule_id: null }) === true);
  check('time_clock CONFIRMED (no rule) → payable',
    isPayableShift({ employee_id: 'e1', start_time: '09:00', end_time: '17:00', source: 'time_clock', confirmed_at: CONFIRMED, source_rule_id: null }) === true);
  check('time_clock UNCONFIRMED → NOT payable',
    isPayableShift({ employee_id: 'e1', start_time: '09:00', end_time: '17:00', source: 'time_clock', confirmed_at: null }) === false);
  // computePay integration: a materialized recurring row contributes 0 even mixed with a payable manual row.
  const manualPay = { employee_id: 'e1', start_time: '09:00', end_time: '17:00', source: 'manual' }; // 8h
  const materializedPlan = { employee_id: 'e1', start_time: '16:00', end_time: '02:00', source: 'manual', source_rule_id: 'rule-1' }; // 10h plan, must NOT pay
  check('computePay: materialized plan row adds 0h (only the 8h manual counts)',
    hoursFor([manualPay, materializedPlan]) === 8, `got ${hoursFor([manualPay, materializedPlan])}`);
}

// ── computePay: the end-to-end pay behaviour the spec requires ──
console.log('\ncomputePay — unconfirmed stays out, confirmed counts once');
{
  const unconfirmed = { employee_id: 'e1', start_time: '09:00', end_time: '17:00', source: 'time_clock', confirmed_at: null, break_minutes: 30 };
  check('unconfirmed time-clock shift → 0h in pay', hoursFor([unconfirmed]) === 0, `got ${hoursFor([unconfirmed])}`);

  const confirmed = { ...unconfirmed, confirmed_at: CONFIRMED };
  check('after confirm → 7.5h (8h span − 30m break)', hoursFor([confirmed]) === 7.5, `got ${hoursFor([confirmed])}`);
  check('after confirm → $150 (7.5h × $20)', payFor([confirmed]) === 150, `got ${payFor([confirmed])}`);

  // EXACTLY ONCE: the same confirmed shift passed once yields its hours once, not doubled.
  check('confirmed shift counted exactly once', hoursFor([confirmed]) === 7.5);
}

console.log('\ncomputePay — manual + recurring unaffected, mixed totals');
{
  const manual = { employee_id: 'e1', start_time: '09:00', end_time: '17:00', source: 'manual', confirmed_at: null, break_minutes: 0 };
  const recurringLike = { employee_id: 'e1', start_time: '10:00', end_time: '14:00' }; // 4h, no time-clock fields
  check('manual 8h counted (no confirmation needed)', hoursFor([manual]) === 8);
  check('recurring-like 4h counted', hoursFor([recurringLike]) === 4);

  const confirmedTc = { employee_id: 'e1', start_time: '09:00', end_time: '17:00', source: 'time_clock', confirmed_at: CONFIRMED, break_minutes: 30 }; // 7.5h
  const unconfirmedTc = { employee_id: 'e1', start_time: '09:00', end_time: '13:00', source: 'time_clock', confirmed_at: null }; // 4h but excluded
  const total = hoursFor([manual, recurringLike, confirmedTc, unconfirmedTc]);
  check('mixed total = 8 + 4 + 7.5 (unconfirmed 4h excluded) = 19.5', total === 19.5, `got ${total}`);
}

console.log('\ncomputePay — overnight shift + consistent rounding');
{
  // Overnight session that crosses midnight: 23:00 → 02:00 = 3 payable hours (shiftHours adds
  // 24h when end < start). Positive, and included once when confirmed.
  const overnight = { employee_id: 'e1', start_time: '23:00:00', end_time: '02:00:00', source: 'time_clock', confirmed_at: CONFIRMED, break_minutes: 0 };
  check('overnight paidShiftHours = 3 (positive)', paidShiftHours(overnight) === 3, `got ${paidShiftHours(overnight)}`);
  check('overnight confirmed → 3h in pay', hoursFor([overnight]) === 3, `got ${hoursFor([overnight])}`);
  // Minute-aligned punches (seconds already dropped by the RPC/derive) → exact whole-minute pay.
  const aligned = { employee_id: 'e1', start_time: '09:00:00', end_time: '17:00:00', source: 'time_clock', confirmed_at: CONFIRMED, break_minutes: 30 };
  check('minute-aligned 8h − 30m break → exactly 7.5h (no stray seconds)', paidShiftHours(aligned) === 7.5, `got ${paidShiftHours(aligned)}`);
}

console.log('\ncomputePay — server confirmation makes the shift enter Pay exactly once (regression)');
{
  // A time-clock shift as clock-out writes it: unconfirmed. Flipping confirmed_at is EXACTLY
  // what the server RPC lensed_confirm_time_clock_shift does (proven in the DB suite).
  const shift = { employee_id: 'e1', start_time: '09:00:00', end_time: '17:00:00', source: 'time_clock', confirmed_at: null, break_minutes: 30 };
  check('unconfirmed → 0h (excluded from Pay)', hoursFor([shift]) === 0, `got ${hoursFor([shift])}`);
  const confirmed = { ...shift, confirmed_at: CONFIRMED };
  check('after server confirm → included, 7.5h', hoursFor([confirmed]) === 7.5, `got ${hoursFor([confirmed])}`);
  check('included EXACTLY once (not doubled)', hoursFor([confirmed]) === 7.5);
}

console.log(`\nALL PASSED (${passed} assertions)`);
