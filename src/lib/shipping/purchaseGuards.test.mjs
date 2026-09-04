// Proof for the checks that stand between a reviewed plan and spending money. Create Packages
// has no quote step and no cancel, so every one of these runs BEFORE the first purchase and a
// hole in any of them is a wrong charge.
// Run:  node src/lib/shipping/purchaseGuards.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./purchaseGuards.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'pg-')), 'purchaseGuards.mjs');
writeFileSync(outFile, outputText);
const {
  authorizeRun, summarizeSpend, parsePrice,
  MAX_BOXES_PER_RUN, FALLBACK_UNIT_PRICE,
} = await import(pathToFileURL(outFile).href);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

/** An otherwise-valid run of `n` boxes, confirmed correctly. */
const okRun = (n = 10, over = {}) =>
  ({ enabled: true, boxes: n, confirmBoxes: n, ...over });

console.log('\nThe flag is the outermost gate');
{
  const r = authorizeRun(okRun(10, { enabled: false }));
  check('a disabled run is refused', r.ok === false && r.code === 'disabled', r.code);
  // Log-only must win over every other verdict. If a disabled run reported "over_cap" it would
  // read as "lift the cap and it buys", when in fact the flag is off.
  const capped = authorizeRun({ enabled: false, boxes: 99_999, confirmBoxes: 1 });
  check('disabled outranks both the cap and a mismatch',
    capped.ok === false && capped.code === 'disabled', capped.code);
}

console.log('\nThe confirm count is the real approval');
{
  check('a matching count authorises', authorizeRun(okRun(10)).ok === true);
  const missing = authorizeRun({ enabled: true, boxes: 10, confirmBoxes: null });
  check('no confirm_boxes at all is refused',
    missing.ok === false && missing.code === 'confirm_missing', missing.code);

  // THE case this exists for: a show ended or a sync landed between the review and the run, so
  // the plan is no longer the one a human read. Buying it would be buying an unreviewed plan.
  const grew = authorizeRun({ enabled: true, boxes: 11, confirmBoxes: 10 });
  check('a plan that GREW since review is refused',
    grew.ok === false && grew.code === 'confirm_mismatch', grew.code);
  const shrank = authorizeRun({ enabled: true, boxes: 9, confirmBoxes: 10 });
  check('a plan that SHRANK since review is also refused',
    shrank.ok === false && shrank.code === 'confirm_mismatch', shrank.code);
  check('…and the refusal says both numbers, so the operator can see what moved',
    shrank.reason.includes('10') && shrank.reason.includes('9'), shrank.reason);

  // Off-by-one must not be tolerated anywhere near money.
  check('one box of drift is enough to refuse',
    authorizeRun({ enabled: true, boxes: 356, confirmBoxes: 357 }).ok === false);
}

console.log('\nNothing to buy is not an error');
{
  const r = authorizeRun({ enabled: true, boxes: 0, confirmBoxes: 0 });
  check('an empty run is refused as nothing_to_buy, not as a mismatch',
    r.ok === false && r.code === 'nothing_to_buy', r.code);
  check('a negative box count cannot slip through',
    authorizeRun({ enabled: true, boxes: -5, confirmBoxes: -5 }).code === 'nothing_to_buy');
}

console.log('\nThe cap bounds the worst mistake');
{
  check('the cap is 400', MAX_BOXES_PER_RUN === 400);
  check('exactly at the cap is allowed', authorizeRun(okRun(MAX_BOXES_PER_RUN)).ok === true);
  const over = authorizeRun(okRun(MAX_BOXES_PER_RUN + 1));
  check('one over the cap is refused', over.ok === false && over.code === 'over_cap', over.code);
  check('a caller cannot raise the cap by confirming a bigger number',
    authorizeRun({ enabled: true, boxes: 5000, confirmBoxes: 5000 }).code === 'over_cap');
  check('an explicit lower cap is honoured',
    authorizeRun({ enabled: true, boxes: 10, confirmBoxes: 10, cap: 5 }).code === 'over_cap');
}

console.log('\nPrices as TikTok actually returns them');
{
  // The one-box test returned the STRING "$4.10", not a number. Parsing it as-is yields NaN,
  // which would silently poison every later average.
  check('"$4.10" parses to 4.1', parsePrice('$4.10') === 4.1, String(parsePrice('$4.10')));
  check('a bare numeric string parses', parsePrice('4.10') === 4.1);
  check('a real number passes through', parsePrice(6.25) === 6.25);
  check('thousands separators survive', parsePrice('$1,234.50') === 1234.5, String(parsePrice('$1,234.50')));
  check('a currency word does not break it', parsePrice('10 dollar') === 10);
  check('nothing numeric yields null, not NaN', parsePrice('free') === null);
  check('null/undefined yield null', parsePrice(null) === null && parsePrice(undefined) === null);
  check('zero and negatives are rejected as prices',
    parsePrice('$0.00') === null && parsePrice(-3) === null);
  check('NaN is rejected', parsePrice(Number.NaN) === null);
}

console.log('\nSpend is an estimate, and says so');
{
  const empty = summarizeSpend([], 100);
  check('with no ledger it falls back to the measured unit price',
    empty.avg_unit_price === FALLBACK_UNIT_PRICE && empty.basis === 'fallback',
    `${empty.avg_unit_price}/${empty.basis}`);
  check('…and the fallback is the $4.10 the one-box test measured', FALLBACK_UNIT_PRICE === 4.1);
  check('the estimate multiplies out', empty.estimated_total === 410, String(empty.estimated_total));
  check('zero boxes estimate zero', summarizeSpend([], 0).estimated_total === 0);

  const real = summarizeSpend([4, 5, 6], 10);
  check('with a ledger the average is used and labelled',
    real.avg_unit_price === 5 && real.basis === 'ledger' && real.estimated_total === 50,
    `${real.avg_unit_price}/${real.basis}/${real.estimated_total}`);
  check('sample count is reported so a thin average is visible', real.samples === 3);

  // A single NaN in the ledger would otherwise make the whole estimate NaN — an estimate that
  // renders as blank next to a button that spends money.
  const dirty = summarizeSpend([4, Number.NaN, 6, 0, -2, null, undefined], 2);
  check('unusable values are dropped rather than poisoning the average',
    dirty.avg_unit_price === 5 && dirty.samples === 2,
    `${dirty.avg_unit_price}/${dirty.samples}`);
  check('an all-bad ledger degrades to the fallback, not to NaN',
    summarizeSpend([Number.NaN, 0], 5).basis === 'fallback');

  check('money is rounded to cents, never left as float dust',
    summarizeSpend([4.105, 4.105], 3).estimated_total === 12.32,
    String(summarizeSpend([4.105, 4.105], 3).estimated_total));
}

console.log(`\n${passed} checks passed\n`);
