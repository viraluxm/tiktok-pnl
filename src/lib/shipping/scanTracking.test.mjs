// Proof for normalizeTracking — the scanner's barcode → USPS tracking parse.
// Run:  node src/lib/shipping/scanTracking.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import ts from 'typescript';

// scanResolve.ts imports from @/lib/mapping/route, which this test does not exercise. Strip the
// imports so the pure parser can be loaded on its own.
const srcPath = fileURLToPath(new URL('./scanResolve.ts', import.meta.url));
const src = readFileSync(srcPath, 'utf8').replace(/^import .*$/gm, '');
const { outputText } = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'sr-')), 'scanResolve.mjs');
writeFileSync(outFile, outputText);
const { normalizeTracking } = await import(pathToFileURL(outFile).href);

let fails = 0;
const eq = (name, got, want) => {
  if (got === want) { console.log(`  ✓ ${name}`); return; }
  console.error(`  ✗ ${name}\n      got  ${got}\n      want ${want}`);
  fails++;
};

console.log('\nThe live failure: a false check-valid window inside the ZIP');
// lots of steals, order 577554269623783833, AWAITING_COLLECTION, photographed 2026-09-07.
// "420" + ZIP5 79928 + the tracking printed on the label.
eq('420+ZIP5 label resolves to the PRINTED tracking',
  normalizeTracking('420799289200190394220319214706'), '9200190394220319214706');
// The window left-to-right search used to return. It must never be produced again.
eq('the false offset-5 window is never returned',
  normalizeTracking('420799289200190394220319214706') !== '9289200190394220319214', true);

console.log('\nShapes that already worked keep working');
eq('bare 22-digit tracking passes through',
  normalizeTracking('9200190394220319214706'), '9200190394220319214706');
eq('HAZMAT extra-zero padding still recovers (zero-collapse path)',
  normalizeTracking('4208914992362903942203000007067'), '9236290394220300007067');

console.log('\nNot a tracking');
eq('an order id is not a tracking', normalizeTracking('577554269623783833'), null);
eq('empty', normalizeTracking(''), null);
eq('short digits', normalizeTracking('9200'), null);
// A BARE 22-digit 9[2-5] string is trusted as scanned, check digit unverified — pre-existing and
// deliberate: our check-digit implementation disagreeing with a legitimate carrier variant should
// not stop a picker, and a wrong tracking merely misses rather than resolving to another box.
eq('a bare 22-digit run is trusted even if the check digit disagrees',
  normalizeTracking('9200190394220319214700'), '9200190394220319214700');
// Inside a longer barcode there is no such trust: the check digit is the only thing separating
// the tracking from the routing digits around it.
eq('a bad check digit inside a 420 label is refused',
  normalizeTracking('420799289200190394220319214700'), null);

console.log('\nZIP+4 layout');
{
  // Build a real 420 + ZIP9 label around a known-good tracking.
  const t = '9200190394220319214706';
  eq('420+ZIP9 strips 12 and resolves', normalizeTracking(`420799281234${t}`), t);
}

console.log('\nThe parser exists exactly ONCE');
// This is the guard for the actual 2026-09-08 failure: PR #225 fixed the false-positive parse in
// scanResolve.ts while an untouched COPY lived in /api/shipping/pick-list — the route the Shipping
// tab's scanner calls. The fix appeared to do nothing and two labels were photographed failing
// hours after it deployed. A parser with two copies is a parser with two behaviours.
{
  const { execSync } = await import('node:child_process');
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  // '--include=*.ts' is quoted so the shell cannot glob it, and it keeps this test file's own
  // mention of the symbol from being counted (it was, at first: the guard reported 2 when
  // there was 1).
  const hits = execSync(
    `grep -rn "function normalizeTracking" "${root}/src" "--include=*.ts" || true`,
    { encoding: 'utf8' },
  ).trim().split('\n').filter(Boolean);
  eq('exactly one definition of normalizeTracking in src/', hits.length, 1);
  eq('and it lives in scanResolve.ts',
    hits[0]?.includes('lib/shipping/scanResolve.ts'), true);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
