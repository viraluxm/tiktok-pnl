// Unit proof for the manager crew board: crew windows (incl. both DST edges), the hour axis,
// hourly bucketing, the picking / no-picks split, and the available-per-picker context.
//
// Same self-contained pattern as pickerPerformance.test.mjs — no app test runner exists, so this
// transpiles the REAL .ts source at runtime via the repo's `typescript` devDep.
//
// Run:  node src/lib/shipping/crewBoard.test.mjs

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'crewboard-'));
const load = async (name) => {
  const srcPath = fileURLToPath(new URL(`./${name}.ts`, import.meta.url));
  const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const outFile = join(dir, `${name}.mjs`);
  writeFileSync(outFile, outputText);
  return import(pathToFileURL(outFile).href);
};

const TZ = 'America/Los_Angeles';
const HOUR = 3_600_000;

const C = await load('crewBoard');
const {
  CREW_SPLIT_HOUR, SHIFT_DAY_START_HOUR, crewOf, crewRangeUtcMs, fulfillmentDayKey,
  tzOffsetMs, zonedHourUtcMs, addDaysISO,
  buildHourAxis, aggregateCrewBoard, formatHourLabel, formatClocked,
} = C;

// The full fulfillment day [04:00, next 04:00) — the span the two crew windows must tile.
const fullDayRange = (day) => ({
  startMs: zonedHourUtcMs(day, SHIFT_DAY_START_HOUR, TZ),
  endMs: zonedHourUtcMs(addDaysISO(day, 1), SHIFT_DAY_START_HOUR, TZ),
});

const offsetAt = (ms) => tzOffsetMs(ms, TZ);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

// Local wall-clock (PT) -> UTC ms, two-pass for DST. Test-side mirror of the impl's technique.
const pt = (y, m, d, h, min = 0) => {
  const naive = Date.UTC(y, m - 1, d, h, min, 0);
  let t = naive - tzOffsetMs(naive, TZ);
  t = naive - tzOffsetMs(t, TZ);
  return t;
};
const iso = (ms) => new Date(ms).toISOString();

console.log('\ncrew windows');
check('split hour is 15 (the measured 14:00-16:59 dead zone)', CREW_SPLIT_HOUR === 15);
check('06:00 is the morning crew', crewOf(pt(2026, 9, 8, 6), TZ) === 'am');
check('14:59 is still morning', crewOf(pt(2026, 9, 8, 14, 59), TZ) === 'am');
check('15:00 flips to night', crewOf(pt(2026, 9, 8, 15), TZ) === 'pm');
check('17:00 (night start) is night', crewOf(pt(2026, 9, 8, 17), TZ) === 'pm');
check('01:00 after midnight is STILL night crew', crewOf(pt(2026, 9, 9, 1), TZ) === 'pm');
check('03:59 is still night crew', crewOf(pt(2026, 9, 9, 3, 59), TZ) === 'pm');
check('04:00 starts the next morning', crewOf(pt(2026, 9, 9, 4), TZ) === 'am');

// The whole point of the 04:00 day boundary: a night shift spanning midnight is ONE day, ONE crew.
{
  const start = pt(2026, 9, 8, 17);
  const tail = pt(2026, 9, 9, 1);
  check('night shift start and tail share a day key',
    fulfillmentDayKey(start, TZ) === fulfillmentDayKey(tail, TZ), fulfillmentDayKey(start, TZ));
  check('night shift start and tail are both pm', crewOf(start, TZ) === 'pm' && crewOf(tail, TZ) === 'pm');
}

console.log('\ncrew ranges tile the fulfillment day exactly');
for (const day of ['2026-09-08', '2026-03-08', '2026-11-01']) { // incl. both DST transition days
  const am = crewRangeUtcMs(day, 'am', TZ);
  const pm = crewRangeUtcMs(day, 'pm', TZ);
  const full = fullDayRange(day);
  check(`${day}: am starts at day start`, am.startMs === full.startMs);
  check(`${day}: am end == pm start (no gap, no overlap)`, am.endMs === pm.startMs);
  check(`${day}: pm ends at next day start`, pm.endMs === full.endMs);
  check(`${day}: am window is local 04:00->15:00`,
    new Date(am.startMs + offsetAt(am.startMs)).getUTCHours() === SHIFT_DAY_START_HOUR
    && new Date(am.endMs + offsetAt(am.endMs)).getUTCHours() === CREW_SPLIT_HOUR);
}

// DST always lands in the NIGHT window, never the morning one — that is the point of putting the
// day boundary at 04:00. US Pacific switches at 02:00 local, which falls inside the PM window of
// the PRECEDING fulfillment day (15:00 -> 04:00 next day). A morning crew's window is therefore
// always exactly 11h, on every calendar day of the year.
{
  const springAm = crewRangeUtcMs('2026-03-08', 'am', TZ); // spring forward is 02:00 Mar 8 2026
  check('spring-forward morning window is UNAFFECTED at 11h',
    springAm.endMs - springAm.startMs === 11 * HOUR, `${(springAm.endMs - springAm.startMs) / HOUR}h`);
  const springPm = crewRangeUtcMs('2026-03-07', 'pm', TZ); // the night that SPANS the 02:00 jump
  check('the night crossing spring-forward loses an hour (12h)',
    springPm.endMs - springPm.startMs === 12 * HOUR, `${(springPm.endMs - springPm.startMs) / HOUR}h`);

  const fallAm = crewRangeUtcMs('2026-11-01', 'am', TZ);   // fall back is 02:00 Nov 1 2026
  check('fall-back morning window is UNAFFECTED at 11h',
    fallAm.endMs - fallAm.startMs === 11 * HOUR, `${(fallAm.endMs - fallAm.startMs) / HOUR}h`);
  const fallPm = crewRangeUtcMs('2026-10-31', 'pm', TZ);   // the night that SPANS the 02:00 repeat
  check('the night crossing fall-back gains an hour (14h)',
    fallPm.endMs - fallPm.startMs === 14 * HOUR, `${(fallPm.endMs - fallPm.startMs) / HOUR}h`);

  for (const d of ['2026-03-07', '2026-03-08', '2026-10-31', '2026-11-01']) {
    const a = crewRangeUtcMs(d, 'am', TZ), p = crewRangeUtcMs(d, 'pm', TZ);
    check(`${d}: windows still tile exactly`, a.endMs === p.startMs && a.startMs < a.endMs && p.startMs < p.endMs);
  }
}

console.log('\nhour axis shows only ELAPSED hours');
{
  const { startMs, endMs } = crewRangeUtcMs('2026-09-08', 'am', TZ);
  const now = pt(2026, 9, 8, 8, 30);
  const { hourStartsMs, hourLabels } = buildHourAxis(startMs, endMs, now, offsetAt);
  check('04:00-08:30 yields 5 buckets (4,5,6,7,8)', hourStartsMs.length === 5, `${hourStartsMs.length}`);
  check('labels are local hours 4..8', hourLabels.join(',') === '4,5,6,7,8', hourLabels.join(','));
  const done = buildHourAxis(startMs, endMs, pt(2026, 9, 9, 12), offsetAt);
  check('a finished shift never exceeds its window', done.hourStartsMs.length === 11, `${done.hourStartsMs.length}`);
  check('last bucket of a finished am shift is 14 (2pm)',
    done.hourLabels[done.hourLabels.length - 1] === 14);
}

console.log('\nboard aggregation');
{
  const day = '2026-09-08';
  const { startMs, endMs } = crewRangeUtcMs(day, 'am', TZ);
  const now = pt(2026, 9, 8, 14, 30); // shift over
  const box = (key, id, atMs) => ({ group_key: key, picker_employee_id: id, picker_name_snapshot: null, verified_at: iso(atMs) });

  // carlos: 3 boxes at 06:00 then nothing (the real 2026-09-08 shape, scaled down).
  // ana: 1 box at 06:00, 1 at 12:00 — steady.
  const events = [
    box('b1', 'carlos', pt(2026, 9, 8, 6, 5)),
    box('b2', 'carlos', pt(2026, 9, 8, 6, 20)),
    box('b3', 'carlos', pt(2026, 9, 8, 6, 40)),
    box('b1', 'carlos', pt(2026, 9, 8, 6, 5)), // duplicate group_key — must collapse
    box('b4', 'ana', pt(2026, 9, 8, 6, 30)),
    box('b5', 'ana', pt(2026, 9, 8, 12, 10)),
  ];
  const punches = [
    { employee_id: 'carlos', name: 'carlos', clock_in_at: iso(pt(2026, 9, 8, 6)), clock_out_at: iso(pt(2026, 9, 8, 14)) },
    { employee_id: 'ana', name: 'ana', clock_in_at: iso(pt(2026, 9, 8, 6)), clock_out_at: iso(pt(2026, 9, 8, 14)) },
    // Edwin was boxing all shift: clocked in, zero boxes.
    { employee_id: 'edwin', name: 'Edwin', clock_in_at: iso(pt(2026, 9, 8, 6)), clock_out_at: iso(pt(2026, 9, 8, 14)) },
  ];

  const b = aggregateCrewBoard(events, punches, day, 'am', startMs, endMs, now, offsetAt, {}, 3);

  check('duplicate group_key collapses to one box', b.totalBoxes === 5, `${b.totalBoxes}`);
  check('two pickers in the picking list', b.picking.length === 2, `${b.picking.length}`);
  check('carlos leads on boxes', b.picking[0].name === 'carlos' && b.picking[0].boxes === 3);
  check('Edwin is in noPicks, NOT picking', b.noPicks.length === 1 && b.noPicks[0].name === 'Edwin');
  check('Edwin keeps his clocked hours', formatClocked(b.noPicks[0].clocked_ms) === '8.0h', formatClocked(b.noPicks[0].clocked_ms));
  check('Edwin is NOT counted in pickingCount', b.pickingCount === 2, `${b.pickingCount}`);

  // Hourly shape — the signal the whole board exists for.
  const carlosHours = b.picking[0].hours;
  check('carlos: 3 boxes bucket into the 6am hour',
    carlosHours.find((h) => h.labelHour === 6).boxes === 3);
  check('carlos: 12pm hour is a visible zero, not a gap',
    carlosHours.find((h) => h.labelHour === 12).boxes === 0);
  const ana = b.picking.find((r) => r.name === 'ana');
  check('ana: boxes land in two different hours',
    ana.hours.find((h) => h.labelHour === 6).boxes === 1 && ana.hours.find((h) => h.labelHour === 12).boxes === 1);
  check('every row shares the same hour axis length',
    b.picking.every((r) => r.hours.length === b.hourStartsMs.length)
    && b.noPicks.every((r) => r.hours.length === b.hourStartsMs.length));

  // Available-per-picker: 5 boxes over 2 people who actually picked = 2.5 each, target 3.
  check('availablePerPicker divides by PICKERS, not everyone clocked in',
    b.availablePerPicker === 2.5, `${b.availablePerPicker}`);
  check('target 3 is flagged UNREACHABLE when only 2.5 were available each', b.targetReachable === false);
  check('hitTarget counts only those at/over target', b.hitTarget === 1, `${b.hitTarget}`);

  const easy = aggregateCrewBoard(events, punches, day, 'am', startMs, endMs, now, offsetAt, {}, 2);
  check('target 2 is reachable at 2.5 available each', easy.targetReachable === true);
  check('both pickers clear a target of 2', easy.hitTarget === 2);

  const noTarget = aggregateCrewBoard(events, punches, day, 'am', startMs, endMs, now, offsetAt, {}, null);
  check('null target -> targetReachable is null, not false', noTarget.targetReachable === null);
  check('null target -> hitTarget is 0', noTarget.hitTarget === 0);
}

console.log('\noff-the-clock picking and the in-progress hour');
{
  const day = '2026-09-08';
  const { startMs, endMs } = crewRangeUtcMs(day, 'am', TZ);
  const now = pt(2026, 9, 8, 8, 20); // mid-shift, the 8am hour is PARTIAL
  const events = [
    { group_key: 'x1', picker_employee_id: 'roberto', picker_name_snapshot: 'Roberto', verified_at: iso(pt(2026, 9, 8, 7, 10)) },
    { group_key: 'x2', picker_employee_id: 'roberto', picker_name_snapshot: 'Roberto', verified_at: iso(pt(2026, 9, 8, 8, 5)) },
  ];
  // Roberto picks without ever clocking in — real behaviour; 8.5% of boxes are picked off the clock.
  const b = aggregateCrewBoard(events, [], day, 'am', startMs, endMs, now, offsetAt, {}, 200);
  check('a picker with NO punch still appears', b.picking.length === 1 && b.picking[0].name === 'Roberto');
  check('no punch -> clocked_ms is null, no rate is claimed', b.picking[0].clocked_ms === null);
  check('no punch -> formatted as em dash', formatClocked(b.picking[0].clocked_ms) === '—');
  check('the current hour is marked in-progress',
    b.picking[0].hours.find((h) => h.labelHour === 8).inProgress === true);
  check('a completed earlier hour is NOT marked in-progress',
    b.picking[0].hours.find((h) => h.labelHour === 7).inProgress === false);
  check('exactly one hour is ever in-progress',
    b.picking[0].hours.filter((h) => h.inProgress).length === 1);

  const empty = aggregateCrewBoard([], [], day, 'am', startMs, endMs, now, offsetAt, {}, 200);
  check('empty board: availablePerPicker is null, not NaN', empty.availablePerPicker === null);
  check('empty board: targetReachable is null', empty.targetReachable === null);
}

console.log('\nnight crew crossing midnight');
{
  const day = '2026-09-08';
  const { startMs, endMs } = crewRangeUtcMs(day, 'pm', TZ);
  const now = pt(2026, 9, 9, 1, 30);
  const events = [
    { group_key: 'n1', picker_employee_id: 'blake', picker_name_snapshot: 'Blake', verified_at: iso(pt(2026, 9, 8, 18, 30)) },
    { group_key: 'n2', picker_employee_id: 'blake', picker_name_snapshot: 'Blake', verified_at: iso(pt(2026, 9, 9, 0, 30)) },
  ];
  const punches = [{ employee_id: 'blake', name: 'Blake', clock_in_at: iso(pt(2026, 9, 8, 17)), clock_out_at: null }];
  const b = aggregateCrewBoard(events, punches, day, 'pm', startMs, endMs, now, offsetAt, {}, null);
  check('a box after midnight stays on the same night board', b.totalBoxes === 2, `${b.totalBoxes}`);
  check('night hours run 15,16,...,0,1 in order',
    b.hourLabels[0] === 15 && b.hourLabels[b.hourLabels.length - 1] === 1, b.hourLabels.join(','));
  check('the after-midnight box buckets into the 12am hour',
    b.picking[0].hours.find((h) => h.labelHour === 0).boxes === 1);
  check('an open punch reads as still on the clock', b.picking[0].on_clock === true);
  check('open punch accrues to now', formatClocked(b.picking[0].clocked_ms) === '8.5h', formatClocked(b.picking[0].clocked_ms));
}

console.log('\ndoubles and straddling punches');
{
  // A real double: Alejandro, 2026-09-08 — AM 06:25->14:01 and PM 16:56->01:00 next day, BOTH
  // punches filed under date '2026-09-08', so both reach both boards.
  const day = '2026-09-08';
  const am = crewRangeUtcMs(day, 'am', TZ);
  const pmw = crewRangeUtcMs(day, 'pm', TZ);
  const double = [{
    employee_id: 'ale', name: 'Alejandro',
    clock_in_at: iso(pt(2026, 9, 8, 6, 25)), clock_out_at: iso(pt(2026, 9, 8, 14, 1)),
  }, {
    employee_id: 'ale', name: 'Alejandro',
    clock_in_at: iso(pt(2026, 9, 8, 16, 56)), clock_out_at: iso(pt(2026, 9, 9, 1, 0)),
  }];
  const amBox = { group_key: 'd1', picker_employee_id: 'ale', picker_name_snapshot: 'Alejandro', verified_at: iso(pt(2026, 9, 8, 9, 0)) };
  const pmBox = { group_key: 'd2', picker_employee_id: 'ale', picker_name_snapshot: 'Alejandro', verified_at: iso(pt(2026, 9, 8, 20, 0)) };

  const amB = aggregateCrewBoard([amBox], double, day, 'am', am.startMs, am.endMs, am.endMs, offsetAt, {}, null);
  const pmB = aggregateCrewBoard([pmBox], double, day, 'pm', pmw.startMs, pmw.endMs, pmw.endMs, offsetAt, {}, null);

  check('double: morning board shows ONLY the morning punch',
    formatClocked(amB.picking[0].clocked_ms) === '7.6h', formatClocked(amB.picking[0].clocked_ms));
  check('double: night board shows ONLY the night punch',
    formatClocked(pmB.picking[0].clocked_ms) === '8.1h', formatClocked(pmB.picking[0].clocked_ms));
  check('double: morning board counts only the morning box', amB.totalBoxes === 1 && amB.picking[0].boxes === 1);
  check('double: night board counts only the night box', pmB.totalBoxes === 1 && pmB.picking[0].boxes === 1);
  check('double: the two boards together account for the full 15.7h day',
    Math.abs((amB.picking[0].clocked_ms + pmB.picking[0].clocked_ms) / 3_600_000 - 15.7) < 0.05,
    `${((amB.picking[0].clocked_ms + pmB.picking[0].clocked_ms) / 3_600_000).toFixed(2)}h`);

  // A STRADDLING punch: 2026-08-29, Alejandro clocked 05:59 -> 16:05, crossing the 15:00 split.
  // Unclamped this single 10.1h punch would be counted IN FULL on both boards.
  const sday = '2026-08-29';
  const sam = crewRangeUtcMs(sday, 'am', TZ);
  const spm = crewRangeUtcMs(sday, 'pm', TZ);
  const straddle = [{
    employee_id: 'ale', name: 'Alejandro',
    clock_in_at: iso(pt(2026, 8, 29, 5, 59)), clock_out_at: iso(pt(2026, 8, 29, 16, 5)),
  }];
  const sBox = { group_key: 's1', picker_employee_id: 'ale', picker_name_snapshot: 'Alejandro', verified_at: iso(pt(2026, 8, 29, 9, 0)) };
  const samB = aggregateCrewBoard([sBox], straddle, sday, 'am', sam.startMs, sam.endMs, sam.endMs, offsetAt, {}, null);
  const spmB = aggregateCrewBoard([], straddle, sday, 'pm', spm.startMs, spm.endMs, spm.endMs, offsetAt, {}, null);

  check('straddle: morning board clamps at 15:00 (05:59->15:00 = 9.0h, not 10.1h)',
    formatClocked(samB.picking[0].clocked_ms) === '9.0h', formatClocked(samB.picking[0].clocked_ms));
  check('straddle: night board sees only the 15:00->16:05 tail (1.1h)',
    formatClocked(spmB.noPicks[0].clocked_ms) === '1.1h', formatClocked(spmB.noPicks[0].clocked_ms));
  check('straddle: the two boards sum to the real punch length, not double it',
    Math.abs((samB.picking[0].clocked_ms + spmB.noPicks[0].clocked_ms) / 3_600_000 - 10.1) < 0.05,
    `${((samB.picking[0].clocked_ms + spmB.noPicks[0].clocked_ms) / 3_600_000).toFixed(2)}h`);

  // A punch entirely outside the window contributes nothing at all — not even a zero row.
  const nightOnly = [{ employee_id: 'blake', name: 'Blake', clock_in_at: iso(pt(2026, 9, 8, 17)), clock_out_at: iso(pt(2026, 9, 9, 1)) }];
  const amOnly = aggregateCrewBoard([], nightOnly, day, 'am', am.startMs, am.endMs, am.endMs, offsetAt, {}, null);
  check('a night-only punch does NOT appear on the morning board',
    amOnly.picking.length === 0 && amOnly.noPicks.length === 0);

  // An open punch on a FINISHED day is not "currently on the clock".
  const openOld = [{ employee_id: 'x', name: 'X', clock_in_at: iso(pt(2026, 9, 8, 6)), clock_out_at: null }];
  const past = aggregateCrewBoard([], openOld, day, 'am', am.startMs, am.endMs, pt(2026, 9, 9, 12), offsetAt, {}, null);
  check('an open punch on a past board does not read as on-the-clock',
    past.noPicks[0].on_clock === false);
}

console.log('\nhour labels');
check('6 -> 6a', formatHourLabel(6) === '6a');
check('12 -> 12p', formatHourLabel(12) === '12p');
check('13 -> 1p', formatHourLabel(13) === '1p');
check('0 -> 12a', formatHourLabel(0) === '12a');

console.log(`\n${passed} checks passed\n`);
