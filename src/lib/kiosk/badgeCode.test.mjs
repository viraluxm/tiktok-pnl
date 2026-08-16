// Proof for the badge-code alphabet + generator. The excluded characters (0 O 1 I L) must NEVER
// appear, codes are exactly 10 chars, and the validator agrees with the generator.
//
// No app test runner exists, so this transpiles badgeCode.ts at runtime via the repo's `typescript`
// devDep (mirrors src/lib/timeclock.test.mjs) and exercises the REAL logic.
//
// Run:  node src/lib/kiosk/badgeCode.test.mjs

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./badgeCode.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const dir = mkdtempSync(join(tmpdir(), 'badgecode-'));
const outPath = join(dir, 'badgeCode.mjs');
writeFileSync(outPath, outputText);
const { BADGE_ALPHABET, BADGE_CODE_LENGTH, generateBadgeCode, isValidBadgeCode } = await import(
  pathToFileURL(outPath).href
);

const EXCLUDED = ['0', 'O', '1', 'I', 'L'];

test('alphabet excludes the ambiguous characters and has 31 symbols', () => {
  for (const ch of EXCLUDED) assert.ok(!BADGE_ALPHABET.includes(ch), `alphabet must not contain ${ch}`);
  assert.equal(BADGE_ALPHABET.length, 31);
  // Only A–Z and 2–9.
  assert.ok(/^[A-Z2-9]+$/.test(BADGE_ALPHABET));
  // No duplicate symbols.
  assert.equal(new Set(BADGE_ALPHABET).size, BADGE_ALPHABET.length);
});

test('generateBadgeCode is deterministic under an injected rng and stays in-alphabet', () => {
  // rng always returns 0 → first symbol repeated.
  const zero = generateBadgeCode(() => 0);
  assert.equal(zero, BADGE_ALPHABET[0].repeat(BADGE_CODE_LENGTH));
  // A rolling counter walks the alphabet.
  let i = 0;
  const rolling = generateBadgeCode(() => i++ % BADGE_ALPHABET.length);
  assert.equal(rolling.length, BADGE_CODE_LENGTH);
  for (const ch of rolling) assert.ok(BADGE_ALPHABET.includes(ch));
});

test('generated codes are always valid and only use allowed characters', () => {
  for (let n = 0; n < 500; n++) {
    const code = generateBadgeCode();
    assert.equal(code.length, BADGE_CODE_LENGTH);
    assert.ok(isValidBadgeCode(code), `generated code should validate: ${code}`);
    for (const ch of code) {
      assert.ok(BADGE_ALPHABET.includes(ch));
      assert.ok(!EXCLUDED.includes(ch));
    }
  }
});

test('isValidBadgeCode rejects wrong length, excluded chars, and lowercase', () => {
  assert.equal(isValidBadgeCode('ABCDEFGHJK'), true); // 10 valid chars
  assert.equal(isValidBadgeCode('ABCDEFGHJ'), false); // 9 chars
  assert.equal(isValidBadgeCode('ABCDEFGHJKM'), false); // 11 chars
  assert.equal(isValidBadgeCode('ABCDEFGHJ0'), false); // contains 0
  assert.equal(isValidBadgeCode('ABCDEFGHJO'), false); // contains O
  assert.equal(isValidBadgeCode('ABCDEFGHIL'), false); // contains I and L
  assert.equal(isValidBadgeCode('abcdefghjk'), false); // lowercase
  assert.equal(isValidBadgeCode(''), false);
});
