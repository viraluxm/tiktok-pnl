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
const { buildLabelPlan, planPageSequence, isSingleSku, slipCaption, sectionKeyOf, UNBOUND_CAPTION } =
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

console.log('\nMixed means TWO OR MORE SKUs, and nothing else');
{
  check('one SKU, one unit → gets a SKU header',
    isSingleSku(box('b1', [sku('s1', 248, 'Pumpkin Glitter')])) === true);
  // Corrected rule. Units decide WHICH header a box goes under, not whether it gets one: a
  // 3-unit order of one SKU is still one SKU, and burying it in mixed made the packer read a
  // label that says exactly what its own header could have said.
  check('one SKU, THREE units → still a SKU header, not mixed',
    isSingleSku(box('b2', [sku('s1', 248, 'Pumpkin Glitter', 3)])) === true);
  check('two SKUs → mixed, because the label must be read',
    isSingleSku(box('b3', [sku('s1', 248, 'A'), sku('s2', 249, 'B')])) === false);
  check('a box with no SKU lines is mixed',
    isSingleSku(box('b4', [])) === false);
  // Zero units is corrupt data. A label that must be read is the safe outcome.
  check('one SKU but zero units is mixed, not a phantom section',
    isSingleSku(box('b5', [sku('s1', 248, 'A', 0)])) === false);
}

console.log('\nUnits split the sections, so every pile is uniform');
{
  const one = box('a', [sku('s1', 248, 'Pumpkin')]);
  const three = box('b', [sku('s1', 248, 'Pumpkin', 3)]);
  check('same SKU, different units → DIFFERENT sections',
    sectionKeyOf(one) !== sectionKeyOf(three), `${sectionKeyOf(one)} vs ${sectionKeyOf(three)}`);
  check('same SKU, same units → same section',
    sectionKeyOf(one) === sectionKeyOf(box('c', [sku('s1', 248, 'Pumpkin')])));

  const plan = buildLabelPlan([one, three, box('d', [sku('s1', 248, 'Pumpkin')])]);
  check('two sections form for one SKU', plan.batches.length === 2, String(plan.batches.length));
  const single = plan.batches.find((b) => b.boxes.length === 2);
  const multi = plan.batches.find((b) => b.boxes.length === 1);
  check('the one-unit section carries no per-box count',
    single.slip === '#248 PUMPKIN', single.slip);
  // Without this the packer working the pile puts one item in and under-ships the 3-unit order.
  check('the multi-unit section STATES the count',
    multi.slip === '#248 PUMPKIN — 3 PER BOX', multi.slip);
  check('multi-unit boxes are counted', plan.multiUnitBoxes === 1, String(plan.multiUnitBoxes));
  check('nothing went to mixed', plan.bundles.length === 0);
}

console.log('\nGrouping');
{
  const plan = buildLabelPlan([
    box('a', [sku('cheese', 401, 'Large Cheese')]),
    box('b', [sku('pump', 248, 'Pumpkin Glitter')]),
    box('c', [sku('cheese', 401, 'Large Cheese')]),
    box('d', [sku('pump', 248, 'Pumpkin Glitter')]),
    box('e', [sku('pump', 248, 'Pumpkin Glitter')]),
    box('f', [sku('x', 1, 'A'), sku('y', 2, 'B')]),          // 2 SKUs -> mixed
    box('g', [sku('cheese', 401, 'Large Cheese', 2)]),        // 1 SKU, 2 units -> own section
  ]);
  check('three sections form: pumpkin, cheese x1, cheese x2',
    plan.batches.length === 3, String(plan.batches.length));
  check('the bigger batch prints first',
    plan.batches[0].sku_number === 248 && plan.batches[0].boxes.length === 3,
    `${plan.batches[0].sku_number} × ${plan.batches[0].boxes.length}`);
  check('the smaller batch survives at 2 boxes', plan.batches[1].boxes.length === 2);
  check('ONLY the multi-SKU box is mixed — the multi-unit one keeps its SKU',
    plan.bundles.map((b) => b.group_key).join(',') === 'f', plan.bundles.map((b) => b.group_key).join(','));
  check('the multi-unit cheese gets its own counted header',
    plan.batches.some((b) => b.slip === '#401 LARGE CHEESE — 2 PER BOX'),
    plan.batches.map((b) => b.slip).join(' | '));
  check('every single-SKU box counts as headed', plan.batchedBoxes === 6, String(plan.batchedBoxes));
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

console.log('\nA section of ONE still gets its header');
{
  // THE CORRECTION. A lone "#999 ONLY ONE" tells the packer what to grab without reading the
  // label; demoting it to mixed forced exactly the read this feature exists to remove. Paper
  // is cheaper than a misread.
  const plan = buildLabelPlan([
    box('p1', [sku('p', 248, 'Pumpkin')]),
    box('p2', [sku('p', 248, 'Pumpkin')]),
    box('lone', [sku('solo', 999, 'Only One')]),
  ]);
  check('the two-box section is a section', plan.batches.some((b) => b.sku_number === 248));
  check('the ONE-box section is also a section, not mixed',
    plan.batches.some((b) => b.sku_number === 999), plan.batches.map((b) => b.slip).join(' | '));
  check('nothing is mixed here at all', plan.bundles.length === 0);
  const slips = planPageSequence(plan).filter((p) => p.kind === 'slip');
  check('the lone box IS announced by name',
    slips.some((p) => p.caption === '#999 ONLY ONE'), slips.map((s) => s.caption).join(' | '));
  check('…and its slip says one label', slips.find((p) => p.caption === '#999 ONLY ONE').count === 1);
  check('single-box sections are counted for honesty about batching',
    plan.singleBoxSections === 1, String(plan.singleBoxSections));
  check('every box is still printed exactly once', plan.totalBoxes === 3
    && planPageSequence(plan).filter((p) => p.kind === 'label').length === 3);
}
{
  // The Snore test set: 7 single-box groups. Seven headers now, not one mixed pile.
  const many = Array.from({ length: 7 }, (_, i) => box(`b${i}`, [sku(`s${i}`, 300 + i, `T${i}`)]));
  const plan = buildLabelPlan(many);
  check('7 lone single-SKU boxes produce 7 sections', plan.batches.length === 7);
  const slips = planPageSequence(plan).filter((p) => p.kind === 'slip');
  check('…and 7 named slips, no mixed pile', slips.length === 7 && plan.bundles.length === 0,
    String(slips.length));
  check('…each naming its own SKU',
    slips.map((s) => s.caption).sort().join(',') ===
      Array.from({ length: 7 }, (_, i) => `#${300 + i} T${i}`).sort().join(','),
    slips.map((s) => s.caption).join(' | '));
  check('all 7 are single-box sections', plan.singleBoxSections === 7);
}
{
  // The real 5-label test run: 3 single-SKU boxes and 2 combine groups holding 2-3 SKUs.
  const plan = buildLabelPlan([
    box('g302', [sku('s302', 302, 'Jumbo UV Color Changing Strawberry')]),
    box('g306', [sku('s306', 306, 'XL Peanut in bag')]),
    box('g405', [sku('s405', 405, 'Green Halloween Cube')]),
    box('gA', [sku('x', 1, 'A'), sku('y', 2, 'B'), sku('z', 3, 'C')], ['o1', 'o2']),
    box('gB', [sku('x', 1, 'A'), sku('y', 2, 'B')], ['o3', 'o4']),
  ]);
  check('the three single-SKU boxes each get a header', plan.batches.length === 3);
  check('only the two combine groups are mixed',
    plan.bundles.map((b) => b.group_key).join(',') === 'gA,gB');
  const shape = planPageSequence(plan)
    .map((p) => (p.kind === 'slip' ? `SLIP(${p.caption})` : 'L')).join(' ');
  check('the stack reads as four sections, not one mixed pile',
    shape === 'SLIP(#302 JUMBO UV COLOR CHANGING STRAWBERRY) L SLIP(#306 XL PEANUT IN BAG) L '
           + 'SLIP(#405 GREEN HALLOWEEN CUBE) L SLIP(MIXED — READ EACH LABEL) L L', shape);
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
  check('one unit adds nothing', slipCaption(248, 'Pumpkin', 1) === '#248 PUMPKIN');
  check('more than one unit states the per-box count',
    slipCaption(248, 'Pumpkin', 4) === '#248 PUMPKIN — 4 PER BOX', slipCaption(248, 'Pumpkin', 4));
  check('the count survives a missing title', slipCaption(7, '', 2) === '#7 — 2 PER BOX',
    slipCaption(7, '', 2));
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
  // #198 has one box and STILL gets its own slip — only the 2-SKU box 'z' is mixed.
  check('every section is preceded by its slip, single-box ones included',
    shape.join(' ') === 'SLIP(#248 PUMPKIN|2) L(a) L(b) SLIP(#198 DUMPLING|1) L(c) '
      + 'SLIP(MIXED — READ EACH LABEL|1) L(z)',
    shape.join(' '));
  check('every box appears exactly once',
    seq.filter((p) => p.kind === 'label').length === 4);
  check('slip counts match their section sizes',
    seq.filter((p) => p.kind === 'slip').map((s) => s.count).join(',') === '2,1,1');
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

console.log('\nA box with NO SKU is its own third case, not a bundle');
{
  const plan = buildLabelPlan([
    box('a', [sku('p', 248, 'Pumpkin')]),
    box('a2', [sku('p', 248, 'Pumpkin')]),
    box('mix', [sku('x', 1, 'A'), sku('y', 2, 'B')]),
    box('nosku', []),
    box('nosku2', []),
  ]);
  check('unbound boxes are separated from bundles',
    plan.unbound.map((b) => b.group_key).join(',') === 'nosku,nosku2',
    plan.unbound.map((b) => b.group_key).join(','));
  // THE point. A bundle's label says what to pack; an unbound label says nothing and has to be
  // looked up by hand. Mixing them hides that inside a pile the packer thinks they can work.
  check('…and mixed holds ONLY the real bundle',
    plan.bundles.map((b) => b.group_key).join(',') === 'mix');
  const seq = planPageSequence(plan);
  const shape = seq.map((p) => (p.kind === 'slip' ? `SLIP(${p.caption}|${p.count})` : `L(${p.group_key})`));
  check('unbound prints LAST, behind its own header',
    shape.join(' ') === 'SLIP(#248 PUMPKIN|2) L(a) L(a2) SLIP(MIXED — READ EACH LABEL|1) L(mix) '
      + `SLIP(${UNBOUND_CAPTION}|2) L(nosku) L(nosku2)`,
    shape.join(' '));
  check('the header names the WORK, since the contents are what is unknown',
    UNBOUND_CAPTION.includes('LOOK UP'), UNBOUND_CAPTION);
  check('every box is still printed exactly once',
    seq.filter((p) => p.kind === 'label').length === 5);
}
{
  const plan = buildLabelPlan([box('n1', []), box('n2', [])]);
  const seq = planPageSequence(plan);
  check('an all-unbound run still opens with the unbound header',
    seq[0].kind === 'slip' && seq[0].caption === UNBOUND_CAPTION);
  check('…and no phantom mixed slip appears',
    !seq.some((p) => p.kind === 'slip' && p.caption.startsWith('MIXED')));
  check('unbound boxes are not counted as headed', plan.batchedBoxes === 0);
}
{
  check('no unbound section when everything has a SKU',
    buildLabelPlan([box('a', [sku('p', 1, 'A')])]).unbound.length === 0);
  check('an empty run has an empty unbound section',
    buildLabelPlan([]).unbound.length === 0);
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
