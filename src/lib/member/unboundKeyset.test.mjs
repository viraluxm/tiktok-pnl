// Proof for the binding queue's keyset pagination in BOTH directions.
//
// The check that matters: paginate a whole dataset and assert the pages reconstruct it exactly —
// no duplicate order_id, no skipped one, at any page boundary. A keyset on a non-unique column
// fails precisely here, and only here, so the dataset below is built to be hostile: long runs of
// identical ordered_at, a boundary that falls INSIDE such a run, and null ordered_at rows.
//
// This drives the REAL filter string keysetClause() emits through a small evaluator for the
// PostgREST subset it uses, rather than testing a parallel reimplementation of the logic.
// Run:  TZ=UTC node src/lib/member/unboundKeyset.test.mjs   (also correct under any host TZ)
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { pathToFileURL } from 'node:url'; import assert from 'node:assert/strict'; import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'uk-'));
const { outputText } = ts.transpileModule(
  readFileSync(new URL('./unboundKeyset.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const p = join(dir, 'uk.mjs'); writeFileSync(p, outputText);
const { keysetClause, orderBy, sortToDesc, encodeCursor, decodeCursor } = await import(pathToFileURL(p).href);

let passed = 0;
const check = (n, c, x = '') => { assert.ok(c, `FAIL: ${n} ${x}`); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); passed++; };

// ── A tiny evaluator for the PostgREST filter subset keysetClause emits ──────────────────────
// Grammar used: top-level comma = OR; and(...) = AND; leaf = col.op.value | col.is.null |
// col.not.is.null. Timestamps arrive double-quoted. Splitting respects parens and quotes.
function splitTop(src) {
  const out = []; let depth = 0, q = false, cur = '';
  for (const ch of src) {
    if (ch === '"') q = !q;
    if (!q && ch === '(') depth++;
    if (!q && ch === ')') depth--;
    if (!q && ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
function evalTerm(term, row) {
  if (term.startsWith('and(')) {
    return splitTop(term.slice(4, -1)).every((t) => evalTerm(t, row));
  }
  if (term.endsWith('.not.is.null')) return row[term.slice(0, -'.not.is.null'.length)] != null;
  if (term.endsWith('.is.null')) return row[term.slice(0, -'.is.null'.length)] == null;
  const m = term.match(/^([a-z_]+)\.(lt|gt|eq)\.(.*)$/);
  if (!m) throw new Error(`unparsed filter term: ${term}`);
  const [, col, op, rawVal] = m;
  const val = rawVal.startsWith('"') ? rawVal.slice(1, -1) : rawVal;
  const cell = row[col];
  if (cell == null) return false; // SQL: NULL compares false to everything
  // ordered_at is timestamptz in Postgres — compare as instants, not as strings.
  // order_id is text — compare as text, which is what PostgREST/Postgres does.
  const a = col === 'ordered_at' ? Date.parse(cell) : String(cell);
  const b = col === 'ordered_at' ? Date.parse(val) : String(val);
  if (op === 'lt') return a < b;
  if (op === 'gt') return a > b;
  return a === b;
}
const matches = (clause, row) => splitTop(clause).some((t) => evalTerm(t, row));

// Sort exactly as orderBy(desc) instructs PostgREST to.
function sortRows(rows, desc) {
  const [oa, oi] = orderBy(desc);
  return [...rows].sort((x, y) => {
    const xn = x.ordered_at == null, yn = y.ordered_at == null;
    if (xn !== yn) return xn ? (oa.nullsFirst ? -1 : 1) : (oa.nullsFirst ? 1 : -1);
    if (!xn && !yn) {
      const d = Date.parse(x.ordered_at) - Date.parse(y.ordered_at);
      if (d !== 0) return oa.ascending ? d : -d;
    }
    const c = String(x.order_id) < String(y.order_id) ? -1 : String(x.order_id) > String(y.order_id) ? 1 : 0;
    return oi.ascending ? c : -c;
  });
}

/** Page through `rows` the way the route does, returning the concatenated order_ids. */
function paginate(rows, desc, pageSize) {
  const full = sortRows(rows, desc);
  const seenIds = [];
  let cursor = null;
  for (let guard = 0; guard < 1000; guard++) {
    const pool = cursor ? full.filter((r) => matches(keysetClause(cursor, desc), r)) : full;
    const page = sortRows(pool, desc).slice(0, pageSize);
    if (!page.length) break;
    seenIds.push(...page.map((r) => r.order_id));
    const last = page[page.length - 1];
    // The route round-trips the cursor through base64 — exercise that too.
    cursor = decodeCursor(encodeCursor({ o: last.ordered_at ?? null, i: String(last.order_id) }));
    if (page.length < pageSize && pool.length <= pageSize) break;
  }
  return { seenIds, expected: full.map((r) => r.order_id) };
}

function assertExact(label, rows, desc, pageSize) {
  const { seenIds, expected } = paginate(rows, desc, pageSize);
  const dupes = seenIds.filter((id, i) => seenIds.indexOf(id) !== i);
  const missing = expected.filter((id) => !seenIds.includes(id));
  check(`${label}: no duplicates`, dupes.length === 0, dupes.length ? `dupes: ${[...new Set(dupes)].join(',')}` : `${seenIds.length} rows`);
  check(`${label}: no skipped rows`, missing.length === 0, missing.length ? `missing: ${missing.join(',')}` : `${expected.length} expected`);
  check(`${label}: exact order preserved`, JSON.stringify(seenIds) === JSON.stringify(expected));
}

// ── Datasets ────────────────────────────────────────────────────────────────────────────────
const T = (n) => new Date(Date.UTC(2026, 7, 10, 1, 0, 0) + n * 1000).toISOString();
const row = (id, t) => ({ order_id: id, ordered_at: t });

// Hostile by construction: a 7-row block sharing ONE instant, so a page boundary lands mid-run.
const tiedBlock = [];
for (let i = 0; i < 7; i++) tiedBlock.push(row(`5775000000000000${10 + i}`, T(100)));
const spread = [row('577500000000000001', T(0)), row('577500000000000002', T(50)),
  row('577500000000000003', T(200)), row('577500000000000004', T(300)),
  row('577500000000000005', T(400)), row('577500000000000006', T(500))];
const MIXED = [...spread, ...tiedBlock];
const ALL_TIED = Array.from({ length: 11 }, (_, i) => row(`5775000000000001${String(10 + i)}`, T(777)));
const WITH_NULLS = [...MIXED, row('577500000000000900', null), row('577500000000000901', null)];

console.log('\nkeyset — sortToDesc');
check("'newest' → desc", sortToDesc('newest') === true);
check("'oldest' → asc", sortToDesc('oldest') === false);
check('absent → desc (default unchanged)', sortToDesc(null) === true && sortToDesc(undefined) === true);
check('garbage → desc (never silently reverses)', sortToDesc('sideways') === true);

console.log('\npage boundaries — mixed timestamps with a tied run, BOTH directions');
for (const size of [2, 3, 5, 13]) {
  assertExact(`newest-first, page=${size}`, MIXED, true, size);
  assertExact(`oldest-first, page=${size}`, MIXED, false, size);
}

console.log('\npage boundaries — EVERY row shares one ordered_at (tiebreak carries it alone)');
for (const size of [1, 2, 4]) {
  assertExact(`all-tied newest, page=${size}`, ALL_TIED, true, size);
  assertExact(`all-tied oldest, page=${size}`, ALL_TIED, false, size);
}

console.log('\npage boundaries — with null ordered_at rows in scope ("All" + either sort)');
for (const size of [2, 3, 5]) {
  assertExact(`nulls newest, page=${size}`, WITH_NULLS, true, size);
  assertExact(`nulls oldest, page=${size}`, WITH_NULLS, false, size);
}

console.log('\nnull placement matches the nullsFirst setting');
{
  const desc = sortRows(WITH_NULLS, true).map((r) => r.ordered_at == null);
  const asc = sortRows(WITH_NULLS, false).map((r) => r.ordered_at == null);
  check('newest-first puts nulls LAST', desc.slice(-2).every(Boolean) && !desc.slice(0, -2).some(Boolean));
  check('oldest-first puts nulls FIRST', asc.slice(0, 2).every(Boolean) && !asc.slice(2).some(Boolean));
}

console.log('\nthe desc clause is null-aware (the branch that did not exist before)');
{
  const cNonNull = { o: T(200), i: '577500000000000003' };
  const cl = keysetClause(cNonNull, true);
  check('desc from a non-null cursor still reaches the trailing null group', cl.includes('ordered_at.is.null'), cl);
  check('desc from a null cursor confines to nulls',
    keysetClause({ o: null, i: '577500000000000901' }, true) === 'and(ordered_at.is.null,order_id.lt.577500000000000901)');
  check('desc never emits a quoted literal null', !keysetClause(cNonNull, true).includes('"null"'));
  // Regression guard for the old shape: `ordered_at.lt."null"` was what a null cursor would have produced.
  check('a null desc cursor cannot produce ordered_at.lt."null"',
    !keysetClause({ o: null, i: 'x' }, true).includes('lt."null"'));
}

console.log('\nasc clause unchanged in shape (no regression to the existing path)');
{
  check('asc from the null group spans nulls-after-id plus all non-nulls',
    keysetClause({ o: null, i: 'abc' }, false) === 'and(ordered_at.is.null,order_id.gt.abc),ordered_at.not.is.null');
  check('asc from a non-null cursor is the composite pair',
    keysetClause({ o: T(200), i: 'abc' }, false) === `ordered_at.gt."${T(200)}",and(ordered_at.eq."${T(200)}",order_id.gt.abc)`);
}

console.log('\ncursor round-trip');
{
  const c = { o: T(100), i: '577500000000000010' };
  check('encode → decode is lossless', JSON.stringify(decodeCursor(encodeCursor(c))) === JSON.stringify(c));
  check('null ordered_at survives the round-trip',
    JSON.stringify(decodeCursor(encodeCursor({ o: null, i: 'z' }))) === JSON.stringify({ o: null, i: 'z' }));
  check('garbage cursor → null (restart, never a throw)', decodeCursor('!!!not-base64!!!') === null);
}

console.log(`\n${passed} checks passed\n`);
