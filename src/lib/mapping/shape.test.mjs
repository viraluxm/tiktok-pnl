// Proof for the dynamic-section rack model: sections are per (shelf, side) and built up one
// at a time, growing a rack creates nothing, shrinking reports what it would destroy, and
// section numbers never get reissued under printed labels.
// Run:  node src/lib/mapping/shape.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./shape.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'shape-')), 'shape.mjs');
writeFileSync(outFile, outputText);
const {
  sectionsOn, nextSectionIndex, planShelfChange, faceCounts, nextRackName,
  clampShelves, shelfIndexes, MIN_SHELVES, MAX_SHELVES, MAX_SECTIONS,
} = await import(pathToFileURL(outFile).href);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

let seq = 0;
const slot = (shelf, section, side, sku = null) =>
  ({ id: `s${++seq}`, shelf_index: shelf, section_index: section, side, inventory_sku_id: sku });

console.log('\nSections are per (shelf, side)');
{
  // The case the old uniform-grid model could not express: side A wider than side B, and
  // shelf 2 divided differently from shelf 1.
  const slots = [
    slot(1, 1, 'A'), slot(1, 2, 'A'), slot(1, 3, 'A'), slot(1, 4, 'A'),
    slot(1, 1, 'B'), slot(1, 2, 'B'),
    slot(2, 1, 'A'), slot(2, 2, 'A'), slot(2, 3, 'A'), slot(2, 4, 'A'), slot(2, 5, 'A'), slot(2, 6, 'A'),
  ];
  check('side A shelf 1 has 4 sections', sectionsOn(slots, 1, 'A').length === 4);
  check('side B shelf 1 has 2 — different from side A', sectionsOn(slots, 1, 'B').length === 2);
  check('side A shelf 2 has 6 — different from shelf 1', sectionsOn(slots, 2, 'A').length === 6);
  check('side B shelf 2 has none yet', sectionsOn(slots, 2, 'B').length === 0);
  check('sections come back in physical order',
    sectionsOn(slots, 1, 'A').map((s) => s.section_index).join(',') === '1,2,3,4');
}

console.log('\nAdding sections');
{
  check('an empty face starts at section 1', nextSectionIndex([], 1, 'A') === 1);
  const slots = [slot(1, 1, 'A'), slot(1, 2, 'A')];
  check('the next section continues the face', nextSectionIndex(slots, 1, 'A') === 3);
  check('the other side is counted independently', nextSectionIndex(slots, 1, 'B') === 1);
  check('another shelf is counted independently', nextSectionIndex(slots, 2, 'A') === 1);
}
{
  const full = Array.from({ length: MAX_SECTIONS }, (_, i) => slot(1, i + 1, 'A'));
  check('a full face refuses another section', nextSectionIndex(full, 1, 'A') === null);
  check('but its other side is still open', nextSectionIndex(full, 1, 'B') === 1);
}
{
  // Deleting a middle section must NOT renumber the survivors — their addresses are already
  // printed on labels sitting on the rack.
  const afterDelete = [slot(1, 1, 'A'), slot(1, 3, 'A')];
  check('a gap is preserved, not closed',
    sectionsOn(afterDelete, 1, 'A').map((s) => s.section_index).join(',') === '1,3');
  check('the next section goes above the gap, never reissuing S2',
    nextSectionIndex(afterDelete, 1, 'A') === 4);
}

console.log('\nShelf changes');
{
  const slots = [slot(1, 1, 'A'), slot(2, 1, 'A'), slot(3, 1, 'A')];
  const grow = planShelfChange(slots, 5);
  check('growing destroys nothing', grow.toDeleteIds.length === 0);
  check('growing creates nothing — a new shelf arrives empty', grow.assignedLost === 0);
}
{
  const slots = [slot(1, 1, 'A'), slot(2, 1, 'A'), slot(3, 1, 'A', 'sku-a'), slot(3, 2, 'B', 'sku-b')];
  const shrink = planShelfChange(slots, 2);
  check('shrinking destroys the removed shelf', shrink.toDeleteIds.length === 2,
    String(shrink.toDeleteIds.length));
  check('assigned slots destroyed are counted', shrink.assignedLost === 2);
  check('the SKUs left unmapped are named',
    shrink.skusUnmapped.includes('sku-a') && shrink.skusUnmapped.includes('sku-b'));
}
{
  // A SKU also living on a surviving shelf is NOT unmapped — a false alarm here trains
  // people to click through the confirmation.
  const slots = [slot(1, 1, 'A', 'sku-x'), slot(3, 1, 'A', 'sku-x')];
  const shrink = planShelfChange(slots, 2);
  check('a SKU with a surviving slot is not reported unmapped',
    shrink.skusUnmapped.length === 0, shrink.skusUnmapped.join(','));
  check('but the destroyed assignment is still counted', shrink.assignedLost === 1);
}
{
  // Same SKU on both faces of a doomed shelf: reported once.
  const slots = [slot(3, 1, 'A', 'sku-d'), slot(3, 1, 'B', 'sku-d')];
  const shrink = planShelfChange(slots, 2);
  check('an unmapped SKU is reported once', shrink.skusUnmapped.length === 1);
  check('both destroyed faces are counted', shrink.assignedLost === 2);
}
{
  check('shelves clamp to the minimum', clampShelves(1) === MIN_SHELVES);
  check('shelves clamp to the maximum', clampShelves(99) === MAX_SHELVES);
  check('shelfIndexes is bottom-first', shelfIndexes(3).join(',') === '1,2,3');
}

console.log('\nFace summary');
{
  const slots = [slot(1, 1, 'A', 'sku-a'), slot(1, 2, 'A'), slot(1, 1, 'B')];
  const fc = faceCounts(slots, 2);
  check('every shelf face is represented', fc.length === 4, String(fc.length));
  const a1 = fc.find((f) => f.shelf === 1 && f.side === 'A');
  check('counts sections and fills per face', a1.sections === 2 && a1.filled === 1,
    `${a1.sections}/${a1.filled}`);
  const b2 = fc.find((f) => f.shelf === 2 && f.side === 'B');
  check('an untouched face reports zero', b2.sections === 0 && b2.filled === 0);
}

console.log('\nAuto-naming');
{
  check('the first rack is R1', nextRackName([]) === 'R1');
  check('names continue in sequence', nextRackName(['R1', 'R2']) === 'R3');
  // Never reissue a name that may still be painted on a rack or printed on a label.
  check('a deleted middle name is NOT reused', nextRackName(['R1', 'R3']) === 'R4');
  check('order does not matter', nextRackName(['R3', 'R1']) === 'R4');
  check('non-conforming names are ignored', nextRackName(['Back wall', 'R2']) === 'R3');
  check('only-garbage names still start at R1', nextRackName(['Back wall']) === 'R1');
  check('double digits sort numerically, not lexically',
    nextRackName(['R9', 'R10']) === 'R11', nextRackName(['R9', 'R10']));
}

console.log(`\n${passed} checks passed\n`);
