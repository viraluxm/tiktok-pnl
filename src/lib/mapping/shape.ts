// A rack's shape: shelves are declared, sections are built up one at a time.
//
// NO IMPORTS — shape.test.mjs transpiles this file standalone at runtime.
//
// A rack declares only how many SHELVES it has. How many sections sit on a given shelf face
// is not a property of the rack at all — it is simply how many slot rows exist for that
// (shelf, side). Real racks are not uniform grids: one side can hold 4 sections while the
// other holds 6, and one shelf can be divided differently from the shelf above it.
//
// Because sections are per-FACE, front/back pairing is not structural: section 3 of side A
// is not necessarily behind section 3 of side B. "Picked from both sides" is therefore just
// the same SKU assigned on each side, which deriveRoute already resolves by taking whichever
// face the picker reaches first.

export type Side = 'A' | 'B';

export const MIN_SHELVES = 2;
export const MAX_SHELVES = 5;

/**
 * Most sections one shelf face may be divided into. A UI constant, not a DB constraint —
 * raising it is a one-line change rather than another migration and another apply.
 *
 * There is deliberately NO minimum. A newly created rack starts with no sections at all and
 * you add them by clicking the face you are looking at, so zero is a normal state rather
 * than an invalid one.
 */
export const MAX_SECTIONS = 6;

export const SIDES: Side[] = ['A', 'B'];

export interface SlotLike {
  id: string;
  shelf_index: number;
  section_index: number;
  side: Side;
  inventory_sku_id: string | null;
}

export function clampShelves(n: number): number {
  return Math.min(MAX_SHELVES, Math.max(MIN_SHELVES, Math.trunc(n)));
}

/** Shelf numbers for a rack, bottom (1) first. */
export function shelfIndexes(shelfCount: number): number[] {
  return Array.from({ length: shelfCount }, (_, i) => i + 1);
}

/**
 * The sections on one shelf face, in physical left-to-right order.
 *
 * Generic so callers keep their own richer slot type (with `slot_code` and the rest) instead
 * of having it narrowed away to SlotLike and needing a cast back.
 */
export function sectionsOn<T extends SlotLike>(slots: T[], shelf: number, side: Side): T[] {
  return slots
    .filter((s) => s.shelf_index === shelf && s.side === side)
    .sort((a, b) => a.section_index - b.section_index);
}

/**
 * The section number a newly added section should take on this shelf face, or null when the
 * face is already at MAX_SECTIONS.
 *
 * Always max + 1, never "lowest unused". Deleting a section in the middle therefore leaves a
 * gap (S1, S3) rather than renumbering the survivors — renumbering would silently change the
 * printed address on labels that are already on the rack, which is exactly the relabelling
 * churn the permanent slot code exists to prevent.
 */
export function nextSectionIndex(slots: SlotLike[], shelf: number, side: Side): number | null {
  const existing = sectionsOn(slots, shelf, side);
  if (existing.length >= MAX_SECTIONS) return null;
  return existing.reduce((max, s) => Math.max(max, s.section_index), 0) + 1;
}

export interface ShelfChangePlan {
  toDeleteIds: string[];
  /** How many destroyed slots currently hold a SKU. Non-zero needs confirmation. */
  assignedLost: number;
  /** Distinct SKUs left with no slot anywhere on this rack after the change. */
  skusUnmapped: string[];
}

/**
 * What changing a rack's shelf count does to its slots.
 *
 * Growing creates NOTHING — a new shelf arrives empty and you add sections to it by hand,
 * which is the whole point of dynamic sections. Only shrinking is destructive, and it
 * reports its cost so the UI can confirm before anything is lost.
 */
export function planShelfChange(existing: SlotLike[], newShelfCount: number): ShelfChangePlan {
  const doomed = existing.filter((s) => s.shelf_index > newShelfCount);
  const surviving = new Set(
    existing.filter((s) => s.shelf_index <= newShelfCount && s.inventory_sku_id)
      .map((s) => s.inventory_sku_id!),
  );

  // A SKU that still has a slot on a surviving shelf is not unmapped — reporting it would be
  // a false alarm, and false alarms on a destructive confirmation just train people to click
  // through it.
  const skusUnmapped = Array.from(
    new Set(doomed.map((s) => s.inventory_sku_id).filter((id): id is string => !!id)),
  ).filter((id) => !surviving.has(id));

  return {
    toDeleteIds: doomed.map((s) => s.id),
    assignedLost: doomed.filter((s) => s.inventory_sku_id).length,
    skusUnmapped,
  };
}

/** Per-face section counts for a rack, for summary display. */
export function faceCounts(
  slots: SlotLike[],
  shelfCount: number,
): Array<{ shelf: number; side: Side; sections: number; filled: number }> {
  const out: Array<{ shelf: number; side: Side; sections: number; filled: number }> = [];
  for (const shelf of shelfIndexes(shelfCount)) {
    for (const side of SIDES) {
      const on = sectionsOn(slots, shelf, side);
      out.push({
        shelf,
        side,
        sections: on.length,
        filled: on.filter((s) => s.inventory_sku_id).length,
      });
    }
  }
  return out;
}

/**
 * The next free rack name. Racks are auto-numbered R1, R2, R3… — there is no reason to make
 * someone name a rack, and free-text names drift out of sync with what is painted on the
 * floor.
 *
 * Max + 1 rather than count + 1, so deleting R2 out of R1/R2/R3 yields R4 and never reissues
 * a name that might still be on a printed label or in someone's head.
 */
export function nextRackName(existingNames: string[]): string {
  const highest = existingNames.reduce((max, n) => {
    const m = /^R(\d+)$/i.exec(n.trim());
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  return `R${highest + 1}`;
}
