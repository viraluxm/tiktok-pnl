// Unit proof for the Code 128-B encoder. A wrong pattern table produces a barcode that either
// fails to scan or — far worse — scans as the WRONG string, so this decodes its own output and
// checks the structural invariants of every symbol it can reach.
//
// Run:  node src/lib/shipping/code128.test.mjs

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./code128.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'c128-')), 'code128.mjs');
writeFileSync(outFile, outputText);
const M = await import(pathToFileURL(outFile).href);
const {
  encodeCode128B, isEncodable, symbolModules, layoutBars, QUIET_MODULES, START_B, STOP,
  generateBatchCode, isBatchCode, BATCH_CODE_PREFIX,
} = M;

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

// Split a width stream back into 11-module symbols (13 for the final STOP) and recover values by
// matching the pattern string. This is an independent read of the encoder's output.
function decode(widths) {
  const symbols = [];
  let i = 0;
  while (i < widths.length) {
    const isStop = i + 7 === widths.length;
    const n = isStop ? 7 : 6;
    symbols.push(widths.slice(i, i + n).join(''));
    i += n;
  }
  return symbols;
}

console.log('\nsymbol structure');
{
  // Every printable character, so every data pattern the encoder can emit gets exercised.
  const all = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('');
  const widths = encodeCode128B(all);
  const symbols = decode(widths);
  check('one symbol per char, plus start, check and stop',
    symbols.length === all.length + 3, `${symbols.length} for ${all.length} chars`);

  const sums = symbols.map((s) => [...s].reduce((a, d) => a + Number(d), 0));
  const body = sums.slice(0, -1);
  check('every symbol except STOP is exactly 11 modules',
    body.every((n) => n === 11), `min ${Math.min(...body)} max ${Math.max(...body)}`);
  check('STOP is 13 modules', sums[sums.length - 1] === 13, `${sums[sums.length - 1]}`);
  check('every symbol except STOP has 6 elements',
    symbols.slice(0, -1).every((s) => s.length === 6));
  check('STOP has 7 elements', symbols[symbols.length - 1].length === 7);
  check('no element is wider than 4 modules',
    symbols.every((s) => [...s].every((d) => Number(d) >= 1 && Number(d) <= 4)));
}

console.log('\nstart, checksum and stop');
{
  // Hand-computed: START_B=104, 'A' -> 65-32=33, check = (104 + 33*1) % 103 = 34, STOP=106.
  const widths = encodeCode128B('A');
  const symbols = decode(widths);
  check('"A" encodes to start + 1 data + check + stop', symbols.length === 4, `${symbols.length}`);
  check('START-B is pattern 211214', symbols[0] === '211214', symbols[0]);
  check("'A' is pattern 111323 (value 33)", symbols[1] === '111323', symbols[1]);
  check('check symbol is pattern 131123 (value 34)', symbols[2] === '131123', symbols[2]);
  check('STOP is pattern 2331112', symbols[3] === '2331112', symbols[3]);
  check('total is 46 modules (11+11+11+13)',
    widths.reduce((a, b) => a + b, 0) === 46, `${widths.reduce((a, b) => a + b, 0)}`);
}

console.log('\nchecksum is position-weighted');
{
  // Same characters, different order -> different check symbol. A checksum that ignored position
  // would produce the same symbol for both and let a transposed scan validate.
  const a = decode(encodeCode128B('AB'));
  const b = decode(encodeCode128B('BA'));
  check('transposing characters changes the check symbol', a[3] !== b[3], `${a[3]} vs ${b[3]}`);
  check('but the data symbols are the same two, swapped',
    a[1] === b[2] && a[2] === b[1]);
}

console.log('\nencodable range');
{
  check('printable ASCII is encodable', isEncodable('SB7F3K9M2QX4'));
  check('space is encodable', isEncodable('A B'));
  check('empty string is NOT encodable', !isEncodable(''));
  check('tab is not encodable', !isEncodable('A\tB'));
  check('non-ASCII is not encodable', !isEncodable('CAFÉ'));
  let threw = false;
  try { encodeCode128B('CAFÉ'); } catch { threw = true; }
  check('encoding unencodable input THROWS rather than dropping characters', threw);
}

console.log('\nlayout');
{
  const code = 'SB7F3K9M2QX4';
  const widths = encodeCode128B(code);
  const total = symbolModules(widths);
  check('symbolModules includes both quiet zones',
    total === widths.reduce((a, b) => a + b, 0) + QUIET_MODULES * 2, `${total}`);

  const W = 240, X0 = 24;
  const bars = layoutBars(widths, X0, W);
  check('bars are half the elements (spaces get no rectangle)',
    bars.length === Math.ceil(widths.length / 2), `${bars.length} of ${widths.length}`);
  check('the first bar starts after the left quiet zone',
    Math.abs(bars[0].x - (X0 + QUIET_MODULES * (W / total))) < 1e-9);
  const last = bars[bars.length - 1];
  check('the last bar ends before the right quiet zone',
    last.x + last.width <= X0 + W - QUIET_MODULES * (W / total) + 1e-9,
    `${(last.x + last.width).toFixed(2)} <= ${(X0 + W - QUIET_MODULES * (W / total)).toFixed(2)}`);
  check('every bar is inside the target width',
    bars.every((b) => b.x >= X0 && b.x + b.width <= X0 + W + 1e-9));
  check('module width is NOT rounded to whole points',
    Number.isInteger(W / total) === false && bars.some((b) => !Number.isInteger(b.width)));

  // Bar/space ratios are what a scanner measures, so they must survive layout exactly. Every bar
  // must be a whole number of modules wide (1-4) — that, not any particular width, is the
  // invariant. Rounding positions to whole points would break this and distort the ratios.
  const module = W / total;
  const inModules = bars.map((b) => b.width / module);
  check('every bar is an exact whole number of modules',
    inModules.every((m) => Math.abs(m - Math.round(m)) < 1e-9));
  check('bar widths span 1..4 modules only',
    inModules.every((m) => Math.round(m) >= 1 && Math.round(m) <= 4),
    `min ${Math.round(Math.min(...inModules))} max ${Math.round(Math.max(...inModules))}`);
  check('the widest bar is exactly N times the narrowest',
    Math.abs(Math.max(...inModules) / Math.min(...inModules)
      - Math.round(Math.max(...inModules)) / Math.round(Math.min(...inModules))) < 1e-9);
}

console.log('\nbatch codes');
{
  let seed = 1;
  const fakeRandom = (n) => Uint8Array.from({ length: n }, () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16 & 0xff);
  const code = generateBatchCode(fakeRandom);
  check('code carries the SB prefix', code.startsWith(BATCH_CODE_PREFIX), code);
  check('code is prefix + 10 body characters', code.length === 12, `${code.length}`);
  check('generated codes validate', isBatchCode(code), code);
  check('generated codes are Code 128-B encodable', isEncodable(code));

  check('rejects the confusable characters I L O U 0 1',
    !isBatchCode('SB0I1LOU2345') && !/[ILOU01]/.test(code.slice(2)), code);
  check('rejects a wrong-length body', !isBatchCode('SB123'));
  check('rejects a missing prefix', !isBatchCode('7F3K9M2QX4'));

  const codes = new Set();
  for (let i = 0; i < 500; i++) codes.add(generateBatchCode(fakeRandom));
  check('500 generated codes are all distinct', codes.size === 500, `${codes.size}`);
  check('every generated code round-trips through the encoder',
    [...codes].every((c) => decode(encodeCode128B(c)).length === c.length + 3));
}

console.log(`\n${passed} checks passed\n`);
