// Proof for the paged reader. The bug it exists to prevent is a SHORT read that looks
// complete, so most of these assert that it either returns everything or throws — never
// something plausible in between.
// Run:  node src/lib/db/readAll.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./readAll.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'readall-')), 'readAll.mjs');
writeFileSync(outFile, outputText);
const { readAllPaged, readPages, PAGE_SIZE } = await import(pathToFileURL(outFile).href);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

/**
 * A fake table of `total` rows that honours its range argument and counts requests.
 *
 * Crucially it REJECTS an unsatisfiable range (start beyond end) the way PostgREST does. An
 * earlier version just returned an empty array, which made it more forgiving than reality —
 * and a fake more forgiving than reality is how the clamped-range outage got past its tests in
 * the first place.
 */
function fakeTable(total) {
  const calls = [];
  const q = (from, to) => {
    calls.push([from, to]);
    if (from > to) {
      return Promise.resolve({ data: null, error: { message: 'Requested range not satisfiable' } });
    }
    const rows = [];
    for (let i = from; i <= to && i < total; i++) rows.push({ i });
    return Promise.resolve({ data: rows, error: null });
  };
  return { q, calls };
}

console.log('\nExhaustion');
{
  const { q, calls } = fakeTable(0);
  const rows = await readAllPaged(q, 'empty');
  check('an empty table returns nothing in one request', rows.length === 0 && calls.length === 1);
}
{
  const { q, calls } = fakeTable(10);
  const rows = await readAllPaged(q, 'small');
  check('a short first page ends immediately', rows.length === 10 && calls.length === 1);
}
{
  // The exact case that broke fulfillment performance: 1,159 rows read as 1000.
  const { q, calls } = fakeTable(1159);
  const rows = await readAllPaged(q, 'the 2026-08-31 case');
  check('1,159 rows are ALL returned, not 1000', rows.length === 1159, `got ${rows.length}`);
  check('…across two requests', calls.length === 2);
  check('…and they are contiguous and complete',
    rows.every((r, i) => r.i === i));
}
{
  // A total that is an exact multiple must still make one more request to prove the end. A
  // full page is indistinguishable from a truncated one.
  const { q, calls } = fakeTable(PAGE_SIZE);
  const rows = await readAllPaged(q, 'exact multiple');
  check('an exactly-full page is followed by a confirming request',
    rows.length === PAGE_SIZE && calls.length === 2, `${calls.length} requests`);
}
{
  const { q, calls } = fakeTable(PAGE_SIZE * 3);
  const rows = await readAllPaged(q, 'three full pages');
  check('three full pages need a fourth request to confirm',
    rows.length === PAGE_SIZE * 3 && calls.length === 4, `${calls.length} requests`);
}
{
  const t = fakeTable(2500);
  await readAllPaged(t.q, 'ranges');
  check('requested ranges tile the table without gaps or overlap',
    t.calls.every(([from, to], n) => from === n * PAGE_SIZE && to === n * PAGE_SIZE + PAGE_SIZE - 1),
    t.calls.map(([f, to]) => `${f}-${to}`).join(' '));
}

console.log('\nFails loud, never short');
{
  let threw = false;
  try {
    await readAllPaged(() => Promise.resolve({ data: null, error: { message: 'boom' } }), 'err');
  } catch (e) { threw = /boom/.test(e.message); }
  check('a query error THROWS rather than returning nothing', threw);
}
{
  // The dangerous shape: page 1 succeeds, page 2 fails. Returning page 1 would be a
  // plausible-looking partial read — exactly the bug this helper exists to prevent.
  let n = 0;
  let threw = false;
  try {
    await readAllPaged((from, to) => {
      n++;
      if (n === 1) {
        const rows = [];
        for (let i = from; i <= to; i++) rows.push({ i });
        return Promise.resolve({ data: rows, error: null });
      }
      return Promise.resolve({ data: null, error: { message: 'page 2 died' } });
    }, 'mid-read failure');
  } catch (e) { threw = /page 2 died/.test(e.message); }
  check('a failure AFTER a good page throws, discarding the partial', threw);
}
{
  let threw = false;
  try {
    // A builder that ignores its range returns a full page forever.
    await readAllPaged(() => {
      const rows = [];
      for (let i = 0; i < PAGE_SIZE; i++) rows.push({ i });
      return Promise.resolve({ data: rows, error: null });
    }, 'runaway');
  } catch (e) { threw = /exceeded/.test(e.message) && /ignoring its range/.test(e.message); }
  check('a builder that ignores its range hits the ceiling and throws', threw);
}
{
  let msg = '';
  try {
    await readAllPaged(() => Promise.resolve({ data: null, error: { message: 'x' } }), 'my-label');
  } catch (e) { msg = e.message; }
  check('the label is in the error, so the failing read is identifiable',
    msg.includes('my-label'), msg);
}
{
  const rows = await readAllPaged(() => Promise.resolve({ data: null, error: null }), 'null data');
  check('null data with no error is treated as an empty page, not a crash', rows.length === 0);
}

console.log('\nreadPages — a bounded read, and the outage it exists to prevent');
{
  // THE REGRESSION. A caller with an exact-multiple budget used to express it by clamping the
  // range, which made the final page exactly full, which made readAllPaged request the next
  // page at `range(1000, 999)` — rejected by PostgREST as "Requested range not satisfiable".
  // readAllPaged threw, and the sync cron's status phase died on every store having examined
  // nothing. Reproduced here against the real failure mode.
  const { q } = fakeTable(5000);
  let threw = null;
  try {
    await readAllPaged((from, to) => q(from, Math.min(to, 1000 - 1)), 'clamped-range');
  } catch (e) { threw = e.message; }
  check('the old clamped-range shape DOES break',
    threw !== null && /not satisfiable/.test(threw), String(threw).slice(0, 70));
}
{
  // The same budget via readPages: stops cleanly, no out-of-range request.
  const t = fakeTable(5000);
  const r = await readPages(t.q, 'bounded', 1);
  check('readPages stops at its page cap without an extra request',
    r.rows.length === PAGE_SIZE && t.calls.length === 1, `${r.rows.length} rows, ${t.calls.length} calls`);
  check('…and every requested range is satisfiable',
    t.calls.every(([from, to]) => to >= from));
  check('…and it SAYS the result is partial', r.reachedCap === true);
}
{
  const t = fakeTable(5000);
  const r = await readPages(t.q, 'bounded', 3);
  check('a 3-page cap reads 3 pages', r.rows.length === 3 * PAGE_SIZE && r.reachedCap === true);
  check('rows are contiguous from the start', r.rows.every((row, i) => row.i === i));
}
{
  // Finishing inside the budget must NOT be reported as capped, or a caller cannot tell
  // "there may be more" from "that was everything".
  const r = await readPages(fakeTable(1500).q, 'bounded', 5);
  check('finishing early reports reachedCap false',
    r.rows.length === 1500 && r.reachedCap === false, `${r.rows.length}`);
}
{
  const r = await readPages(fakeTable(0).q, 'bounded', 5);
  check('an empty table is not "capped"', r.rows.length === 0 && r.reachedCap === false);
}
{
  const t = fakeTable(5000);
  const r = await readPages(t.q, 'bounded', 0);
  check('a zero cap reads nothing and issues no request',
    r.rows.length === 0 && t.calls.length === 0 && r.reachedCap === true);
}
{
  let threw = false;
  try {
    await readPages(() => Promise.resolve({ data: null, error: { message: 'db down' } }), 'bounded', 3);
  } catch (e) { threw = /db down/.test(e.message) && /bounded/.test(e.message); }
  check('a query error still THROWS — a bounded read is partial by budget, not by failure', threw);
}

console.log(`\n${passed} checks passed\n`);
