// A rack's shape: shelves are declared, sections are added to a shelf one at a time.
//
// NO IMPORTS — shape.test.mjs transpiles this file standalone at runtime.
//
// A rack declares only how many SHELVES it has. A shelf is then divided into sections, and
// each section is ONE physical space that carries which aisle(s) it is picked from. That is
// the important distinction: reachability is a property of the space, not a second axis the
// rack is divided along. Modelling it as two parallel per-face layouts made adding one
// section look like it created a front and a back.
//
// Asymmetric racks still work: a shelf can carry four 'A' sections and six 'B' sections.
// They are simply one list you can see at once.

/** A physical face of a rack — what the walking route stops at. Always exactly two. */
export type RackSide = 'A' | 'B';

/** Which aisle(s) a section is picked from. 'AB' is one space reachable from both. */
export type SectionSide = 'A' | 'B' | 'AB';

export const MIN_SHELVES = 2;
export const MAX_SHELVES = 5;

/**
 * Most sections one shelf can present to a SINGLE side. Counted per side rather than per
 * shelf, so a shelf may hold up to six reachable from A and six from B — an 'AB' section
 * counts toward both, because it occupies a pickable position in each aisle.
 *
 * A UI constant, not a DB constraint: raising it is a one-line change rather than another
 * migration and another apply. There is deliberately no minimum — a new rack starts with no
 * sections and you add them by clicking, so zero is a normal state.
 */
export const MAX_SECTIONS_PER_SIDE = 6;

export const RACK_SIDES: RackSide[] = ['A', 'B'];
export const SECTION_SIDES: SectionSide[] = ['A', 'B', 'AB'];

export interface SlotLike {
  id: string;
  shelf_index: number;
  section_index: number;
  side: SectionSide;
  inventory_sku_id: string | null;
}

export function clampShelves(n: number): number {
  return Math.min(MAX_SHELVES, Math.max(MIN_SHELVES, Math.trunc(n)));
}

/** Shelf numbers for a rack, bottom (1) first. */
export function shelfIndexes(shelfCount: number): number[] {
  return Array.from({ length: shelfCount }, (_, i) => i + 1);
}

/** The rack faces a section can be picked from. */
export function reachableFrom(side: SectionSide): RackSide[] {
  return side === 'AB' ? ['A', 'B'] : [side];
}

export function isReachableFrom(side: SectionSide, face: RackSide): boolean {
  return side === 'AB' || side === face;
}

/** Every section on a shelf, both sides together, in section order. */
export function sectionsOn<T extends SlotLike>(slots: T[], shelf: number): T[] {
  return slots
    .filter((s) => s.shelf_index === shelf)
    .sort((a, b) => a.section_index - b.section_index);
}

/** Sections on a shelf that a picker standing in the given aisle can actually reach. */
export function sectionsFacing<T extends SlotLike>(slots: T[], shelf: number, face: RackSide): T[] {
  return sectionsOn(slots, shelf).filter((s) => isReachableFrom(s.side, face));
}

/**
 * Whether another section can be added to this shelf for the given side. An 'AB' section
 * occupies a position in BOTH aisles, so adding one requires room on each.
 */
export function canAddSection(slots: SlotLike[], shelf: number, side: SectionSide): boolean {
  return reachableFrom(side).every(
    (face) => sectionsFacing(slots, shelf, face).length < MAX_SECTIONS_PER_SIDE,
  );
}

/**
 * The number a newly added section takes on this shelf, or null when it cannot be added.
 *
 * Always max + 1 across the whole shelf, never "lowest unused". Deleting a section in the
 * middle therefore leaves a gap (S1, S3) rather than renumbering the survivors —
 * renumbering would silently change the address printed on labels already on the rack,
 * which is exactly the relabelling churn the permanent slot code exists to prevent.
 */
export function nextSectionIndex(
  slots: SlotLike[],
  shelf: number,
  side: SectionSide,
): number | null {
  if (!canAddSection(slots, shelf, side)) return null;
  return sectionsOn(slots, shelf).reduce((max, s) => Math.max(max, s.section_index), 0) + 1;
}

/**
 * Whether a section's side may be changed to `next`.
 *
 * Widening to 'AB' can be blocked: the section already occupies a position in its current
 * aisle, but the aisle it is gaining may already be full.
 */
export function canChangeSide(
  slots: SlotLike[],
  slot: SlotLike,
  next: SectionSide,
): boolean {
  const gaining = reachableFrom(next).filter((f) => !isReachableFrom(slot.side, f));
  return gaining.every(
    (face) => sectionsFacing(slots, slot.shelf_index, face).length < MAX_SECTIONS_PER_SIDE,
  );
}

export interface ShelfInsertPlan {
  /** The number the new shelf will take. */
  newShelfIndex: number;
  /** Existing shelves at or above this index shift up by one. */
  shiftFrom: number;
  /** Slots whose shelf_index changes — their printed level is now wrong. */
  renumbered: SlotLike[];
}

/**
 * Insert a shelf above or below an existing one.
 *
 * Shelf numbers are ORDINAL — L1 is the bottom — so a shelf cannot be inserted without
 * renumbering everything above it. That is not an implementation quirk; it is what physically
 * happens. Add a shelf below L3 and the shelf that was L3 is now the fourth one up, even
 * though it never moved.
 *
 * The consequence is real and worth surfacing rather than hiding: every printed label above
 * the insertion point shows a level that is no longer true. The BARCODES still resolve — they
 * encode an opaque slot id, not the address — so picking keeps working; it is the human
 * caption that goes stale. `renumbered` is exactly the set that needs reprinting.
 */
export function planShelfInsert(
  slots: SlotLike[],
  at: number,
  position: 'above' | 'below',
): ShelfInsertPlan {
  const newShelfIndex = position === 'above' ? at + 1 : at;
  return {
    newShelfIndex,
    shiftFrom: newShelfIndex,
    renumbered: slots.filter((s) => s.shelf_index >= newShelfIndex),
  };
}

export interface ShelfRemovePlan {
  toDeleteIds: string[];
  assignedLost: number;
  skusUnmapped: string[];
  /** Shelves above the removed one shift DOWN by one. */
  shiftFrom: number;
  renumbered: SlotLike[];
}

/**
 * Remove one shelf, wherever it sits.
 *
 * Destroys that shelf's sections and closes the gap, so — like insertion — everything above
 * renumbers and its printed captions go stale.
 */
export function planShelfRemove(slots: SlotLike[], shelf: number): ShelfRemovePlan {
  const doomed = slots.filter((s) => s.shelf_index === shelf);
  const surviving = new Set(
    slots.filter((s) => s.shelf_index !== shelf && s.inventory_sku_id)
      .map((s) => s.inventory_sku_id!),
  );
  return {
    toDeleteIds: doomed.map((s) => s.id),
    assignedLost: doomed.filter((s) => s.inventory_sku_id).length,
    skusUnmapped: Array.from(
      new Set(doomed.map((s) => s.inventory_sku_id).filter((id): id is string => !!id)),
    ).filter((id) => !surviving.has(id)),
    shiftFrom: shelf + 1,
    renumbered: slots.filter((s) => s.shelf_index > shelf),
  };
}

export interface ShelfChangePlan {
  toDeleteIds: string[];
  /** How many destroyed sections currently hold a SKU. Non-zero needs confirmation. */
  assignedLost: number;
  /** Distinct SKUs left with no section anywhere on this rack after the change. */
  skusUnmapped: string[];
}

/**
 * What changing a rack's shelf count does to its sections.
 *
 * Growing creates NOTHING — a new shelf arrives empty and you divide it by hand. Only
 * shrinking is destructive, and it reports its cost so the UI can confirm before anything
 * is lost.
 */
export function planShelfChange(existing: SlotLike[], newShelfCount: number): ShelfChangePlan {
  const doomed = existing.filter((s) => s.shelf_index > newShelfCount);
  const surviving = new Set(
    existing.filter((s) => s.shelf_index <= newShelfCount && s.inventory_sku_id)
      .map((s) => s.inventory_sku_id!),
  );

  // A SKU that still has a section on a surviving shelf is not unmapped — a false alarm here
  // just trains people to click through the confirmation.
  const skusUnmapped = Array.from(
    new Set(doomed.map((s) => s.inventory_sku_id).filter((id): id is string => !!id)),
  ).filter((id) => !surviving.has(id));

  return {
    toDeleteIds: doomed.map((s) => s.id),
    assignedLost: doomed.filter((s) => s.inventory_sku_id).length,
    skusUnmapped,
  };
}

/**
 * The next free rack name. Racks are auto-numbered R1, R2, R3… — there is no reason to make
 * someone name a rack, and free text drifts out of sync with what is painted on the floor.
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
