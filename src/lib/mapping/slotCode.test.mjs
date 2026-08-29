// Proof for slot barcode values: shape, alphabet safety, scan disambiguation against the
// other three barcode kinds the picker's scanner sees, and uniform distribution.
// Transpiles slotCode.ts (no imports) at runtime — same pattern as route.test.mjs.
// Run:  node src/lib/mapping/slotCode.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./slotCode.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'slotcode-')), 'slotCode.mjs');
writeFileSync(outFile, outputText);
const { generateSlotCode, isSlotCode, normalizeSlotCode, SLOT_CODE_PREFIX } = await import(
  pathToFileURL(outFile).href
);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

console.log('\nShape');
{
  const c = generateSlotCode();
  check('is prefixed', c.startsWith(SLOT_CODE_PREFIX), c);
  check('is prefix + 10 chars', c.length === SLOT_CODE_PREFIX.length + 10, c);
  check('validates itself', isSlotCode(c), c);
}
{
  const codes = Array.from({ length: 2000 }, generateSlotCode);
  check('every generated code validates', codes.every(isSlotCode));
  check('2000 codes are all distinct', new Set(codes).size === 2000);
}

console.log('\nAlphabet excludes ambiguous characters');
{
  const body = Array.from({ length: 500 }, generateSlotCode)
    .map((c) => c.slice(SLOT_CODE_PREFIX.length))
    .join('');
  for (const bad of ['O', 'I', 'L', '0', '1']) {
    check(`never emits "${bad}"`, !body.includes(bad));
  }
}

console.log('\nScan disambiguation — the four barcode kinds must not collide');
{
  check('rejects a SKU label', !isSlotCode('SKU1042-7K3Q'));
  check('rejects a bare employee badge', !isSlotCode('7K3QM2XAJP'));
  check('rejects a 22-digit shipping label', !isSlotCode('9234567890123456789012'));
  check('rejects an empty scan', !isSlotCode(''));
  check('rejects the prefix alone', !isSlotCode('LOC-'));
  check('rejects a short body', !isSlotCode('LOC-ABC'));
  check('rejects a long body', !isSlotCode('LOC-ABCDEFGHJKM'));
}
{
  // A misread that lands on an excluded character must FAIL rather than be repaired into a
  // different, valid slot — silently picking the wrong location is the worst outcome here.
  check('rejects a body containing O', !isSlotCode('LOC-ABCDEFGHJO'));
  check('rejects a body containing 0', !isSlotCode('LOC-ABCDEFGHJ0'));
  check('rejects a body containing I', !isSlotCode('LOC-ABCDEFGHJI'));
  check('rejects lowercase-only garbage', !isSlotCode('hello world'));
}

console.log('\nNormalisation');
{
  const c = generateSlotCode();
  check('tolerates surrounding whitespace', isSlotCode(`  ${c}\n`), c);
  check('tolerates lowercase entry', isSlotCode(c.toLowerCase()), c);
  check('strips interior whitespace', normalizeSlotCode('LOC- ABC DEF').includes('LOC-ABCDEF'));
  check('uppercases', normalizeSlotCode('loc-abc') === 'LOC-ABC');
}

console.log('\nDistribution');
{
  // Rejection sampling should leave the alphabet roughly uniform. With 31 symbols over
  // 60k draws the expected count per symbol is ~1935; a naive `% 31` would skew the first
  // eight symbols by ~3%, well outside this band.
  const body = Array.from({ length: 6000 }, generateSlotCode)
    .map((c) => c.slice(SLOT_CODE_PREFIX.length))
    .join('');
  const counts = new Map();
  for (const ch of body) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const expected = body.length / 31;
  const worst = Math.max(...[...counts.values()].map((n) => Math.abs(n - expected) / expected));
  check('all 31 symbols appear', counts.size === 31, `${counts.size}/31`);
  check('no symbol deviates more than 15%', worst < 0.15, `worst=${(worst * 100).toFixed(1)}%`);
}

console.log(`\n${passed} checks passed\n`);
