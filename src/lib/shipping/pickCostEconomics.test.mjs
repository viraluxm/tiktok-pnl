// Unit proof for fulfillment unit economics — $/box, $/SKU, the payable-vs-pending split, and
// the on-clock-but-zero-boxes rows. Exercises the REAL exported functions from
// pickCostEconomics.ts, transpiled at runtime (no app test runner exists). Its two
// value-imports are rewired to transpiled modules; '@/types' imports are type-only (erased).
//
// Run:  node src/lib/shipping/pickCostEconomics.test.mjs
//   (every timezone helper takes an explicit tz, so results are host-TZ independent)
//
// The main fixture is the REAL 2026-09-02 day shift, because that day contains every hard
// case at once: five fulfillment punches, ALL unconfirmed (payable hours = 0 for the whole
// crew), and two of the five completed zero boxes.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'pickcost-'));
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
const employeesUrl = transpile('../employees.ts', 'employees.mjs');
const perfUrl = transpile('./pickerPerformance.ts', 'pickerPerformance.mjs');
const { aggregateFulfillmentDay } = await import(perfUrl);
const costUrl = transpile('./pickCostEconomics.ts', 'pickCostEconomics.mjs', {
  "'@/lib/employees'": `'${employeesUrl}'`,
  "'@/lib/shipping/pickerPerformance'": `'${perfUrl}'`,
});
const {
  FULFILLMENT_TRACKS, isFulfillmentTrack, shiftFulfillmentDay, employeeCostForDay,
  perUnitCents, buildFulfillmentEconomics, subtotalByTrack, formatCentsPerUnit, formatDollars,
  formatHours, formatTrack, MAX_PLAUSIBLE_PUNCH_HOURS,
  pickerKey, skuCount, countBoxesOutsidePunch,
} = await import(costUrl);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};
const near = (a, b, tol = 0.01) => a != null && Math.abs(a - b) <= tol;

const RATE = 22;
// A time-clock punch. PT → UTC is +7h in September (PDT).
const punch = (employee_id, date, inPT, outPT, { confirmed = false, ruleId = null, open = false } = {}) => ({
  employee_id,
  date,
  start_time: inPT,
  end_time: open ? null : outPT,
  source: 'time_clock',
  source_rule_id: ruleId,
  confirmed_at: confirmed ? `${date}T23:00:00Z` : null,
  break_minutes: 0,
  clock_in_at: `${date}T${String(Number(inPT.slice(0, 2)) + 7).padStart(2, '0')}${inPT.slice(2)}:00Z`,
  clock_out_at: open ? null : `${date}T${String(Number(outPT.slice(0, 2)) + 7).padStart(2, '0')}${outPT.slice(2)}:00Z`,
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('track vocabulary');
// ─────────────────────────────────────────────────────────────────────────────
check('three tracks', FULFILLMENT_TRACKS.length === 3, FULFILLMENT_TRACKS.join('/'));
check('picker/packer/flex accepted',
  ['picker', 'packer', 'flex'].every(isFulfillmentTrack));
check('anything else rejected',
  !isFulfillmentTrack('forklift') && !isFulfillmentTrack('') && !isFulfillmentTrack(null)
  && !isFulfillmentTrack('fulfillment'));

// ─────────────────────────────────────────────────────────────────────────────
console.log('shift → fulfillment day (must share the 04:00 boundary with boxes)');
// ─────────────────────────────────────────────────────────────────────────────
{
  // Day crew: clock in 06:15 PT on 09-02 → 09-02.
  const day = punch('E1', '2026-09-02', '06:15', '14:03');
  check('06:15 PT punch → same day', shiftFulfillmentDay(day, 'America/Los_Angeles') === '2026-09-02');

  // Night crew: clock in 17:01 PT on 09-01, out 01:30 PT on 09-02. Books to 09-01, which is
  // the SAME fulfillment day the 00:30 boxes bucket into — the whole point of the boundary.
  const night = {
    ...punch('E1', '2026-09-01', '17:01', '01:30'),
    clock_in_at: '2026-09-02T00:01:00Z',  // 17:01 PT on 09-01
    clock_out_at: '2026-09-02T08:30:00Z', // 01:30 PT on 09-02
  };
  check('night punch crossing midnight → ONE day', shiftFulfillmentDay(night, 'America/Los_Angeles') === '2026-09-01');

  // 02:00 PT is BEFORE the 04:00 boundary → previous fulfillment day. This is exactly where
  // labor.ts's calendar-date bucketing would disagree with the box bucketing.
  const preDawn = { ...punch('E1', '2026-09-02', '02:00', '03:30'), clock_in_at: '2026-09-02T09:00:00Z' };
  check('02:00 PT punch → PREVIOUS fulfillment day',
    shiftFulfillmentDay(preDawn, 'America/Los_Angeles') === '2026-09-01');

  // Manual shift with no punch instants → falls back to shifts.date.
  const manual = { employee_id: 'E1', date: '2026-08-30', start_time: '06:00', end_time: '14:00', source: 'manual' };
  check('manual shift (no instants) falls back to shifts.date',
    shiftFulfillmentDay(manual, 'America/Los_Angeles') === '2026-08-30');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('payable vs pending split (the payroll gate is never weakened)');
// ─────────────────────────────────────────────────────────────────────────────
{
  const EMP = [
    { id: 'F1', role: 'fulfillment', hourly_rate: RATE },
    { id: 'F2', role: 'fulfillment', hourly_rate: RATE },
    { id: 'H1', role: 'host', hourly_rate: 25 },
  ];
  const SHIFTS = [
    punch('F1', '2026-09-02', '06:00', '14:00', { confirmed: true }),   // 8h payable
    punch('F2', '2026-09-02', '06:00', '14:00'),                        // 8h PENDING
    punch('H1', '2026-09-02', '06:00', '14:00', { confirmed: true }),   // host — not pick labor
    punch('F1', '2026-09-01', '06:00', '14:00', { confirmed: true }),   // other day
    { ...punch('F1', '2026-09-02', '17:00', '01:00'), open: true, end_time: null, clock_out_at: null }, // OPEN
    punch('F2', '2026-09-02', '06:00', '14:00', { confirmed: true, ruleId: 'rule-1' }), // plan row
    punch('GHOST', '2026-09-02', '06:00', '14:00', { confirmed: true }), // orphan employee
  ];
  const m = employeeCostForDay(EMP, SHIFTS, '2026-09-02', 'America/Los_Angeles');

  check('only fulfillment employees bucketed', m.size === 2, `ids: ${[...m.keys()].join(',')}`);
  check('host excluded', !m.has('H1'));
  check('orphan punch skipped', !m.has('GHOST'));

  const f1 = m.get('F1');
  check('confirmed punch → payable 8h', near(f1.payable_hours, 8), `${f1.payable_hours}h`);
  check('payable cents = 8h × $22', f1.payable_cents === Math.round(8 * RATE * 100), `${f1.payable_cents}c`);
  check('OPEN punch contributes nothing (indeterminate hours)',
    f1.pending_hours === 0, `pending ${f1.pending_hours}h`);

  const f2 = m.get('F2');
  check('unconfirmed punch → PENDING, not payable',
    f2.payable_hours === 0 && near(f2.pending_hours, 8), `payable ${f2.payable_hours}h / pending ${f2.pending_hours}h`);
  check('materialized plan row (source_rule_id) excluded from BOTH',
    near(f2.pending_hours, 8) && f2.payable_hours === 0, 'only the one real punch counted');

  // Break deduction flows through paidShiftHours verbatim — never reimplemented here.
  const withBreak = employeeCostForDay(
    EMP, [{ ...punch('F1', '2026-09-02', '06:00', '14:00', { confirmed: true }), break_minutes: 30 }],
    '2026-09-02', 'America/Los_Angeles');
  check('break_minutes deducted (8h span − 30m = 7.5h)',
    near(withBreak.get('F1').payable_hours, 7.5), `${withBreak.get('F1').payable_hours}h`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('per-unit guards');
// ─────────────────────────────────────────────────────────────────────────────
check('cents/box over 0 boxes → null (not 0)', perUnitCents(10000, 0) === null);
check('0 cents → null (nobody on the clock ≠ free)', perUnitCents(0, 10) === null);
check('negative guarded', perUnitCents(-5, 10) === null && perUnitCents(100, -3) === null);
check('normal case', near(perUnitCents(15390, 100), 153.9, 0.001));

// ─────────────────────────────────────────────────────────────────────────────
console.log('real day: 2026-09-02 day shift (all punches unconfirmed, 2 of 5 zero-box)');
// ─────────────────────────────────────────────────────────────────────────────
{
  const EMP = [
    { id: 'alex', role: 'fulfillment', hourly_rate: RATE, fulfillment_track: 'picker' },
    { id: 'jeralynn', role: 'fulfillment', hourly_rate: RATE, fulfillment_track: 'picker' },
    { id: 'blake', role: 'fulfillment', hourly_rate: RATE, fulfillment_track: 'flex' },
    { id: 'joseph', role: 'fulfillment', hourly_rate: RATE, fulfillment_track: 'packer' },
    { id: 'carlos', role: 'fulfillment', hourly_rate: RATE },  // track unset
  ];
  const SHIFTS = [
    punch('alex', '2026-09-02', '06:15', '14:03'),      // 7.80h
    punch('jeralynn', '2026-09-02', '06:05', '14:01'),  // 7.9333h
    punch('blake', '2026-09-02', '07:25', '14:01'),     // 6.60h
    punch('carlos', '2026-09-02', '07:17', '14:01'),    // 6.7333h — ZERO boxes
    punch('joseph', '2026-09-02', '06:15', '14:03'),    // 7.80h  — ZERO boxes
  ];
  const stat = (id, name, boxes, orders) => ({
    picker_employee_id: id, name, is_unassigned: false,
    orders_picked: orders, boxes_completed: boxes,
    avg_pick_ms: null, active_pick_ms: null, orders_per_active_hour: null,
    valid_duration_count: 0, sessions: 1, median_gap_ms: null,
  });
  const PICKERS = [
    stat('alex', 'Alex', 225, 832),
    stat('jeralynn', 'Jeralynn', 173, 631),
    stat('blake', 'Blake', 129, 401),
  ];
  const NAMES = { alex: 'Alex', jeralynn: 'Jeralynn', blake: 'Blake', joseph: 'Joseph', carlos: 'carlos' };
  const TRACKS = { alex: 'picker', jeralynn: 'picker', blake: 'flex', joseph: 'packer', carlos: null };

  const cost = employeeCostForDay(EMP, SHIFTS, '2026-09-02', 'America/Los_Angeles');
  const econ = buildFulfillmentEconomics({ pickers: PICKERS, costByEmployee: cost, nameById: NAMES, trackById: TRACKS });

  check('rows examined', econ.rows.length === 5, `${econ.rows.length} rows (3 picked + 2 on-clock zero-box)`);
  check('zero-box on-clock people GET a row', econ.rows.some((r) => r.name === 'Joseph')
    && econ.rows.some((r) => r.name === 'carlos'));
  check('pickers sort ahead of zero-box rows',
    econ.rows.slice(0, 3).every((r) => r.boxes_completed > 0)
    && econ.rows.slice(3).every((r) => r.boxes_completed === 0));

  const alex = econ.rows.find((r) => r.name === 'Alex');
  check('track attached', alex.fulfillment_track === 'picker');
  check('unset track survives as null', econ.rows.find((r) => r.name === 'carlos').fulfillment_track === null);
  check('existing PickerDayStats fields preserved verbatim',
    alex.orders_picked === 832 && alex.boxes_completed === 225 && alex.orders_per_active_hour === null);

  // ALL punches unconfirmed → confirmed cost is genuinely not computable, and must read as
  // null rather than as a misleading $0.000.
  check('unconfirmed day → confirmed $/box is null',
    alex.cost.cost_per_box_cents === null && econ.cost.cost_per_box_cents === null,
    'payroll gate held');
  check('…and confirmed $/SKU is null too',
    alex.cost.cost_per_order_cents === null && econ.cost.cost_per_order_cents === null);
  check('crew payable hours are 0 on an unconfirmed day', econ.cost.payable_hours === 0);

  // The projection is what a manager actually reads mid-day.
  check('Alex projected $/box ≈ $0.762',
    near(alex.cost.cost_per_box_cents_projected, 76.27, 0.05),
    `${(alex.cost.cost_per_box_cents_projected / 100).toFixed(3)}`);
  check('Alex projected $/SKU ≈ $0.206',
    near(alex.cost.cost_per_order_cents_projected, 20.63, 0.05),
    `${(alex.cost.cost_per_order_cents_projected / 100).toFixed(3)}`);
  check('crew projected $/box ≈ $1.539',
    near(econ.cost.cost_per_box_cents_projected, 153.9, 0.2),
    `${(econ.cost.cost_per_box_cents_projected / 100).toFixed(3)}`);
  check('crew projected $/SKU ≈ $0.435',
    near(econ.cost.cost_per_order_cents_projected, 43.5, 0.1),
    `${(econ.cost.cost_per_order_cents_projected / 100).toFixed(3)}`);

  // A zero-box row has hours and money but no rate — never a divide-by-zero, never $0.
  const joseph = econ.rows.find((r) => r.name === 'Joseph');
  check('zero-box row keeps its hours', near(joseph.cost.pending_hours, 7.8), `${joseph.cost.pending_hours}h`);
  check('zero-box row has NO $/box (0 boxes)', joseph.cost.cost_per_box_cents_projected === null);
  check('zero-box row is flagged on_clock', joseph.on_clock === true);

  // The crew figure includes the unproductive hours; unproductive_* explains it.
  check('unproductive hours = Joseph + carlos',
    near(econ.unproductive_hours, 7.8 + 6.7333, 0.02), `${econ.unproductive_hours.toFixed(2)}h`);
  check('unproductive cost ≈ $320',
    near(econ.unproductive_cents, (7.8 + 6.7333) * RATE * 100, 200),
    formatDollars(econ.unproductive_cents));

  // RECONCILIATION: crew money must equal the sum over employees — no double count, no drop.
  let sumCents = 0;
  for (const c of cost.values()) sumCents += c.payable_cents + c.pending_cents;
  check('crew cents == Σ per-employee cents',
    econ.cost.payable_cents + econ.cost.pending_cents === sumCents,
    `${sumCents}c over ${cost.size} employees`);

  // And crew $/box must be WORSE than the picking-only rate, because it carries the idle hours.
  const pickingCents = econ.rows.filter((r) => r.boxes_completed > 0)
    .reduce((s, r) => s + r.cost.payable_cents + r.cost.pending_cents, 0);
  const pickingBoxes = econ.rows.reduce((s, r) => s + r.boxes_completed, 0);
  check('crew $/box is worse than picking-only $/box (idle hours are carried)',
    econ.cost.cost_per_box_cents_projected > pickingCents / pickingBoxes,
    `crew ${(econ.cost.cost_per_box_cents_projected / 100).toFixed(3)} vs picking ${(pickingCents / pickingBoxes / 100).toFixed(3)}`);

  // ── track roll-up: the reason the sub-type exists ────────────────────────────
  const subs = subtotalByTrack(econ.rows);
  check('buckets examined', subs.length === 4,
    `${subs.length} buckets: ${subs.map((s) => s.track ?? 'unset').join(', ')}`);
  check('buckets in FULFILLMENT_TRACKS order, Unset last',
    subs.map((s) => s.track).join(',') === 'picker,packer,flex,');
  check('empty buckets omitted, not emitted as zeros',
    subs.every((s) => s.people > 0));

  const pickerSub = subs.find((s) => s.track === 'picker');
  check('picker bucket = Alex + Jeralynn', pickerSub.people === 2
    && pickerSub.boxes_completed === 398 && pickerSub.orders_picked === 1463,
    `${pickerSub.boxes_completed} boxes / ${pickerSub.orders_picked} SKUs`);
  check('picker $/box ≈ $0.870', near(pickerSub.cost.cost_per_box_cents_projected, 86.97, 0.1),
    `${(pickerSub.cost.cost_per_box_cents_projected / 100).toFixed(3)}`);

  const packerSub = subs.find((s) => s.track === 'packer');
  check('packer bucket has hours but no $/box (packing writes no rows)',
    near(packerSub.cost.pending_hours, 7.8) && packerSub.cost.cost_per_box_cents_projected === null,
    `${packerSub.cost.pending_hours}h, 0 boxes`);

  check('Unset bucket surfaced, not hidden',
    subs.find((s) => s.track === null).people === 1, 'carlos has no track set');

  // CONSERVATION: every row lands in exactly one bucket, and no money is created or lost.
  let bucketCents = 0;
  let bucketPeople = 0;
  for (const s of subs) {
    bucketCents += s.cost.payable_cents + s.cost.pending_cents;
    bucketPeople += s.people;
  }
  check('Σ bucket cents == crew cents',
    bucketCents === econ.cost.payable_cents + econ.cost.pending_cents,
    `${bucketCents}c across ${subs.length} buckets`);
  check('Σ bucket people == row count (each row in exactly one bucket)',
    bucketPeople === econ.rows.length, `${bucketPeople} of ${econ.rows.length}`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('forgotten clock-outs must not poison the projection (real 2026-08-31 shape)');
// ─────────────────────────────────────────────────────────────────────────────
{
  // 2026-08-31 really contained a single 47.15h punch (carlos) and a 23.81h one (Joseph),
  // both unconfirmed. Projecting them put the day at $2.93/box against $1.57 confirmed.
  const EMP = [
    { id: 'good', role: 'fulfillment', hourly_rate: RATE },
    { id: 'runaway', role: 'fulfillment', hourly_rate: RATE },
    { id: 'double', role: 'fulfillment', hourly_rate: RATE },
  ];
  const long = (id, hours) => ({
    employee_id: id, date: '2026-08-31', start_time: '06:00', end_time: '06:00',
    source: 'time_clock', source_rule_id: null, confirmed_at: null, break_minutes: 0,
    clock_in_at: '2026-08-31T13:00:00Z',
    clock_out_at: new Date(Date.parse('2026-08-31T13:00:00Z') + hours * 3600_000).toISOString(),
  });
  const SHIFTS = [
    punch('good', '2026-08-31', '06:00', '14:00'),  // 8h pending — plausible
    long('runaway', 47.15),                          // forgotten clock-out
    // A LEGITIMATE double: two ~8h punches summing to 16.08h. Must NOT be suspected, which is
    // why the threshold is per-punch and not per day-sum (Alejandro really did this on 08-31).
    punch('double', '2026-08-31', '06:00', '14:00'),
    { ...punch('double', '2026-08-31', '17:00', '01:05'), clock_in_at: '2026-09-01T00:00:00Z', clock_out_at: '2026-09-01T08:05:00Z' },
  ];
  const cost = employeeCostForDay(EMP, SHIFTS, '2026-08-31', 'America/Los_Angeles');

  check('threshold is 18h', MAX_PLAUSIBLE_PUNCH_HOURS === 18);
  const runaway = cost.get('runaway');
  check('47.15h punch flagged suspect, NOT pending',
    runaway.suspect_punches === 1 && near(runaway.suspect_hours, 47.15, 0.02) && runaway.pending_hours === 0,
    `${runaway.suspect_hours.toFixed(2)}h suspect`);
  check('suspect hours carry NO money into the projection', runaway.pending_cents === 0);

  const dbl = cost.get('double');
  check('legitimate 16.08h double (two punches) NOT suspected',
    dbl.suspect_punches === 0 && near(dbl.pending_hours, 16.08, 0.05),
    `${dbl.pending_hours.toFixed(2)}h pending over 2 punches`);

  // With the runaway excluded, the projection reflects the 24.08 plausible hours only.
  const econ = buildFulfillmentEconomics({
    pickers: [{
      picker_employee_id: 'good', name: 'good', is_unassigned: false,
      orders_picked: 300, boxes_completed: 100,
      avg_pick_ms: null, active_pick_ms: null, orders_per_active_hour: null,
      valid_duration_count: 0, sessions: 1, median_gap_ms: null,
    }],
    costByEmployee: cost, nameById: { good: 'good', runaway: 'runaway', double: 'double' } });
  check('crew suspect surfaced for the UI',
    econ.suspect_punches === 1 && near(econ.suspect_hours, 47.15, 0.02));
  check('crew projection excludes the runaway (24.08h, not 71.2h)',
    near(econ.cost.pending_hours, 8 + 16.08, 0.05), `${econ.cost.pending_hours.toFixed(2)}h`);
  check('projected $/box uses only plausible hours',
    near(econ.cost.cost_per_box_cents_projected, 24.08 * RATE * 100 / 100, 2),
    `${(econ.cost.cost_per_box_cents_projected / 100).toFixed(3)}`);

  // And a CONFIRMED long punch is still paid — payable must never be silently trimmed, or the
  // view would disagree with payroll.
  const confirmedLong = employeeCostForDay(
    EMP, [{ ...long('runaway', 47.15), confirmed_at: '2026-09-01T00:00:00Z' }],
    '2026-08-31', 'America/Los_Angeles');
  check('a CONFIRMED long punch stays payable (payroll is paying it)',
    near(confirmedLong.get('runaway').payable_hours, 47.15, 0.02)
    && confirmedLong.get('runaway').suspect_punches === 0,
    'never diverge from payroll');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('crew denominator must include UNASSIGNED boxes (real 2026-08-31 gap)');
// ─────────────────────────────────────────────────────────────────────────────
{
  // 08-31 had 1,159 completed boxes of which 26 were unassigned (no picker id, no snapshot).
  // Charging all paid hours against only the 1,133 attributed boxes read $1.57/box when the
  // true figure is $1.53 — the unassigned boxes were picked by paid labour too.
  const EMP = [{ id: 'F1', role: 'fulfillment', hourly_rate: RATE }];
  const SHIFTS = [{
    employee_id: 'F1', date: '2026-08-31', start_time: '06:00', end_time: '14:00',
    source: 'time_clock', source_rule_id: null, confirmed_at: '2026-09-01T00:00:00Z',
    break_minutes: 0,
    clock_in_at: '2026-08-31T13:00:00Z',
    clock_out_at: new Date(Date.parse('2026-08-31T13:00:00Z') + 80.6 * 3600_000).toISOString(),
  }];
  // 80.6h is the real 08-31 payable total; expressed as one CONFIRMED shift so it is payable
  // (a confirmed long punch is deliberately not suspected — proven directly above).
  const cost = employeeCostForDay(EMP, SHIFTS, '2026-08-31', 'America/Los_Angeles');
  const attributed = [{
    picker_employee_id: 'F1', name: 'F1', is_unassigned: false,
    orders_picked: 3181 - 78, boxes_completed: 1133,
    avg_pick_ms: null, active_pick_ms: null, orders_per_active_hour: null,
    valid_duration_count: 0, sessions: 1, median_gap_ms: null,
  }];

  const withoutTotals = buildFulfillmentEconomics({ pickers: attributed, costByEmployee: cost, nameById: { F1: 'F1' } });
  const withTotals = buildFulfillmentEconomics({ pickers: attributed, costByEmployee: cost, nameById: { F1: 'F1' },
    dayTotals: { boxes_completed: 1159, orders_picked: 3181 } });

  check('rows compared', withoutTotals.rows.length === 1 && withTotals.rows.length === 1);
  check('attributed-only denominator reads $1.57/box (the BUG)',
    near(withoutTotals.cost.cost_per_box_cents, 156.5, 0.6),
    `${(withoutTotals.cost.cost_per_box_cents / 100).toFixed(3)} over 1133 boxes`);
  check('day-totals denominator reads $1.53/box (matches the SQL)',
    near(withTotals.cost.cost_per_box_cents, 153.0, 0.6),
    `${(withTotals.cost.cost_per_box_cents / 100).toFixed(3)} over 1159 boxes`);
  check('day totals give the CHEAPER (correct) rate — unassigned work still counts',
    withTotals.cost.cost_per_box_cents < withoutTotals.cost.cost_per_box_cents);
  check('$/SKU matches the SQL too ($0.557)',
    near(withTotals.cost.cost_per_order_cents, 55.8, 0.3),
    `${(withTotals.cost.cost_per_order_cents / 100).toFixed(3)}`);
  check('per-PICKER rows still divide by that picker own boxes, not day totals',
    near(withTotals.rows[0].cost.cost_per_box_cents, 80.6 * RATE * 100 / 1133, 0.5),
    'day totals apply to the crew figure only');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('confirmed day: both figures present and equal');
// ─────────────────────────────────────────────────────────────────────────────
{
  const EMP = [{ id: 'F1', role: 'fulfillment', hourly_rate: RATE }];
  const SHIFTS = [punch('F1', '2026-08-31', '06:00', '14:00', { confirmed: true })]; // 8h × $22 = $176
  const cost = employeeCostForDay(EMP, SHIFTS, '2026-08-31', 'America/Los_Angeles');
  const econ = buildFulfillmentEconomics({
    pickers: [{
      picker_employee_id: 'F1', name: 'F1', is_unassigned: false,
      orders_picked: 400, boxes_completed: 100,
      avg_pick_ms: null, active_pick_ms: null, orders_per_active_hour: null,
      valid_duration_count: 0, sessions: 1, median_gap_ms: null,
    }],
    costByEmployee: cost, nameById: { F1: 'F1' }, trackById: { F1: 'picker' } });

  const r = econ.rows[0];
  check('confirmed $/box = $176 / 100 = $1.76', near(r.cost.cost_per_box_cents, 176), `${r.cost.cost_per_box_cents}c`);
  check('confirmed $/SKU = $176 / 400 = $0.44', near(r.cost.cost_per_order_cents, 44), `${r.cost.cost_per_order_cents}c`);
  check('nothing pending → projected equals confirmed',
    r.cost.cost_per_box_cents === r.cost.cost_per_box_cents_projected
    && r.cost.cost_per_order_cents === r.cost.cost_per_order_cents_projected);
  check('no unproductive hours when everyone picked', econ.unproductive_hours === 0);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('empty day');
// ─────────────────────────────────────────────────────────────────────────────
{
  const econ = buildFulfillmentEconomics({ pickers: [], costByEmployee: new Map() });
  check('no rows', econ.rows.length === 0);
  check('all rates null, no crash',
    econ.cost.cost_per_box_cents === null && econ.cost.cost_per_order_cents_projected === null);
  check('zero unproductive', econ.unproductive_hours === 0 && econ.unproductive_cents === 0);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('LIVE hours: cost must not read "—" for the whole working day');
// ─────────────────────────────────────────────────────────────────────────────
{
  // A `shifts` row is only written at CLOCK-OUT (verified: the one open time entry has
  // shift_id = null). So mid-shift there are no hours and both figures rendered "—" all day.
  const EMP = [
    { id: 'F1', role: 'fulfillment', hourly_rate: RATE },
    { id: 'H1', role: 'host', hourly_rate: 25 },
  ];
  const NOW = Date.parse('2026-09-02T17:00:00Z');            // 10:00 PT — mid day shift
  const OPEN = [{ employee_id: 'F1', clocked_in_at: '2026-09-02T13:15:00Z' }]; // in at 06:15 PT
  const stat = {
    picker_employee_id: 'F1', name: 'F1', is_unassigned: false,
    orders_picked: 100, boxes_completed: 40,
    avg_pick_ms: null, active_pick_ms: null, orders_per_active_hour: null,
    valid_duration_count: 0, sessions: 1, median_gap_ms: null,
  };

  // BEFORE: no shifts row, no open punch passed → nothing to divide by.
  const blind = employeeCostForDay(EMP, [], '2026-09-02', 'America/Los_Angeles');
  check('without open punches the day has ZERO hours (the bug)', blind.size === 0);
  const blindEcon = buildFulfillmentEconomics({ pickers: [stat], costByEmployee: blind });
  check('…so $/box renders as null (the "—" a manager saw all day)',
    blindEcon.cost.cost_per_box_cents_projected === null);

  // AFTER: the open punch supplies 3.75h of live hours.
  const live = employeeCostForDay(EMP, [], '2026-09-02', 'America/Los_Angeles', OPEN, NOW);
  const f1 = live.get('F1');
  check('open punch → 3.75h live', near(f1.live_hours, 3.75), `${f1.live_hours}h`);
  check('live is NOT payable and NOT pending (payroll gate untouched)',
    f1.payable_hours === 0 && f1.pending_hours === 0);
  const econ = buildFulfillmentEconomics({ pickers: [stat], costByEmployee: live });
  check('projected $/box now computable mid-shift',
    near(econ.cost.cost_per_box_cents_projected, 3.75 * RATE * 100 / 40, 0.5),
    `${(econ.cost.cost_per_box_cents_projected / 100).toFixed(3)}`);
  check('confirmed $/box still null — nothing is confirmed yet',
    econ.cost.cost_per_box_cents === null);
  check('crew live hours surfaced for the banner', near(econ.cost.live_hours, 3.75));

  // Breaks taken so far are subtracted, so lunch does not bill.
  const withBreak = employeeCostForDay(EMP, [],
    '2026-09-02', 'America/Los_Angeles',
    [{ ...OPEN[0], break_minutes_so_far: 30 }], NOW);
  check('break_minutes_so_far subtracted from live hours',
    near(withBreak.get('F1').live_hours, 3.25), `${withBreak.get('F1').live_hours}h`);

  // A host's open punch is not picking labour.
  const hostOpen = employeeCostForDay(EMP, [], '2026-09-02', 'America/Los_Angeles',
    [{ employee_id: 'H1', clocked_in_at: '2026-09-02T13:15:00Z' }], NOW);
  check('host open punch ignored', hostOpen.size === 0);

  // An open punch already past the plausible cap is a missed clock-out, not live work.
  const stale = employeeCostForDay(EMP, [], '2026-09-02', 'America/Los_Angeles',
    [{ employee_id: 'F1', clocked_in_at: '2026-09-02T11:00:00Z' }],
    Date.parse('2026-09-03T09:00:00Z')); // 22h open
  check('open punch past 18h → suspect, not live',
    stale.get('F1').suspect_punches === 1 && stale.get('F1').live_hours === 0,
    `${stale.get('F1').suspect_hours.toFixed(1)}h suspect`);

  // A punch that started on a DIFFERENT fulfillment day does not leak in.
  const other = employeeCostForDay(EMP, [], '2026-09-01', 'America/Los_Angeles', OPEN, NOW);
  check('open punch bucketed by the 04:00 boundary, not "today"', other.size === 0);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('$/SKU denominator is TRUE UNITS, not the order count');
// ─────────────────────────────────────────────────────────────────────────────
{
  check('no map → falls back to distinct order count', skuCount(['a', 'b', 'b']) === 2);
  const units = new Map([['a', 1], ['b', 3]]);
  check('with a units map → sums units', skuCount(['a', 'b'], units) === 4);
  check('order missing from the map counts as 1 (never zeroes a box)',
    skuCount(['a', 'zz'], units) === 2);
  check('duplicate ids inside one box are de-duped', skuCount(['b', 'b'], units) === 3);

  // End to end: a box holding one 3-unit order must divide by 3, not by 1.
  const EMP = [{ id: 'F1', role: 'fulfillment', hourly_rate: RATE }];
  const cost = employeeCostForDay(EMP,
    [punch('F1', '2026-09-02', '06:00', '14:00', { confirmed: true })], // 8h = $176
    '2026-09-02', 'America/Los_Angeles');
  const boxes = [{ picker_employee_id: 'F1', picker_name_snapshot: 'F1', order_ids: ['a'], verified_at: '2026-09-02T15:00:00Z' }];
  const stat = {
    picker_employee_id: 'F1', name: 'F1', is_unassigned: false,
    orders_picked: 1, boxes_completed: 1,
    avg_pick_ms: null, active_pick_ms: null, orders_per_active_hour: null,
    valid_duration_count: 0, sessions: 1, median_gap_ms: null,
  };
  const byOrders = buildFulfillmentEconomics({ pickers: [stat], costByEmployee: cost, boxes });
  const byUnits = buildFulfillmentEconomics({
    pickers: [stat], costByEmployee: cost, boxes, unitsByOrderId: new Map([['a', 3]]) });
  check('order count gives $176/SKU (overstated)', near(byOrders.rows[0].cost.cost_per_order_cents, 17600, 1));
  check('true units give $58.67/SKU', near(byUnits.rows[0].cost.cost_per_order_cents, 17600 / 3, 1));
  check('skus_picked reports 3, orders_picked still reports 1',
    byUnits.rows[0].skus_picked === 3 && byUnits.rows[0].orders_picked === 1);
  check('crew SKU total uses true units', byUnits.skus_picked === 3);
  check('$/box is unaffected by the unit count',
    byOrders.rows[0].cost.cost_per_box_cents === byUnits.rows[0].cost.cost_per_box_cents);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('pickerKey MIRRORS aggregateFulfillmentDay grouping (drift guard)');
// ─────────────────────────────────────────────────────────────────────────────
{
  // The SKU roll-up groups boxes itself, so its key rule must match the aggregate's exactly.
  // Driven off the aggregate's OWN output rather than an assumed shape.
  const ev = (gk, id, snap) => ({
    group_key: gk, picker_employee_id: id, picker_name_snapshot: snap,
    pick_started_at: null, verified_at: '2026-09-02T15:00:00Z', order_ids: [gk],
  });
  const events = [ev('b1', 'E1', 'Alex'), ev('b2', null, 'Ghost'), ev('b3', null, null), ev('b4', 'E1', 'Renamed')];
  const agg = aggregateFulfillmentDay(events, { E1: 'Alex' });

  check('aggregate produced the groups to compare', agg.pickers.length === 2 && !!agg.unassigned,
    `${agg.pickers.length} pickers + unassigned`);
  check('id wins over snapshot', pickerKey(ev('x', 'E1', 'Renamed')) === 'id:E1');
  check('snapshot used when id is null', pickerKey(ev('x', null, 'Ghost')) === 'name:Ghost');
  check('neither → null (unassigned, matches the aggregate)', pickerKey(ev('x', null, null)) === null);
  check('id-keyed boxes collapse to ONE group, exactly as the aggregate did',
    new Set(events.filter((e) => e.picker_employee_id).map(pickerKey)).size === 1
    && agg.pickers.filter((p) => p.picker_employee_id === 'E1').length === 1);
  check('unassigned box excluded from every picker key, as the aggregate excludes it',
    agg.unassigned.boxes_completed === 1);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('off-clock boxes are surfaced (cannot be corrected, only flagged)');
// ─────────────────────────────────────────────────────────────────────────────
{
  const box = (id, at) => ({ picker_employee_id: id, picker_name_snapshot: null, order_ids: ['o' + at], verified_at: at });
  const boxes = [
    box('F1', '2026-09-02T14:00:00Z'), // inside
    box('F1', '2026-09-02T20:00:00Z'), // inside
    box('F1', '2026-09-02T23:00:00Z'), // OUTSIDE — after clock-out
    box(null, '2026-09-02T14:00:00Z'), // unattributable → not examined
  ];
  const windows = [{ employee_id: 'F1', start: '2026-09-02T13:15:00Z', end: '2026-09-02T21:00:00Z' }];
  const r = countBoxesOutsidePunch(boxes, windows);
  check('examined only attributable boxes', r.examined === 3, `${r.examined} of ${boxes.length}`);
  check('one box outside the punch', r.outside === 1);

  // An OPEN window runs to now, so live work is not miscounted as off-clock.
  const openW = [{ employee_id: 'F1', start: '2026-09-02T13:15:00Z', end: null }];
  const rOpen = countBoxesOutsidePunch(boxes, openW, Date.parse('2026-09-03T00:00:00Z'));
  check('open punch window counts to now → nothing outside', rOpen.outside === 0);

  // A picker with no punch at all: every box is outside.
  const rNone = countBoxesOutsidePunch(boxes, []);
  check('no punches → every attributable box is outside', rNone.outside === 3 && rNone.examined === 3);

  // Quality passthrough onto the result.
  const econ = buildFulfillmentEconomics({
    pickers: [], costByEmployee: new Map(), boxes, punchWindows: windows,
    breakStats: { shifts: 5, withBreak: 0 },
  });
  check('quality carries the off-clock counts',
    econ.quality.boxes_examined === 3 && econ.quality.boxes_outside_punch === 1);
  check('quality carries the break counts',
    econ.quality.shifts_examined === 5 && econ.quality.shifts_with_break === 0);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('formatters');
// ─────────────────────────────────────────────────────────────────────────────
check('null → em dash', formatCentsPerUnit(null) === '—');
check('sub-dollar keeps 3 decimals (0.435 vs 0.499 must not collide)',
  formatCentsPerUnit(43.5) === '$0.435' && formatCentsPerUnit(49.9) === '$0.499');
check('over a dollar → 2 decimals', formatCentsPerUnit(153.9) === '$1.54');
check('dollars whole', formatDollars(81107) === '$811');
check('dollars thousands separated', formatDollars(2341200) === '$23,412');
check('hours one decimal', formatHours(7.8) === '7.8' && formatHours(0) === '0');
check('track label', formatTrack(null) === 'Unset' && formatTrack('packer') === 'Packer');

console.log(`\n${passed} checks passed.`);
