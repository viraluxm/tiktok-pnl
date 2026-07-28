// Unit proof for the Inventory search / status-filter / sort helpers
// (feat/inventory-search-filters).
//
// No app test runner exists, so this transpiles filterSkus.ts at runtime via the
// repo's `typescript` devDep (matching src/lib/training/session.test.mjs) and
// exercises the REAL matchesInventorySearch / searchInventory / lowStockThreshold
// / inventoryStatusOf / filterInventoryByStatus / sortInventorySkus /
// deriveVisibleInventorySkus.
//
// Run:  node src/lib/inventory/filterSkus.test.mjs

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./filterSkus.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'invfilter-')), 'filterSkus.mjs');
writeFileSync(outFile, outputText);
const {
  LOW_STOCK_DEFAULT_THRESHOLD,
  matchesInventorySearch,
  searchInventory,
  lowStockThreshold,
  inventoryStatusOf,
  filterInventoryByStatus,
  sortInventorySkus,
  deriveVisibleInventorySkus,
} = await import(pathToFileURL(outFile).href);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

// Minimal SKU factory — every field a helper reads, overridable per case.
const mk = (over = {}) => ({
  sku_number: 1,
  barcode: '',
  title: '',
  shortcut_letter: null,
  category: null,
  qty_on_hand: 10,
  reorder_point: null,
  updated_at: '2026-01-01T00:00:00.000Z',
  ...over,
});

const ids = (list) => list.map((s) => s.sku_number);

// ── 1. SKU-number search ──
{
  const list = [mk({ sku_number: 207, title: 'Blue Widget' }), mk({ sku_number: 42, title: 'Red Gizmo' })];
  check('SKU-number search', ids(searchInventory(list, '207')).join() === '207');
  check('SKU-number search (numeric coerced to string)', matchesInventorySearch(mk({ sku_number: 42 }), '42'));
}

// ── 2. Barcode search ──
{
  const list = [mk({ sku_number: 1, barcode: 'ABC-1234-XYZ' }), mk({ sku_number: 2, barcode: 'ZZZ-9999' })];
  check('barcode partial search', ids(searchInventory(list, '1234')).join() === '1');
}

// ── 3. Product-title search ──
{
  const list = [mk({ sku_number: 1, title: 'Blue Squishmallow' }), mk({ sku_number: 2, title: 'Charging Cable' })];
  check('title word search', ids(searchInventory(list, 'squish')).join() === '1');
}

// ── 4. Shortcut-letter search ──
{
  const list = [mk({ sku_number: 1, shortcut_letter: 'A' }), mk({ sku_number: 2, shortcut_letter: 'B' })];
  check('shortcut-letter search', ids(searchInventory(list, 'a')).join() === '1');
}

// ── 5. Case-insensitive matching ──
{
  const s = mk({ title: 'Blue Widget' });
  check('case-insensitive (upper query)', matchesInventorySearch(s, 'BLUE'));
  check('case-insensitive (mixed query)', matchesInventorySearch(s, 'wIdGeT'));
}

// ── 6. Partial-string matching ──
check('partial substring', matchesInventorySearch(mk({ title: 'Blue Widget' }), 'wid'));

// ── 7. Empty search returns everything ──
{
  const list = [mk({ sku_number: 1 }), mk({ sku_number: 2 }), mk({ sku_number: 3 })];
  check('empty query returns all', searchInventory(list, '').length === 3);
  check('whitespace-only query returns all', searchInventory(list, '   ').length === 3);
  check('empty query matches any row', matchesInventorySearch(mk(), ''));
}

// ── 8. No results ──
{
  const list = [mk({ sku_number: 1, title: 'Widget' }), mk({ sku_number: 2, title: 'Gizmo' })];
  check('no-match returns []', searchInventory(list, 'zzzzz').length === 0);
}

// ── 9. Null / empty searchable fields are safe ──
{
  const sparse = mk({ sku_number: 77, title: null, barcode: null, shortcut_letter: null });
  check('null fields do not throw + sku_number still matches', matchesInventorySearch(sparse, '77'));
  check('null fields: unrelated query is a clean miss', matchesInventorySearch(sparse, 'anything') === false);
  check('empty-string fields are a clean miss', matchesInventorySearch(mk({ title: '', barcode: '' }), 'x') === false);
}

// ── 10. Low-stock default threshold of 5 ──
{
  check('default threshold constant is 5', LOW_STOCK_DEFAULT_THRESHOLD === 5);
  check('threshold falls back to 5 when reorder_point null', lowStockThreshold(mk({ reorder_point: null })) === 5);
  check('qty 5, no reorder_point → low', inventoryStatusOf(mk({ qty_on_hand: 5, reorder_point: null })) === 'low');
  check('qty 6, no reorder_point → not low (in)', inventoryStatusOf(mk({ qty_on_hand: 6, reorder_point: null })) === 'in');
  check('threshold falls back to 5 when reorder_point is 0', lowStockThreshold(mk({ reorder_point: 0 })) === 5);
  check('threshold falls back to 5 when reorder_point negative', lowStockThreshold(mk({ reorder_point: -3 })) === 5);
}

// ── 11. Low-stock custom positive reorder_point ──
{
  check('custom reorder_point wins', lowStockThreshold(mk({ reorder_point: 10 })) === 10);
  check('qty 8 with reorder_point 10 → low', inventoryStatusOf(mk({ qty_on_hand: 8, reorder_point: 10 })) === 'low');
  check('qty 11 with reorder_point 10 → in', inventoryStatusOf(mk({ qty_on_hand: 11, reorder_point: 10 })) === 'in');
  const list = [
    mk({ sku_number: 1, qty_on_hand: 8, reorder_point: 10 }), // low (custom)
    mk({ sku_number: 2, qty_on_hand: 8, reorder_point: null }), // in (default 5)
  ];
  check('low filter honors per-SKU reorder_point', ids(filterInventoryByStatus(list, 'low')).join() === '1');
}

// ── 12. Zero excluded from low ──
check('qty 0 is NOT low', inventoryStatusOf(mk({ qty_on_hand: 0 })) !== 'low');

// ── 13. Zero included in out of stock ──
{
  check('qty 0 → out', inventoryStatusOf(mk({ qty_on_hand: 0 })) === 'out');
  const list = [mk({ sku_number: 1, qty_on_hand: 0 }), mk({ sku_number: 2, qty_on_hand: 10 })];
  check('out filter includes qty 0', ids(filterInventoryByStatus(list, 'out')).join() === '1');
}

// ── 14. Negative quantities included in out of stock ──
{
  check('qty -3 (oversold) → out', inventoryStatusOf(mk({ qty_on_hand: -3 })) === 'out');
  const list = [mk({ sku_number: 1, qty_on_hand: -3 }), mk({ sku_number: 2, qty_on_hand: 0 }), mk({ sku_number: 3, qty_on_hand: 4 })];
  check('out filter includes negatives and zero', ids(filterInventoryByStatus(list, 'out')).sort().join() === '1,2');
}

// ── 15. Lowest-stock sorting ──
{
  const list = [mk({ sku_number: 1, qty_on_hand: 10 }), mk({ sku_number: 2, qty_on_hand: -2 }), mk({ sku_number: 3, qty_on_hand: 5 }), mk({ sku_number: 4, qty_on_hand: 0 })];
  check('stock-asc sorts lowest (incl. negatives) first', sortInventorySkus(list, 'stock-asc').map((s) => s.qty_on_hand).join() === '-2,0,5,10');
}

// ── 16. Highest-stock sorting ──
{
  const list = [mk({ sku_number: 1, qty_on_hand: 10 }), mk({ sku_number: 2, qty_on_hand: -2 }), mk({ sku_number: 3, qty_on_hand: 5 }), mk({ sku_number: 4, qty_on_hand: 0 })];
  check('stock-desc sorts highest first', sortInventorySkus(list, 'stock-desc').map((s) => s.qty_on_hand).join() === '10,5,0,-2');
}

// ── 17. Recently-updated sorting ──
{
  const list = [
    mk({ sku_number: 1, updated_at: '2026-01-01T00:00:00.000Z' }),
    mk({ sku_number: 2, updated_at: '2026-07-01T00:00:00.000Z' }),
    mk({ sku_number: 3, updated_at: '2026-03-15T00:00:00.000Z' }),
  ];
  check('updated-desc sorts most-recent first', ids(sortInventorySkus(list, 'updated-desc')).join() === '2,3,1');
  // Missing/invalid updated_at sorts oldest, without throwing.
  const withBad = [mk({ sku_number: 9, updated_at: '' }), mk({ sku_number: 10, updated_at: '2026-05-01T00:00:00.000Z' })];
  check('updated-desc tolerates empty timestamp', ids(sortInventorySkus(withBad, 'updated-desc')).join() === '10,9');
}

// ── 18. Default SKU-number sorting ──
{
  const list = [mk({ sku_number: 3 }), mk({ sku_number: 1 }), mk({ sku_number: 2 })];
  check('sku-asc sorts by sku_number ascending', ids(sortInventorySkus(list, 'sku-asc')).join() === '1,2,3');
}

// ── 19. Combined category + search + status + sort ──
{
  const list = [
    mk({ sku_number: 1, category: 'squish', title: 'Squish Bear', qty_on_hand: 3, reorder_point: null }), // squish, low, matches "bear"
    mk({ sku_number: 2, category: 'squish', title: 'Squish Bear Deluxe', qty_on_hand: 2, reorder_point: null }), // squish, low, matches "bear"
    mk({ sku_number: 3, category: 'squish', title: 'Bear Cable', qty_on_hand: 50, reorder_point: null }), // squish but IN stock (excluded by low)
    mk({ sku_number: 4, category: 'electronics', title: 'Bear Charger', qty_on_hand: 1, reorder_point: null }), // wrong category (excluded)
    mk({ sku_number: 5, category: 'squish', title: 'Bear Mini', qty_on_hand: 4, reorder_point: null }), // squish, low, matches "bear"
  ];
  const out = deriveVisibleInventorySkus(list, { category: 'squish', search: 'bear', status: 'low', sort: 'stock-desc' });
  // squish ∩ title~"bear" ∩ low(0<q≤5) → {1:q3, 2:q2, 5:q4} ; then stock-desc → [5(4), 1(3), 2(2)]
  check('combined pipeline filters + sorts correctly', ids(out).join() === '5,1,2', `got ${ids(out).join()}`);
}

// ── 19b. deriveVisibleInventorySkus defaults (category omitted = already scoped) ──
{
  const list = [mk({ sku_number: 3 }), mk({ sku_number: 1 }), mk({ sku_number: 2 })];
  check('derive default is sku-asc pass-through', ids(deriveVisibleInventorySkus(list)).join() === '1,2,3');
}

// ── 20. Input array is not mutated ──
{
  const input = Object.freeze([
    mk({ sku_number: 3, qty_on_hand: 30 }),
    mk({ sku_number: 1, qty_on_hand: 10 }),
    mk({ sku_number: 2, qty_on_hand: 20 }),
  ]);
  const before = ids(input).join();
  sortInventorySkus(input, 'stock-asc');
  filterInventoryByStatus(input, 'out');
  searchInventory(input, 'x');
  deriveVisibleInventorySkus(input, { sort: 'stock-desc', status: 'all' });
  check('input order unchanged after all operations', ids(input).join() === before, `before=${before}`);
}

// ── 21. Returned sorted array is a NEW array ──
{
  const input = [mk({ sku_number: 1 }), mk({ sku_number: 2 })];
  check('sortInventorySkus returns a new array', sortInventorySkus(input, 'sku-asc') !== input);
  check('searchInventory (empty query) returns a new array', searchInventory(input, '') !== input);
  check('filterInventoryByStatus (all) returns a new array', filterInventoryByStatus(input, 'all') !== input);
  check('deriveVisibleInventorySkus returns a new array', deriveVisibleInventorySkus(input) !== input);
}

console.log(`\nAll ${passed} inventory filter/sort assertions passed.`);
