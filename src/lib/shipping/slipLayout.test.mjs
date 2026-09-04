// Proof for slip text fitting. An overflowing slip is worse than a small one — the packer reads
// a truncated SKU name and pulls the wrong stock — so the tests centre on never overflowing.
// Run:  node src/lib/shipping/slipLayout.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./slipLayout.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'sl-')), 'slipLayout.mjs');
writeFileSync(outFile, outputText);
const { fitText, splitCaption } = await import(pathToFileURL(outFile).href);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

/** Monospace stand-in: every glyph is 0.6 x size wide, like a real sans-serif average. */
const measure = (t, size) => t.length * size * 0.6;
const SIZES = [48, 40, 32, 26, 22, 18, 14, 11, 9];
const WIDTH = 274; // a 4x6 label at 298pt wide, less 12pt margins

console.log('\nSplitting a caption');
{
  const a = splitCaption('#248 PUMPKIN GLITTER');
  check('number and title separate', a.number === '#248' && a.title === 'PUMPKIN GLITTER',
    `${a.number}/${a.title}`);
  const b = splitCaption('MIXED — READ EACH LABEL');
  check('a caption with no number is all title',
    b.number === null && b.title === 'MIXED — READ EACH LABEL', `${b.number}/${b.title}`);
  const c = splitCaption('#7');
  check('a number with no title', c.number === '#7' && c.title === '');
  const d = splitCaption('#? MYSTERY');
  check('the unknown-SKU caption survives', d.number === '#?' && d.title === 'MYSTERY');
  check('empty input does not crash',
    splitCaption('').title === '' && splitCaption('').number === null);
  check('surrounding whitespace is trimmed', splitCaption('  #9 SPACED  ').title === 'SPACED');
}

console.log('\nNothing ever overflows the label');
{
  const cases = [
    'PUMPKIN GLITTER',
    'XL PEANUT IN BAG',
    'JUMBO UV COLOR CHANGING STRAWBERRY',       // the longest real title on Snore
    'CRUNCHY TEXTURE GRAPE IN A BOX',
    'MIXED — READ EACH LABEL',
    'A'.repeat(80),                              // one unbroken monster token
    'SUPERCALIFRAGILISTICEXPIALIDOCIOUSSQUISHYTHING EXTRA',
  ];
  for (const text of cases) {
    const fit = fitText(text, measure, WIDTH, 3, SIZES);
    const widest = Math.max(...fit.lines.map((l) => measure(l, fit.size)));
    check(`"${text.slice(0, 34)}${text.length > 34 ? '…' : ''}" fits`,
      widest <= WIDTH && fit.lines.length <= 3 && fit.lines.length >= 1,
      `${fit.size}pt × ${fit.lines.length} lines, widest ${Math.round(widest)}/${WIDTH}`);
  }
}

console.log('\nThe biggest size that works is the one chosen');
{
  const short = fitText('CHEESE', measure, WIDTH, 3, SIZES);
  check('a short title takes the largest size', short.size === 48, `${short.size}pt`);
  check('…on one line', short.lines.length === 1);

  const long = fitText('JUMBO UV COLOR CHANGING STRAWBERRY', measure, WIDTH, 3, SIZES);
  check('a long title shrinks rather than overflowing', long.size < 48, `${long.size}pt`);
  // It must not shrink further than necessary — a smaller slip is harder to read across a room.
  // Measured with an unlimited line budget, so the fallback's truncation cannot hide the
  // overflow (an earlier version of this check was fooled by exactly that).
  const oneBigger = SIZES[SIZES.indexOf(long.size) - 1];
  const unbounded = fitText('JUMBO UV COLOR CHANGING STRAWBERRY', measure, WIDTH, 99, [oneBigger]);
  check('…and not one step further than it must',
    unbounded.lines.length > 3,
    `${oneBigger}pt genuinely needs ${unbounded.lines.length} lines`);
  check('the chosen size is not truncated', long.truncated === undefined);
}

console.log('\nTruncation is visible, never silent');
{
  // Only reachable when nothing fits at any size. A clipped title that LOOKS complete is the
  // one failure worse than a small slip: they pull stock matching a name never fully shown.
  const fit = fitText('B'.repeat(400), measure, 100, 2, [40, 20]);
  check('the clipped line is marked with an ellipsis',
    fit.lines[fit.lines.length - 1].endsWith('…'), fit.lines.join(' | '));
  check('and the result says it was truncated', fit.truncated === true);
  check('the ellipsis does not push the line over the width',
    Math.max(...fit.lines.map((l) => measure(l, fit.size))) <= 100,
    String(Math.round(Math.max(...fit.lines.map((l) => measure(l, fit.size))))));
  const clean = fitText('CHEESE', measure, WIDTH, 3, SIZES);
  check('text that fits is never marked truncated and gains no ellipsis',
    clean.truncated === undefined && !clean.lines.join('').includes('…'));
}

console.log('\nWrapping');
{
  const fit = fitText('ONE TWO THREE FOUR FIVE SIX SEVEN EIGHT', measure, 120, 4, [20, 16, 12]);
  check('words are never split when they need not be',
    fit.lines.every((l) => !/\b\w+$/.test(l) || true) && fit.lines.join(' ').split(/\s+/).length === 8);
  check('no word is lost in wrapping',
    fit.lines.join(' ').replace(/\s+/g, ' ') === 'ONE TWO THREE FOUR FIVE SIX SEVEN EIGHT',
    fit.lines.join(' | '));
}
{
  // A single word wider than the label at EVERY size must still be drawn, broken mid-word.
  const fit = fitText('B'.repeat(200), measure, 100, 2, [40, 20]);
  check('an unfittable word is hard-broken rather than left to overflow',
    fit.lines.length > 0 && Math.max(...fit.lines.map((l) => measure(l, fit.size))) <= 100,
    `${fit.lines.length} lines at ${fit.size}pt`);
  check('…and truncated to the line budget', fit.lines.length <= 2);
}

console.log('\nEdges');
{
  check('empty text yields no lines', fitText('', measure, WIDTH, 3, SIZES).lines.length === 0);
  check('whitespace-only text yields no lines',
    fitText('   \t ', measure, WIDTH, 3, SIZES).lines.length === 0);
  check('an empty size list still returns something drawable',
    fitText('HELLO', measure, WIDTH, 3, []).size > 0);
  check('a single line budget is respected',
    fitText('ONE TWO THREE FOUR FIVE SIX', measure, 80, 1, [20, 10, 5]).lines.length === 1);
}

console.log(`\n${passed} checks passed\n`);
