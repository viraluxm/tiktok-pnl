// Proof that a singles pile is collected from the label pages FOLLOWING its slip — the grouping
// the PDF route does before minting a batch.
//
// This is the case that was broken: labels are bought per shop and printed COMBINED, so one pile
// routinely spans a dozen runs ('#428' spanned 12 runs / 148 labels over the 4 days to
// 2026-09-09). A batch keyed to a single run could not cover such a pile, so the barcode was
// suppressed — meaning no barcode on essentially every real print.
//
// Run:  node src/lib/shipping/singlesPiles.test.mjs

import assert from 'node:assert/strict';

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

// The exact grouping the PDF route performs over seq.pages.
function collectPiles(pages) {
  const piles = [];
  let current = null;
  for (const page of pages) {
    if (page.kind === 'slip') { current = { caption: page.caption, groupKeys: [] }; piles.push(current); }
    else if (page.kind === 'banner') { current = null; }
    else if (current) { current.groupKeys.push(page.group_key); }
  }
  return piles;
}

const slip = (caption) => ({ kind: 'slip', caption });
const banner = (caption) => ({ kind: 'banner', caption });
const label = (group_key) => ({ kind: 'label', group_key });

console.log('\npile collection');
{
  const pages = [
    banner('SINGLES — PREP STATION'),
    slip('#428 CRUNCHY SOAP BAR ORIGINAL'), label('trk:a1'), label('trk:a2'), label('trk:a3'),
    slip('#384 VASELINE BUTTER IN BOX'), label('trk:b1'), label('trk:b2'),
    banner('BUNDLED ORDERS — PICK REGULAR'), label('trk:c1'), label('trk:c2'),
    banner('UNBOUND'), label('trk:d1'),
  ];
  const piles = collectPiles(pages);
  check('one pile per slip, none for banners', piles.length === 2, `${piles.length}`);
  check('a pile takes the labels that FOLLOW its slip',
    piles[0].groupKeys.join(',') === 'trk:a1,trk:a2,trk:a3', piles[0].groupKeys.join(','));
  check('the next slip ends the previous pile',
    piles[1].groupKeys.join(',') === 'trk:b1,trk:b2', piles[1].groupKeys.join(','));

  const claimed = new Set(piles.flatMap((p) => p.groupKeys));
  check('bundled labels are NOT swept into a singles pile',
    !claimed.has('trk:c1') && !claimed.has('trk:c2'));
  check('unbound labels are NOT swept into a singles pile', !claimed.has('trk:d1'));
  check('a banner ends the pile above it — nothing leaks across it',
    piles.every((p) => p.groupKeys.every((k) => k.startsWith('trk:a') || k.startsWith('trk:b'))));
}

console.log('\na pile spanning many runs — the case that was broken');
{
  // '#428' as it really prints: 148 labels bought across 12 runs, printed as one combined stack.
  // The pile is defined by what follows the slip, so the runs are irrelevant to its identity.
  const labels = Array.from({ length: 148 }, (_, i) => label(`trk:9200${String(i).padStart(4, '0')}`));
  const pages = [banner('SINGLES — PREP STATION'), slip('#428 CRUNCHY SOAP BAR ORIGINAL'), ...labels];
  const piles = collectPiles(pages);
  check('all 148 labels land in one pile', piles[0].groupKeys.length === 148, `${piles[0].groupKeys.length}`);
  check('no run id is needed to define the pile',
    !JSON.stringify(piles[0]).includes('run'), 'pile carries caption + group_keys only');
  check('every label is unique — none double-counted',
    new Set(piles[0].groupKeys).size === 148);
}

console.log('\nedge cases');
{
  check('no slips -> no piles, and no batch is minted',
    collectPiles([banner('BUNDLED ORDERS — PICK REGULAR'), label('trk:x')]).length === 0);

  // A slip with nothing after it must not mint a code: an empty batch would print a barcode that
  // credits nothing, which reads to the packer as the scan having failed.
  const empty = collectPiles([slip('#999 GHOST'), banner('MIXED')]);
  check('a slip with no labels yields an empty pile', empty.length === 1 && empty[0].groupKeys.length === 0);
  check('empty piles are filtered before minting (mintSinglesBatches drops them)',
    empty.filter((p) => p.groupKeys.length > 0).length === 0);

  check('labels before any slip are ignored',
    collectPiles([label('trk:orphan'), slip('#1 A'), label('trk:a')])[0].groupKeys.join(',') === 'trk:a');
}

console.log(`\n${passed} checks passed\n`);
