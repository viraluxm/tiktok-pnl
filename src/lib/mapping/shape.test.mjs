// Proof for the rack shape model: a shelf holds ONE list of sections, each carrying which
// aisle(s) it is picked from. Covers asymmetric shelves, the per-side capacity an 'AB'
// section consumes twice, section numbering that never gets reissued, and shelf changes.
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
  sectionsOn, sectionsFacing, reachableFrom, isReachableFrom, canAddSection, canChangeSide,
  planShelfInsert, planShelfRemove, canInsertShelf,
  nextSectionIndex, planShelfChange, nextRackName, clampShelves, shelfIndexes,
  MIN_SHELVES, MAX_SHELVES, MAX_SECTIONS_PER_SIDE,
} = await import(pathToFileURL(outFile).href);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

let seq = 0;
const sec = (shelf, index, side, sku = null) =>
  ({ id: `s${++seq}`, shelf_index: shelf, section_index: index, side, inventory_sku_id: sku });

console.log('\nReachability');
{
  check("'A' is reachable from aisle A only",
    reachableFrom('A').join(',') === 'A' && !isReachableFrom('A', 'B'));
  check("'B' is reachable from aisle B only",
    reachableFrom('B').join(',') === 'B' && !isReachableFrom('B', 'A'));
  check("'AB' is reachable from both",
    reachableFrom('AB').join(',') === 'A,B' &&
    isReachableFrom('AB', 'A') && isReachableFrom('AB', 'B'));
}

console.log('\nA shelf holds ONE list of sections');
{
  // Adding one section must NOT imply a second on the other side — the bug this model fixes.
  const slots = [sec(4, 1, 'A')];
  check('one added section is exactly one section', sectionsOn(slots, 4).length === 1);
  check('and it is not reachable from the other aisle',
    sectionsFacing(slots, 4, 'B').length === 0);
  check('but it IS reachable from its own', sectionsFacing(slots, 4, 'A').length === 1);
}
{
  // The asymmetry the user asked for: four on one side, six on the other, one shelf.
  const slots = [
    ...Array.from({ length: 4 }, (_, i) => sec(1, i + 1, 'A')),
    ...Array.from({ length: 6 }, (_, i) => sec(1, i + 5, 'B')),
  ];
  check('one shelf can hold 4 on side A and 6 on side B',
    sectionsFacing(slots, 1, 'A').length === 4 && sectionsFacing(slots, 1, 'B').length === 6);
  check('the shelf lists all ten together', sectionsOn(slots, 1).length === 10);
  check('sections come back in order',
    sectionsOn(slots, 1).map((s) => s.section_index).join(',') === '1,2,3,4,5,6,7,8,9,10');
}
{
  const slots = [sec(1, 1, 'AB')];
  check("an 'AB' section appears in BOTH aisles",
    sectionsFacing(slots, 1, 'A').length === 1 && sectionsFacing(slots, 1, 'B').length === 1);
  check('but is still one section on the shelf', sectionsOn(slots, 1).length === 1);
}

console.log('\nPer-side capacity');
{
  const fullA = Array.from({ length: MAX_SECTIONS_PER_SIDE }, (_, i) => sec(1, i + 1, 'A'));
  check('a full A side refuses another A', canAddSection(fullA, 1, 'A') === false);
  check('but B is still open', canAddSection(fullA, 1, 'B') === true);
  check("and 'AB' is refused, since it needs room in BOTH aisles",
    canAddSection(fullA, 1, 'AB') === false);
  check('another shelf is unaffected', canAddSection(fullA, 2, 'A') === true);
}
{
  // 'AB' sections consume capacity on both sides.
  const abFull = Array.from({ length: MAX_SECTIONS_PER_SIDE }, (_, i) => sec(1, i + 1, 'AB'));
  check("six 'AB' sections fill side A", canAddSection(abFull, 1, 'A') === false);
  check("six 'AB' sections also fill side B", canAddSection(abFull, 1, 'B') === false);
}

console.log('\nChanging a section’s side');
{
  const slots = [sec(1, 1, 'A'), sec(1, 2, 'B')];
  check('narrowing is always allowed', canChangeSide(slots, slots[0], 'A') === true);
  check("widening to 'AB' is allowed when the other aisle has room",
    canChangeSide(slots, slots[0], 'AB') === true);
}
{
  // The section itself is on A; side B is already full, so it cannot widen into it.
  const slots = [
    sec(1, 1, 'A'),
    ...Array.from({ length: MAX_SECTIONS_PER_SIDE }, (_, i) => sec(1, i + 2, 'B')),
  ];
  check("widening to 'AB' is refused when the gained aisle is full",
    canChangeSide(slots, slots[0], 'AB') === false);
  check('narrowing that same section is still fine',
    canChangeSide(slots, slots[0], 'B') === true || canChangeSide(slots, slots[0], 'A') === true);
}
{
  // Re-declaring the side a section already has must never be blocked by its own presence.
  const slots = Array.from({ length: MAX_SECTIONS_PER_SIDE }, (_, i) => sec(1, i + 1, 'AB'));
  check("an 'AB' section can stay 'AB' on a full shelf",
    canChangeSide(slots, slots[0], 'AB') === true);
}

console.log('\nSection numbering');
{
  check('an empty shelf starts at section 1', nextSectionIndex([], 1, 'A') === 1);
  const slots = [sec(1, 1, 'A'), sec(1, 2, 'B')];
  check('numbering runs across the whole shelf, not per side',
    nextSectionIndex(slots, 1, 'A') === 3, String(nextSectionIndex(slots, 1, 'A')));
  check('another shelf numbers independently', nextSectionIndex(slots, 2, 'A') === 1);
}
{
  const afterDelete = [sec(1, 1, 'A'), sec(1, 3, 'A')];
  check('a gap is preserved, not closed',
    sectionsOn(afterDelete, 1).map((s) => s.section_index).join(',') === '1,3');
  check('the next section goes above the gap, never reissuing S2',
    nextSectionIndex(afterDelete, 1, 'A') === 4);
}
{
  const fullA = Array.from({ length: MAX_SECTIONS_PER_SIDE }, (_, i) => sec(1, i + 1, 'A'));
  check('a full side yields no next index', nextSectionIndex(fullA, 1, 'A') === null);
}

console.log('\nShelf changes');
{
  const slots = [sec(1, 1, 'A'), sec(2, 1, 'A'), sec(3, 1, 'A')];
  const grow = planShelfChange(slots, 5);
  check('growing destroys nothing', grow.toDeleteIds.length === 0);
  check('growing creates nothing — a new shelf arrives empty', grow.assignedLost === 0);
}
{
  const slots = [sec(1, 1, 'A'), sec(3, 1, 'A', 'sku-a'), sec(3, 2, 'B', 'sku-b')];
  const shrink = planShelfChange(slots, 2);
  check('shrinking destroys the removed shelf', shrink.toDeleteIds.length === 2);
  check('assigned sections destroyed are counted', shrink.assignedLost === 2);
  check('the SKUs left unmapped are named',
    shrink.skusUnmapped.includes('sku-a') && shrink.skusUnmapped.includes('sku-b'));
}
{
  const slots = [sec(1, 1, 'A', 'sku-x'), sec(3, 1, 'A', 'sku-x')];
  const shrink = planShelfChange(slots, 2);
  check('a SKU with a surviving section is not reported unmapped',
    shrink.skusUnmapped.length === 0);
  check('but the destroyed assignment is still counted', shrink.assignedLost === 1);
}
{
  check('shelves clamp to the minimum', clampShelves(1) === MIN_SHELVES);
  check('shelves clamp to the maximum', clampShelves(99) === MAX_SHELVES);
  check('shelfIndexes is bottom-first', shelfIndexes(3).join(',') === '1,2,3');
}

console.log('\nInserting and removing a shelf mid-rack');
{
  const slots = [sec(1, 1, 'A'), sec(2, 1, 'A'), sec(3, 1, 'A')];
  const above = planShelfInsert(slots, 2, 'above');
  check('inserting ABOVE L2 makes the new shelf L3', above.newShelfIndex === 3);
  check('only L3 and up renumber',
    above.renumbered.length === 1 && above.renumbered.every((x) => x.shelf_index >= 3),
    String(above.renumbered.length));
}
{
  const slots = [sec(1, 1, 'A'), sec(2, 1, 'A'), sec(3, 1, 'A')];
  const below = planShelfInsert(slots, 2, 'below');
  check('inserting BELOW L2 makes the new shelf L2', below.newShelfIndex === 2);
  check('L2 and up renumber — two shelves', below.renumbered.length === 2,
    String(below.renumbered.length));
}
{
  // The two extremes bound the reprint cost: at the bottom every label goes stale, at the top
  // none do. That range is exactly what the UI has to warn about.
  const slots = [sec(1, 1, 'A'), sec(2, 1, 'A'), sec(3, 1, 'A')];
  check('below the bottom shelf renumbers every shelf',
    planShelfInsert(slots, 1, 'below').renumbered.length === 3);
  check('above the top shelf renumbers none',
    planShelfInsert(slots, 3, 'above').renumbered.length === 0);
}
{
  const slots = [sec(1, 1, 'A', 'sku-a'), sec(2, 1, 'A', 'sku-b'), sec(3, 1, 'A')];
  const rm = planShelfRemove(slots, 2);
  check('removing L2 destroys only its sections', rm.toDeleteIds.length === 1);
  check('and reports the assignment lost',
    rm.assignedLost === 1 && rm.skusUnmapped.includes('sku-b'));
  check('shelves above L2 renumber down', rm.renumbered.length === 1 && rm.shiftFrom === 3);
}
{
  // Same false-alarm rule as everywhere else: a SKU still on a surviving shelf is not lost.
  const slots = [sec(1, 1, 'A', 'sku-x'), sec(2, 1, 'A', 'sku-x')];
  const rm = planShelfRemove(slots, 2);
  check('a SKU with a surviving section is not reported unmapped', rm.skusUnmapped.length === 0);
  check('but the destroyed assignment is still counted', rm.assignedLost === 1);
}
{
  const slots = [sec(1, 1, 'A'), sec(2, 1, 'A'), sec(3, 1, 'A')];
  check('removing the TOP shelf renumbers nothing',
    planShelfRemove(slots, 3).renumbered.length === 0);
}

console.log('\nNothing goes below L1');
{
  // The bottom shelf sits on the floor, so there is no space under it. Enforcing this also
  // means L1 can never be renumbered — its printed labels stay correct forever.
  check('below L1 is refused', canInsertShelf(4, 1, 'below').ok === false);
  check('and says why', /floor/i.test(canInsertShelf(4, 1, 'below').reason ?? ''),
    canInsertShelf(4, 1, 'below').reason);
  check('ABOVE L1 is fine', canInsertShelf(4, 1, 'above').ok === true);
  check('below any higher shelf is fine', canInsertShelf(4, 2, 'below').ok === true);
}
{
  check('a full rack refuses either direction',
    canInsertShelf(MAX_SHELVES, 2, 'above').ok === false &&
    canInsertShelf(MAX_SHELVES, 2, 'below').ok === false);
  check('a shelf that does not exist is refused', canInsertShelf(4, 9, 'above').ok === false);
}
{
  // The payoff of the L1 rule: no legal insertion can ever renumber the bottom shelf.
  const slots = [sec(1, 1, 'A'), sec(2, 1, 'A'), sec(3, 1, 'A')];
  const legal = [];
  for (let at = 1; at <= 3; at++) {
    for (const pos of ['above', 'below']) {
      if (canInsertShelf(3, at, pos).ok) legal.push(planShelfInsert(slots, at, pos));
    }
  }
  check('no legal insert ever renumbers L1',
    legal.every((p) => p.renumbered.every((x) => x.shelf_index > 1)),
    `${legal.length} legal insertions checked`);
}

console.log('\nAuto-naming');
{
  check('the first rack is R1', nextRackName([]) === 'R1');
  check('names continue in sequence', nextRackName(['R1', 'R2']) === 'R3');
  check('a deleted middle name is NOT reused', nextRackName(['R1', 'R3']) === 'R4');
  check('order does not matter', nextRackName(['R3', 'R1']) === 'R4');
  check('non-conforming names are ignored', nextRackName(['Back wall', 'R2']) === 'R3');
  check('double digits sort numerically, not lexically', nextRackName(['R9', 'R10']) === 'R11');
}

console.log(`\n${passed} checks passed\n`);
