'use client';

import { useMemo, useState } from 'react';
import type { Stop } from '@/lib/mapping/route';
import type { MappingRack, MappingSlot } from '@/hooks/useMapping';

// The floor, seen from above.
//
// Earlier versions drew this as a list of rows with aisle strips between them and explained
// the rule in prose. It did not land, three times. The problem was never the wording — a row
// of cards does not look like a warehouse, so there was nothing for the rule to attach to.
//
// So: racks are drawn as what they are from above — long, shallow blocks that sit flush
// against each other when they are side by side. Each block's top edge is its A face and its
// bottom edge its B face, and those edges physically touch the aisle lanes drawn above and
// below the row. You can see which face opens onto which aisle without being told.
//
// Rows can be added ABOVE as well as below, because grid_row is free to go negative and
// "where does a rack go if I put it at the top" had no answer before.

export default function FloorPlan({
  racks, slotsByRack, stops, onOpen, onMove, onAddAt,
}: {
  racks: MappingRack[];
  slotsByRack: Map<string, MappingSlot[]>;
  stops: Stop[];
  onOpen: (rackId: string) => void;
  onMove: (rackId: string, row: number, col: number) => void;
  onAddAt: (row: number, col: number) => void;
}) {
  const [dragId, setDragId] = useState<string | null>(null);

  const rows = useMemo(
    () => Array.from(new Set(racks.map((r) => r.grid_row))).sort((a, b) => a - b),
    [racks],
  );
  const maxCol = useMemo(() => racks.reduce((m, r) => Math.max(m, r.grid_col), -1), [racks]);
  const cols = useMemo(
    () => Array.from({ length: Math.max(maxCol + 2, 4) }, (_, i) => i),
    [maxCol],
  );

  const stopFor = (rackId: string, side: 'A' | 'B') =>
    stops.find((s) => s.rackId === rackId && s.side === side);

  const facesOn = (aisleIndex: number) =>
    stops.filter((s) => s.aisle === aisleIndex).sort((a, b) => a.position - b.position);

  const rackAt = (row: number, col: number) =>
    racks.find((r) => r.grid_row === row && r.grid_col === col) ?? null;

  const drop = (row: number, col: number) => {
    if (!dragId) return;
    const id = dragId;
    setDragId(null);
    onMove(id, row, col);
  };

  return (
    <div className="overflow-x-auto rounded-2xl border border-tt-border bg-tt-card p-3">
      <div className="min-w-[34rem]">
        <AddRowButton
          label="+ add a row above"
          onClick={() => onAddAt((rows[0] ?? 0) - 1, 0)}
        />

        {rows.map((row, i) => (
          <div key={row}>
            <Aisle index={i} faces={facesOn(i)} />
            <div className="flex">
              {cols.map((col) => {
                const rack = rackAt(row, col);
                return rack ? (
                  <RackBlock
                    key={col}
                    rack={rack}
                    sections={(slotsByRack.get(rack.id) ?? []).length}
                    filled={(slotsByRack.get(rack.id) ?? []).filter((s) => s.inventory_sku_id).length}
                    stopA={stopFor(rack.id, 'A')?.position}
                    stopB={stopFor(rack.id, 'B')?.position}
                    onOpen={() => onOpen(rack.id)}
                    onDragStart={() => setDragId(rack.id)}
                  />
                ) : (
                  <EmptyCell
                    key={col}
                    dragging={!!dragId}
                    onDrop={() => drop(row, col)}
                    onAdd={() => onAddAt(row, col)}
                  />
                );
              })}
            </div>
            {i === rows.length - 1 && <Aisle index={rows.length} faces={facesOn(rows.length)} />}
          </div>
        ))}

        <AddRowButton
          label="+ add a row below"
          onClick={() => onAddAt((rows[rows.length - 1] ?? -1) + 1, 0)}
        />
      </div>
    </div>
  );
}

// A walkable lane. Named with the faces you can reach standing in it, which is the whole
// reason aisles are modelled at all.
function Aisle({ index, faces }: { index: number; faces: Stop[] }) {
  return (
    <div className="my-1 flex items-center gap-2 rounded-md border-y border-dashed border-tt-green/25 bg-tt-green/[0.06] px-2 py-1.5">
      <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-tt-green/80">
        ↔ Aisle {index + 1}
      </span>
      <span className="h-px flex-1 bg-tt-green/20" />
      <span className="shrink-0 text-[11px] text-tt-muted">
        {faces.length
          ? `you can reach ${faces.map((f) => f.label).join(', ')} from here`
          : 'nothing faces this lane yet'}
      </span>
    </div>
  );
}

// A rack from above: long and shallow. Its top edge is side A and its bottom edge side B, and
// both sit flush against the aisle lanes drawn either side of the row.
function RackBlock({
  rack, sections, filled, stopA, stopB, onOpen, onDragStart,
}: {
  rack: MappingRack;
  sections: number;
  filled: number;
  stopA?: number;
  stopB?: number;
  onOpen: () => void;
  onDragStart: () => void;
}) {
  return (
    <div className="w-40 shrink-0 px-0.5">
      <div className="flex items-center justify-between px-1 text-[9px] font-bold uppercase tracking-wide text-tt-cyan/70">
        <span>A</span>
        {stopA != null && <span>stop {stopA + 1}</span>}
      </div>
      <div className="h-1 rounded-t bg-tt-cyan/50" />
      <button
        draggable
        onDragStart={onDragStart}
        onClick={onOpen}
        title={`Open ${rack.name}`}
        className="w-full border-x-2 border-tt-border bg-tt-card-hover px-2 py-3 text-center transition-colors hover:bg-tt-border/40 cursor-grab active:cursor-grabbing"
      >
        <div className="text-base font-extrabold text-tt-text">{rack.name}</div>
        <div className="text-[10px] text-tt-muted">
          {rack.shelf_count} shelves · {sections} sections
        </div>
        <div className={`text-[10px] tabular-nums ${sections > 0 && filled === sections ? 'text-tt-green' : 'text-tt-muted'}`}>
          {sections === 0 ? 'no sections' : `${filled}/${sections} filled`}
        </div>
      </button>
      <div className="h-1 rounded-b bg-tt-cyan/50" />
      <div className="flex items-center justify-between px-1 text-[9px] font-bold uppercase tracking-wide text-tt-cyan/70">
        <span>B</span>
        {stopB != null && <span>stop {stopB + 1}</span>}
      </div>
    </div>
  );
}

// Empty floor. Kept quiet until you are actually dragging, so the map reads as the racks you
// have rather than a grid of placeholders.
function EmptyCell({
  dragging, onDrop, onAdd,
}: { dragging: boolean; onDrop: () => void; onAdd: () => void }) {
  const [over, setOver] = useState(false);
  return (
    <div className="w-40 shrink-0 px-0.5 py-[18px]">
      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); onDrop(); }}
        className={`flex h-[72px] items-center justify-center rounded-md border-2 border-dashed transition-colors ${
          over ? 'border-tt-green bg-tt-green/10'
            : dragging ? 'border-tt-border' : 'border-transparent hover:border-tt-border/60'
        }`}
      >
        <button
          onClick={onAdd}
          className={`text-xs transition-opacity cursor-pointer ${
            dragging ? 'opacity-0' : 'text-tt-muted/60 hover:text-tt-text'
          }`}
        >
          + rack
        </button>
      </div>
    </div>
  );
}

function AddRowButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="my-1 w-full rounded-md border border-dashed border-tt-border/60 py-1 text-[11px] text-tt-muted hover:border-tt-green/50 hover:text-tt-text cursor-pointer"
    >
      {label}
    </button>
  );
}
