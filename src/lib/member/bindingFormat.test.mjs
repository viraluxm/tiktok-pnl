// Proof for the binding page's Pacific rendering (O1) and per-session distance (O4).
// The whole point is host-timezone independence, so the harness asserts every rendered string is
// IDENTICAL under TZ=UTC, America/New_York and Asia/Singapore — UTC+8 is the zone that made the
// original bug invisible. Transpiles timezone.ts + sessionDistance.ts + bindingFormat.ts.
// Run:  TZ=UTC node src/lib/member/bindingFormat.test.mjs   (and under any other host TZ)
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { pathToFileURL } from 'node:url'; import assert from 'node:assert/strict'; import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'bf-'));
const tr = (relFromMember, outName, rw = (s) => s) => {
  const { outputText } = ts.transpileModule(
    readFileSync(new URL(relFromMember, import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  const p = join(dir, outName); writeFileSync(p, rw(outputText)); return p;
};
tr('../schedule/timezone.ts', 'timezone.mjs');
tr('./sessionDistance.ts', 'sessionDistance.mjs');
const bfPath = tr('./bindingFormat.ts', 'bindingFormat.mjs', (s) => s
  .replaceAll("'@/lib/schedule/timezone'", "'./timezone.mjs'")
  .replaceAll("'@/lib/member/sessionDistance'", "'./sessionDistance.mjs'"));
const { fmtInstantPT, fmtWindowPT, fmtDistance, ptDateKey } = await import(pathToFileURL(bfPath).href);
const { sessionDistance } = await import(pathToFileURL(join(dir, 'sessionDistance.mjs')).href);

let passed = 0;
const check = (n, c, x = '') => { assert.ok(c, `FAIL: ${n} ${x}`); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); passed++; };
const eq = (n, got, want) => check(n, got === want, `got ${JSON.stringify(got)}`);

console.log(`\nbinding format — host TZ=${process.env.TZ ?? '(unset)'}`);

console.log('\nO1 — instants render in Pacific by named zone');
{
  // The repro from the investigation: ordered_at 2026-08-10T01:10:44.821Z.
  // At UTC+8 the old code rendered "10 Aug 2026"; in Pacific it is Aug 9, 6:10 PM.
  eq('repro order renders Aug 9 6:10 PM PDT', fmtInstantPT('2026-08-10T01:10:44.821+00:00'), 'Aug 9, 6:10 PM PDT');
  eq('session start renders Aug 9 6:17 PM PDT', fmtInstantPT('2026-08-10T01:17:16.685+00:00'), 'Aug 9, 6:17 PM PDT');
  eq('PST (winter) label is used off-DST', fmtInstantPT('2026-01-15T20:00:00.000Z'), 'Jan 15, 12:00 PM PST');
  eq('null renders an em dash', fmtInstantPT(null), '—');
  eq('unparseable renders an em dash', fmtInstantPT('nope'), '—');
  check('never emits a numeric UTC offset', !/[+-]\d{2}:\d{2}/.test(fmtInstantPT('2026-08-10T01:10:44Z')));
}

console.log('\nO1 — window rendering, same Pacific day');
{
  // 2026-08-10 16:47:41Z → 2026-08-11 02:29:19Z is Aug 10 09:47 → 19:29 Pacific: same day.
  eq('same-day window keeps one date, time-only end',
    fmtWindowPT('2026-08-10T23:47:41.783+00:00', '2026-08-11T02:29:19.220+00:00'),
    'Aug 10, 4:47 PM → 7:29 PM PDT');
  eq('open session renders ongoing',
    fmtWindowPT('2026-08-10T01:17:16.685+00:00', null), 'Aug 9, 6:17 PM PDT → ongoing');
  eq('no start renders an em dash', fmtWindowPT(null, '2026-08-10T01:17:16Z'), '—');
}

console.log('\nO1 — window spanning midnight Pacific (the required case)');
{
  // The repro session: Aug 9 18:17 PDT → Aug 10 03:02 PDT. The end MUST repeat its date and
  // carry an explicit day marker, or it reads as same-day.
  const w = fmtWindowPT('2026-08-10T01:17:16.685+00:00', '2026-08-10T10:02:12.966+00:00');
  eq('midnight-crossing window repeats the end date and marks +1d', w,
    'Aug 9, 6:17 PM → Aug 10, 3:02 AM PDT (+1d)');
  check('the two dates differ in the rendered string', /Aug 9/.test(w) && /Aug 10/.test(w), w);
  check('carries an explicit day-offset marker', w.includes('(+1d)'), w);

  // A show running past two midnights marks +2d.
  const w2 = fmtWindowPT('2026-08-10T01:17:00Z', '2026-08-12T06:00:00Z');
  check('two-midnight window marks +2d', w2.includes('(+2d)'), w2);

  // Pacific-day boundary, not UTC-day: 2026-08-10T06:59Z is still Aug 9 in Pacific (23:59).
  eq('Pacific day key, not UTC day', ptDateKey('2026-08-10T06:59:00Z'), '2026-08-09');
  const w3 = fmtWindowPT('2026-08-10T02:00:00Z', '2026-08-10T06:59:00Z');
  check('window inside one Pacific day but crossing UTC midnight is NOT marked',
    !w3.includes('(+'), w3);
}

console.log('\nO4 — distance: direction is explicit');
{
  const W = { started_at: '2026-08-10T01:17:16.685+00:00', ended_at: '2026-08-10T10:02:12.966+00:00', created_at: null };
  const t = Date.parse('2026-08-10T01:10:44.821+00:00');

  const d = sessionDistance(t, W);
  eq('repro order is before_start', d.direction, 'before_start');
  eq('repro offset is 392 s', d.seconds, 392);
  eq('renders as 7 min before start', fmtDistance(d), '7 min before start');

  eq('inside the window reads "in window"',
    fmtDistance(sessionDistance(Date.parse('2026-08-10T05:00:00Z'), W)), 'in window');
  eq('after the end is explicit',
    fmtDistance(sessionDistance(Date.parse('2026-08-10T12:02:12.966Z'), W)), '2 h after end');

  // Open-ended session is never "after end".
  eq('open session is never after_end',
    sessionDistance(Date.parse('2026-08-20T00:00:00Z'), { ...W, ended_at: null }).direction, 'within');

  // Falls back to created_at when started_at is absent.
  eq('falls back to created_at for the start',
    sessionDistance(Date.parse('2026-08-10T01:00:00Z'),
      { started_at: null, ended_at: null, created_at: '2026-08-10T01:17:16.685+00:00' }).direction, 'before_start');

  check('unknowable distance is null (no start)',
    sessionDistance(Date.parse('2026-08-10T01:00:00Z'), { started_at: null, ended_at: null, created_at: null }) === null);
  check('unknowable distance is null (bad capture time)',
    sessionDistance(NaN, W) === null);
  check('fmtDistance(null) renders nothing', fmtDistance(null) === null);
}

console.log('\nO4 — duration scale reads sensibly at every magnitude');
{
  const at = (secs) => fmtDistance({ direction: 'before_start', seconds: secs });
  eq('45 s', at(45), '45 s before start');
  eq('89 s stays in seconds', at(89), '89 s before start');
  eq('6 min', at(392), '7 min before start');
  eq('exactly 5 min', at(300), '5 min before start');
  eq('89 min stays in minutes', at(5340), '89 min before start');
  eq('2 h 5 min', at(7500), '2 h 5 min before start');
  eq('whole hours drop the minutes', at(7200), '2 h before start');
  eq('multi-day', at(200000), '2 d 7 h before start');
}

console.log(`\n${passed} checks passed\n`);
