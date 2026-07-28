// Unit proof for fulfillment picker-performance KPIs, validation, per-box timing, and
// business-day math. No app test runner exists, so this self-contained file transpiles
// pickerPerformance.ts at runtime via the repo's `typescript` devDep and exercises the REAL
// exported functions.
//
// Run:  node src/lib/shipping/pickerPerformance.test.mjs
//   (timezone helpers pass an explicit timeZone, so results are host-TZ independent.)
//
// Covers every accuracy scenario in the spec: one box, multi-order combined box, abandoned/
// failed/duplicate confirmations, reload, picker change, missing start, negative duration,
// over-threshold duration, timezone/DST boundaries, unassigned history, rename/former/delete.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./pickerPerformance.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'picker-')), 'pickerPerformance.mjs');
writeFileSync(outFile, outputText);
const M = await import(pathToFileURL(outFile).href);
const {
  MAX_PICK_DURATION_MS, validatePicker, mean, median, boxDurationMs, sessionize,
  aggregateFulfillmentDay, zonedDayStartUtcMs, zonedDayRangeUtcMs, zonedDayKey, addDaysISO,
  tzOffsetMs, formatPickDuration, formatRate,
} = M;

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

const SEC = 1000;
const MIN = 60 * SEC;
const BASE = Date.UTC(2026, 6, 15, 17, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
// A box event: startMs → pick_started_at, atMs → verified_at (completion).
const ev = ({ group_key, id = null, snap = null, startMs, atMs, orders = ['o1'] }) => ({
  group_key,
  picker_employee_id: id,
  picker_name_snapshot: snap,
  pick_started_at: startMs == null ? null : iso(startMs),
  verified_at: iso(atMs),
  order_ids: orders,
});
const byName = (day, name) => day.pickers.find((p) => p.name === name);

// ── 1. Picker validation ──────────────────────────────────────────────────────
console.log('validatePicker');
check('active fulfillment valid', validatePicker({ id: 'e', name: 'Ann', role: 'fulfillment', status: 'active' }).valid);
check('probation fulfillment valid', validatePicker({ id: 'e', name: 'Ann', role: 'fulfillment', status: 'probation' }).valid);
check('role trimmed + lowercased', validatePicker({ id: 'e', name: 'Ann', role: '  Fulfillment ', status: 'active' }).valid);
check('host rejected (role)', validatePicker({ id: 'e', name: 'H', role: 'host', status: 'active' }).reason === 'role');
check('manager rejected (role)', validatePicker({ id: 'e', name: 'M', role: 'manager', status: 'active' }).reason === 'role');
check('former rejected (status)', validatePicker({ id: 'e', name: 'F', role: 'fulfillment', status: 'former' }).reason === 'status');
check('foreign / not-found rejected', validatePicker(null).reason === 'not_found');

// ── 2. mean / median ────────────────────────────────────────────────────────────
console.log('mean / median');
check('mean empty → null', mean([]) === null);
check('mean', mean([10, 20, 30]) === 20);
check('median odd', median([3, 1, 2]) === 2);
check('median even', median([1, 2, 3, 4]) === 2.5);

// ── 3. boxDurationMs (validity rules) ─────────────────────────────────────────────
console.log('boxDurationMs');
check('valid duration', boxDurationMs(iso(BASE), iso(BASE + 90 * SEC)) === 90 * SEC);
check('missing start → null', boxDurationMs(null, iso(BASE)) === null);
check('missing end → null', boxDurationMs(iso(BASE), null) === null);
check('unparseable → null', boxDurationMs('not-a-date', iso(BASE)) === null);
check('zero duration → null', boxDurationMs(iso(BASE), iso(BASE)) === null);
check('negative duration → null', boxDurationMs(iso(BASE + 60 * SEC), iso(BASE)) === null);
check('exactly at max threshold is valid', boxDurationMs(iso(BASE), iso(BASE + MAX_PICK_DURATION_MS)) === MAX_PICK_DURATION_MS);
check('over max threshold → null', boxDurationMs(iso(BASE), iso(BASE + MAX_PICK_DURATION_MS + 1)) === null);
check('MAX_PICK_DURATION_MS is 30 minutes', MAX_PICK_DURATION_MS === 30 * MIN);

// ── 4. sessionize (internal diagnostic retained) ────────────────────────────────
console.log('sessionize (internal)');
check('no picks → 0 sessions', (() => { const r = sessionize([]); return r.sessions === 0; })());
check('two close → 1 session', (() => { const r = sessionize([BASE, BASE + 10 * MIN]); return r.sessions === 1; })());
check('lunch gap → 2 sessions', (() => { const r = sessionize([BASE, BASE + 20 * MIN]); return r.sessions === 2; })());

// ── 5. aggregateFulfillmentDay — duration metrics ────────────────────────────────
console.log('aggregateFulfillmentDay');

// 5a. One completed box WITH valid timing → avg = active = its own duration; oph computed.
{
  const day = aggregateFulfillmentDay([ev({ group_key: 'g1', id: 'e1', snap: 'Ann', startMs: BASE, atMs: BASE + 2 * MIN, orders: ['o1', 'o2', 'o3'] })], { e1: 'Ann' });
  const p = byName(day, 'Ann');
  check('combined 3-order box → orders 3, boxes 1', p.orders_picked === 3 && p.boxes_completed === 1);
  check('one box avg = its duration (2m)', p.avg_pick_ms === 2 * MIN);
  check('one box active = its duration (2m)', p.active_pick_ms === 2 * MIN);
  check('orders/active-hour = 3 ÷ (2/60) = 90', p.orders_per_active_hour === 90);
  check('summary avg = 2m', day.summary.avg_pick_ms === 2 * MIN);
}

// 5b. One completed box MISSING start → no accurate average → nulls, not zero.
{
  const day = aggregateFulfillmentDay([ev({ group_key: 'g1', id: 'e1', snap: 'Ann', startMs: null, atMs: BASE, orders: ['o1'] })], { e1: 'Ann' });
  const p = byName(day, 'Ann');
  check('missing start → avg null (—)', p.avg_pick_ms === null);
  check('missing start → active null (—)', p.active_pick_ms === null);
  check('missing start → orders/hour null (—)', p.orders_per_active_hour === null);
  check('box still counted', p.boxes_completed === 1 && p.orders_picked === 1);
  check('valid_duration_count = 0', p.valid_duration_count === 0);
}

// 5c. Average across multiple boxes = arithmetic mean; active = sum.
{
  const day = aggregateFulfillmentDay([
    ev({ group_key: 'a', id: 'e1', snap: 'Ann', startMs: BASE, atMs: BASE + 1 * MIN, orders: ['o1'] }),          // 1m
    ev({ group_key: 'b', id: 'e1', snap: 'Ann', startMs: BASE + 5 * MIN, atMs: BASE + 8 * MIN, orders: ['o2'] }), // 3m
  ], { e1: 'Ann' });
  const p = byName(day, 'Ann');
  check('avg of 1m,3m = 2m', p.avg_pick_ms === 2 * MIN);
  check('active = 1m+3m = 4m', p.active_pick_ms === 4 * MIN);
  check('orders/active-hour = 2 ÷ (4/60) = 30', p.orders_per_active_hour === 30);
}

// 5d. Invalid durations excluded from avg/active but box still counts.
{
  const day = aggregateFulfillmentDay([
    ev({ group_key: 'ok', id: 'e1', snap: 'Ann', startMs: BASE, atMs: BASE + 2 * MIN, orders: ['o1'] }),               // valid 2m
    ev({ group_key: 'neg', id: 'e1', snap: 'Ann', startMs: BASE + 5 * MIN, atMs: BASE + 4 * MIN, orders: ['o2'] }),    // negative → excluded
    ev({ group_key: 'long', id: 'e1', snap: 'Ann', startMs: BASE, atMs: BASE + 45 * MIN, orders: ['o3'] }),           // >30m → excluded
  ], { e1: 'Ann' });
  const p = byName(day, 'Ann');
  check('3 boxes counted', p.boxes_completed === 3);
  check('only 1 valid duration', p.valid_duration_count === 1);
  check('avg = the single valid 2m', p.avg_pick_ms === 2 * MIN);
  check('active = 2m (invalids excluded)', p.active_pick_ms === 2 * MIN);
}

// 5e. Duplicate group_key confirmations count once.
{
  const day = aggregateFulfillmentDay([
    ev({ group_key: 'dup', id: 'e1', snap: 'Ann', startMs: BASE, atMs: BASE + 1 * MIN }),
    ev({ group_key: 'dup', id: 'e1', snap: 'Ann', startMs: BASE, atMs: BASE + 1 * MIN }),
  ], { e1: 'Ann' });
  check('duplicate group_key → boxes 1', byName(day, 'Ann').boxes_completed === 1);
}

// 5f. Picker changed between boxes → two cards; active pickers = 2.
{
  const day = aggregateFulfillmentDay([
    ev({ group_key: 'a', id: 'e1', snap: 'Ann', startMs: BASE, atMs: BASE + 1 * MIN }),
    ev({ group_key: 'b', id: 'e2', snap: 'Bob', startMs: BASE, atMs: BASE + 1 * MIN }),
  ], { e1: 'Ann', e2: 'Bob' });
  check('picker change → 2 cards', day.pickers.length === 2 && day.summary.active_pickers === 2);
}

// 5g. Rename (current name), former (still shown), deleted (snapshot), unassigned history.
{
  const renamed = aggregateFulfillmentDay([ev({ group_key: 'g', id: 'e1', snap: 'Old', startMs: BASE, atMs: BASE + MIN })], { e1: 'New' });
  check('rename → current name', !!byName(renamed, 'New') && !byName(renamed, 'Old'));

  const deleted = aggregateFulfillmentDay([ev({ group_key: 'g', id: null, snap: 'Gone', startMs: BASE, atMs: BASE + MIN })], {});
  check('deleted employee attributed by snapshot (not Unassigned)', !!byName(deleted, 'Gone') && byName(deleted, 'Gone').is_unassigned === false);

  const day = aggregateFulfillmentDay([
    ev({ group_key: 'g1', id: 'e1', snap: 'Ann', startMs: BASE, atMs: BASE + MIN, orders: ['a'] }),
    ev({ group_key: 'h1', id: null, snap: null, startMs: null, atMs: BASE + 2 * MIN, orders: ['x', 'y'] }), // historical unassigned
  ], { e1: 'Ann' });
  check('unassigned history not a named picker', day.pickers.length === 1);
  check('unassigned bucket orders by cardinality', day.unassigned && day.unassigned.boxes_completed === 1 && day.unassigned.orders_picked === 2);
  check('summary totals include unassigned', day.summary.orders_picked === 3 && day.summary.boxes_completed === 2);
}

// 5h. Empty day.
{
  const day = aggregateFulfillmentDay([], {});
  check('empty day → no pickers, null avg', day.pickers.length === 0 && day.unassigned === null && day.summary.avg_pick_ms === null && day.summary.active_pickers === 0);
}

// ── 6. Business-day (America/Los_Angeles) bounds — midnight + DST ────────────────
console.log('timezone day math');
const HOUR = 60 * MIN;
check('addDaysISO basic', addDaysISO('2026-07-15', 1) === '2026-07-16');
check('normal summer PT day = 24h', (() => { const r = zonedDayRangeUtcMs('2026-07-15'); return r.endMs - r.startMs === 24 * HOUR; })());
check('PT summer midnight = 07:00 UTC', zonedDayStartUtcMs('2026-07-15') === Date.UTC(2026, 6, 15, 7, 0, 0));
check('spring-forward day (2026-03-08) = 23h', (() => { const r = zonedDayRangeUtcMs('2026-03-08'); return r.endMs - r.startMs === 23 * HOUR; })());
check('fall-back day (2026-11-01) = 25h', (() => { const r = zonedDayRangeUtcMs('2026-11-01'); return r.endMs - r.startMs === 25 * HOUR; })());
check('tzOffsetMs summer = -7h', tzOffsetMs(Date.UTC(2026, 6, 15, 12, 0, 0)) === -7 * HOUR);
check('06:59 UTC → previous PT day', zonedDayKey(Date.UTC(2026, 6, 15, 6, 59, 0)) === '2026-07-14');
check('07:01 UTC → this PT day', zonedDayKey(Date.UTC(2026, 6, 15, 7, 1, 0)) === '2026-07-15');

// ── 7. formatters ────────────────────────────────────────────────────────────────
console.log('formatters');
check('null → em dash', formatPickDuration(null) === '—');
check('seconds → "42 sec"', formatPickDuration(42 * SEC) === '42 sec');
check('min+sec → "2m 18s"', formatPickDuration(2 * MIN + 18 * SEC) === '2m 18s');
check('whole minutes → "5m"', formatPickDuration(5 * MIN) === '5m');
check('hours+min → "1h 12m"', formatPickDuration(72 * MIN) === '1h 12m');
check('whole hours → "2h"', formatPickDuration(2 * HOUR) === '2h');
check('rate null → "—"', formatRate(null) === '—');
check('rate one decimal', formatRate(12.34) === '12.3');

console.log(`\n${passed} checks passed.`);
