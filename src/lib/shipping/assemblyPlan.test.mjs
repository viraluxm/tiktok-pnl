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
const { buildAssemblySequence, needsRefetch, itemsFromLedger, LEDGER_COLUMNS, DOC_REFETCH_MARGIN_MS } =
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
  // And specifically the one that got away.
  check('banner_caption is in the column list', LEDGER_COLUMNS.includes('banner_caption'));
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
