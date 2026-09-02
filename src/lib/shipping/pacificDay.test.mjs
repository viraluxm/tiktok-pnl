// Proof that "today" means a Pacific calendar day, including across both DST boundaries —
// where a hardcoded offset would be an hour out and the picker's box count would jump or
// stall. Run:  node src/lib/shipping/pacificDay.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./pacificDay.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'pacday-')), 'pacificDay.mjs');
writeFileSync(outFile, outputText);
const { pacificDate, pacificDayStart } = await import(pathToFileURL(outFile).href);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

const TZ = 'America/Los_Angeles';
const wallOf = (d) => d.toLocaleString('sv-SE', { timeZone: TZ });

// The defining property: whatever instant you ask about, the day's start must land on
// midnight Pacific, and must be the SAME Pacific date as the instant itself.
const cases = [
  ['midsummer, PDT (UTC-7)',        '2026-07-15T18:00:00Z'],
  ['midwinter, PST (UTC-8)',        '2026-01-15T18:00:00Z'],
  ['just after Pacific midnight',   '2026-07-15T07:30:00Z'],
  ['just before Pacific midnight',  '2026-07-15T06:30:00Z'],
  ['spring forward, day of',        '2026-03-08T20:00:00Z'],
  ['spring forward, day after',     '2026-03-09T20:00:00Z'],
  ['fall back, day of',             '2026-11-01T20:00:00Z'],
  ['fall back, day after',          '2026-11-02T20:00:00Z'],
  ['new year in Pacific, not UTC',  '2027-01-01T05:00:00Z'],
];

console.log('\nThe day starts at Pacific midnight');
for (const [label, iso] of cases) {
  const at = new Date(iso);
  const start = pacificDayStart(at);
  check(`${label}: starts at 00:00:00`, wallOf(start).endsWith('00:00:00'), wallOf(start));
}

console.log('\nThe start belongs to the same Pacific day as the instant');
for (const [label, iso] of cases) {
  const at = new Date(iso);
  check(`${label}: same date`, pacificDate(pacificDayStart(at)) === pacificDate(at),
    `${pacificDate(pacificDayStart(at))} vs ${pacificDate(at)}`);
}

console.log('\nSanity');
{
  // 05:00Z on 1 Jan is still 31 Dec in Pacific — the case a UTC-based "today" gets wrong, and
  // the reason this is not just new Date().setHours(0,0,0,0).
  check('a UTC new year is still the previous Pacific day',
    pacificDate(new Date('2027-01-01T05:00:00Z')) === '2026-12-31',
    pacificDate(new Date('2027-01-01T05:00:00Z')));
}
{
  const at = new Date('2026-07-15T18:00:00Z');
  check('the start is never after the instant', pacificDayStart(at).getTime() <= at.getTime());
  check('and never more than 24h before',
    at.getTime() - pacificDayStart(at).getTime() < 24 * 3600 * 1000);
}
{
  // Offsets really do differ between the two cases, so the test above is not vacuous.
  const summer = pacificDayStart(new Date('2026-07-15T18:00:00Z')).toISOString();
  const winter = pacificDayStart(new Date('2026-01-15T18:00:00Z')).toISOString();
  check('PDT midnight is 07:00Z', summer.endsWith('T07:00:00.000Z'), summer);
  check('PST midnight is 08:00Z', winter.endsWith('T08:00:00.000Z'), winter);
}

console.log(`\n${passed} checks passed\n`);
