// Which number goes big on the pack device, and in which unit.
//
// Getting this wrong is silent and demoralising: a singles-only packer who credits 135 packages
// and sees a giant green 0 will read it as the scan having failed.
//
// Run:  node src/lib/shipping/deviceCounter.test.mjs

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./crewBoard.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'dev-')), 'crewBoard.mjs');
writeFileSync(outFile, outputText);
const { weightedBoxes } = await import(pathToFileURL(outFile).href);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

// The exact choice the overlay makes.
function display(totals, fallback) {
  const t = totals;
  const singlesOnly = !!t && t.singles > 0 && t.boxes === 0;
  const headline = !t ? fallback : singlesOnly ? t.singles : t.weighted;
  const unit = singlesOnly ? 'singles' : 'boxes';
  return { headline, unit, showsSubline: !!t && !singlesOnly && (t.boxes > 0 || t.singles > 0) };
}
const totals = (boxes, items, singles = 0) =>
  ({ weighted: Math.round(weightedBoxes(boxes, items)), boxes, items, singles });

console.log('\nthe device shows the number the target is measured on');
{
  // Alex, 2026-09-10: the device said 256 while the manager board said 302 against a 200 target.
  const alex = totals(256, 1108);
  check('a picker sees WEIGHTED, matching the manager board', display(alex).headline === alex.weighted,
    `${display(alex).headline} (raw boxes ${alex.boxes})`);
  check("and that is materially different from the raw count — the reason for this change",
    display(alex).headline > alex.boxes, `${display(alex).headline} vs ${alex.boxes}`);
  check('the unit is boxes', display(alex).unit === 'boxes');
  check('raw boxes and items still show underneath, so the headline is checkable',
    display(alex).showsSubline);
}

console.log('\na singles-only packer is not shown a green zero');
{
  const prep = totals(0, 0, 135);
  check('135 singles, 0 boxes -> weighted really is 0', prep.weighted === 0);
  check('but the headline shows 135, not 0', display(prep).headline === 135, `${display(prep).headline}`);
  check('and the unit says singles, so it is never ambiguous', display(prep).unit === 'singles');
  check('no boxes/items subline for a singles-only packer', !display(prep).showsSubline);
}

console.log('\nsomeone who did both');
{
  const both = totals(120, 400, 60);
  check('the headline is weighted boxes, NOT boxes + singles mixed together',
    display(both).headline === both.weighted, `${display(both).headline}`);
  check('singles are excluded from the weighted headline',
    display(both).headline === Math.round(weightedBoxes(120, 400)));
  check('the unit stays boxes', display(both).unit === 'boxes');
  check('the subline carries the singles so they are still visible', display(both).showsSubline);
}

console.log('\nedges');
{
  check('a caller that sends no totals falls back to the raw count',
    display(null, 47).headline === 47, 'older client keeps working');
  check('an empty day shows 0 boxes, not 0 singles',
    display(totals(0, 0, 0)).headline === 0 && display(totals(0, 0, 0)).unit === 'boxes');
  check('one box does not claim to be singles', display(totals(1, 1)).unit === 'boxes');
  check('a box with unresolved lines still counts as work',
    display(totals(1, 1)).headline >= 1, `${display(totals(1, 1)).headline}`);
}

console.log(`\n${passed} checks passed\n`);
