// Unit proof for the Shows tab's net-net economics — the two new cards' math, the trailing
// pick rate they allocate at, and the shared show-duration rule.
//
// Exercises the REAL exported functions, transpiled at runtime (no app test runner exists),
// with value-imports rewired to transpiled modules the same way pickCostEconomics.test.mjs
// does. The payroll gate is NOT stubbed: trailingFulfillmentRate reaches the real isPayableShift.
//
// Run:  node src/lib/shows/netEconomics.test.mjs
//
// FIXTURES ARE THE REAL MEASURED DAYS, not invented numbers. The trailing-rate case is the
// actual 2026-08-27..09-02 window (5,908 boxes, 18,355 recorded picks, 26,741 units sold, all
// verified against prod), and the show case is the real 2026-09-03 show the feature was designed
// against (385 auctions won / 393 units / $1,315.00 sale / $1,136.35 COGS / 68 units per hour).
// That matters because the point of the feature is that this show reads +$178.65 on the existing
// card and NEGATIVE once labor is charged — if the math here drifted, the card would go back to
// looking profitable.
//
// THE CONSERVATION TEST below is the reason the denominator is units SOLD, not units picked. It
// is the assertion that would have caught the original bug, so it is the one to keep working.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'shownet-'));
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
const perfUrl = transpile('../shipping/pickerPerformance.ts', 'pickerPerformance.mjs');
const costUrl = transpile('../shipping/pickCostEconomics.ts', 'pickCostEconomics.mjs', {
  "'@/lib/employees'": `'${employeesUrl}'`,
  "'@/lib/shipping/pickerPerformance'": `'${perfUrl}'`,
});
const rateUrl = transpile('../shipping/trailingFulfillmentRate.ts', 'trailingFulfillmentRate.mjs', {
  "'@/lib/shipping/pickCostEconomics'": `'${costUrl}'`,
  "'@/lib/shipping/pickerPerformance'": `'${perfUrl}'`,
});
const netUrl = transpile('./netEconomics.ts', 'netEconomics.mjs');
const durUrl = transpile('./duration.ts', 'duration.mjs');

const { trailingFulfillmentRate } = await import(rateUrl);
const { showNetEconomics, SHORT_SHOW_MS } = await import(netUrl);
const { resolveShowDuration } = await import(durUrl);
const { addDaysISO } = await import(perfUrl);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};
const near = (a, b, tol = 0.01) => a != null && Math.abs(a - b) <= tol;

const TZ = 'America/Los_Angeles';
const RATE = 22; // the real fulfillment rate — every picker is on $22.00/h

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
console.log('show duration — the shared rule both cards divide by');
// ─────────────────────────────────────────────────────────────────────────────
{
  const start = '2026-09-03T02:17:34Z';
  const lastCap = '2026-09-03T08:00:00Z';

  const sane = resolveShowDuration({ started_at: start, ended_at: '2026-09-03T08:02:33Z', last_capture_at: lastCap });
  check('sane ended_at is preferred', sane.source === 'ended_at' && near(sane.duration_ms / 3_600_000, 5.7497, 0.01),
    `${(sane.duration_ms / 3_600_000).toFixed(2)}h`);

  // A show that reads "Live" for days, then gets an ended_at long after the last sale.
  const stale = resolveShowDuration({ started_at: start, ended_at: '2026-09-06T00:00:00Z', last_capture_at: lastCap });
  check('stale ended_at is rejected for last-capture', stale.source === 'last_capture',
    `${(stale.duration_ms / 3_600_000).toFixed(2)}h not 69h`);

  check('ended_at BEFORE start is rejected',
    resolveShowDuration({ started_at: start, ended_at: '2026-09-02T00:00:00Z', last_capture_at: lastCap }).source === 'last_capture');

  // A live show with no ended_at at all — the common case while selling.
  const live = resolveShowDuration({ started_at: start, ended_at: null, last_capture_at: lastCap });
  check('null ended_at falls back to last capture', live.source === 'last_capture' && live.duration_ms > 0);

  // No captures AND no ended_at → nothing to measure. Must be null, not 0: a 0 would make
  // units/hr and net/hr divide by zero and render Infinity.
  const nothing = resolveShowDuration({ started_at: start, ended_at: null, last_capture_at: null });
  check('no end at all → null duration, never 0', nothing.duration_ms === null);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('trailing pick rate — pooled over the REAL 2026-08-27..09-02 window');
// ─────────────────────────────────────────────────────────────────────────────
// Real per-day crew hours from prod (payable+pending, suspect punches excluded):
//   08-27 93.6h   08-28 95.8h   08-29 19.9h   08-30 dark   08-31 109.7h   09-01 84.1h   09-02 61.0h
// Modelled as one punch per crew-member-equivalent so the pooling is what's under test, not
// the roster. Total 464.1h x $22 = $10,210.20 over 18,355 units = $0.5563/unit.
{
  const employees = [];
  const shifts = [];
  // Each day's hours split across whole 8h punches plus a remainder, all day-crew (06:00 start)
  // so every punch buckets unambiguously inside its own 04:00→04:00 fulfillment day.
  const HOURS_BY_DAY = {
    '2026-08-27': 93.6, '2026-08-28': 95.8, '2026-08-29': 19.9,
    '2026-08-31': 109.7, '2026-09-01': 84.1, '2026-09-02': 61.0,
  };
  let seq = 0;
  for (const [date, hours] of Object.entries(HOURS_BY_DAY)) {
    let left = hours;
    while (left > 0.001) {
      const h = Math.min(8, left);
      left -= h;
      const id = `emp-${seq++}`;
      employees.push({ id, role: 'fulfillment', hourly_rate: RATE });
      // 06:00 + h, expressed as HH:MM.
      const endMin = Math.round(6 * 60 + h * 60);
      const outPT = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
      shifts.push(punch(id, date, '06:00', outPT, { confirmed: true }));
    }
  }

  const dayKeys = Array.from({ length: 7 }, (_, i) => addDaysISO('2026-08-27', i));
  // Real prod volume for this window: 5,908 boxes, 18,355 recorded picks, 26,741 units sold
  // (ex-cancelled), 1,449 cancelled.
  const VOL = { sold_units: 26741, sold_orders: 26741, cancelled_orders: 1449, picked_units: 18355, boxes: 5908 };
  const r = trailingFulfillmentRate(employees, shifts, dayKeys, VOL, TZ, [], Date.parse('2026-09-03T18:00:00Z'));

  check('pools all 7 day keys (incl. the dark 08-30)', r.days === 7);
  check('pooled hours ≈ 464.1h', near(r.payable_hours, 464.1, 0.2), `${r.payable_hours.toFixed(1)}h`);
  check('pooled cost ≈ $10,210', near(r.payable_cents / 100, 10210.2, 5), `$${(r.payable_cents / 100).toFixed(2)}`);
  // THE allocation rate — labor ÷ units SOLD.
  check('$/unit sold ≈ $0.382', near(r.cents_per_unit / 100, 10210.2 / 26741, 0.005),
    `$${(r.cents_per_unit / 100).toFixed(4)}`);
  // The OLD basis, kept as a diagnostic only. Materially higher — that gap IS the bug.
  check('$/unit PICKED is higher than $/unit sold (the picked count is under-recorded)',
    r.cents_per_picked_unit_projected > r.cents_per_unit_projected,
    `picked $${(r.cents_per_picked_unit_projected / 100).toFixed(4)} vs sold $${(r.cents_per_unit_projected / 100).toFixed(4)}`);
  // picked ÷ sold is a BACKLOG ratio, not a recording-coverage one (coverage of shipped orders
  // is ~97%). Below 100% means picking ran behind sales in the window.
  check('picked % of sold ≈ 68.6% (backlog, not a recording gap)',
    near(r.picked_pct_of_sold, 100 * 18355 / 26741, 0.1), `${r.picked_pct_of_sold.toFixed(1)}%`);
  check('$/box ≈ $1.728', near(r.cents_per_box_projected / 100, 1.7283, 0.005),
    `$${(r.cents_per_box_projected / 100).toFixed(4)}`);

  // ── CONSERVATION: the property the picked-unit denominator violated ──────────────────────
  // Allocating the rate across every unit sold in the window must return the payroll actually
  // spent. With the picked denominator this over-shot by 46% ($17,520 charged vs $12,018 paid),
  // which is what made it wrong regardless of how carefully each show's share was computed.
  const laborCents = r.payable_cents + r.pending_cents + r.live_cents;
  const allocatedCents = r.cents_per_unit_projected * r.sold_units;
  check('allocating over units sold returns the real payroll (±0.1%)',
    Math.abs(allocatedCents - laborCents) / laborCents < 0.001,
    `allocated $${(allocatedCents / 100).toFixed(2)} vs payroll $${(laborCents / 100).toFixed(2)}`);
  const allocatedOnPicked = r.cents_per_picked_unit_projected * r.sold_units;
  check('allocating the PICKED rate over units sold over-charges payroll',
    allocatedOnPicked > laborCents * 1.2,
    `would charge $${(allocatedOnPicked / 100).toFixed(2)} for $${(laborCents / 100).toFixed(2)} of payroll`);

  // POOLED, NOT AVERAGED — asserted as the identity Σcents ÷ Σunits, which is the definition.
  check('rate is exactly pooled cents over units sold',
    r.cents_per_unit === r.payable_cents / r.sold_units);

  // On THIS window the mean of the daily rates happens to land close to the pooled rate
  // ($0.5602 vs $0.5563), so it proves nothing on its own — the two definitions only diverge
  // when volume is unevenly distributed. That case is constructed below, because it is the one
  // that would silently misprice a show.
  const dailyMean = [93.6 / 4118, 95.8 / 4282, 19.9 / 1167, 109.7 / 3181, 84.1 / 2199, 61.0 / 3408]
    .reduce((a, b) => a + b * RATE, 0) / 6;
  check('daily-mean of per-PICK rates is close to the pooled pick rate on this window (not a proof)',
    Math.abs(r.cents_per_picked_unit_projected / 100 - dailyMean) < 0.05,
    `pooled $${(r.cents_per_picked_unit_projected / 100).toFixed(4)} vs daily-mean $${dailyMean.toFixed(4)}`);

  // Zero units must not produce a rate. Dividing by 0 would give Infinity, which formats as
  // "$Infinity" on the card; perUnitCents returns null instead.
  const empty = trailingFulfillmentRate(employees, shifts, dayKeys,
    { sold_units: 0, sold_orders: 0, cancelled_orders: 0, picked_units: 0, boxes: 0 },
    TZ, [], Date.parse('2026-09-03T18:00:00Z'));
  check('no units sold → null rate, never 0 or Infinity',
    empty.cents_per_unit === null && empty.cents_per_box_projected === null
    && empty.cents_per_picked_unit_projected === null && empty.picked_pct_of_sold === null);
}

// Where the two definitions actually diverge: equal hours, wildly unequal volume. A mean of
// daily rates weights the 100-unit day and the 1,000-unit day the same and lands at $0.968/unit
// — 3x the $0.320 the business really paid. This is why the rate is pooled.
{
  const employees = [
    { id: 'x', role: 'fulfillment', hourly_rate: RATE },
    { id: 'y', role: 'fulfillment', hourly_rate: RATE },
  ];
  const shifts = [
    punch('x', '2026-09-01', '06:00', '14:00', { confirmed: true }),
    punch('y', '2026-09-02', '06:00', '14:00', { confirmed: true }),
  ];
  const r = trailingFulfillmentRate(employees, shifts, ['2026-09-01', '2026-09-02'],
    { sold_units: 1100, sold_orders: 1100, cancelled_orders: 0, picked_units: 1100, boxes: 200 },
    TZ, [], Date.parse('2026-09-03T18:00:00Z'));
  const dailyMean = ((8 * RATE) / 1000 + (8 * RATE) / 100) / 2;
  check('pooled $0.320 vs daily-mean $0.968 on skewed volume',
    near(r.cents_per_unit / 100, 0.32, 0.001) && near(dailyMean, 0.968, 0.001),
    `pooled $${(r.cents_per_unit / 100).toFixed(3)} vs daily-mean $${dailyMean.toFixed(3)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('trailing pick rate — the payroll gate is NOT reimplemented');
// ─────────────────────────────────────────────────────────────────────────────
{
  const employees = [
    { id: 'a', role: 'fulfillment', hourly_rate: RATE },
    { id: 'b', role: 'fulfillment', hourly_rate: RATE },
    { id: 'h', role: 'host', hourly_rate: 25 },
  ];
  const dayKeys = ['2026-09-02'];
  const now = Date.parse('2026-09-03T18:00:00Z');

  // Confirmed vs unconfirmed: the SAME 8h punch lands in payable or pending depending only on
  // confirmed_at, which is isPayableShift's rule, not this module's.
  const conf = trailingFulfillmentRate(employees, [punch('a', '2026-09-02', '06:00', '14:00', { confirmed: true })], dayKeys, { sold_units: 300, sold_orders: 300, cancelled_orders: 0, picked_units: 300, boxes: 100 }, TZ, [], now);
  const unconf = trailingFulfillmentRate(employees, [punch('a', '2026-09-02', '06:00', '14:00')], dayKeys, { sold_units: 300, sold_orders: 300, cancelled_orders: 0, picked_units: 300, boxes: 100 }, TZ, [], now);
  check('confirmed punch → payable', near(conf.payable_hours, 8) && conf.pending_hours === 0);
  check('unconfirmed punch → pending, NOT payable', unconf.payable_hours === 0 && near(unconf.pending_hours, 8));
  check('confirmed-only rate is null while everything is pending, projected is not',
    unconf.cents_per_unit === null && near(unconf.cents_per_unit_projected / 100, 8 * RATE / 300, 0.001),
    `projected $${(unconf.cents_per_unit_projected / 100).toFixed(4)}`);

  // A materialized schedule row is PLAN, never pay (source_rule_id) — the load-bearing guard.
  const planned = trailingFulfillmentRate(employees,
    [punch('a', '2026-09-02', '06:00', '14:00', { confirmed: true, ruleId: 'rule-1' })], dayKeys, { sold_units: 300, sold_orders: 300, cancelled_orders: 0, picked_units: 300, boxes: 100 }, TZ, [], now);
  check('materialized plan row contributes nothing',
    planned.payable_hours === 0 && planned.pending_hours === 0 && planned.cents_per_unit === null);

  // A forgotten clock-out must not double the window's cost.
  const runaway = trailingFulfillmentRate(employees, [punch('a', '2026-09-02', '06:00', '06:00'), punch('b', '2026-09-02', '06:00', '14:00', { confirmed: true })], dayKeys, { sold_units: 300, sold_orders: 300, cancelled_orders: 0, picked_units: 300, boxes: 100 }, TZ, [], now);
  check('open punch (no end_time) is neither payable nor pending',
    near(runaway.payable_hours, 8) && runaway.pending_hours === 0);

  // A HOST punch is not picking labor, even on a fulfillment day.
  const withHost = trailingFulfillmentRate(employees,
    [punch('h', '2026-09-02', '06:00', '14:00', { confirmed: true })], dayKeys, { sold_units: 300, sold_orders: 300, cancelled_orders: 0, picked_units: 300, boxes: 100 }, TZ, [], now);
  check('host hours are excluded from picking cost', withHost.payable_hours === 0);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('net-net — the REAL 2026-09-03 show that reads +$178.65 on the old card');
// ─────────────────────────────────────────────────────────────────────────────
{
  const UNITS = 393;
  const SALE = 131500;   // $1,315.00
  const COGS = 113635;   // $1,136.35
  const GROSS = SALE - COGS; // +$178.65 — what the existing Gross profit card shows
  const DURATION = Math.round((UNITS / 68) * 3_600_000); // 68 units/hr → 5.78h
  const HOST = Math.round(2500 * (DURATION / 3_600_000)); // $25.00/h host

  const r = showNetEconomics({
    baseProfitCents: GROSS,
    baseIsNetOfFees: false,
    unitsSold: UNITS,
    durationMs: DURATION,
    hostPayCents: HOST,
    pickCentsPerUnit: 55.63,
  });

  check('gross profit is positive on this show', GROSS === 17865, `$${(GROSS / 100).toFixed(2)}`);
  check('host pay ≈ $144.49', near(r.hostCents / 100, 144.49, 0.05), `$${(r.hostCents / 100).toFixed(2)}`);
  check('allocated picking ≈ $218.63', near(r.pickCents / 100, 218.63, 0.05), `$${(r.pickCents / 100).toFixed(2)}`);
  // THE POINT OF THE FEATURE: labor turns a +$178.65 show negative.
  check('net-net is NEGATIVE once labor is charged', r.netNetCents < 0,
    `$${(r.netNetCents / 100).toFixed(2)}`);
  check('net-net ≈ −$184.47', near(r.netNetCents / 100, -184.47, 0.1), `$${(r.netNetCents / 100).toFixed(2)}`);
  check('net-net per unit ≈ −$0.469', near(r.netNetPerUnitCents / 100, -0.4694, 0.001),
    `$${(r.netNetPerUnitCents / 100).toFixed(4)}`);
  check('net profit per hour ≈ −$31.92', near(r.netPerHourCents / 100, -31.92, 0.1),
    `$${(r.netPerHourCents / 100).toFixed(2)}`);
  check('the three per-unit lines reconcile to net-net per unit',
    near((GROSS / UNITS - r.pickPerUnitCents - r.hostPerUnitCents) / 100, r.netNetPerUnitCents / 100, 0.0001));
  check('nothing missing on a complete show', r.missing.length === 0);
  check('not flagged short', r.shortShow === false);
  check('fee state is carried through for the label', r.baseIsNetOfFees === false);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('net-net — a missing cost is NEVER zero');
// ─────────────────────────────────────────────────────────────────────────────
{
  const base = {
    baseProfitCents: 17865, baseIsNetOfFees: false, unitsSold: 393,
    durationMs: 20_805_882, hostPayCents: 14449, pickCentsPerUnit: 55.63,
  };

  // 7% of recent sessions have no host_id. Omitting host pay would print a BETTER net-net than
  // the show earned — the exact failure this null-not-zero rule exists to prevent.
  const noHost = showNetEconomics({ ...base, hostPayCents: null });
  check('no host → net-net withheld, not overstated',
    noHost.netNetCents === null && noHost.netNetPerUnitCents === null && noHost.netPerHourCents === null);
  check('no host → missing says why', noHost.missing.includes('host_pay'));
  check('no host → picking still reported on its own', near(noHost.pickCents / 100, 218.63, 0.05));

  const noPick = showNetEconomics({ ...base, pickCentsPerUnit: null });
  check('no pick rate → net-net withheld', noPick.netNetCents === null && noPick.missing.includes('pick_rate'));
  check('no pick rate → host pay still reported', near(noPick.hostCents / 100, 144.49, 0.05));

  const noDuration = showNetEconomics({ ...base, durationMs: null });
  check('no duration → per-hour withheld',
    noDuration.netPerHourCents === null && noDuration.missing.includes('duration'));
  check('no duration → per-unit still computable (units do not need the clock)',
    noDuration.netNetPerUnitCents != null);

  const noUnits = showNetEconomics({ ...base, unitsSold: 0 });
  check('no units → no picking allocation and no per-unit figure',
    noUnits.pickCents === null && noUnits.netNetPerUnitCents === null && noUnits.missing.includes('units'));

  // A zero-cost input is treated as ABSENT, not as free labor.
  const zeroHost = showNetEconomics({ ...base, hostPayCents: 0 });
  check('host pay of 0 is treated as unknown, not as free',
    zeroHost.hostCents === null && zeroHost.netNetCents === null);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('net-net — short shows, and the payout-based basis');
// ─────────────────────────────────────────────────────────────────────────────
{
  // The real 13-minute / 10-item show. Host pay covers 13 minutes while the host was paid for
  // the block around it, so the figure is flagged rather than silently trusted.
  const short = showNetEconomics({
    baseProfitCents: 500, baseIsNetOfFees: false, unitsSold: 10,
    durationMs: 13 * 60 * 1000, hostPayCents: Math.round(2500 * (13 / 60)), pickCentsPerUnit: 55.63,
  });
  check('13-minute show is flagged short', short.shortShow === true, `${SHORT_SHOW_MS / 60000}min threshold`);
  check('short show still produces a figure', short.netNetCents != null);

  const full = showNetEconomics({
    baseProfitCents: 500, baseIsNetOfFees: false, unitsSold: 10,
    durationMs: 45 * 60 * 1000, hostPayCents: 1875, pickCentsPerUnit: 55.63,
  });
  check('45-minute show is not flagged', full.shortShow === false);

  // Once payouts are refreshed the base is payout−COGS (fees already out), so net-net is the
  // true bottom line. Same math, different base — only the label changes.
  const netBase = showNetEconomics({
    baseProfitCents: 8000, baseIsNetOfFees: true, unitsSold: 393,
    durationMs: 20_805_882, hostPayCents: 14449, pickCentsPerUnit: 55.63,
  });
  check('payout basis flows through', netBase.baseIsNetOfFees === true);
  check('payout basis is worse than the won basis (fees are real)',
    netBase.netNetCents < -18447, `$${(netBase.netNetCents / 100).toFixed(2)}`);
}

console.log(`\n${passed} assertions passed`);
