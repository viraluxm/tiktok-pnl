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
  authorizeRun, summarizeSpend, parsePrice, summarizeLedgerSpend,
  MAX_MANIFEST_BOXES, FALLBACK_UNIT_PRICE,
} = await import(pathToFileURL(outFile).href);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

/** An otherwise-valid run of `n` boxes: confirmed correctly, with a limit that covers them. */
const okRun = (n = 10, over = {}) =>
  ({ enabled: true, boxes: n, confirmBoxes: n, unboundCount: 0, unboundPolicy: null, ...over });

console.log('\nThe flag is the outermost gate');
{
  const r = authorizeRun(okRun(10, { enabled: false }));
  check('a disabled run is refused', r.ok === false && r.code === 'disabled', r.code);
  // Log-only must win over every other verdict. If a disabled run reported "over_cap" it would
  // read as "lift the cap and it buys", when in fact the flag is off.
  const capped = authorizeRun({ enabled: false, boxes: 99_999, confirmBoxes: 1, unboundCount: 0, unboundPolicy: null });
  check('disabled outranks both the cap and a mismatch',
    capped.ok === false && capped.code === 'disabled', capped.code);
}

console.log('\nThe confirm count is the real approval');
{
  const good = authorizeRun(okRun(10));
  check('a matching count authorises, and says how many to buy',
    good.ok === true && good.buy === 10, String(good.buy ?? good.code));
  const missing = authorizeRun({ enabled: true, boxes: 10, confirmBoxes: null, unboundCount: 0, unboundPolicy: null });
  check('no confirm_boxes at all is refused',
    missing.ok === false && missing.code === 'confirm_missing', missing.code);

  // THE case this exists for: a show ended or a sync landed between the review and the run, so
  // the plan is no longer the one a human read. Buying it would be buying an unreviewed plan.
  const grew = authorizeRun({ enabled: true, boxes: 11, confirmBoxes: 10, unboundCount: 0, unboundPolicy: null });
  check('a plan that GREW since review is refused',
    grew.ok === false && grew.code === 'confirm_mismatch', grew.code);
  const shrank = authorizeRun({ enabled: true, boxes: 9, confirmBoxes: 10, unboundCount: 0, unboundPolicy: null });
  check('a plan that SHRANK since review is also refused',
    shrank.ok === false && shrank.code === 'confirm_mismatch', shrank.code);
  check('…and the refusal says both numbers, so the operator can see what moved',
    shrank.reason.includes('10') && shrank.reason.includes('9'), shrank.reason);

  // Off-by-one must not be tolerated anywhere near money.
  check('one box of drift is enough to refuse',
    authorizeRun({ enabled: true, boxes: 356, confirmBoxes: 357, unboundCount: 0, unboundPolicy: null }).ok === false);
}

console.log('\nNothing to buy is not an error');
{
  const r = authorizeRun({ enabled: true, boxes: 0, confirmBoxes: 0, unboundCount: 0, unboundPolicy: null });
  check('an empty run is refused as nothing_to_buy, not as a mismatch',
    r.ok === false && r.code === 'nothing_to_buy', r.code);
  check('a negative box count cannot slip through',
    authorizeRun({ enabled: true, boxes: -5, confirmBoxes: -5, unboundCount: 0, unboundPolicy: null }).code === 'nothing_to_buy');
}

console.log('\nSCOPE bounds a run now, not a per-call limit');
{
  // The old model required a `limit` on every call so one click could not buy everything. That
  // was replaced deliberately: a fulfilment day is 474-863 boxes and the operator asked NOT to
  // split a day across approvals. The bound is now the SCOPE (a day, or named shows) plus a
  // confirm count, and the authorised manifest is drained without further approval.
  const r = authorizeRun(okRun(593));
  check('a whole fulfilment day authorises in one act',
    r.ok === true && r.buy === 593, String(r.buy ?? r.code));
  check('the busiest measured day (863 boxes) still fits', authorizeRun(okRun(863)).ok === true);
}

console.log('\nThe ceiling is a sanity backstop, not the control');
{
  check('the ceiling is 1500', MAX_MANIFEST_BOXES === 1500);
  check('exactly at the ceiling is allowed', authorizeRun(okRun(MAX_MANIFEST_BOXES)).ok === true);
  const over = authorizeRun(okRun(MAX_MANIFEST_BOXES + 1));
  check('one over is refused', over.ok === false && over.code === 'over_cap', over.code);
  check('…and the refusal says how to fix it, not just that it failed',
    over.reason.includes('narrow the scope'), over.reason);
  check('an explicit lower ceiling is honoured',
    authorizeRun({ enabled: true, boxes: 10, confirmBoxes: 10, unboundCount: 0,
      unboundPolicy: null, cap: 5 }).code === 'over_cap');
}

console.log('\nRefusal order — the cheapest, safest verdict wins');
{
  // A stale plan is reported before the unbound question: answering it against a plan nobody
  // reviewed is meaningless.
  const stale = authorizeRun({ enabled: true, boxes: 20, confirmBoxes: 10,
    unboundCount: 3, unboundPolicy: null });
  check('a stale plan outranks the unbound question', stale.code === 'confirm_mismatch', stale.code);
  // The unbound question comes before the ceiling, since the answer changes the box count.
  const both = authorizeRun({ enabled: true, boxes: 9_999, confirmBoxes: 9_999,
    unboundCount: 3, unboundPolicy: null });
  check('the unbound question comes before the ceiling', both.code === 'unbound_present', both.code);
  check('the flag still outranks everything',
    authorizeRun({ enabled: false, boxes: 9_999, confirmBoxes: 1,
      unboundCount: 3, unboundPolicy: null }).code === 'disabled');
}

console.log('\nUnbound boxes must be answered, never assumed');
{
  // Unbound is usually a TIMING state — the team binds shortly after a show — so the right
  // answer is normally "wait and re-run". A job that picked for you would either leave those
  // orders unshipped or buy labels nobody can pick from. Both are worse than being asked.
  const unanswered = authorizeRun(okRun(20, { unboundCount: 3 }));
  check('a run with unbound boxes and no answer is refused',
    unanswered.ok === false && unanswered.code === 'unbound_present', unanswered.code);
  check('…and the refusal states how many', unanswered.reason.includes('3 box'), unanswered.reason);
  check('…and offers all three ways out',
    unanswered.reason.includes('check again') && unanswered.reason.includes('skip')
      && unanswered.reason.includes('include'), unanswered.reason);
  check('…and warns what include actually means for the picker',
    unanswered.reason.includes('looked up by hand'), unanswered.reason);

  check('skip authorises', authorizeRun(okRun(20, { unboundCount: 3, unboundPolicy: 'skip' })).ok === true);
  check('include authorises', authorizeRun(okRun(20, { unboundCount: 3, unboundPolicy: 'include' })).ok === true);
  // The common case: nothing unbound, so the question never fires.
  check('zero unbound needs no answer at all', authorizeRun(okRun(20)).ok === true);
}
{
  // Order matters: a stale plan must be reported before the unbound question, because the
  // answer to the question is meaningless against a plan nobody reviewed.
  const stale = authorizeRun({ enabled: true, boxes: 20, confirmBoxes: 10,
    unboundCount: 3, unboundPolicy: null });
  check('a stale plan outranks the unbound question', stale.code === 'confirm_mismatch', stale.code);
  // And the unbound question comes BEFORE limit, since the answer changes what the run holds.
  const noLimit = authorizeRun({ enabled: true, boxes: 20, confirmBoxes: 20,
    unboundCount: 3, unboundPolicy: null });
  check('the unbound question comes before the limit question',
    noLimit.code === 'unbound_present', noLimit.code);
  check('the flag still outranks everything',
    authorizeRun({ enabled: false, boxes: 20, confirmBoxes: 20,
      unboundCount: 3, unboundPolicy: null }).code === 'disabled');
}

console.log('\nRolling spend, from the ledger');
{
  const NOW = Date.parse('2026-09-04T12:00:00Z');
  const DAY = 86_400_000;
  const row = (daysAgo, price) =>
    ({ price_amount: price, purchased_at: new Date(NOW - daysAgo * DAY).toISOString() });

  const w = summarizeLedgerSpend(
    [row(1, 4.1), row(3, 4.75), row(10, 4), row(29, 5), row(45, 100)], NOW, 21.36);
  check('the run total is carried through', w.run_total === 21.36, String(w.run_total));
  check('7d counts only the last week',
    w.last_7d.labels === 2 && w.last_7d.spent === 8.85, JSON.stringify(w.last_7d));
  check('30d includes the older ones but not the 45-day-old',
    w.last_30d.labels === 4 && w.last_30d.spent === 17.85, JSON.stringify(w.last_30d));
  check('the $100 outside the window is excluded', w.last_30d.spent < 100);

  // The "already purchased at TikTok" rows: a real label whose price was never ours to see.
  // Counting them as zero labels would undercount the work; inventing a price would overstate.
  const nullPrice = summarizeLedgerSpend([row(1, null), row(1, 4)], NOW);
  check('a null-priced label still counts as a label',
    nullPrice.last_7d.labels === 2, String(nullPrice.last_7d.labels));
  check('…but contributes nothing to spend',
    nullPrice.last_7d.spent === 4, String(nullPrice.last_7d.spent));

  check('an empty ledger is zeros, not NaN',
    summarizeLedgerSpend([], NOW).last_30d.spent === 0
      && summarizeLedgerSpend([], NOW).last_7d.labels === 0);
  check('an unparseable date is skipped rather than crashing',
    summarizeLedgerSpend([{ price_amount: 4, purchased_at: 'soon' }], NOW).last_30d.labels === 0);
  check('a future-dated row is not counted',
    summarizeLedgerSpend([{ price_amount: 4, purchased_at: new Date(NOW + DAY).toISOString() }], NOW)
      .last_7d.labels === 0);
  check('money is rounded to cents',
    summarizeLedgerSpend([row(1, 1.005), row(1, 1.005)], NOW).last_7d.spent === 2.01,
    String(summarizeLedgerSpend([row(1, 1.005), row(1, 1.005)], NOW).last_7d.spent));
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
