// Isometric projection for the rack view.
//
// NO IMPORTS — iso.test.mjs transpiles this file standalone at runtime.
//
// WHY ISOMETRIC: a rack has a front and a back, and that is exactly the thing the flat view
// could not show. Here a section picked from aisle A sits in the front row, one picked from
// aisle B sits behind it, and a section picked from BOTH is a single deep box spanning the
// two rows. "Picked from both sides" stops being a badge you have to decode and becomes the
// shape of the box.
//
// AXES — a right-handed lattice, in rack terms rather than graphics terms:
//   x  along the shelf, left to right (section position)
//   z  depth into the rack: 0 = the BACK row (side B), 1 = the FRONT row (side A)
//   y  height, supplied in PIXELS rather than lattice units, because shelf spacing and box
//      height are independent of the floor grid.
//
// Screen mapping is the classic 2:1 dimetric:  sx = (x - z)·W,  sy = (x + z)·H - y
// Increasing x moves right-and-down; increasing z moves left-and-down. Both move *toward*
// the viewer, which is why depth ordering is by (x + z) — see paintOrder.

export interface Pt {
  x: number;
  y: number;
}

export interface IsoScale {
  /** Horizontal half-step per lattice unit. */
  W: number;
  /** Vertical half-step per lattice unit — half of W gives the 2:1 look. */
  H: number;
  /** Pixels between one shelf and the next. */
  LEVEL: number;
  /** Height of a section box in pixels. Kept below LEVEL so the shelf beam shows. */
  BOX_H: number;
}

// LEVEL is generous ON PURPOSE, and the value is load-bearing rather than taste.
//
// In isometric, a box on an upper shelf projects DOWNWARD across the shelf beneath it, and a
// back-row box at x lands in the same screen column as a front-row box at x+1. At tight
// spacing those two facts combine and back-row sections disappear entirely behind the row in
// front or the shelf above — measured, not guessed: at LEVEL 62 a back section's label was
// fully covered. 85 clears it with margin: the tallest thing a box occupies on screen is its
// height plus its projected depth, ~71px for a both-sides box, so anything below ~75 starts
// swallowing the row beneath. iso.test.mjs pins that relationship, so shrinking this to "look
// tidier" fails loudly instead of silently hiding sections an operator needs to click.
export const ISO: IsoScale = { W: 26, H: 13, LEVEL: 85, BOX_H: 30 };

/** Space left between neighbouring boxes so they read as separate objects. */
export const GAP = 0.16;

/**
 * Extra separation between the back row and the front row, on top of GAP. Without it the two
 * rows project onto overlapping screen columns and the back one is swallowed.
 */
export const ROW_GAP = 0.45;

/** Height of a box's base above its shelf beam. */
export const BOX_LIFT = 7;

/** Project a lattice point at a given pixel height to screen space. */
export function project(x: number, z: number, yPx: number, iso: IsoScale = ISO): Pt {
  return {
    x: (x - z) * iso.W,
    y: (x + z) * iso.H - yPx,
  };
}

export interface Box {
  /** Left edge along the shelf. */
  x: number;
  /** Back edge in depth. 0 = back row, 1 = front row. */
  z: number;
  /** Width along the shelf, in lattice units. */
  w: number;
  /** Depth, in lattice units. 1 = one row, 2 = spans both rows (picked from both sides). */
  d: number;
  /** Height of the box's base, in pixels above the rack floor. */
  baseY: number;
  /** Height of the box, in pixels. */
  h: number;
}

export interface BoxFaces {
  /** The lid. */
  top: Pt[];
  /** The face pointing right-and-down the screen (+x). */
  right: Pt[];
  /** The face pointing left-and-down the screen, toward the viewer (+z). */
  front: Pt[];
}

/**
 * The three faces of a box that a viewer can actually see, each as a closed 4-point polygon.
 *
 * The hidden three (bottom, -x, -z) are never emitted: drawing them would only cost paint and
 * they can never be picked, so a face polygon here is always a real click target.
 */
export function boxFaces(b: Box, iso: IsoScale = ISO): BoxFaces {
  const topY = b.baseY + b.h;
  const x0 = b.x;
  const x1 = b.x + b.w;
  const z0 = b.z;
  const z1 = b.z + b.d;

  return {
    top: [
      project(x0, z0, topY, iso),
      project(x1, z0, topY, iso),
      project(x1, z1, topY, iso),
      project(x0, z1, topY, iso),
    ],
    right: [
      project(x1, z0, topY, iso),
      project(x1, z1, topY, iso),
      project(x1, z1, b.baseY, iso),
      project(x1, z0, b.baseY, iso),
    ],
    front: [
      project(x0, z1, topY, iso),
      project(x1, z1, topY, iso),
      project(x1, z1, b.baseY, iso),
      project(x0, z1, b.baseY, iso),
    ],
  };
}

/** A polygon as an SVG `points` string. */
export function toPoints(poly: Pt[]): string {
  return poly.map((p) => `${round(p.x)},${round(p.y)}`).join(' ');
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Painter's-algorithm ordering: far boxes first, near boxes last, so nearer boxes overlap
 * the ones behind them instead of the reverse.
 *
 * Depth key is (x + z), because both axes move toward the viewer on screen. Ties break on
 * height, LOWER first — a box on an upper shelf is drawn after the one below it, so an
 * overhanging lid never gets clipped by the shelf underneath.
 */
export function paintOrder<T extends { x: number; z: number; baseY: number }>(boxes: T[]): T[] {
  return boxes
    .slice()
    .sort((a, b) => (a.x + a.z) - (b.x + b.z) || a.baseY - b.baseY);
}

/** Axis-aligned screen bounds of a set of polygons, for sizing the SVG viewBox. */
export function bounds(polys: Pt[][]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of polys) {
    for (const p of poly) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (minX === Infinity) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

export interface ShelfPlacement<T> {
  section: T;
  x: number;
  z: number;
  d: number;
}

/**
 * Lay one shelf's sections out along the x axis.
 *
 * The front and back rows each advance independently, because a section at the front and one
 * at the back can physically sit back-to-back at the same point along the shelf. A both-sides
 * section consumes a position in BOTH rows and is placed at the first x where both are free,
 * so the two rows stay aligned around it rather than drifting apart.
 *
 * Sections are taken in section_index order, so a shelf's drawn layout matches its numbering
 * and the printed labels.
 */
export function layoutShelf<T extends { section_index: number; side: 'A' | 'B' | 'AB' }>(
  sections: T[],
): ShelfPlacement<T>[] {
  let nextA = 0;
  let nextB = 0;
  return sections
    .slice()
    .sort((a, b) => a.section_index - b.section_index)
    .map((section) => {
      const { z, d } = depthFor(section.side);
      let x: number;
      if (section.side === 'AB') {
        x = Math.max(nextA, nextB);
        nextA = x + 1;
        nextB = x + 1;
      } else if (section.side === 'A') {
        x = nextA;
        nextA = x + 1;
      } else {
        x = nextB;
        nextB = x + 1;
      }
      return { section, x, z, d };
    });
}

export interface RackBox<T> extends Box {
  section: T;
}

export interface RackSectionLike {
  shelf_index: number;
  section_index: number;
  side: 'A' | 'B' | 'AB';
}

/**
 * Turn a rack's sections into drawable boxes: shelf by shelf, laid out along x, lifted to
 * their shelf height, and inset by GAP / ROW_GAP so neighbours and rows stay distinguishable.
 *
 * Returned unordered — pass the result through paintOrder before drawing.
 */
export function layoutRack<T extends RackSectionLike>(
  sections: T[],
  shelfCount: number,
  iso: IsoScale = ISO,
): RackBox<T>[] {
  const out: RackBox<T>[] = [];
  for (let shelf = 1; shelf <= shelfCount; shelf++) {
    const onShelf = sections.filter((s) => s.shelf_index === shelf);
    const baseY = (shelf - 1) * iso.LEVEL + BOX_LIFT;
    for (const placed of layoutShelf(onShelf)) {
      // The front row is pushed away from the back row; a spanning box absorbs that gap into
      // its own depth so it still meets both rows.
      const z = placed.z + GAP / 2 + (placed.z >= 1 ? ROW_GAP : 0);
      const d = placed.d - GAP + (placed.d === 2 ? ROW_GAP : 0);
      out.push({
        section: placed.section,
        x: placed.x + GAP / 2,
        z,
        w: 1 - GAP,
        d,
        baseY,
        h: iso.BOX_H,
      });
    }
  }
  return out;
}

/** Total depth the rack occupies in lattice units, including the row gap. */
export const RACK_DEPTH = 2 + ROW_GAP;

/**
 * Mirror a box so the rack is seen from its other side — what you get by walking around it.
 *
 * Both axes flip, because both reverse when you turn 180°: what was on your left is now on
 * your right, and the row that was at the front is now at the back. Flipping only depth
 * would show side B where side A used to be while leaving the sections in their original
 * left-to-right order, which is the view from nowhere.
 *
 * `width` and `depth` are the rack's full extents, so a box's distance from one edge becomes
 * its distance from the opposite one.
 */
export function flipBox<T extends Box>(b: T, width: number, depth: number): T {
  return {
    ...b,
    x: width - (b.x + b.w),
    z: depth - (b.z + b.d),
  };
}

/**
 * Depth a section occupies, from which aisle(s) it is picked from.
 *
 * 'A' is the front row (nearest the viewer), 'B' the back row, and 'AB' is ONE box two rows
 * deep — the visual statement that it is a single space reachable from either aisle, rather
 * than two sections that happen to share a SKU.
 */
export function depthFor(side: 'A' | 'B' | 'AB'): { z: number; d: number } {
  if (side === 'AB') return { z: 0, d: 2 };
  return side === 'A' ? { z: 1, d: 1 } : { z: 0, d: 1 };
}
