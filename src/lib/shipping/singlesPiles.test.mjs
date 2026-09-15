// Proof that a singles pile is collected from the label pages FOLLOWING its slip, and that the
// part window used to deliver the PDF cannot change what a pile contains.
//
// This file IMPORTS the real singlesPiles.ts. It previously carried its own copy of the grouping,
// which is why the part-boundary defect shipped green: the copy was correct and the route was not.
// A test that reimplements the thing it is testing only ever proves the copy.
//
// Two defects are pinned here, both live on 2026-09-13:
//   * a pile split across a part boundary minted a batch holding only the labels sharing a part
//     with its slip — the paper said 6 LABELS, the barcode credited 2;
//   * a part opening mid-pile carried no slip, so its labels joined no pile at all and were
//     uncreditable by any barcode in the building.
//
// Run:  node src/lib/shipping/singlesPiles.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'singlesPiles.ts'), 'utf8');
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { collectPiles, sliceToPart, planDelivery } = await import(
  'data:text/javascript,' + encodeURIComponent(js)
);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

const slip = (caption, count) => ({ kind: 'slip', caption, count });
const banner = (caption, count) => ({ kind: 'banner', caption, count });
const label = (group_key) => ({ kind: 'label', group_key });

console.log('\npile collection');
{
  const pages = [
    banner('SINGLES — PREP STATION', 5),
    slip('#428 CRUNCHY SOAP BAR ORIGINAL', 3), label('a1'), label('a2'), label('a3'),
    slip('#309 JUMBO GREY SHARK', 2), label('b1'), label('b2'),
    banner('MIXED', 1), label('m1'),
  ];
  const piles = collectPiles(pages);
  check('one pile per slip', piles.length === 2);
  check('a pile holds the labels following its slip',
    piles[0].groupKeys.join(',') === 'a1,a2,a3');
  check('a banner ends the pile above it — mixed labels join no pile',
    piles[1].groupKeys.join(',') === 'b1,b2');
  check('every slip count matches its pile',
    pages.filter((p) => p.kind === 'slip').every((s, i) => s.count === piles[i].groupKeys.length));
}

console.log('\na pile spanning a part boundary — the 2026-09-13 defect');
{
  // '#309 JUMBO GREY SHARK': 6 labels, the boundary falling after the second.
  const pages = [
    banner('SINGLES — PREP STATION', 6),
    slip('#309 JUMBO GREY SHARK', 6),
    label('g1'), label('g2'), label('g3'), label('g4'), label('g5'), label('g6'),
  ];

  const whole = collectPiles(pages);
  check('the pile is all six', whole[0].groupKeys.length === 6);

  const part1 = sliceToPart(pages, 0, 1);
  const part2 = sliceToPart(pages, 2, 5);
  check('part 1 carries the slip', part1.some((p) => p.kind === 'slip'));
  check('part 2 opens mid-pile and carries NO slip', !part2.some((p) => p.kind === 'slip'));

  // The defect, reproduced: collecting from the delivered parts loses boxes.
  const fromParts = [...collectPiles(part1), ...collectPiles(part2)]
    .reduce((n, p) => n + p.groupKeys.length, 0);
  check('collecting from the sliced parts strands boxes — 2 of 6, the shipped bug',
    fromParts === 2, `${fromParts} of 6`);

  // The fix: collect from the whole document, slice only for delivery.
  check('collecting from the whole document keeps all six', whole[0].groupKeys.length === 6);
  check('and the slip’s printed count agrees with the batch it mints',
    pages.find((p) => p.kind === 'slip').count === whole[0].groupKeys.length);
}

console.log('\nthe part window itself is unchanged');
{
  const pages = [
    banner('SINGLES — PREP STATION', 4),
    slip('#1 A', 2), label('a1'), label('a2'),
    slip('#2 B', 2), label('b1'), label('b2'),
  ];
  check('a full window returns the document untouched',
    sliceToPart(pages, 0, 3) === pages);
  check('a window starting on a slip boundary carries its headers',
    sliceToPart(pages, 2, 3).filter((p) => p.kind === 'slip').length === 1);
  check('a label’s pages are never split — every part is whole labels',
    sliceToPart(pages, 1, 2).filter((p) => p.kind === 'label')
      .map((p) => p.group_key).join(',') === 'a2,b1');
  check('an empty document is returned as-is', sliceToPart([], 0, 0).length === 0);
}

console.log('\nplanDelivery — piles and part derived from one input');
{
  const pages = [
    banner('SINGLES — PREP STATION', 6),
    slip('#309 JUMBO GREY SHARK', 6),
    label('g1'), label('g2'), label('g3'), label('g4'), label('g5'), label('g6'),
  ];
  // Every part of the same document must agree on what the pile contains — that is what lets a
  // packer scan one slip and be credited the stack they actually built.
  const counts = [[0, 1], [2, 5], [0, 5]].map(([f, t]) => {
    const d = planDelivery(pages, f, t);
    return d.piles.reduce((n, p) => n + p.groupKeys.length, 0);
  });
  check('part 1, part 2 and the whole print all mint the same 6-label pile',
    counts.every((n) => n === 6), counts.join(' / '));

  const mid = planDelivery(pages, 2, 5);
  check('while the part delivered is still only its own labels',
    mid.pages.filter((p) => p.kind === 'label').length === 4);
}

console.log(`\n${passed} checks passed\n`);
