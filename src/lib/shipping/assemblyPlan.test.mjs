// Proof for resolving a print plan against the purchase ledger. The failures that matter here
// are quiet ones: a label that vanishes from the stack, or a slip that promises more labels
// than follow it.
// Run:  node src/lib/shipping/assemblyPlan.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./assemblyPlan.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'ap-')), 'assemblyPlan.mjs');
writeFileSync(outFile, outputText);
const { buildAssemblySequence, needsRefetch, itemsFromLedger, itemsFromLedgerMerged, LEDGER_COLUMNS, DOC_REFETCH_MARGIN_MS, pileOf, unprintableReason } =
  await import(pathToFileURL(outFile).href);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

const NOW = Date.parse('2026-09-04T12:00:00Z');
const HOUR = 3_600_000;

/** A purchased ledger row with a fresh document. */
const row = (key, over = {}) => ({
  group_key: key, status: 'purchased', package_id: `pkg-${key}`,
  doc_url: `https://doc/${key}`,
  doc_url_expires_at: new Date(NOW + 20 * HOUR).toISOString(),
  tracking_number: `trk-${key}`, ...over,
});
/** A box to print, under `caption` (null = no header). */
const item = (key, caption = null, banner = null) => ({ group_key: key, banner, caption });
/** Several boxes under one SKU header. */
const section = (caption, ...keys) => keys.map((k) => item(k, caption));
const shape = (seq) => seq.pages
  .map((p) => (p.kind === 'banner' ? `BANNER(${p.caption}|${p.count})`
    : p.kind === 'slip' ? `SLIP(${p.caption}|${p.count})` : `L(${p.group_key})`)).join(' ');

// ── pileOf: the run summary must count what the FILE will contain ───────────────────────────
//
// The bug this pins: the summary classified by banner alone, so a run whose purchase had failed
// on 1 single and 5 bundles advertised "Singles (261) / Bundles (357)" for files that held 260
// and 353. A count nobody can trust is worse than no count, because the operator reconciles
// against it.
{
  const B = { singles: 'SINGLES — PREP STATION', mixed: 'BUNDLED ORDERS — PICK REGULAR', unbound: 'NO SKU ON FILE — LOOK UP EACH ORDER' };
  const row = (over = {}) => ({ group_key: 'g', status: 'purchased', package_id: 'pkg', banner_caption: B.singles, ...over });

  check('purchased single counts as singles', pileOf(row(), B) === 'singles');
  check('purchased bundle counts as mixed', pileOf(row({ banner_caption: B.mixed }), B) === 'mixed');
  check('purchased unbound counts as unbound', pileOf(row({ banner_caption: B.unbound }), B) === 'unbound');

  // The four ways a row is real in the ledger but absent from the PDF.
  check('FAILED purchase counts in no pile', pileOf(row({ status: 'failed' }), B) === null);
  check('CLAIMED (unconfirmed) counts in no pile', pileOf(row({ status: 'claimed' }), B) === null);
  check('no package_id counts in no pile', pileOf(row({ package_id: null }), B) === null);
  check('missing row counts in no pile', pileOf(undefined, B) === null);

  // An unrecognised banner is reported, not silently folded into singles.
  check('unknown banner is "other"', pileOf(row({ banner_caption: 'SOMETHING NEW' }), B) === 'other');
  check('no banner at all is null', pileOf(row({ banner_caption: null }), B) === null);

  // The real scenario, end to end: Snore's 2026-09-07 run.
  const snore = [
    ...Array.from({ length: 260 }, (_, i) => row({ group_key: `s${i}` })),
    row({ group_key: 'sf', status: 'failed' }),
    ...Array.from({ length: 331 }, (_, i) => row({ group_key: `m${i}`, banner_caption: B.mixed })),
    ...Array.from({ length: 5 }, (_, i) => row({ group_key: `mf${i}`, banner_caption: B.mixed, status: 'failed' })),
  ];
  const tally = snore.reduce((a, r) => { const k = pileOf(r, B); if (k) a[k] = (a[k] ?? 0) + 1; return a; }, {});
  check('Snore 2026-09-07 singles = 260, not 261', tally.singles === 260, `got ${tally.singles}`);
  check('Snore 2026-09-07 bundles = 331, not 336', tally.mixed === 331, `got ${tally.mixed}`);

  // pileOf must agree with the PDF's own gate, not merely resemble it.
  for (const st of ['failed', 'claimed', 'weird']) {
    check(`pileOf refuses exactly when unprintableReason does (${st})`,
      (pileOf(row({ status: st }), B) === null) === Boolean(unprintableReason(row({ status: st }))));
  }
}

console.log('\nDocument freshness');
{
  check('a row with no doc_url must be re-fetched', needsRefetch(row('a', { doc_url: null }), NOW));
  check('a row with no expiry is treated as stale, not assumed good',
    needsRefetch(row('a', { doc_url_expires_at: null }), NOW));
  check('an unparseable expiry is treated as stale',
    needsRefetch(row('a', { doc_url_expires_at: 'whenever' }), NOW));
  check('a URL expiring inside the margin is re-fetched',
    needsRefetch(row('a', { doc_url_expires_at: new Date(NOW + 30 * 60_000).toISOString() }), NOW));
  check('an already-expired URL is re-fetched',
    needsRefetch(row('a', { doc_url_expires_at: new Date(NOW - HOUR).toISOString() }), NOW));
  check('a comfortably fresh URL is kept', needsRefetch(row('a'), NOW) === false);
  check('the margin is an hour', DOC_REFETCH_MARGIN_MS === HOUR);
  // Exactly at the boundary counts as stale: assembly takes time, and a URL that dies mid-run
  // leaves a hole in a stack the packer believes is complete.
  check('exactly at the margin is stale',
    needsRefetch(row('a', { doc_url_expires_at: new Date(NOW + HOUR).toISOString() }), NOW));
}

console.log('\nThe happy path');
{
  const seq = buildAssemblySequence(
    [...section('#248 PUMPKIN', 'a', 'b'), ...section('MIXED — READ EACH LABEL', 'z')],
    [row('a'), row('b'), row('z')], NOW,
  );
  check('every page survives in order',
    shape(seq) === 'SLIP(#248 PUMPKIN|2) L(a) L(b) SLIP(MIXED — READ EACH LABEL|1) L(z)', shape(seq));
  check('nothing is missing', seq.missing.length === 0);
  check('nothing needs re-fetching', seq.refetch.length === 0);
  check('counts are reported', seq.labelCount === 3 && seq.slipCount === 2);
  check('package_id is carried through for fetching',
    seq.pages.filter((p) => p.kind === 'label').every((p) => p.package_id.startsWith('pkg-')));
}

console.log('\nA slip never promises more labels than follow it');
{
  // THE case this exists for. Plan wanted 3, one box was never confirmed. A slip reading "3" in
  // front of 2 labels makes the packer pull three items and leaves one stranded.
  const seq = buildAssemblySequence(
    section('#248 PUMPKIN', 'a', 'b', 'c'),
    [row('a'), row('b'), row('c', { status: 'claimed', package_id: null })], NOW,
  );
  check('the slip count is corrected to the labels that survive',
    shape(seq) === 'SLIP(#248 PUMPKIN|2) L(a) L(b)', shape(seq));
  check('and the lost box is reported, not dropped silently',
    seq.missing.length === 1 && seq.missing[0].group_key === 'c', JSON.stringify(seq.missing));
  check('…with a reason that says what to do',
    seq.missing[0].reason.includes('reconciling by hand'), seq.missing[0].reason);
}
{
  // A whole section lost. A slip with nothing behind it reads as "the next label is a pumpkin"
  // when the next label is a bundle.
  const seq = buildAssemblySequence(
    [...section('#248 PUMPKIN', 'a', 'b'), ...section('MIXED — READ EACH LABEL', 'z')],
    [row('z')], NOW,
  );
  check('a slip whose entire section is unprintable is dropped with it',
    shape(seq) === 'SLIP(MIXED — READ EACH LABEL|1) L(z)', shape(seq));
  check('both lost boxes are reported', seq.missing.length === 2);
  check('slip count reflects the drop', seq.slipCount === 1);
}
{
  const seq = buildAssemblySequence(
    [item('a', '#1 A'), item('b', '#2 B')], [], NOW);
  check('losing everything produces no pages at all rather than orphan slips',
    seq.pages.length === 0, shape(seq));
  check('…and every box is accounted for', seq.missing.length === 2);
}

console.log('\nWhy a box can be unprintable');
{
  const cases = [
    ['no ledger row', undefined, 'no purchase recorded'],
    ['a failed purchase', row('x', { status: 'failed' }), 'no label was bought'],
    ['an unconfirmed claim', row('x', { status: 'claimed' }), 'purchase unconfirmed'],
    // The "already purchased at TikTok" path records status 'purchased' with NO package_id.
    // The label is real but we cannot fetch it — printing must not silently skip it.
    ['purchased with no package_id', row('x', { package_id: null }), 'Seller Center'],
    ['an unexpected status', row('x', { status: 'weird' }), 'unexpected ledger status'],
  ];
  for (const [name, r, expect] of cases) {
    const seq = buildAssemblySequence([item('x')], r ? [r] : [], NOW);
    check(`${name} → reported, zero pages`,
      seq.pages.length === 0 && seq.missing.length === 1 && seq.missing[0].reason.includes(expect),
      seq.missing[0]?.reason);
  }
  check('a purchased row with an EMPTY-STRING package_id is caught too',
    buildAssemblySequence([item('x')], [row('x', { package_id: '' })], NOW).missing.length === 1);
}

console.log('\nStale documents are flagged, not trusted');
{
  const seq = buildAssemblySequence(
    section('#5 C', 'a', 'b'),
    [row('a'), row('b', { doc_url_expires_at: new Date(NOW - HOUR).toISOString() })], NOW,
  );
  check('a stale box still prints — it is fetchable, just not from the cached URL',
    seq.labelCount === 2 && seq.missing.length === 0);
  check('its package_id is listed for re-fetching',
    seq.refetch.length === 1 && seq.refetch[0] === 'pkg-b', JSON.stringify(seq.refetch));
  const staleLabel = seq.pages.find((p) => p.kind === 'label' && p.group_key === 'b');
  check('…and its stale doc_url is NULLED so it cannot be used by mistake',
    staleLabel.doc_url === null, String(staleLabel.doc_url));
  const freshLabel = seq.pages.find((p) => p.kind === 'label' && p.group_key === 'a');
  check('the fresh one keeps its URL', freshLabel.doc_url === 'https://doc/a');
}

console.log('\nRebuilding the stack from the ledger alone');
{
  // The whole point: minutes after buying, the orders have advanced and the planner can no
  // longer find them. The ledger must be able to reproduce the reviewed stack by itself.
  const rows = [
    row('b', { print_seq: 1, slip_caption: '#248 PUMPKIN GLITTER' }),
    row('z', { print_seq: 3, slip_caption: 'MIXED — READ EACH LABEL' }),
    row('a', { print_seq: 0, slip_caption: '#248 PUMPKIN GLITTER' }),
    row('c', { print_seq: 2, slip_caption: 'MIXED — READ EACH LABEL' }),
  ];
  const seq = buildAssemblySequence(itemsFromLedger(rows), rows, NOW);
  check('print_seq drives the order, not the row order',
    shape(seq) === 'SLIP(#248 PUMPKIN GLITTER|2) L(a) L(b) SLIP(MIXED — READ EACH LABEL|2) L(c) L(z)',
    shape(seq));
  check('one slip per section, not one per label', seq.slipCount === 2);
  check('slip counts are derived from the grouping', seq.pages[0].count === 2 && seq.pages[3].count === 2);
}
{
  // Shuffling the input must not change the stack — a reprint has to match the first print.
  const rows = Array.from({ length: 6 }, (_, i) =>
    row(`k${i}`, { print_seq: i, slip_caption: i < 3 ? '#1 A' : '#2 B' }));
  const one = shape(buildAssemblySequence(itemsFromLedger(rows), rows, NOW));
  const two = shape(buildAssemblySequence(itemsFromLedger(rows.slice().reverse()), rows, NOW));
  check('a reprint is byte-identical regardless of row order', one === two, one);
}
{
  const rows = [
    row('a', { print_seq: 0, slip_caption: null }),
    row('b', { print_seq: 1, slip_caption: '#7 G' }),
  ];
  const seq = buildAssemblySequence(itemsFromLedger(rows), rows, NOW);
  check('a box with no caption gets no slip, and a later section still opens one',
    shape(seq) === 'L(a) SLIP(#7 G|1) L(b)', shape(seq));
}
{
  // A caption that recurs non-adjacently is two sections, not one — grouping is consecutive so
  // the slip always describes the labels immediately behind it.
  const rows = [
    row('a', { print_seq: 0, slip_caption: '#1 A' }),
    row('b', { print_seq: 1, slip_caption: '#2 B' }),
    row('c', { print_seq: 2, slip_caption: '#1 A' }),
  ];
  const seq = buildAssemblySequence(itemsFromLedger(rows), rows, NOW);
  check('a recurring caption opens a second section rather than merging',
    shape(seq) === 'SLIP(#1 A|1) L(a) SLIP(#2 B|1) L(b) SLIP(#1 A|1) L(c)', shape(seq));
}
{
  // The one row already in prod (the single-box test) predates print_seq. A paid label must
  // not disappear from a stack because its position is unknown.
  const rows = [
    row('legacy', { print_seq: null, slip_caption: null }),
    row('a', { print_seq: 0, slip_caption: '#1 A' }),
  ];
  const seq = buildAssemblySequence(itemsFromLedger(rows), rows, NOW);
  check('a row with no print_seq still prints, sorted last',
    shape(seq) === 'SLIP(#1 A|1) L(a) L(legacy)', shape(seq));
  check('…and is not reported as missing', seq.missing.length === 0);
  // The bug this model removes: a caption-less box after a section used to be absorbed into
  // it, so the pumpkin slip claimed 2 labels when only one was a pumpkin.
  check('…and is NOT absorbed into the preceding section',
    seq.pages[0].count === 1, String(seq.pages[0].count));
}
{
  check('an empty ledger rebuilds to nothing', itemsFromLedger([]).length === 0);
}

console.log('\nTwo levels: piles, and SKU sections inside them');
{
  // The stack the prep station actually receives: a SINGLES pile split by SKU, then a MIXED
  // pile that has no SKU split because there is no single SKU to name.
  const items = [
    { group_key: 'p1', banner: 'SINGLES — ONE SKU EACH', caption: '#248 PUMPKIN' },
    { group_key: 'p2', banner: 'SINGLES — ONE SKU EACH', caption: '#248 PUMPKIN' },
    { group_key: 'b1', banner: 'SINGLES — ONE SKU EACH', caption: '#352 BANANA' },
    { group_key: 'm1', banner: 'MIXED — READ EACH LABEL', caption: null },
    { group_key: 'm2', banner: 'MIXED — READ EACH LABEL', caption: null },
  ];
  const rows = items.map((i) => row(i.group_key));
  const seq = buildAssemblySequence(items, rows, NOW);
  check('the pile banner counts the WHOLE pile, not one section',
    shape(seq) === 'BANNER(SINGLES — ONE SKU EACH|3) SLIP(#248 PUMPKIN|2) L(p1) L(p2) '
      + 'SLIP(#352 BANANA|1) L(b1) BANNER(MIXED — READ EACH LABEL|2) L(m1) L(m2)',
    shape(seq));
  check('banners are counted', seq.bannerCount === 2, String(seq.bannerCount));
  check('slips are counted separately', seq.slipCount === 2, String(seq.slipCount));
}
{
  // A lost box must shrink BOTH levels. A banner saying 3 over a pile of 2 sends the prep
  // station looking for a label that was never bought.
  const items = [
    { group_key: 'p1', banner: 'SINGLES', caption: '#248 PUMPKIN' },
    { group_key: 'p2', banner: 'SINGLES', caption: '#248 PUMPKIN' },
    { group_key: 'p3', banner: 'SINGLES', caption: '#248 PUMPKIN' },
  ];
  const seq = buildAssemblySequence(
    items, [row('p1'), row('p2'), row('p3', { status: 'claimed', package_id: null })], NOW);
  check('the banner count shrinks with the pile',
    shape(seq) === 'BANNER(SINGLES|2) SLIP(#248 PUMPKIN|2) L(p1) L(p2)', shape(seq));
}
{
  // A pile emptied entirely drops its banner too, or the stack opens with a divider for
  // nothing and the next pile reads as belonging to it.
  const items = [
    { group_key: 'x', banner: 'SINGLES', caption: '#1 A' },
    { group_key: 'm', banner: 'MIXED', caption: null },
  ];
  const seq = buildAssemblySequence(items, [row('m')], NOW);
  check('an emptied pile drops its banner with it',
    shape(seq) === 'BANNER(MIXED|1) L(m)', shape(seq));
}
{
  // Rows predating banner_caption still print, as one unheaded run.
  const rows = [row('legacy', { print_seq: 0, slip_caption: null, banner_caption: null })];
  const seq = buildAssemblySequence(itemsFromLedger(rows), rows, NOW);
  check('a row with no banner still prints', shape(seq) === 'L(legacy)', shape(seq));
  check('…and no empty banner is emitted', seq.bannerCount === 0);
}

console.log('\nThe column list must cover every field the type declares');
{
  // THE BUG THIS EXISTS FOR. banner_caption was added to the migration, the write path, the
  // LedgerRow type, the grouping, the renderer and these tests — but not to the PDF route's
  // SELECT. A missing column arrives as `undefined`, which reads as "no banner", so a real day
  // printed with both pile dividers silently absent and nothing threw.
  //
  // No other test could catch it: every one of them builds rows by hand and never issues the
  // query. This one reads the interface out of the source and checks the string agrees.
  const src = readFileSync(srcPath, 'utf8');
  const body = src.slice(
    src.indexOf('export interface LedgerRow {') + 'export interface LedgerRow {'.length,
    src.indexOf('}', src.indexOf('export interface LedgerRow {')),
  );
  const fields = [...body.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
  check('the interface was parsed', fields.length >= 8, fields.join(','));
  const missing = fields.filter((f) => !LEDGER_COLUMNS.includes(f));
  check('every LedgerRow field appears in LEDGER_COLUMNS',
    missing.length === 0, missing.length ? `MISSING: ${missing.join(', ')}` : 'all present');

  // A name-by-name check is not enough: a botched edit once produced
  // 'tracking_number, , store_id' + 'print_seq, …' — an empty column and two names fused
  // together — and every name was still "present". PostgREST would have rejected the query.
  const parts = LEDGER_COLUMNS.split(',').map((x) => x.trim());
  check('the column list has no empty entries', parts.every((x) => x.length > 0),
    JSON.stringify(parts.filter((x) => !x)));
  check('no two column names are fused together',
    parts.every((x) => /^[a-z_][a-z0-9_]*$/.test(x)),
    parts.filter((x) => !/^[a-z_][a-z0-9_]*$/.test(x)).join(' | '));
  check('no column is listed twice', new Set(parts).size === parts.length);
  // And specifically the one that got away.
  check('banner_caption is in the column list', LEDGER_COLUMNS.includes('banner_caption'));
}

console.log('\nMerging runs from several shops into one pile per SKU');
{
  const SINGLES = 'SINGLES — PREP STATION';
  const MIXED = 'BUNDLED ORDERS — PICK REGULAR';
  const ORDER = [SINGLES, MIXED];
  // The real shape: labels are bought per shop, but 108 of 190 SKUs sell in more than one and
  // the top sellers are in all four. Printed per shop, the same SKU sits in several piles and
  // the prep station walks it repeatedly.
  const rows = [
    row('snore-a', { store_id: 's1', banner_caption: SINGLES, slip_caption: '#106 PINK POPSICLE', print_seq: 0 }),
    row('snore-b', { store_id: 's1', banner_caption: SINGLES, slip_caption: '#106 PINK POPSICLE', print_seq: 1 }),
    row('snore-c', { store_id: 's1', banner_caption: SINGLES, slip_caption: '#428 SOAP BAR', print_seq: 2 }),
    row('lots-a',  { store_id: 's2', banner_caption: SINGLES, slip_caption: '#106 PINK POPSICLE', print_seq: 0 }),
    row('lots-b',  { store_id: 's2', banner_caption: MIXED,   slip_caption: null, print_seq: 1 }),
    row('snore-m', { store_id: 's1', banner_caption: MIXED,   slip_caption: null, print_seq: 3 }),
  ];
  const seq = buildAssemblySequence(itemsFromLedgerMerged(rows, ORDER), rows, NOW);

  check('the same SKU from two shops becomes ONE pile',
    shape(seq).includes('SLIP(#106 PINK POPSICLE|3)'), shape(seq));
  check('…and the bigger SKU section prints first',
    shape(seq).indexOf('#106 PINK POPSICLE') < shape(seq).indexOf('#428 SOAP BAR'));
  check('mixed from both shops merges too',
    shape(seq).includes(`BANNER(${MIXED}|2)`), shape(seq));
  check('the singles banner counts every shop\'s singles',
    shape(seq).includes(`BANNER(${SINGLES}|4)`), shape(seq));
  check('every label still appears exactly once', seq.labelCount === 6);
  check('no box is lost in the merge', seq.missing.length === 0);
}
{
  const SINGLES = 'SINGLES — PREP STATION';
  const MIXED = 'BUNDLED ORDERS — PICK REGULAR';
  // Piles keep the planner's running order — singles first, mixed after — regardless of which
  // pile happens to be larger. Ordering piles by size would send the packer to the read-each-one
  // pile first, which is the opposite of the point.
  const rows = [
    row('m1', { banner_caption: MIXED, slip_caption: null }),
    row('m2', { banner_caption: MIXED, slip_caption: null }),
    row('m3', { banner_caption: MIXED, slip_caption: null }),
    row('s1', { banner_caption: SINGLES, slip_caption: '#1 A' }),
  ];
  const seq = buildAssemblySequence(itemsFromLedgerMerged(rows, [SINGLES, MIXED]), rows, NOW);
  check('singles come before mixed even when mixed is bigger',
    shape(seq).indexOf(SINGLES) < shape(seq).indexOf(MIXED), shape(seq));
}
{
  // Determinism: two prints of the same selection must be identical, whatever order the rows
  // arrive in — a reprint that reorders the stack is a reprint nobody can trust.
  const SINGLES = 'SINGLES — PREP STATION';
  const rows = ['d', 'a', 'c', 'b'].map((k) =>
    row(k, { banner_caption: SINGLES, slip_caption: '#5 E' }));
  const one = itemsFromLedgerMerged(rows, [SINGLES]).map((i) => i.group_key).join(',');
  const two = itemsFromLedgerMerged(rows.slice().reverse(), [SINGLES]).map((i) => i.group_key).join(',');
  check('a merged stack is deterministic', one === two && one === 'a,b,c,d', one);
}
{
  check('merging nothing yields nothing', itemsFromLedgerMerged([], []).length === 0);
  const seq = buildAssemblySequence(
    itemsFromLedgerMerged([row('x', { banner_caption: null, slip_caption: null })], []), 
    [row('x', { banner_caption: null, slip_caption: null })], NOW);
  check('an unbannered row still prints in a merge', seq.labelCount === 1, shape(seq));
}

console.log('\nSplitting the stack into two files loses nothing');
{
  // The route filters seq.pages on the BANNER. Reproduced here so the invariant that matters —
  // singles + mixed == the whole stack, with no label dropped or duplicated — is pinned.
  const SINGLES = 'SINGLES — PREP STATION';
  const MIXED = 'BUNDLED ORDERS — PICK REGULAR';
  const NOSKU = 'NO SKU ON FILE — LOOK UP EACH ORDER';
  const rows = [
    row('s1', { banner_caption: SINGLES, slip_caption: '#1 A', print_seq: 0 }),
    row('s2', { banner_caption: SINGLES, slip_caption: '#1 A', print_seq: 1 }),
    row('s3', { banner_caption: SINGLES, slip_caption: '#2 B', print_seq: 2 }),
    row('m1', { banner_caption: MIXED, slip_caption: null, print_seq: 3 }),
    row('m2', { banner_caption: MIXED, slip_caption: null, print_seq: 4 }),
    row('u1', { banner_caption: NOSKU, slip_caption: null, print_seq: 5 }),
  ];
  const seq = buildAssemblySequence(itemsFromLedger(rows), rows, NOW);

  const filterTo = (want) => {
    const kept = []; let keeping = false;
    for (const p of seq.pages) {
      if (p.kind === 'banner') keeping = want(p.caption);
      if (keeping) kept.push(p);
    }
    return kept;
  };
  const singles = filterTo((b) => b === SINGLES);
  const mixed = filterTo((b) => b === MIXED || b === NOSKU);

  const labelsOf = (pp) => pp.filter((p) => p.kind === 'label').map((p) => p.group_key);
  const all = labelsOf(seq.pages);
  const both = [...labelsOf(singles), ...labelsOf(mixed)];

  check('the two files together hold every label',
    both.slice().sort().join(',') === all.slice().sort().join(','), both.join(','));
  check('…and none twice', new Set(both).size === both.length);
  check('singles holds only the singles pile',
    labelsOf(singles).join(',') === 's1,s2,s3', labelsOf(singles).join(','));
  check('mixed holds bundles AND no-SKU, which are both "read each label" work',
    labelsOf(mixed).join(',') === 'm1,m2,u1', labelsOf(mixed).join(','));
  check('each file keeps its own banners so it is self-describing',
    singles.some((p) => p.kind === 'banner' && p.caption === SINGLES)
      && mixed.some((p) => p.kind === 'banner' && p.caption === MIXED)
      && mixed.some((p) => p.kind === 'banner' && p.caption === NOSKU));
  check('the singles file keeps its per-SKU slips',
    singles.filter((p) => p.kind === 'slip').length === 2);
}

console.log('\nEdges');
{
  const empty = buildAssemblySequence([], [], NOW);
  check('an empty plan assembles nothing',
    empty.pages.length === 0 && empty.missing.length === 0 && empty.labelCount === 0);
  const noSlip = buildAssemblySequence([item('a')], [row('a')], NOW);
  check('labels with no leading slip still print', shape(noSlip) === 'L(a)', shape(noSlip));
  // Ledger rows for boxes outside this plan must not leak into the stack.
  const extra = buildAssemblySequence([item('a')], [row('a'), row('other')], NOW);
  check('ledger rows outside the plan are ignored', extra.labelCount === 1);
}

console.log(`\n${passed} checks passed\n`);
