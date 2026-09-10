// Proof that the singles prep screen is reachable by a STATION account without touching the
// middleware allowlist. Getting this wrong is silent: the packer just gets bounced to /fulfillment
// and the barcode looks broken.
//
// Run:  node src/lib/supabase/stationSinglesPath.test.mjs

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./claims.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'claims-')), 'claims.mjs');
writeFileSync(outFile, outputText);
const { isPathAllowed, confinementFor, STATION_CONFINEMENT } = await import(pathToFileURL(outFile).href);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

const station = confinementFor('station', undefined);

console.log('\nthe singles prep screen is reachable by a station account');
check('station confinement is the expected allowlist',
  JSON.stringify(station.allow) === JSON.stringify(['/fulfillment', '/api/station']),
  JSON.stringify(station.allow));
check('/fulfillment/singles IS allowed — no middleware change needed',
  isPathAllowed('/fulfillment/singles', station));
check('its API route is allowed', isPathAllowed('/api/station/singles-scan', station));
check('the packing screen still works', isPathAllowed('/fulfillment', station));

console.log('\nand the allowlist is still tight');
check('a TOP-LEVEL /singles would have been BLOCKED (why the page lives under /fulfillment)',
  !isPathAllowed('/singles', station));
check('/fulfillmentsingles does not sneak past the prefix match',
  !isPathAllowed('/fulfillmentsingles', station));
for (const p of ['/dashboard', '/team/binding', '/api/shipping/singles-scan', '/s/abc/pickers', '/admin/team']) {
  check(`${p} stays blocked for station`, !isPathAllowed(p, station));
}

console.log('\nowners are not confined');
check('an owner/admin session has no confinement at all',
  confinementFor(undefined, undefined) === undefined && confinementFor('admin', undefined) === undefined);

console.log(`\n${passed} checks passed\n`);
