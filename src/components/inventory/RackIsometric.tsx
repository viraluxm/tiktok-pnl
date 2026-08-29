'use client';

import { useMemo } from 'react';
import {
  layoutRack, boxFaces, paintOrder, bounds, toPoints,
  ISO, GAP, BOX_LIFT, RACK_DEPTH,
  type Box, type Pt,
} from '@/lib/mapping/iso';
import type { MappingSlot, MappingSku } from '@/hooks/useMapping';

// The rack, drawn as a rack.
//
// The isometric view earns its place for one reason: a rack has a front and a back, and that
// is precisely what a flat list could not show. A section picked from aisle A sits in the
// front row, one picked from aisle B sits behind it, and a section picked from BOTH is a
// single deep box spanning the two. "Picked from both sides" stops being a badge to decode
// and becomes the shape of the box.
//
// Geometry, depth ordering and the spacing that keeps back-row sections visible all live in
// lib/mapping/iso.ts, where they are unit-tested. This file only paints and handles clicks.

/** Draw a rack at least this many sections wide, however few it actually holds. */
const MIN_RACK_WIDTH = 5;

const FILL = {
  beam: ['#3f4753', '#333a44', '#2b313a'],
  post: ['#4b5563', '#3d4653', '#333b46'],
  emptyA: ['#1f2937', '#1a222e', '#161d27'],
  emptyB: ['#18202b', '#141b24', '#11171f'],
  skuA: ['#22c55e', '#1a9c4b', '#14793a'],
  skuB: ['#15803d', '#116632', '#0d4f27'],
  span: ['#2dd4bf', '#1fa89a', '#17847a'],
  ghost: ['#111827', '#0e141d', '#0b1017'],
  selected: ['#67e8f9', '#31b8cc', '#2494a6'],
} as const;

function fillsFor(slot: MappingSlot, hasSku: boolean, selected: boolean): readonly string[] {
  if (selected) return FILL.selected;
  if (slot.side === 'AB') return hasSku ? FILL.span : FILL.emptyA;
  if (!hasSku) return slot.side === 'B' ? FILL.emptyB : FILL.emptyA;
  return slot.side === 'B' ? FILL.skuB : FILL.skuA;
}

function Faces({
  box, fills, dashed, onClick, title, opacity = 1,
}: {
  box: Box;
  fills: readonly string[];
  dashed?: boolean;
  onClick?: () => void;
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
    <g
      onClick={onClick}
      opacity={opacity}
      style={onClick ? { cursor: 'pointer' } : undefined}
    >
      {title && <title>{title}</title>}
      {/* Painted back-to-front within the box: the two side faces, then the lid. */}
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
  shelfCount, slots, skuById, selectedSlotId, canAddToShelf, onPickSection, onAddSection,
}: {
  shelfCount: number;
  slots: MappingSlot[];
  skuById: Map<string, MappingSku>;
  selectedSlotId: string | null;
  canAddToShelf: (shelf: number) => boolean;
  onPickSection: (slot: MappingSlot) => void;
  onAddSection: (shelf: number) => void;
}) {
  const boxes = useMemo(() => layoutRack(slots, shelfCount), [slots, shelfCount]);

  // How far along the shelf the rack runs — the widest shelf, with room for the add-ghost.
  //
  // Floored at MIN_RACK_WIDTH so a sparse rack still reads as a rack. Without it a 4-shelf
  // rack holding one section projects as a thin tower, and scaling that to fit the panel
  // shrinks it to nothing.
  const widest = useMemo(
    () => Math.max(MIN_RACK_WIDTH, ...boxes.map((b) => b.x + b.w), ...Array.from(
      { length: shelfCount },
      (_, i) => slots.filter((s) => s.shelf_index === i + 1 && s.side !== 'B').length + 1,
    )),
    [boxes, slots, shelfCount],
  );

  // Ghost "add a section here" boxes: one per shelf, at the next free front-row position.
  const ghosts = useMemo(
    () => Array.from({ length: shelfCount }, (_, i) => i + 1)
      .filter(canAddToShelf)
      .map((shelf) => {
        const frontUsed = slots.filter(
          (s) => s.shelf_index === shelf && (s.side === 'A' || s.side === 'AB'),
        ).length;
        return {
          shelf,
          box: {
            x: frontUsed + GAP / 2,
            z: 1 + GAP / 2 + 0.45,
            w: 1 - GAP,
            d: 1 - GAP,
            baseY: (shelf - 1) * ISO.LEVEL + BOX_LIFT,
            h: ISO.BOX_H,
          } as Box,
        };
      }),
    [shelfCount, slots, canAddToShelf],
  );

  const beams: Box[] = useMemo(
    () => Array.from({ length: shelfCount }, (_, i) => ({
      x: -0.15, z: -0.15, w: widest + 0.3, d: RACK_DEPTH + 0.3,
      baseY: i * ISO.LEVEL, h: 6,
    })),
    [shelfCount, widest],
  );

  const posts: Box[] = useMemo(() => {
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
    const PAD = 26;
    return `${b.minX - PAD} ${b.minY - PAD} ${b.maxX - b.minX + PAD * 2} ${b.maxY - b.minY + PAD * 2}`;
  }, [beams, posts, boxes, ghosts]);

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={viewBox}
        className="h-auto w-full"
        style={{ maxHeight: '30rem' }}
        role="img"
        aria-label={`Rack with ${shelfCount} shelves and ${slots.length} sections`}
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
                  title={`Add a section to shelf ${item.shelf}`}
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
                fills={fillsFor(slot, !!sku, selected)}
                dashed={!sku && !selected}
                onClick={() => onPickSection(slot)}
                title={
                  `S${slot.section_index} · ${slot.side === 'AB' ? 'both aisles' : `side ${slot.side}`}` +
                  ` · ${sku ? `#${sku.sku_number} ${sku.title}` : 'empty'}`
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
