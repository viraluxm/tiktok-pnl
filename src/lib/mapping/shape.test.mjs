// Proof for rack shape and reshaping — the one destructive operation in the Mapping UI.
// Covers slot expansion (both faces of every section), bounds, and the reshape diff:
// surviving slots must be left untouched so their barcodes and assignments hold, and the
// cost of a shrink must be reported before it happens.
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
  slotPositions, slotCount, planReshape, clampShelves, clampSections,
  MIN_SHELVES, MAX_SHELVES, MIN_SECTIONS, MAX_SECTIONS,
} = await import(pathToFileURL(outFile).href);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

// Build existing slots for a shape, optionally assigning SKUs by position key.
const existingFor = (shelves, sections, assign = {}) =>
  slotPositions(shelves, sections).map((p, i) => ({
    ...p,
    id: `slot-${i}`,
    inventory_sku_id: assign[`${p.shelf_index}:${p.section_index}:${p.side}`] ?? null,
  }));

console.log('\nSlot expansion');
{
  // The user's own worked example: 2 shelves x 4 sections is 16 slots, not 8.
  check('2 shelves x 4 sections = 16 slots', slotCount(2, 4) === 16, String(slotCount(2, 4)));
  check('slotPositions agrees with slotCount', slotPositions(2, 4).length === 16);
  const positions = slotPositions(2, 4);
  check('every position has both faces',
    positions.filter((p) => p.side === 'A').length === 8 &&
    positions.filter((p) => p.side === 'B').length === 8);
  check('positions are unique',
    new Set(positions.map((p) => `${p.shelf_index}:${p.section_index}:${p.side}`)).size === 16);
  check('shelves are 1-based', Math.min(...positions.map((p) => p.shelf_index)) === 1);
  check('sections are 1-based', Math.min(...positions.map((p) => p.section_index)) === 1);
}
{
  check('smallest legal rack is 2x2x2 = 8', slotCount(MIN_SHELVES, MIN_SECTIONS) === 8);
  check('largest legal rack is 5x6x2 = 60', slotCount(MAX_SHELVES, MAX_SECTIONS) === 60);
}

console.log('\nBounds');
{
  check('shelves clamp up to the minimum', clampShelves(1) === MIN_SHELVES);
  check('shelves clamp down to the maximum', clampShelves(99) === MAX_SHELVES);
  check('shelves pass through in range', clampShelves(3) === 3);
  check('sections clamp up to the minimum', clampSections(0) === MIN_SECTIONS);
  check('sections clamp down to the maximum', clampSections(99) === MAX_SECTIONS);
  check('fractional input is truncated', clampShelves(3.9) === 3);
}

console.log('\nReshape — growing');
{
  const existing = existingFor(2, 2);
  const plan = planReshape(existing, 3, 2);
  check('growing creates only the new slots', plan.toCreate.length === 4, String(plan.toCreate.length));
  check('growing destroys nothing', plan.toDeleteIds.length === 0);
  check('growing loses no assignments', plan.assignedLost === 0);
  check('new slots are all on the new shelf',
    plan.toCreate.every((p) => p.shelf_index === 3));
}
{
  // Surviving slots must not be recreated — that is what keeps printed barcodes valid.
  const existing = existingFor(2, 2);
  const plan = planReshape(existing, 2, 4);
  check('widening leaves existing slots untouched', plan.toDeleteIds.length === 0);
  check('widening adds both faces of each new section', plan.toCreate.length === 8,
    String(plan.toCreate.length));
}

console.log('\nReshape — shrinking');
{
  const existing = existingFor(3, 2);
  const plan = planReshape(existing, 2, 2);
  check('shrinking deletes the removed shelf', plan.toDeleteIds.length === 4,
    String(plan.toDeleteIds.length));
  check('shrinking creates nothing', plan.toCreate.length === 0);
}
{
  // The cost that must be surfaced before the user confirms.
  const existing = existingFor(3, 2, { '3:1:A': 'sku-a', '3:2:B': 'sku-b' });
  const plan = planReshape(existing, 2, 2);
  check('assigned slots being destroyed are counted', plan.assignedLost === 2,
    String(plan.assignedLost));
  check('the SKUs left unmapped are named',
    plan.skusUnmapped.length === 2 && plan.skusUnmapped.includes('sku-a') && plan.skusUnmapped.includes('sku-b'),
    plan.skusUnmapped.join(','));
}
{
  // A double-sided SKU losing ONE face is still findable — reporting it as unmapped would
  // be a false alarm that trains people to click through the confirmation.
  const existing = existingFor(3, 2, { '3:1:A': 'sku-x', '1:1:A': 'sku-x' });
  const plan = planReshape(existing, 2, 2);
  check('a SKU with a surviving slot is not reported unmapped',
    plan.skusUnmapped.length === 0, plan.skusUnmapped.join(','));
  check('but the destroyed assignment is still counted', plan.assignedLost === 1);
}
{
  // Same SKU on both faces of a doomed section: reported once, not twice.
  const existing = existingFor(3, 2, { '3:1:A': 'sku-d', '3:1:B': 'sku-d' });
  const plan = planReshape(existing, 2, 2);
  check('an unmapped SKU is reported once', plan.skusUnmapped.length === 1,
    plan.skusUnmapped.join(','));
  check('both destroyed faces are counted', plan.assignedLost === 2);
}

console.log('\nReshape — no-op and mixed');
{
  const existing = existingFor(3, 4);
  const plan = planReshape(existing, 3, 4);
  check('reshaping to the same shape is a no-op',
    plan.toCreate.length === 0 && plan.toDeleteIds.length === 0 && plan.assignedLost === 0);
}
{
  // Taller but narrower: creates and destroys in the same operation.
  const existing = existingFor(2, 4, { '1:4:A': 'sku-w' });
  const plan = planReshape(existing, 4, 2);
  check('a mixed reshape both creates and deletes',
    plan.toCreate.length > 0 && plan.toDeleteIds.length > 0,
    `+${plan.toCreate.length} -${plan.toDeleteIds.length}`);
  check('final slot count matches the new shape',
    existing.length - plan.toDeleteIds.length + plan.toCreate.length === slotCount(4, 2));
  check('the lost assignment is reported', plan.skusUnmapped.includes('sku-w'));
}
{
  const plan = planReshape([], 2, 2);
  check('a rack with no slots yet is fully created', plan.toCreate.length === 8);
  check('and destroys nothing', plan.toDeleteIds.length === 0);
}

console.log(`\n${passed} checks passed\n`);
