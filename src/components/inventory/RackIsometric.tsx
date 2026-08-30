'use client';

import { useMemo, useRef } from 'react';
import {
  layoutRack, boxFaces, paintOrder, bounds, toPoints, flipBox,
  ISO, GAP, ROW_GAP, BOX_LIFT, RACK_DEPTH,
  type Box, type Pt,
} from '@/lib/mapping/iso';
import { sectionsFacing, type RackSide } from '@/lib/mapping/shape';
import type { MappingSlot, MappingSku } from '@/hooks/useMapping';

// The rack, drawn as a rack.
//
// A rack has a front and a back, which is the one thing a flat list could never show. Here a
// section picked from aisle A sits in the front row, one picked from aisle B sits behind it,
// and a section picked from BOTH is a single deep box spanning the two. "Picked from both
// sides" stops being a badge to decode and becomes the shape of the box.
//
// Viewing side B mirrors the whole rack — the same thing that happens when you walk around
// it — so the row nearest you is always the side you are standing at, and the "+" always adds
// a section to that side.
//
// Geometry, depth ordering, flipping and the spacing that keeps back-row sections visible all
// live in lib/mapping/iso.ts, where they are unit-tested. This file only paints and reports
// clicks.

/** Draw a rack at least this many sections wide, however few it actually holds. */
const MIN_RACK_WIDTH = 5;

const FILL = {
  beam: ['#3f4753', '#333a44', '#2b313a'],
  post: ['#4b5563', '#3d4653', '#333b46'],
  emptyNear: ['#243041', '#1e2836', '#19212c'],
  emptyFar: ['#18202b', '#141b24', '#11171f'],
  skuNear: ['#22c55e', '#1a9c4b', '#14793a'],
  skuFar: ['#15803d', '#116632', '#0d4f27'],
  span: ['#2dd4bf', '#1fa89a', '#17847a'],
  ghost: ['#111827', '#0e141d', '#0b1017'],
  selected: ['#67e8f9', '#31b8cc', '#2494a6'],
  // A section whose SKU has run out. Solid red rather than a pulse or glow: on a rack of
  // twenty boxes, motion is noise — a flat colour is read instantly and stays readable in a
  // screenshot or a printout.
  outOfStock: ['#ef4444', '#c02f2f', '#992424'],
} as const;

function fillsFor(
  slot: MappingSlot, sku: MappingSku | null, selected: boolean, viewSide: RackSide,
): readonly string[] {
  if (selected) return FILL.selected;
  // Out of stock outranks every other colour, including the both-sides teal: "there is
  // nothing here" is more urgent than "you can reach this from either aisle".
  if (sku && sku.qty_on_hand <= 0) return FILL.outOfStock;
  if (slot.side === 'AB') return sku ? FILL.span : FILL.emptyNear;
  const near = slot.side === viewSide;
  if (!sku) return near ? FILL.emptyNear : FILL.emptyFar;
  return near ? FILL.skuNear : FILL.skuFar;
}

function Faces({
  box, fills, dashed, onClick, title, opacity = 1,
}: {
  box: Box;
  fills: readonly string[];
  dashed?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  title?: string;
  opacity?: number;
}) {
  const f = boxFaces(box);
  const stroke = dashed ? 'rgba(148,163,184,.55)' : 'rgba(0,0,0,.35)';
  const common = {
    stroke,
    strokeWidth: 1,
    strokeDasharray: dashed ? '3 3' : undefined,
    strokeLinejoin: 'round' as const,
  };
  return (
    <g onClick={onClick} opacity={opacity} style={onClick ? { cursor: 'pointer' } : undefined}>
      {title && <title>{title}</title>}
      <polygon points={toPoints(f.front)} fill={fills[2]} {...common} />
      <polygon points={toPoints(f.right)} fill={fills[1]} {...common} />
      <polygon points={toPoints(f.top)} fill={fills[0]} {...common} />
    </g>
  );
}

function lidCentre(box: Box): Pt {
  const t = boxFaces(box).top;
  return { x: (t[0].x + t[2].x) / 2, y: (t[0].y + t[2].y) / 2 };
}

export default function RackIsometric({
  shelfCount, slots, skuById, selectedSlotId, viewSide, canAddToShelf, onPickSection, onAddSection,
  readOnly = false, maxHeightRem = 38,
}: {
  shelfCount: number;
  slots: MappingSlot[];
  skuById: Map<string, MappingSku>;
  selectedSlotId: string | null;
  /** Which side you are standing at. Viewing B mirrors the rack. */
  viewSide: RackSide;
  canAddToShelf: (shelf: number) => boolean;
  /** Reports the clicked section plus where it sits, in container pixels, to anchor a popover. */
  onPickSection: (slot: MappingSlot, at: Pt) => void;
  onAddSection: (shelf: number) => void;
  /** Gallery thumbnails: draw the rack, offer no interaction and no add-targets. */
  readOnly?: boolean;
  maxHeightRem?: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const flipped = viewSide === 'B';

  const rawBoxes = useMemo(() => layoutRack(slots, shelfCount), [slots, shelfCount]);

  const widest = useMemo(
    () => Math.max(
      MIN_RACK_WIDTH,
      ...rawBoxes.map((b) => b.x + b.w),
      ...Array.from({ length: shelfCount }, (_, i) =>
        sectionsFacing(slots, i + 1, viewSide).length + 1),
    ),
    [rawBoxes, slots, shelfCount, viewSide],
  );

  // "+" targets sit in the row nearest the viewer, so adding always means "add to the side I
  // am standing at" rather than a fixed side the operator has to remember.
  const rawGhosts = useMemo(
    () => (readOnly ? [] : Array.from({ length: shelfCount }, (_, i) => i + 1))
      .filter(canAddToShelf)
      .map((shelf) => ({
        shelf,
        box: {
          x: sectionsFacing(slots, shelf, viewSide).length + GAP / 2,
          z: viewSide === 'A' ? 1 + GAP / 2 + ROW_GAP : GAP / 2,
          w: 1 - GAP,
          d: 1 - GAP,
          baseY: (shelf - 1) * ISO.LEVEL + BOX_LIFT,
          h: ISO.BOX_H,
        } as Box,
      })),
    [shelfCount, slots, viewSide, canAddToShelf, readOnly],
  );

  // Flipped inline rather than through a shared closure, so each memo's dependencies are the
  // plain values it actually reads.
  const boxes = useMemo(
    () => (flipped ? rawBoxes.map((b) => flipBox(b, widest, RACK_DEPTH)) : rawBoxes),
    [rawBoxes, flipped, widest],
  );
  const ghosts = useMemo(
    () => (flipped
      ? rawGhosts.map((g) => ({ ...g, box: flipBox(g.box, widest, RACK_DEPTH) }))
      : rawGhosts),
    [rawGhosts, flipped, widest],
  );

  const beams = useMemo(
    () => Array.from({ length: shelfCount }, (_, i) => ({
      x: -0.15, z: -0.15, w: widest + 0.3, d: RACK_DEPTH + 0.3,
      baseY: i * ISO.LEVEL, h: 6,
    })),
    [shelfCount, widest],
  );

  const posts = useMemo(() => {
    const h = shelfCount * ISO.LEVEL + 10;
    return [
      { x: -0.15, z: -0.15, w: 0.15, d: 0.15, baseY: 0, h },
      { x: widest, z: -0.15, w: 0.15, d: 0.15, baseY: 0, h },
      { x: -0.15, z: RACK_DEPTH, w: 0.15, d: 0.15, baseY: 0, h },
      { x: widest, z: RACK_DEPTH, w: 0.15, d: 0.15, baseY: 0, h },
    ];
  }, [shelfCount, widest]);

  const viewBox = useMemo(() => {
    const all = [...beams, ...posts, ...boxes, ...ghosts.map((g) => g.box)];
    const b = bounds(all.flatMap((x) => {
      const f = boxFaces(x);
      return [f.top, f.right, f.front];
    }));
    const PAD = 24;
    return `${b.minX - PAD} ${b.minY - PAD} ${b.maxX - b.minX + PAD * 2} ${b.maxY - b.minY + PAD * 2}`;
  }, [beams, posts, boxes, ghosts]);

  // SVG user units → container pixels, so an HTML popover can be anchored to a drawn box.
  const toContainerPx = (p: Pt): Pt => {
    const svg = svgRef.current;
    const wrap = wrapRef.current;
    if (!svg || !wrap) return { x: 0, y: 0 };
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = p.x;
    pt.y = p.y;
    const scr = pt.matrixTransform(ctm);
    const rect = wrap.getBoundingClientRect();
    return { x: scr.x - rect.left, y: scr.y - rect.top };
  };

  return (
    <div ref={wrapRef} className="relative w-full">
      <svg
        ref={svgRef}
        viewBox={viewBox}
        className="block w-full"
        style={{ maxHeight: `${maxHeightRem}rem` }}
        role="img"
        aria-label={`Rack with ${shelfCount} shelves and ${slots.length} sections, viewed from side ${viewSide}`}
      >
        {paintOrder(beams).map((b, i) => <Faces key={`beam${i}`} box={b} fills={FILL.beam} />)}
        {paintOrder(posts).map((b, i) => <Faces key={`post${i}`} box={b} fills={FILL.post} />)}

        {paintOrder([
          ...boxes.map((b) => ({ ...b, kind: 'section' as const })),
          ...ghosts.map((g) => ({ ...g.box, kind: 'ghost' as const, shelf: g.shelf })),
        ]).map((item) => {
          if (item.kind === 'ghost') {
            const c = lidCentre(item);
            return (
              <g key={`ghost-${item.shelf}`}>
                <Faces
                  box={item}
                  fills={FILL.ghost}
                  dashed
                  opacity={0.85}
                  title={`Add a section to shelf ${item.shelf}, side ${viewSide}`}
                  onClick={() => onAddSection(item.shelf)}
                />
                <text
                  x={c.x} y={c.y + 5} textAnchor="middle"
                  fontSize="15" fontWeight="700" fill="#94a3b8"
                  style={{ pointerEvents: 'none', userSelect: 'none' }}
                >
                  +
                </text>
              </g>
            );
          }

          const slot = item.section;
          const sku = slot.inventory_sku_id ? skuById.get(slot.inventory_sku_id) ?? null : null;
          const selected = slot.id === selectedSlotId;
          const c = lidCentre(item);
          return (
            <g key={slot.id}>
              <Faces
                box={item}
                fills={fillsFor(slot, sku, selected, viewSide)}
                dashed={!sku && !selected}
                onClick={readOnly ? undefined : () => onPickSection(slot, toContainerPx(c))}
                title={
                  `S${slot.section_index} · ${slot.side === 'AB' ? 'both aisles' : `side ${slot.side}`}` +
                  ` · ${sku ? `#${sku.sku_number} ${sku.title}${sku.qty_on_hand <= 0 ? ' — OUT OF STOCK' : ''}` : 'empty'}`
                }
              />
              <text
                x={c.x} y={c.y + 4} textAnchor="middle"
                fontSize="11" fontWeight="700"
                fill={sku || selected ? '#04140a' : '#94a3b8'}
                style={{ pointerEvents: 'none', userSelect: 'none' }}
              >
                {sku ? `#${sku.sku_number}` : `S${slot.section_index}`}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
