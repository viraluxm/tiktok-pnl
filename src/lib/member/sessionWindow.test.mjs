// Proof for the ASYMMETRIC containment grace (O2): a 10-minute start pad that recovers the
// first-lots-of-the-night orders, and an end pad held at 300s exactly as before.
// Run:  TZ=UTC node src/lib/member/sessionWindow.test.mjs   (also correct under any host TZ)
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { pathToFileURL } from 'node:url'; import assert from 'node:assert/strict'; import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'sw-'));
const { outputText } = ts.transpileModule(
  readFileSync(new URL('./sessionWindow.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const p = join(dir, 'sessionWindow.mjs'); writeFileSync(p, outputText);
const { captureInWindow, START_GRACE_MS, END_GRACE_MS } = await import(pathToFileURL(p).href);

let passed = 0;
const check = (n, c, x = '') => { assert.ok(c, `FAIL: ${n} ${x}`); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); passed++; };

// A concrete window: the repro session 0ae46a32 (Aug 9 18:17 → Aug 10 03:02 Pacific).
const START = '2026-08-10T01:17:16.685+00:00';
const END = '2026-08-10T10:02:12.966+00:00';
const W = { started_at: START, ended_at: END, created_at: null };
const sMs = Date.parse(START), eMs = Date.parse(END);
const beforeStart = (s) => captureInWindow(sMs - s * 1000, W);
const afterEnd = (s) => captureInWindow(eMs + s * 1000, W);

console.log('\nasymmetric grace — constants');
check('START_GRACE_MS is 10 min', START_GRACE_MS === 600_000, String(START_GRACE_MS));
check('END_GRACE_MS is 5 min (unchanged)', END_GRACE_MS === 300_000, String(END_GRACE_MS));
check('the grace is genuinely asymmetric', START_GRACE_MS > END_GRACE_MS);

console.log('\nstart edge — widened to 10 min');
check('9m59s before start PASSES', beforeStart(599));
check('exactly 10m00s before start passes (inclusive bound)', beforeStart(600));
check('10m01s before start FAILS', !beforeStart(601));
check('inside the window passes', captureInWindow(sMs + 1000, W));

console.log('\nend edge — held at 5 min, must NOT have loosened');
check('4m59s after end PASSES', afterEnd(299));
check('exactly 5m00s after end passes (inclusive bound)', afterEnd(300));
check('5m01s after end FAILS', !afterEnd(301));
// The specific regression this guards: 10 min after end must still be refused, or a room hosting
// back-to-back shows starts absorbing the next show's orders into the previous session.
check('6 min after end FAILS (would pass if the pad were made symmetric at 10 min)', !afterEnd(360));
check('9m59s after end FAILS', !afterEnd(599));

console.log('\nasymmetry proven at one magnitude');
check('6 min before start passes AND 6 min after end fails', beforeStart(360) && !afterEnd(360));

console.log('\nthe three known repro orders now pass containment');
// Real values from live data; each previously failed the 300s symmetric pad.
const repro = [
  ['577517677668045544', '2026-08-10T01:10:44.821+00:00', START, END, 392],
  ['577508262289248656', '2026-08-03T23:20:49.872+00:00', '2026-08-03T23:26:30.168+00:00', '2026-08-04T08:18:20.781+00:00', 340],
  ['577513041881043701', '2026-08-07T01:14:32.309+00:00', '2026-08-07T01:21:53.139+00:00', '2026-08-07T05:09:52.543+00:00', 441],
];
for (const [oid, tIso, st, en, lead] of repro) {
  const w = { started_at: st, ended_at: en, created_at: null };
  const t = Date.parse(tIso);
  const observed = Math.round((Date.parse(st) - t) / 1000);
  check(`${oid} lead is ${lead}s as recorded`, observed === lead, `${observed}s`);
  check(`${oid} FAILED under the old 300s pad`, t < Date.parse(st) - 300_000);
  check(`${oid} PASSES under the new 600s pad`, captureInWindow(t, w));
}
// 441s is the worst observed lead; confirm the margin the constant claims.
check('worst observed lead (441s) leaves 159s (~2.6 min) of margin',
  START_GRACE_MS / 1000 - 441 === 159, `${(START_GRACE_MS / 1000 - 441)}s spare`);

console.log('\nunchanged behaviour — shape and edge cases');
check('returns a boolean, not an object', typeof captureInWindow(sMs, W) === 'boolean');
check('open-ended session is unbounded after the start',
  captureInWindow(Date.parse('2026-12-01T00:00:00Z'), { ...W, ended_at: null }));
check('missing start AND created_at is unbounded before the end',
  captureInWindow(Date.parse('2020-01-01T00:00:00Z'), { started_at: null, ended_at: END, created_at: null }));
check('falls back to created_at for the start',
  captureInWindow(Date.parse(START) - 599_000, { started_at: null, ended_at: END, created_at: START }));
check('non-finite capture time matches every session', captureInWindow(NaN, W));

console.log(`\n${passed} checks passed\n`);
