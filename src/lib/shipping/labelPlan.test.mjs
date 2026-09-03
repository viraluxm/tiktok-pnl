// Proof for the label print plan: which boxes batch, which deliberately do not, and the page
// sequence a printer receives.
// Run:  node src/lib/shipping/labelPlan.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./labelPlan.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'lp-')), 'labelPlan.mjs');
writeFileSync(outFile, outputText);
const { buildLabelPlan, planPageSequence, isBatchable, slipCaption, MIN_BATCH_SIZE } =
  await import(pathToFileURL(outFile).href);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

const sku = (id, n, title, qty = 1) =>
  ({ inventory_sku_id: id, sku_number: n, title, qty });
/** A box. `orders` defaults to one order named after the group. */
const box = (key, skus, orders = [key]) => ({ group_key: key, order_ids: orders, skus });

console.log('\nWhat batches, and what deliberately does not');
{
  check('one SKU, one unit → batchable',
    isBatchable(box('b1', [sku('s1', 248, 'Pumpkin Glitter')])) === true);
  // The rule that costs 1.6% of volume to keep the other 47.7% mechanical.
  check('one SKU, THREE units → NOT batchable (breaks the one-per-label loop)',
    isBatchable(box('b2', [sku('s1', 248, 'Pumpkin Glitter', 3)])) === false);
  check('two SKUs → not batchable',
    isBatchable(box('b3', [sku('s1', 248, 'A'), sku('s2', 249, 'B')])) === false);
  check('a box with no SKU lines is not batchable',
    isBatchable(box('b4', [])) === false);
}

console.log('\nGrouping');
{
  const plan = buildLabelPlan([
    box('a', [sku('cheese', 401, 'Large Cheese')]),
    box('b', [sku('pump', 248, 'Pumpkin Glitter')]),
    box('c', [sku('cheese', 401, 'Large Cheese')]),
    box('d', [sku('pump', 248, 'Pumpkin Glitter')]),
    box('e', [sku('pump', 248, 'Pumpkin Glitter')]),
    box('f', [sku('x', 1, 'A'), sku('y', 2, 'B')]),          // bundle
    box('g', [sku('cheese', 401, 'Large Cheese', 2)]),        // multi-unit → bundle
  ]);
  check('two SKU batches formed', plan.batches.length === 2, String(plan.batches.length));
  check('the bigger batch prints first',
    plan.batches[0].sku_number === 248 && plan.batches[0].boxes.length === 3,
    `${plan.batches[0].sku_number} × ${plan.batches[0].boxes.length}`);
  check('the smaller batch survives at 2 boxes', plan.batches[1].boxes.length === 2);
  check('the multi-SKU box AND the multi-unit box are both bundles',
    plan.bundles.length === 2 && plan.bundles.map((b) => b.group_key).sort().join(',') === 'f,g');
  check('batched count excludes bundles', plan.batchedBoxes === 5, String(plan.batchedBoxes));
  check('total boxes counts everything', plan.totalBoxes === 7);
}
{
  // The box is the unit, not the order — 159 orders collapsed to 62 boxes on the real test set.
  const plan = buildLabelPlan([
    box('combined', [sku('s1', 1, 'A')], ['o1', 'o2', 'o3']),
    box('single', [sku('s1', 1, 'A')], ['o4']),
  ]);
  check('one label per BOX, not per order', plan.totalBoxes === 2);
  check('…while orders are counted separately', plan.totalOrders === 4, String(plan.totalOrders));
}
{
  const plan = buildLabelPlan([
    box('a1', [sku('s1', 5, 'A')]), box('a2', [sku('s1', 5, 'A')]),
    box('b1', [sku('s2', 3, 'B')]), box('b2', [sku('s2', 3, 'B')]),
  ]);
  check('equal-sized batches tie-break on SKU number',
    plan.batches.map((b) => b.sku_number).join(',') === '3,5',
    plan.batches.map((b) => b.sku_number).join(','));
}

console.log('\nA group of one is not a batch');
{
  check('the threshold is 2', MIN_BATCH_SIZE === 2);
  const plan = buildLabelPlan([
    box('p1', [sku('p', 248, 'Pumpkin')]),
    box('p2', [sku('p', 248, 'Pumpkin')]),
    box('lone', [sku('solo', 999, 'Only One')]),
  ]);
  check('a 2-box group is still a batch', plan.batches.length === 1 && plan.batches[0].sku_number === 248);
  check('a 1-box group is demoted to mixed, not given its own slip',
    plan.bundles.map((b) => b.group_key).join(',') === 'lone',
    plan.bundles.map((b) => b.group_key).join(','));
  check('no slip announces the lone box',
    !planPageSequence(plan).some((p) => p.kind === 'slip' && p.caption.includes('999')));
  check('batchedBoxes counts only real batches, not the demoted one',
    plan.batchedBoxes === 2, String(plan.batchedBoxes));
  check('but the lone box is still printed', plan.totalBoxes === 3
    && planPageSequence(plan).filter((p) => p.kind === 'label').length === 3);
}
{
  // The Snore test set: 7 single-box groups. All demoted → one mixed slip, not seven.
  const many = Array.from({ length: 7 }, (_, i) => box(`b${i}`, [sku(`s${i}`, 300 + i, `T${i}`)]));
  const plan = buildLabelPlan(many);
  check('7 singleton groups produce ZERO batches', plan.batches.length === 0);
  const slips = planPageSequence(plan).filter((p) => p.kind === 'slip');
  check('…and exactly one slip instead of seven', slips.length === 1, String(slips.length));
  check('…which names the action', slips[0].caption === 'MIXED — READ EACH LABEL', slips[0].caption);
}

console.log('\nSlip captions');
{
  check('caption is number + upper-cased title',
    slipCaption(248, 'Pumpkin Glitter') === '#248 PUMPKIN GLITTER',
    slipCaption(248, 'Pumpkin Glitter'));
  check('a missing SKU number degrades rather than crashing',
    slipCaption(null, 'Mystery') === '#? MYSTERY');
  check('a missing title leaves just the number', slipCaption(7, '') === '#7');
  check('surrounding whitespace is trimmed',
    slipCaption(9, '  Spaced  ') === '#9 SPACED');
}

console.log('\nPage sequence');
{
  const plan = buildLabelPlan([
    box('a', [sku('p', 248, 'Pumpkin')]),
    box('b', [sku('p', 248, 'Pumpkin')]),
    box('c', [sku('d', 198, 'Dumpling')]),
    box('z', [sku('x', 1, 'A'), sku('y', 2, 'B')]),
  ]);
  const seq = planPageSequence(plan);
  const shape = seq.map((p) => (p.kind === 'slip' ? `SLIP(${p.caption}|${p.count})` : `L(${p.group_key})`));
  // #198 has one box, so it is demoted into mixed alongside the bundle rather than getting a slip.
  check('every real batch is preceded by its slip, and singletons are not',
    shape.join(' ') === 'SLIP(#248 PUMPKIN|2) L(a) L(b) SLIP(MIXED — READ EACH LABEL|2) L(c) L(z)',
    shape.join(' '));
  check('every box appears exactly once',
    seq.filter((p) => p.kind === 'label').length === 4);
  check('slip counts match their section sizes',
    seq.filter((p) => p.kind === 'slip').map((s) => s.count).join(',') === '2,2');
}
{
  // Bundles get their own slip. Without it the first bundle label reads as part of the last
  // SKU batch — the confusion slips exist to prevent.
  const plan = buildLabelPlan([box('z', [sku('x', 1, 'A'), sku('y', 2, 'B')])]);
  const seq = planPageSequence(plan);
  check('a mixed-only run still opens with a slip',
    seq[0].kind === 'slip' && seq[0].caption === 'MIXED — READ EACH LABEL');
}
{
  const plan = buildLabelPlan([box('a', [sku('p', 1, 'A')]), box('b', [sku('p', 1, 'A')])]);
  const seq = planPageSequence(plan);
  check('no mixed slip when everything batches',
    !seq.some((p) => p.kind === 'slip' && p.caption.startsWith('MIXED')));
}
{
  const plan = buildLabelPlan([]);
  check('an empty run plans nothing',
    plan.batches.length === 0 && plan.bundles.length === 0 && plan.totalBoxes === 0);
  check('…and produces no pages', planPageSequence(plan).length === 0);
}

console.log('\nDeterminism — a reviewed dry run must print in the reviewed order');
{
  const boxes = [
    box('c', [sku('p', 248, 'Pumpkin')]), box('a', [sku('p', 248, 'Pumpkin')]),
    box('b', [sku('d', 198, 'Dumpling')]), box('z', [sku('x', 1, 'A'), sku('y', 2, 'B')]),
  ];
  const one = planPageSequence(buildLabelPlan(boxes));
  const two = planPageSequence(buildLabelPlan(boxes.slice().reverse()));
  check('input order does not change the page sequence',
    JSON.stringify(one) === JSON.stringify(two));
  check('boxes within a section are in a stable order',
    one.filter((p) => p.kind === 'label').map((p) => p.group_key).join(',') === 'a,c,b,z',
    one.filter((p) => p.kind === 'label').map((p) => p.group_key).join(','));
}

console.log(`\n${passed} checks passed\n`);
