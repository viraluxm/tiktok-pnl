// Walk-order derivation for the pick route.
//
// NO IMPORTS — route.test.mjs transpiles this file standalone at runtime, the same pattern
// as eligibility.ts / otGate.ts. Keep it pure and dependency-free.
//
// THE MODEL
// Racks sit on a grid. Racks sharing a grid_row form one physical row; the lane between two
// adjacent occupied rows is an aisle. Every rack has exactly two sides, and which way they
// face is FIXED: side A always faces the lower-numbered row ("up" the grid), side B the
// higher ("down"). That consistency is deliberate — if A meant an arbitrary direction per
// rack, a picker could never build intuition and would have to re-read the screen at every
// stop.
//
// The consequence that makes routing work: two racks in adjacent rows each present one face
// to the aisle between them. With R1 in row 0 and R2 in row 1, R1's B side and R2's A side
// open onto the same aisle, so a picker standing there reaches both without moving.
//
//        ══ aisle 0 ══════════════
//        row 0    [R1]   [R3]          A faces up
//        ══ aisle 1 ══════════════  ←  R1B, R3B, R2A, R4A all reachable here
//        row 1    [R2]   [R4]          B faces down
//        ══ aisle 2 ══════════════
//
// Aisles are derived, never stored, so they cannot drift out of sync with the grid.
//
// WHY OVERRIDES EXIST
// A grid knows geometry, not the building. It cannot know about a door that does not open,
// a pallet permanently parked in an aisle, or where the packing station is. So the derived
// serpentine is a default, and any single rack-side can be pinned to an explicit position.

export type Side = 'A' | 'B';

/** The four floor corners a picker might start their route from. */
export type StartCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface RackShape {
  id: string;
  name: string;
  grid_row: number;
  grid_col: number;
  /** Manual walking position for side A. null = use the derived serpentine. */
  route_pos_a: number | null;
  /** Manual walking position for side B. null = use the derived serpentine. */
  route_pos_b: number | null;
  is_active?: boolean;
}

export interface Stop {
  rackId: string;
  rackName: string;
  side: Side;
  /** Derived index of the aisle this face opens onto. */
  aisle: number;
  /** Operator-facing name for the stop, e.g. "R3A". */
  label: string;
  /** Position in the pure serpentine, before any override is applied. */
  derivedIndex: number;
  /** Final 0-based walking position after overrides are resolved. */
  position: number;
  overridden: boolean;
}

/**
 * Aisle index each face of a rack opens onto, given the rack's position among the
 * occupied rows. A rack in the i-th occupied row has its A face on aisle i and its B
 * face on aisle i+1.
 */
function facesFor(rowIndex: number): { A: number; B: number } {
  return { A: rowIndex, B: rowIndex + 1 };
}

/**
 * Derive the walking order for every rack-side, as a serpentine over the aisles.
 *
 * Aisles are walked in order from the starting corner, alternating direction so the picker
 * never crosses the floor empty-handed. Within an aisle, stops are ordered by column in
 * whichever direction that aisle is being walked.
 *
 * Overrides are resolved last: a rack-side with an explicit position sorts by it, and
 * everything else keeps its derived index. Ties break toward the derived order, so pinning
 * one stop never scrambles the rest.
 */
export function deriveRoute(
  racks: RackShape[],
  startCorner: StartCorner = 'top-left',
): Stop[] {
  const active = racks.filter((r) => r.is_active !== false);
  if (active.length === 0) return [];

  const rows = Array.from(new Set(active.map((r) => r.grid_row))).sort((a, b) => a - b);
  const rowIndex = new Map<number, number>(rows.map((row, i) => [row, i]));

  // Bucket every rack face onto the aisle it opens onto.
  const byAisle = new Map<number, Array<{ rack: RackShape; side: Side }>>();
  for (const rack of active) {
    const faces = facesFor(rowIndex.get(rack.grid_row)!);
    for (const side of ['A', 'B'] as Side[]) {
      const aisle = faces[side];
      const bucket = byAisle.get(aisle);
      if (bucket) bucket.push({ rack, side });
      else byAisle.set(aisle, [{ rack, side }]);
    }
  }

  const startAtBottom = startCorner === 'bottom-left' || startCorner === 'bottom-right';
  const startGoingLeft = startCorner === 'top-right' || startCorner === 'bottom-right';

  // Aisles in walking order. Empty aisles cannot occur here (every aisle in the map has at
  // least one face), so no filtering is needed.
  const aisles = Array.from(byAisle.keys()).sort((a, b) => (startAtBottom ? b - a : a - b));

  const stops: Stop[] = [];
  aisles.forEach((aisle, nth) => {
    // Alternate direction each aisle — that is what makes it a serpentine rather than a
    // series of round trips.
    const goingLeft = startGoingLeft ? nth % 2 === 0 : nth % 2 === 1;
    const faces = byAisle.get(aisle)!.slice().sort((x, y) => {
      const byCol = goingLeft
        ? y.rack.grid_col - x.rack.grid_col
        : x.rack.grid_col - y.rack.grid_col;
      if (byCol !== 0) return byCol;
      // Two racks can share a column across the aisle, facing each other. Order them
      // stably by name so the route does not shuffle between reads.
      return x.rack.name.localeCompare(y.rack.name);
    });

    for (const { rack, side } of faces) {
      stops.push({
        rackId: rack.id,
        rackName: rack.name,
        side,
        aisle,
        label: `${rack.name}${side}`,
        derivedIndex: stops.length,
        position: stops.length,
        overridden: false,
      });
    }
  });

  // Resolve manual overrides. Sorting by (effective position, derived index) keeps the
  // derived order intact everywhere an override is absent.
  const overrideFor = (s: Stop): number | null => {
    const rack = active.find((r) => r.id === s.rackId)!;
    return s.side === 'A' ? rack.route_pos_a : rack.route_pos_b;
  };

  // An explicit pin OUTRANKS a derived index that happens to land on the same number.
  // Without that tie-break, pinning a stop to position 0 would drop it behind whichever
  // stop the serpentine already put there — the pin would silently not take effect.
  const resolved = stops
    .map((s) => {
      const ov = overrideFor(s);
      return { stop: s, effective: ov ?? s.derivedIndex, overridden: ov != null };
    })
    .sort(
      (a, b) =>
        a.effective - b.effective ||
        Number(b.overridden) - Number(a.overridden) ||
        a.stop.derivedIndex - b.stop.derivedIndex,
    );

  return resolved.map(({ stop, overridden }, i) => ({ ...stop, position: i, overridden }));
}

/**
 * Walking position of every rack-side, keyed "<rackId>:<side>" for cheap lookup when
 * sorting pick lines.
 */
export function routePositionMap(
  racks: RackShape[],
  startCorner: StartCorner = 'top-left',
): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of deriveRoute(racks, startCorner)) m.set(`${s.rackId}:${s.side}`, s.position);
  return m;
}

/**
 * What the picker's device shows: rack, side and level. Deliberately stops short of the
 * section — once someone is at the right shelf they find the item by eye in about as long
 * as reading a section number would take, and a label that is roughly right survives a SKU
 * being nudged one position over, where a precise one would simply be wrong.
 */
export function pickerLabel(rackName: string, side: Side, shelfIndex: number): string {
  return `${rackName}${side} L${shelfIndex}`;
}

/**
 * The full physical address, including section. Printed as the human-readable caption on a
 * slot label — the barcode itself stays opaque so relocating a rack never invalidates it.
 */
export function slotAddress(
  rackName: string,
  side: Side,
  shelfIndex: number,
  sectionIndex: number,
): string {
  return `${rackName}${side} L${shelfIndex} S${sectionIndex}`;
}
