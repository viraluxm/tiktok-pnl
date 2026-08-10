// Proof for host live-hours: the four states, union-of-wall-clock, reliable-only, Pacific-day
// clipping (incl. midnight crossing), orphan exclusion. Transpiles timezone.ts + liveHours.ts.
// Run:  TZ=UTC node src/lib/schedule/liveHours.test.mjs   (also correct under any host TZ)
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { pathToFileURL } from 'node:url'; import assert from 'node:assert/strict'; import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'lh-'));
const tr = (rel, outName, rw = (s) => s) => {
  const { outputText } = ts.transpileModule(readFileSync(new URL(`./${rel}`, import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  const p = join(dir, outName); writeFileSync(p, rw(outputText)); return p;
};
tr('timezone.ts', 'timezone.mjs');
const lhPath = tr('liveHours.ts', 'lh.mjs', (s) => s.replaceAll('./timezone', './timezone.mjs'));
const { liveHoursForHostDate, formatLiveHours } = await import(pathToFileURL(lhPath).href);
const { laWallTimeToUtc } = await import(pathToFileURL(join(dir, 'timezone.mjs')).href);

let passed = 0;
const check = (n, c, x = '') => { assert.ok(c, `FAIL: ${n} ${x}`); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); passed++; };
// Build a session with Pacific wall-clock start/end (reuse laWallTimeToUtc so it's self-consistent).
const S = (host, d1, t1, d2, t2, end_source = 'live_ended', status = 'ended') => ({
  host_id: host, status, end_source,
  started_at: status === 'ended' || t1 ? laWallTimeToUtc(d1, t1).toISOString() : null,
  ended_at: d2 ? laWallTimeToUtc(d2, t2).toISOString() : null,
});
const H = 'host-1';
const DAY = '2026-08-01';

console.log('\nlive hours — states + union + clipping');

// known: single reliable 16:00–18:00 PDT = 2h
check('known: single reliable session → 2.0h',
  liveHoursForHostDate([S(H, DAY, '16:00', DAY, '18:00')], H, DAY).hours === 2, );

// union (overlap): 16–18 and 17–19 → union 3h (not 4)
check('overlap union: 16–18 + 17–19 → 3.0h (not 4)',
  liveHoursForHostDate([S(H, DAY, '16:00', DAY, '18:00'), S(H, DAY, '17:00', DAY, '19:00')], H, DAY).hours === 3);

// reliable + unreliable same host/day → known 2h, 1 excluded, "≥" marker
{
  const r = liveHoursForHostDate([S(H, DAY, '16:00', DAY, '18:00'), S(H, DAY, '20:00', DAY, '23:00', 'auto_ender')], H, DAY);
  check('reliable + unreliable → known 2.0h, 1 excluded', r.state === 'known' && r.hours === 2 && r.excludedUnreliable === 1);
  check('format shows ≥ and excluded note', /^live ≥2\.0h \(1 excluded, unreliable end\)$/.test(formatLiveHours(r)), formatLiveHours(r));
}

// insufficient: only unreliable sessions for the host
{
  const r = liveHoursForHostDate([S(H, DAY, '16:00', DAY, '18:00', 'cleanup_backfill'), S(H, DAY, '20:00', DAY, '22:00', 'auto_ender')], H, DAY);
  check('insufficient: only unreliable → not a number', r.state === 'insufficient' && r.unreliableCount === 2 && r.hours === undefined);
}

// not_attributed: no host sessions, but a NULL-host session that day
check('not_attributed: null-host session exists that day',
  liveHoursForHostDate([S(null, DAY, '16:00', DAY, '18:00')], H, DAY).state === 'not_attributed');

// zero: sessions that day but all attributed to OTHER hosts (no null-host)
check('zero: only other hosts have sessions that day',
  liveHoursForHostDate([S('host-2', DAY, '16:00', DAY, '18:00')], H, DAY).state === 'zero');
// zero: no sessions at all that day
check('zero: no sessions at all', liveHoursForHostDate([], H, DAY).state === 'zero');

// orphan excluded: status='live' (ended_at null) never computes against now()
{
  const orphan = { host_id: H, status: 'live', end_source: null, started_at: laWallTimeToUtc(DAY, '16:00').toISOString(), ended_at: null };
  check('orphan (status=live) ignored → falls through to zero', liveHoursForHostDate([orphan], H, DAY).state === 'zero');
}

// Pacific-day clipping + midnight crossing: a 22:00 Aug1 → 02:00 Aug2 session counts 2h on EACH day.
{
  const cross = S(H, DAY, '22:00', '2026-08-02', '02:00');
  check('crossing session: 2.0h on Aug 1 (clipped to midnight)', liveHoursForHostDate([cross], H, DAY).hours === 2);
  check('crossing session: 2.0h on Aug 2 (clipped from midnight)', liveHoursForHostDate([cross], H, '2026-08-02').hours === 2);
}

console.log(`\nALL PASSED (${passed} assertions)`);
