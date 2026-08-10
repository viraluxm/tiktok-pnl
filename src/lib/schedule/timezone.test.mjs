// DST + timezone proof for the forward materializer's LA wall-clock → UTC conversion.
// The materializer generates 28 days out, so from early October it crosses the Nov 1 fall-back;
// DST boundaries are exactly where hand-rolled time math breaks. Transpiles timezone.ts at runtime
// (no imports) and asserts the UTC instants AND the true elapsed durations across both 2026
// Pacific transitions: spring-forward Sun Mar 8, fall-back Sun Nov 1.
//
// Run:  TZ=UTC node src/lib/schedule/timezone.test.mjs   (also run under a non-UTC TZ — the
//       conversion must be host-timezone-independent since it pins America/Los_Angeles via Intl.)
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./timezone.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'tz-')), 'timezone.mjs');
writeFileSync(outFile, outputText);
const { laWallTimeToUtc } = await import(pathToFileURL(outFile).href);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};
const iso = (dateISO, t) => laWallTimeToUtc(dateISO, t).toISOString();
const hoursBetween = (aISO, bStart, bDate, bEnd) =>
  (laWallTimeToUtc(bDate, bEnd).getTime() - laWallTimeToUtc(aISO, bStart).getTime()) / 3_600_000;

console.log(`\nDST + offset (host TZ = ${process.env.TZ ?? 'unset'})`);

// Standard offsets: winter = PST (UTC-8), summer = PDT (UTC-7).
check('winter noon (Jan 15) = 20:00Z (PST, UTC-8)', iso('2026-01-15', '12:00') === '2026-01-15T20:00:00.000Z', iso('2026-01-15', '12:00'));
check('summer noon (Jul 15) = 19:00Z (PDT, UTC-7)', iso('2026-07-15', '12:00') === '2026-07-15T19:00:00.000Z', iso('2026-07-15', '12:00'));

// Daytime shift ON each transition date resolves to that day's post-transition offset.
check('Mar 8 (spring-fwd day) 12:00 = 19:00Z (PDT)', iso('2026-03-08', '12:00') === '2026-03-08T19:00:00.000Z', iso('2026-03-08', '12:00'));
check('Mar 8 18:00 = Mar 9 01:00Z', iso('2026-03-08', '18:00') === '2026-03-09T01:00:00.000Z', iso('2026-03-08', '18:00'));
check('Nov 1 (fall-back day) 12:00 = 20:00Z (PST)', iso('2026-11-01', '12:00') === '2026-11-01T20:00:00.000Z', iso('2026-11-01', '12:00'));
check('Nov 1 18:00 = Nov 2 02:00Z', iso('2026-11-01', '18:00') === '2026-11-02T02:00:00.000Z', iso('2026-11-01', '18:00'));

// Duration across the boundary is the TRUE elapsed time, not the nominal wall-clock delta.
{
  // Daytime 12:00–18:00 on each transition date = a clean 6h (both endpoints same side of the change).
  check('Mar 8 12:00–18:00 = 6h', hoursBetween('2026-03-08', '12:00', '2026-03-08', '18:00') === 6);
  check('Nov 1 12:00–18:00 = 6h', hoursBetween('2026-11-01', '12:00', '2026-11-01', '18:00') === 6);

  // SAME nominal span (23:00→05:00 = 6h wall-clock) on BOTH transitions, so the DST direction is
  // unambiguous: fall-back must be LONGER than nominal, spring-forward SHORTER. (Using different
  // nominal spans obscures which way the clock moved — the whole point of a DST test.)
  const NOMINAL = 6;
  // Fall-back night Oct 31 23:00 → Nov 1 05:00: the clock repeats an hour ⇒ +1h ⇒ 7h elapsed.
  const fallBack = hoursBetween('2026-10-31', '23:00', '2026-11-01', '05:00');
  check('fall-back overnight (6h nominal) = 7h — clock repeats an hour, MORE elapsed',
    fallBack === 7 && fallBack === NOMINAL + 1,
    `start=${iso('2026-10-31','23:00')} end=${iso('2026-11-01','05:00')}`);
  // Spring-forward night Mar 7 23:00 → Mar 8 05:00: an hour vanishes ⇒ −1h ⇒ 5h elapsed.
  const springFwd = hoursBetween('2026-03-07', '23:00', '2026-03-08', '05:00');
  check('spring-fwd overnight (6h nominal) = 5h — an hour vanishes, LESS elapsed',
    springFwd === 5 && springFwd === NOMINAL - 1,
    `start=${iso('2026-03-07','23:00')} end=${iso('2026-03-08','05:00')}`);
  // Direction sanity: fall-back is strictly longer than spring-forward for the same wall-clock shift.
  check('fall-back elapsed > spring-forward elapsed for identical 6h wall-clock shift', fallBack > springFwd);
}

console.log(`\nALL PASSED (${passed} assertions)`);
