// Pure, framework-independent search / status-filter / sort helpers for the
// Inventory list. Deliberately has NO React / Supabase / DOM imports so it can
// be unit-tested directly under plain `node` (see filterSkus.test.mjs).
//
// These operate on already-fetched, already-org-scoped SKUs (the result of
// useInventorySkus()). They are DISPLAY-ONLY: they never mutate their input, do
// not touch the React Query cache, and are not aware of stores/orgs/RLS — all of
// that stays server-side. Quantities are read straight off qty_on_hand (the
// stored, FIFO-maintained column); no costing/FIFO logic is duplicated here.

// Default "low stock" floor used when a SKU has no usable reorder_point.
export const LOW_STOCK_DEFAULT_THRESHOLD = 5;

export type InventoryStatusFilter = 'all' | 'low' | 'out';
export type InventorySort = 'sku-asc' | 'stock-asc' | 'stock-desc' | 'updated-desc';

// Structural subset of InventorySku that these helpers actually read. Keeping a
// local shape (rather than importing InventorySku) makes the module trivially
// testable with plain objects; the real InventorySku is assignable to it.
export interface InventorySkuLike {
  sku_number: number;
  barcode: string | null;
  title: string | null;
  shortcut_letter: string | null;
  category: string | null;
  qty_on_hand: number;
  reorder_point: number | null;
  updated_at: string;
}

// Lowercased string for a possibly-missing value; numbers become their digits.
function norm(v: unknown): string {
  return v == null ? '' : String(v).toLowerCase();
}

// Case-insensitive, null-safe partial match across the four searchable fields:
// title, sku_number (as a string), barcode, and shortcut_letter. An empty /
// whitespace-only query matches everything.
export function matchesInventorySearch(sku: InventorySkuLike, rawQuery: string): boolean {
  const q = (rawQuery ?? '').trim().toLowerCase();
  if (!q) return true;
  return (
    norm(sku.title).includes(q) ||
    norm(sku.sku_number).includes(q) ||
    norm(sku.barcode).includes(q) ||
    norm(sku.shortcut_letter).includes(q)
  );
}

export function searchInventory<T extends InventorySkuLike>(list: readonly T[], query: string): T[] {
  const q = (query ?? '').trim();
  if (!q) return list.slice(); // new array; never leak the input reference
  return list.filter((s) => matchesInventorySearch(s, q));
}

// Per-SKU low-stock floor: an explicit positive reorder_point wins, else the
// default. Guards against null / 0 / negative reorder_point (the PATCH endpoint
// does not validate it), which would otherwise make the low filter never fire.
export function lowStockThreshold(sku: Pick<InventorySkuLike, 'reorder_point'>): number {
  const rp = sku.reorder_point;
  return rp != null && rp > 0 ? rp : LOW_STOCK_DEFAULT_THRESHOLD;
}

// Derived stock status for one SKU:
//   out  → qty_on_hand <= 0  (0 and oversold negatives both count as out)
//   low  → 0 < qty_on_hand <= threshold
//   in   → qty_on_hand > threshold
export function inventoryStatusOf(sku: InventorySkuLike): 'in' | 'low' | 'out' {
  const qty = sku.qty_on_hand ?? 0;
  if (qty <= 0) return 'out';
  if (qty <= lowStockThreshold(sku)) return 'low';
  return 'in';
}

export function filterInventoryByStatus<T extends InventorySkuLike>(
  list: readonly T[],
  status: InventoryStatusFilter,
): T[] {
  if (status === 'all') return list.slice();
  return list.filter((s) => inventoryStatusOf(s) === status);
}

// Milliseconds for an ISO updated_at; unparseable / missing sorts oldest.
function updatedMs(s: Pick<InventorySkuLike, 'updated_at'>): number {
  const t = s.updated_at ? Date.parse(s.updated_at) : NaN;
  return Number.isFinite(t) ? t : 0;
}

// Always returns a NEW array (never mutates the input / the React Query cache).
// V8's sort is stable, so equal keys keep their incoming order.
export function sortInventorySkus<T extends InventorySkuLike>(list: readonly T[], sort: InventorySort): T[] {
  const copy = list.slice();
  switch (sort) {
    case 'stock-asc':
      copy.sort((a, b) => (a.qty_on_hand ?? 0) - (b.qty_on_hand ?? 0));
      break;
    case 'stock-desc':
      copy.sort((a, b) => (b.qty_on_hand ?? 0) - (a.qty_on_hand ?? 0));
      break;
    case 'updated-desc':
      copy.sort((a, b) => updatedMs(b) - updatedMs(a));
      break;
    case 'sku-asc':
    default:
      // Preserves the existing default (server returns sku_number ascending).
      copy.sort((a, b) => (a.sku_number ?? 0) - (b.sku_number ?? 0));
      break;
  }
  return copy;
}

export interface DeriveVisibleOptions {
  // 'all' (default) or a specific category value to keep. Category is applied
  // FIRST to mirror the existing list behavior; when omitted, the input is
  // assumed already category-scoped and this step is a no-op.
  category?: string;
  search?: string;
  status?: InventoryStatusFilter;
  sort?: InventorySort;
}

// Full display pipeline: category → search → status → sort. Each stage returns a
// new array, so the original list (the cached query data) is never mutated.
export function deriveVisibleInventorySkus<T extends InventorySkuLike>(
  list: readonly T[],
  opts: DeriveVisibleOptions = {},
): T[] {
  const { category = 'all', search = '', status = 'all', sort = 'sku-asc' } = opts;
  const byCategory = category === 'all' ? list.slice() : list.filter((s) => s.category === category);
  const bySearch = searchInventory(byCategory, search);
  const byStatus = filterInventoryByStatus(bySearch, status);
  return sortInventorySkus(byStatus, sort);
}
