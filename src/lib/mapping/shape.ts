// A rack's physical shape, and what changing it does to the slots underneath.
//
// NO IMPORTS — shape.test.mjs transpiles this file standalone at runtime.
//
// A rack of S shelves and N sections has S x N section positions and therefore S x N x 2
// slots, because every position has a front and a back face reachable from different aisles.
//
// Reshaping is the one destructive operation in the Mapping UI: shrinking a rack destroys
// slots, and a destroyed slot may have had a SKU on it. planReshape reports that cost up
// front so the UI can require confirmation rather than discovering it afterwards.

export type Side = 'A' | 'B';

/**
 * Bounds. The DB enforces only the MINIMUMS (CHECK constraints in migration 115) — the
 * maximums live here on purpose, because raising a constant is a one-line change while
 * raising a CHECK constraint is another migration and another silence-gated apply.
 */
export const MIN_SHELVES = 2;
export const MAX_SHELVES = 5;
export const MIN_SECTIONS = 2;
export const MAX_SECTIONS = 6;

export const SIDES: Side[] = ['A', 'B'];

export interface SlotPosition {
  shelf_index: number;
  section_index: number;
  side: Side;
}

export interface ExistingSlot extends SlotPosition {
  id: string;
  inventory_sku_id: string | null;
}

export interface ReshapePlan {
  toCreate: SlotPosition[];
  toDeleteIds: string[];
  /** How many slots being destroyed currently hold a SKU. Non-zero needs confirmation. */
  assignedLost: number;
  /** Distinct SKUs that would be left unmapped by this reshape. */
  skusUnmapped: string[];
}

export function clampShelves(n: number): number {
  return Math.min(MAX_SHELVES, Math.max(MIN_SHELVES, Math.trunc(n)));
}

export function clampSections(n: number): number {
  return Math.min(MAX_SECTIONS, Math.max(MIN_SECTIONS, Math.trunc(n)));
}

/** Total slots a rack of this shape holds — both faces of every section. */
export function slotCount(shelfCount: number, sectionsPerShelf: number): number {
  return shelfCount * sectionsPerShelf * SIDES.length;
}

/**
 * Every slot position in a rack of this shape. Shelf 1 is the bottom and section 1 the
 * left, so the generated order reads the way someone standing at the rack would scan it.
 */
export function slotPositions(shelfCount: number, sectionsPerShelf: number): SlotPosition[] {
  const out: SlotPosition[] = [];
  for (let shelf = 1; shelf <= shelfCount; shelf++) {
    for (let section = 1; section <= sectionsPerShelf; section++) {
      for (const side of SIDES) {
        out.push({ shelf_index: shelf, section_index: section, side });
      }
    }
  }
  return out;
}

const keyOf = (p: SlotPosition) => `${p.shelf_index}:${p.section_index}:${p.side}`;

/**
 * Diff a rack's existing slots against a new shape.
 *
 * Slots that survive are left ALONE — not deleted and recreated — so their barcodes stay
 * valid and their SKU assignments stay put. Reprinting every label because a rack grew a
 * shelf would defeat the point of a permanent slot code.
 */
export function planReshape(
  existing: ExistingSlot[],
  shelfCount: number,
  sectionsPerShelf: number,
): ReshapePlan {
  const wanted = slotPositions(shelfCount, sectionsPerShelf);
  const wantedKeys = new Set(wanted.map(keyOf));
  const haveKeys = new Set(existing.map(keyOf));

  const toCreate = wanted.filter((p) => !haveKeys.has(keyOf(p)));
  const doomed = existing.filter((s) => !wantedKeys.has(keyOf(s)));

  // A SKU is only really unmapped if it has no surviving slot — a double-sided SKU losing
  // one face is still findable, so reporting it as lost would be a false alarm.
  const survivingSkus = new Set(
    existing.filter((s) => wantedKeys.has(keyOf(s)) && s.inventory_sku_id).map((s) => s.inventory_sku_id!),
  );
  const skusUnmapped = Array.from(
    new Set(doomed.map((s) => s.inventory_sku_id).filter((id): id is string => !!id)),
  ).filter((id) => !survivingSkus.has(id));

  return {
    toCreate,
    toDeleteIds: doomed.map((s) => s.id),
    assignedLost: doomed.filter((s) => s.inventory_sku_id).length,
    skusUnmapped,
  };
}
