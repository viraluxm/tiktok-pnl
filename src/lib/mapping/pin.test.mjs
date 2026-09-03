// Proof for override PINs: a correct PIN verifies, a wrong one does not, the same PIN hashes
// differently every time (salted), and a corrupted stored value DENIES rather than throwing —
// a broken row must not 500 the pick screen and block the floor.
// Run:  node src/lib/mapping/pin.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./pin.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'pin-')), 'pin.mjs');
writeFileSync(outFile, outputText);
const { hashPin, verifyPin, isValidPinFormat } = await import(pathToFileURL(outFile).href);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

console.log('\nFormat');
{
  check('four digits is valid', isValidPinFormat('1234'));
  check('eight digits is valid', isValidPinFormat('12345678'));
  check('three digits is refused', !isValidPinFormat('123'));
  check('nine digits is refused', !isValidPinFormat('123456789'));
  check('letters are refused', !isValidPinFormat('12a4'));
  check('empty is refused', !isValidPinFormat(''));
  check('whitespace is refused', !isValidPinFormat(' 1234'));
}

console.log('\nHashing');
{
  const stored = await hashPin('4821');
  check('stored value names its scheme', stored.startsWith('scrypt$'), stored.slice(0, 12) + '…');
  check('the PIN never appears in the stored value', !stored.includes('4821'));
  check('the correct PIN verifies', await verifyPin('4821', stored));
  check('a wrong PIN does not', !(await verifyPin('4822', stored)));
  check('an empty PIN does not', !(await verifyPin('', stored)));
}
{
  // Salted: two people choosing 1234 must not share a hash, or one leak exposes both.
  const a = await hashPin('1234');
  const b = await hashPin('1234');
  check('the same PIN hashes differently every time', a !== b);
  check('…and both still verify', (await verifyPin('1234', a)) && (await verifyPin('1234', b)));
}

console.log('\nA broken stored value denies, it does not throw');
{
  // The pick screen calls this. A corrupted row must refuse the override, not crash the
  // endpoint and leave a picker stuck mid-order with no way through.
  for (const [name, bad] of [
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['no scheme', 'deadbeef'],
    ['unknown scheme', 'bcrypt$aa$bb'],
    ['too few parts', 'scrypt$aa'],
    ['too many parts', 'scrypt$aa$bb$cc'],
    ['non-hex salt', 'scrypt$zzzz$bb'],
    ['short salt', 'scrypt$aabb$' + 'aa'.repeat(32)],
    ['short hash', 'scrypt$' + 'aa'.repeat(16) + '$aabb'],
  ]) {
    check(`${name} denies`, (await verifyPin('1234', bad)) === false);
  }
}

console.log(`\n${passed} checks passed\n`);
