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
  authorizeRun, summarizeSpend, parsePrice, summarizeLedgerSpend, estimateForSizes,
  MAX_MANIFEST_BOXES, FALLBACK_UNIT_PRICE, SHRINK_TOLERANCE, MIN_SHRINK_ALLOWANCE,
} = await import(pathToFileURL(outFile).href);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

/** Group keys `b1..bn`, standing in for the boxes a check listed. */
const keys = (n, prefix = 'b') => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

/** An otherwise-valid run of `n` boxes: exactly the set that was reviewed still resolves. */
const okRun = (n = 10, over = {}) => ({
  enabled: true, resolvedKeys: keys(n), reviewedKeys: keys(n),
  unboundCount: 0, unboundPolicy: null, ...over,
});

console.log('\nThe flag is the outermost gate');
{
  const r = authorizeRun(okRun(10, { enabled: false }));
  check('a disabled run is refused', r.ok === false && r.code === 'disabled', r.code);
  // Log-only must win over every other verdict. If a disabled run reported "over_cap" it would
  // read as "lift the cap and it buys", when in fact the flag is off.
  const capped = authorizeRun({
    enabled: false, resolvedKeys: keys(99_999), reviewedKeys: keys(1),
    unboundCount: 0, unboundPolicy: null,
  });
  check('disabled outranks both the cap and a mismatch',
    capped.ok === false && capped.code === 'disabled', capped.code);
}

console.log('\nThe REVIEWED SET is the approval, not the count');
{
  const good = authorizeRun(okRun(10));
  check('a set that still resolves authorises, and names the boxes to buy',
    good.ok === true && good.buy.length === 10 && good.buy[0] === 'b1', String(good.buy?.length ?? good.code));
  check('…and reports no drift either way',
    good.ok === true && good.dropped === 0 && good.added === 0);

  const missing = authorizeRun({
    enabled: true, resolvedKeys: keys(10), reviewedKeys: null,
    unboundCount: 0, unboundPolicy: null,
  });
  check('no reviewed set at all is refused',
    missing.ok === false && missing.code === 'confirm_missing', missing.code);
  check('…and the refusal names what to send',
    missing.reason.includes('reviewed_keys'), missing.reason);
}

console.log('\nA box that appeared since the review is NEVER bought');
{
  // THE money property. Create Packages has no cancel, so a box nobody read must not be in the
  // manifest however many appeared — the spend is bounded by what a human actually approved.
  const r = authorizeRun({
    enabled: true, resolvedKeys: [...keys(10), 'brand-new'], reviewedKeys: keys(10),
    unboundCount: 0, unboundPolicy: null,
  });
  check('the unreviewed box is excluded', r.ok === true && !r.buy.includes('brand-new'), String(r.buy));
  check('…and is counted as added, so the caller can say so',
    r.ok === true && r.added === 1 && r.buy.length === 10);

  // Even a flood of new boxes cannot enlarge the purchase.
  const flood = authorizeRun({
    enabled: true, resolvedKeys: [...keys(10), ...keys(2_000, 'new')], reviewedKeys: keys(10),
    unboundCount: 0, unboundPolicy: null,
  });
  check('2,000 new boxes still buy only the 10 reviewed',
    flood.ok === true && flood.buy.length === 10 && flood.added === 2_000,
    String(flood.buy?.length ?? flood.code));
}

console.log('\nOrdinary drift must NOT block the purchase');
{
  // The bug this replaced. `authorize` re-resolves the whole run — ~20s of TikTok verification
  // for 4,200 orders — and orders keep landing during a show, so the count moved between the
  // check and the claim. Exact equality refused every attempt on a real 1,324-box night
  // (observed 1,329 -> 1,324 -> 1,325) and no amount of re-checking could converge.
  const live = authorizeRun({
    enabled: true,
    resolvedKeys: [...keys(1_324), 'aged-in-since'],
    reviewedKeys: keys(1_324),
    unboundCount: 0, unboundPolicy: null,
  });
  check('the live deadlock case now authorises',
    live.ok === true, live.ok ? '' : `${live.code}: ${live.reason}`);
  check('…buying exactly the 1,324 that were reviewed',
    live.ok === true && live.buy.length === 1_324 && live.added === 1);

  // Drift the other way: a few boxes got bought elsewhere or aged back out.
  const shrunk = authorizeRun({
    enabled: true, resolvedKeys: keys(1_324).slice(0, 1_320), reviewedKeys: keys(1_324),
    unboundCount: 0, unboundPolicy: null,
  });
  check('a small shrink authorises rather than refusing',
    shrunk.ok === true && shrunk.buy.length === 1_320 && shrunk.dropped === 4,
    shrunk.ok ? '' : shrunk.code);
}

console.log('\nA material shrink still stops for a human');
{
  check('the tolerance is 5% with a 5-box floor',
    SHRINK_TOLERANCE === 0.05 && MIN_SHRINK_ALLOWANCE === 5);

  // Buying FEWER boxes than approved can never overspend, so this is not a money gate — it is
  // there so a scope or sync that resolved to something else entirely gets looked at.
  const collapsed = authorizeRun({
    enabled: true, resolvedKeys: keys(400), reviewedKeys: keys(1_324),
    unboundCount: 0, unboundPolicy: null,
  });
  check('a plan that collapsed from 1,324 to 400 is refused',
    collapsed.ok === false && collapsed.code === 'confirm_mismatch', collapsed.code);
  check('…and the refusal says how much moved and what tolerance applied',
    collapsed.reason.includes('924') && collapsed.reason.includes('1324')
      && collapsed.reason.includes('67'), collapsed.reason);

  // The floor keeps small runs usable: 5% of 15 is under one box.
  const small = authorizeRun({
    enabled: true, resolvedKeys: keys(15).slice(0, 10), reviewedKeys: keys(15),
    unboundCount: 0, unboundPolicy: null,
  });
  check('a 15-box run may lose 5 without refusing',
    small.ok === true && small.buy.length === 10, small.ok ? '' : small.code);
  const small6 = authorizeRun({
    enabled: true, resolvedKeys: keys(15).slice(0, 9), reviewedKeys: keys(15),
    unboundCount: 0, unboundPolicy: null,
  });
  check('…but losing 6 of 15 is refused', small6.ok === false && small6.code === 'confirm_mismatch');

  // Total divergence: the scope resolved to a different set entirely.
  const disjoint = authorizeRun({
    enabled: true, resolvedKeys: keys(10, 'other'), reviewedKeys: keys(10),
    unboundCount: 0, unboundPolicy: null,
  });
  check('a set sharing NOTHING with the review is refused',
    disjoint.ok === false && disjoint.code === 'confirm_mismatch', disjoint.code);
  check('…and says nothing reviewed survived rather than reporting a count',
    disjoint.reason.includes('none of the 10'), disjoint.reason);
}

console.log('\nDuplicate keys cannot inflate a run or claim a box twice');
{
  const dupes = authorizeRun({
    enabled: true, resolvedKeys: ['b1', 'b1', 'b2', '', 'b2'], reviewedKeys: ['b1', 'b2', 'b2'],
    unboundCount: 0, unboundPolicy: null,
  });
  check('a repeated key is collapsed on both sides',
    dupes.ok === true && dupes.buy.length === 2 && dupes.dropped === 0 && dupes.added === 0,
    String(dupes.buy ?? dupes.code));
  check('…and a blank key is dropped, not bought', dupes.ok === true && !dupes.buy.includes(''));
}

console.log('\nPrint order comes from the CURRENT plan, membership from the review');
{
  // Captions and sequence must describe the stack that will really be assembled, so order
  // follows what resolves now; only WHICH boxes is decided by the review.
  const r = authorizeRun({
    enabled: true, resolvedKeys: ['b3', 'b1', 'b2'], reviewedKeys: ['b1', 'b2', 'b3'],
    unboundCount: 0, unboundPolicy: null,
  });
  check('buy is returned in resolved (print) order, not reviewed order',
    r.ok === true && r.buy.join(',') === 'b3,b1,b2', String(r.buy));
}

console.log('\nNothing to buy is not an error');
{
  const r = authorizeRun({
    enabled: true, resolvedKeys: [], reviewedKeys: [], unboundCount: 0, unboundPolicy: null,
  });
  check('an empty run is refused as nothing_to_buy, not as a mismatch',
    r.ok === false && r.code === 'nothing_to_buy', r.code);
  check('a run of nothing but blanks cannot slip through',
    authorizeRun({ enabled: true, resolvedKeys: ['', ''], reviewedKeys: ['x'],
      unboundCount: 0, unboundPolicy: null }).code === 'nothing_to_buy');
}

console.log('\nSCOPE bounds a run now, not a per-call limit');
{
  // The old model required a `limit` on every call so one click could not buy everything. That
  // was replaced deliberately: a fulfilment day is 474-863 boxes and the operator asked NOT to
  // split a day across approvals. The bound is now the SCOPE (a day, or named shows) plus the
  // reviewed set, and the authorised manifest is drained without further approval.
  const r = authorizeRun(okRun(593));
  check('a whole fulfilment day authorises in one act',
    r.ok === true && r.buy.length === 593, String(r.buy?.length ?? r.code));
  check('the busiest measured day (863 boxes) still fits', authorizeRun(okRun(863)).ok === true);
}

console.log('\nThe ceiling is a sanity backstop, not the control');
{
  check('the ceiling is 3000', MAX_MANIFEST_BOXES === 3000);
  // Three unbought nights came to 1,454 boxes on real data, so the old 1,500 was close enough
  // to bite on an ordinary catch-up.
  check('three real nights (1,454 boxes) fit with room to spare',
    authorizeRun(okRun(1454)).ok === true);
  check('exactly at the ceiling is allowed', authorizeRun(okRun(MAX_MANIFEST_BOXES)).ok === true);
  const over = authorizeRun(okRun(MAX_MANIFEST_BOXES + 1));
  check('one over is refused', over.ok === false && over.code === 'over_cap', over.code);
  check('…and the refusal says how to fix it, not just that it failed',
    over.reason.includes('narrow the scope'), over.reason);
  check('an explicit lower ceiling is honoured',
    authorizeRun(okRun(10, { cap: 5 })).code === 'over_cap');

  // The cap counts what will be BOUGHT, not what resolved: unreviewed boxes are already gone.
  const manyResolved = authorizeRun({
    enabled: true, resolvedKeys: [...keys(10), ...keys(5_000, 'new')], reviewedKeys: keys(10),
    unboundCount: 0, unboundPolicy: null,
  });
  check('5,010 resolved boxes but 10 reviewed is under the cap, not over it',
    manyResolved.ok === true && manyResolved.buy.length === 10,
    manyResolved.ok ? '' : manyResolved.code);
}

console.log('\nRefusal order — the cheapest, safest verdict wins');
{
  // A stale plan is reported before the unbound question: answering it against a plan nobody
  // reviewed is meaningless.
  const stale = authorizeRun({
    enabled: true, resolvedKeys: keys(10, 'other'), reviewedKeys: keys(10),
    unboundCount: 3, unboundPolicy: null,
  });
  check('a stale plan outranks the unbound question', stale.code === 'confirm_mismatch', stale.code);
  // The unbound question comes before the ceiling, since the answer changes the box count.
  const both = authorizeRun(okRun(9_999, { unboundCount: 3, unboundPolicy: null }));
  check('the unbound question comes before the ceiling', both.code === 'unbound_present', both.code);
  check('the flag still outranks everything',
    authorizeRun({ enabled: false, resolvedKeys: keys(9_999), reviewedKeys: keys(1),
      unboundCount: 3, unboundPolicy: null }).code === 'disabled');
  // A missing review outranks the unbound question for the same reason a stale one does.
  check('a missing review outranks the unbound question',
    authorizeRun({ enabled: true, resolvedKeys: keys(10), reviewedKeys: null,
      unboundCount: 3, unboundPolicy: null }).code === 'confirm_missing');
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

console.log('\nThe spend can never exceed what was reviewed (fuzzed)');
{
  // The one invariant that money depends on, over 500 randomised drift patterns rather than the
  // handful above: whatever resolves, every bought box was reviewed, and no box is bought twice.
  let seed = 20260906;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let worst = 0, violations = 0, authorised = 0;
  for (let t = 0; t < 500; t++) {
    const n = 1 + Math.floor(rnd() * 80);
    const reviewed = keys(n);
    const kept = reviewed.filter(() => rnd() > 0.15);
    const fresh = keys(Math.floor(rnd() * 30), 'new');
    const resolved = [...kept, ...fresh].sort(() => rnd() - 0.5);
    const r = authorizeRun({
      enabled: true, resolvedKeys: resolved, reviewedKeys: reviewed,
      unboundCount: 0, unboundPolicy: null,
    });
    if (!r.ok) continue;
    authorised++;
    const set = new Set(reviewed);
    if (r.buy.length > reviewed.length) violations++;
    if (r.buy.some((k) => !set.has(k))) violations++;
    if (new Set(r.buy).size !== r.buy.length) violations++;
    worst = Math.max(worst, r.buy.length - reviewed.length);
  }
  check('no authorised run ever bought an unreviewed or duplicated box',
    violations === 0 && worst <= 0, `${authorised} authorised, worst overshoot ${worst}`);
}

console.log('\nPrice follows box SIZE, so the estimate must too');
{
  // The real ladder, measured over the first 21 purchases (r = 0.853 against order count).
  const history = [
    ...Array(7).fill({ orders: 1, price: 4.01 }),
    ...Array(4).fill({ orders: 2, price: 4.94 }),
    { orders: 4, price: 6.10 }, { orders: 4, price: 6.31 },
    { orders: 7, price: 9.04 }, { orders: 7, price: 10.68 },
    { orders: 20, price: 11.45 },
  ];

  // THE MISS THIS FIXES. Wednesday was 15 large combines. A flat $4.24 average predicted $63.60
  // against an actual $107.65 — 69% low — because the average was built from single-item labels.
  const flat = summarizeSpend(history.map((h) => h.price), 15).estimated_total;
  const sized = estimateForSizes(history, [1, 2, 2, 4, 4, 7, 7, 7, 20, 20, 12, 9, 6, 6, 3]).total;
  check('a size-aware estimate lands far above a flat average for a heavy mix',
    sized > flat * 1.3, `flat ${flat} vs sized ${sized}`);

  const singles = estimateForSizes(history, Array(10).fill(1));
  check('ten single-order boxes price at the single-order rate',
    Math.abs(singles.total - 40.1) < 0.05, String(singles.total));
  check('…and report it as drawn from history', singles.basis === 'history', singles.basis);

  const big = estimateForSizes(history, [20]);
  check('a 20-order combine prices at its own rate, not the average',
    Math.abs(big.total - 11.45) < 0.01, String(big.total));

  // A size never seen borrows its nearest neighbour rather than a fitted line: 21 points do not
  // support a model that looks more confident than the data.
  const unseen = estimateForSizes(history, [19]);
  check('an unseen size borrows the nearest observed one',
    Math.abs(unseen.total - 11.45) < 0.01 && unseen.basis === 'nearest',
    `${unseen.total}/${unseen.basis}`);
  const tie = estimateForSizes([{ orders: 2, price: 5 }, { orders: 4, price: 9 }], [3]);
  check('a tie goes to the LARGER size, erring toward over-estimating',
    tie.total === 9, String(tie.total));
}
{
  const history = [{ orders: 1, price: 4 }, { orders: 1, price: 6 }];
  const e = estimateForSizes(history, [1, 1]);
  check('the range reports the observed spread, not a made-up interval',
    e.low === 8 && e.high === 12 && e.total === 10, `${e.low}/${e.total}/${e.high}`);
  check('samples are reported so a thin history is visible', e.samples === 2);
}
{
  const none = estimateForSizes([], [1, 2, 3]);
  check('no history falls back to the flat measured price',
    none.basis === 'fallback' && Math.abs(none.total - 3 * FALLBACK_UNIT_PRICE) < 0.01,
    String(none.total));
  check('no boxes estimates zero, not NaN', estimateForSizes([], []).total === 0);
  check('unusable history rows are dropped',
    estimateForSizes([{ orders: 0, price: 5 }, { orders: 1, price: -2 }], [1]).basis === 'fallback');
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
