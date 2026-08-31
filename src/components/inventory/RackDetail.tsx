'use client';

import { useMemo, useRef, useState } from 'react';
import SkuThumb from '@/components/common/SkuThumb';
import RackIsometric from './RackIsometric';
import { slotAddress } from '@/lib/mapping/route';
import { printSectionLabels } from '@/lib/mapping/slotLabel';
import {
  canAddSection, MIN_SHELVES, MAX_SHELVES,
  type SectionSide, type RackSide,
} from '@/lib/mapping/shape';
import type { Pt } from '@/lib/mapping/iso';
import type { MappingRack, MappingSlot, MappingSku } from '@/hooks/useMapping';

// One rack, full screen. Everything a section needs happens ON the drawing: click a box and
// a popover opens over it with the only two decisions that matter — which SKU, and whether
// it is picked from both aisles — plus its label. Sending the operator to a panel far below
// the rack for that was the wrong shape; they are looking at the rack.

export default function RackDetail({
  rack, slots, skus, skuById, busy,
  onBack, onAddSection, onAssign, onSetSide, onDeleteSection, onInsertShelf, onRemoveShelf,
  onDeleteRack,
}: {
  rack: MappingRack;
  slots: MappingSlot[];
  skus: MappingSku[];
  skuById: Map<string, MappingSku>;
  busy: boolean;
  onBack: () => void;
  onAddSection: (shelf: number, side: SectionSide) => void;
  onAssign: (slotId: string, skuId: string | null) => void;
  onSetSide: (slotId: string, side: SectionSide) => void;
  onDeleteSection: (slotId: string) => void;
  onInsertShelf: (at: number, position: 'above' | 'below') => void;
  onRemoveShelf: (at: number) => void;
  onDeleteRack: () => void;
}) {
  const [viewSide, setViewSide] = useState<RackSide>('A');
  const [openSlotId, setOpenSlotId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<Pt>({ x: 0, y: 0 });
  // Captured when the popover opens rather than read from the ref during render — the width
  // at click time is what the clamp needs, and reading refs mid-render is not allowed.
  const [wrapWidth, setWrapWidth] = useState(0);
  const [search, setSearch] = useState('');
  const [shelfMenu, setShelfMenu] = useState<null | { shelf: number; at: Pt }>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const openSlot = slots.find((s) => s.id === openSlotId) ?? null;
  const filled = slots.filter((s) => s.inventory_sku_id).length;

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return skus;
    return skus.filter(
      (s) => String(s.sku_number).includes(q) ||
        s.title.toLowerCase().includes(q) ||
        s.barcode.toLowerCase().includes(q),
    );
  }, [skus, search]);

  const close = () => { setOpenSlotId(null); setSearch(''); };
  const closeShelf = () => setShelfMenu(null);

  return (
    <section className="rounded-2xl border border-tt-border bg-tt-card p-4">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="rounded-lg border border-tt-border px-2 py-1 text-xs text-tt-muted hover:text-tt-text cursor-pointer"
          >
            ← All racks
          </button>
          <h3 className="text-base font-bold text-tt-text">Rack {rack.name}</h3>
          <span className="text-[11px] text-tt-muted">
            {rack.shelf_count} shelves · {slots.length} sections · {filled} filled
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[11px] text-tt-muted">Standing at</span>
          <div className="flex overflow-hidden rounded-lg border border-tt-border">
            {(['A', 'B'] as RackSide[]).map((s) => (
              <button
                key={s}
                onClick={() => { setViewSide(s); close(); }}
                className={`px-3 py-1 text-xs font-bold transition-colors cursor-pointer ${
                  viewSide === s ? 'bg-tt-green text-black' : 'text-tt-muted hover:text-tt-text'
                }`}
              >
                Side {s}
              </button>
            ))}
          </div>
          <button
            onClick={() => { setViewSide(viewSide === 'A' ? 'B' : 'A'); close(); }}
            title="Walk around to the other side"
            className="rounded-lg border border-tt-border px-2 py-1 text-xs text-tt-muted hover:text-tt-text cursor-pointer"
          >
            ⟲ Flip
          </button>
        </div>
      </header>

      <div ref={wrapRef} className="relative">
        <RackIsometric
          shelfCount={rack.shelf_count}
          slots={slots}
          skuById={skuById}
          selectedSlotId={openSlotId}
          viewSide={viewSide}
          canAddToShelf={(shelf) => !busy && canAddSection(slots, shelf, viewSide)}
          onPickSection={(slot, at) => {
            setOpenSlotId(slot.id);
            setAnchor(at);
            setWrapWidth(wrapRef.current?.clientWidth ?? 0);
            setSearch('');
          }}
          onAddSection={(shelf) => onAddSection(shelf, viewSide)}
          onPickShelf={(shelf, at) => {
            close();
            setShelfMenu({ shelf, at });
            setWrapWidth(wrapRef.current?.clientWidth ?? 0);
          }}
        />

        {shelfMenu && (
          <ShelfMenu
            shelf={shelfMenu.shelf}
            anchor={shelfMenu.at}
            containerWidth={wrapWidth}
            shelfCount={rack.shelf_count}
            sectionsOnShelf={slots.filter((s) => s.shelf_index === shelfMenu.shelf).length}
            busy={busy}
            onInsert={(position) => { onInsertShelf(shelfMenu.shelf, position); closeShelf(); }}
            onRemove={() => { onRemoveShelf(shelfMenu.shelf); closeShelf(); }}
            onClose={closeShelf}
          />
        )}

        {openSlot && (
          <SectionPopover
            slot={openSlot}
            rackName={rack.name}
            sku={openSlot.inventory_sku_id ? skuById.get(openSlot.inventory_sku_id) ?? null : null}
            matches={matches}
            search={search}
            setSearch={setSearch}
            anchor={anchor}
            viewSide={viewSide}
            containerWidth={wrapWidth}
            busy={busy}
            onAssign={(skuId) => { onAssign(openSlot.id, skuId); close(); }}
            onSetSide={(side) => onSetSide(openSlot.id, side)}
            onDelete={() => { onDeleteSection(openSlot.id); close(); }}
            onClose={close}
          />
        )}
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-tt-muted">
        You are looking at <b>side {viewSide}</b> — the near row. Click a box to set its SKU, or a
        dashed <b>+</b> to divide a shelf. A{' '}
        <b className="text-tt-cyan">teal box spanning both rows</b> is one space picked from either
        aisle.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-tt-border pt-3">
        <span className="text-[11px] text-tt-muted">
          {rack.shelf_count} shelves · tap an <b className="text-tt-text">L</b> tab on the rack to
          add or remove one
        </span>
        <span className="flex-1" />
        {slots.length > 0 && (
          <button
            onClick={() => printSectionLabels(
              slots
                .slice()
                .sort((a, b) => a.shelf_index - b.shelf_index || a.section_index - b.section_index)
                .map((s) => ({
                  slot_code: s.slot_code,
                  address: slotAddress(rack.name, s.side === 'AB' ? 'A' : s.side, s.shelf_index, s.section_index),
                })),
            )}
            className="rounded-lg border border-tt-border px-2 py-1.5 text-xs text-tt-text cursor-pointer"
          >
            Print all {slots.length} labels
          </button>
        )}
        <button
          onClick={onDeleteRack}
          disabled={busy}
          className="rounded-lg border border-tt-border px-2 py-1.5 text-xs text-tt-muted hover:text-tt-red disabled:opacity-40 cursor-pointer"
        >
          Delete rack
        </button>
      </div>
    </section>
  );
}

// Anchored over the box you clicked. Deliberately small: a section only has two decisions
// (which SKU, and whether it is picked from both sides) plus its label, and all three belong
// where you are already looking.
function SectionPopover({
  slot, rackName, sku, matches, search, setSearch, anchor, viewSide, containerWidth, busy,
  onAssign, onSetSide, onDelete, onClose,
}: {
  slot: MappingSlot;
  rackName: string;
  sku: MappingSku | null;
  matches: MappingSku[];
  search: string;
  setSearch: (s: string) => void;
  anchor: Pt;
  viewSide: RackSide;
  containerWidth: number;
  busy: boolean;
  onAssign: (skuId: string | null) => void;
  onSetSide: (side: SectionSide) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const WIDTH = 320;
  // Clamp so a box near an edge does not push the popover off the panel.
  const left = containerWidth
    ? Math.min(Math.max(anchor.x, WIDTH / 2 + 8), containerWidth - WIDTH / 2 - 8)
    : anchor.x;
  const address = slotAddress(rackName, slot.side === 'AB' ? 'A' : slot.side, slot.shelf_index, slot.section_index);

  return (
    <div
      className="absolute z-20 rounded-xl border border-tt-cyan/70 p-3 shadow-2xl"
      style={{
        width: WIDTH,
        left,
        top: anchor.y + 14,
        transform: 'translateX(-50%)',
        // Opaque on purpose. A translucent panel let the rack show through the SKU list and
        // made both unreadable.
        background: '#0a0e14',
        boxShadow: '0 18px 50px rgba(0,0,0,.75)',
      }}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-bold text-tt-text">
            {slot.side === 'AB' ? `${rackName} L${slot.shelf_index} S${slot.section_index}` : address}
          </div>
          <div className="font-mono text-[10px] text-tt-muted">{slot.slot_code}</div>
        </div>
        <button onClick={onClose} className="shrink-0 text-xs text-tt-muted hover:text-tt-text cursor-pointer">✕</button>
      </div>

      {/* The side a section sits on is a fact — you added it from that aisle. The only real
          decision is whether it is ALSO reachable from the other one, so that is the only
          control. Turning "both" off returns it to the side you are currently standing at,
          which is unambiguous because that is the side you are looking at it from. */}
      <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-tt-border px-2 py-1.5">
        <span className="text-[11px] text-tt-muted">
          Picked from{' '}
          <b className="text-tt-text">
            {slot.side === 'AB' ? 'both aisles' : `side ${slot.side}`}
          </b>
        </span>
        <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-tt-muted cursor-pointer">
          <input
            type="checkbox"
            checked={slot.side === 'AB'}
            disabled={busy}
            onChange={(e) => onSetSide(e.target.checked ? 'AB' : viewSide)}
            className="cursor-pointer"
          />
          Both aisles
        </label>
      </div>

      <input
        autoFocus
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search or scan a SKU…"
        className="mb-2 w-full rounded-lg border border-tt-border bg-tt-card px-2 py-1.5 text-sm text-tt-text"
      />

      {sku && sku.qty_on_hand <= 0 && (
        <p className="mb-2 rounded-lg border border-tt-red/60 bg-tt-red/10 px-2 py-1 text-[11px] text-tt-red">
          <b>#{sku.sku_number} is out of stock</b> ({sku.qty_on_hand} on hand). This section shows red
          on the rack until it is restocked.
        </p>
      )}

      <div className="max-h-48 space-y-1 overflow-y-auto">
        {matches.slice(0, 40).map((s) => {
          const out = s.qty_on_hand <= 0;
          return (
            <button
              key={s.id}
              onClick={() => onAssign(s.id)}
              disabled={busy}
              title={out ? `#${s.sku_number} has ${s.qty_on_hand} on hand` : undefined}
              className={`flex w-full items-center gap-2 rounded-lg border px-2 py-1 text-left disabled:opacity-40 cursor-pointer ${
                s.id === slot.inventory_sku_id
                  ? 'border-tt-green bg-tt-green/10'
                  : 'border-transparent hover:bg-tt-card-hover'
              }`}
            >
              <SkuThumb url={s.thumbnail_url} />
              <span className="min-w-0 flex-1 truncate text-xs">
                <b className="text-tt-text">#{s.sku_number}</b>
                <span className="ml-1 text-tt-muted">{s.title}</span>
              </span>
              <span
                className={`shrink-0 text-[10px] tabular-nums ${out ? 'font-bold text-tt-red' : 'text-tt-muted'}`}
              >
                {out ? `out (${s.qty_on_hand})` : s.qty_on_hand}
              </span>
            </button>
          );
        })}
        {matches.length === 0 && <p className="px-1 py-2 text-xs text-tt-muted">No SKU matches.</p>}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-tt-border pt-2">
        <button
          onClick={() => printSectionLabels([{ slot_code: slot.slot_code, address }])}
          className="rounded-lg border border-tt-border px-2 py-1 text-[11px] text-tt-text cursor-pointer"
        >
          Print label
        </button>
        {sku && (
          <button
            onClick={() => onAssign(null)}
            disabled={busy}
            className="rounded-lg border border-tt-border px-2 py-1 text-[11px] text-tt-muted hover:text-tt-text disabled:opacity-40 cursor-pointer"
          >
            Clear SKU
          </button>
        )}
        <span className="flex-1" />
        <button
          onClick={onDelete}
          disabled={busy}
          className="rounded-lg border border-tt-border px-2 py-1 text-[11px] text-tt-muted hover:text-tt-red disabled:opacity-40 cursor-pointer"
        >
          Remove section
        </button>
      </div>
    </div>
  );
}

/**
 * Add or remove a shelf, anchored to the level tab you tapped.
 *
 * Says up front how many printed labels the change invalidates. Shelf numbers are ordinal, so
 * inserting below L3 makes the old L3 into L4 — the barcodes still resolve, but the human
 * caption on every label above the insertion point is now wrong. Discovering that at the rack
 * with a stack of stale labels is much worse than being told here.
 */
function ShelfMenu({
  shelf, anchor, containerWidth, shelfCount, sectionsOnShelf, busy,
  onInsert, onRemove, onClose,
}: {
  shelf: number;
  anchor: Pt;
  containerWidth: number;
  shelfCount: number;
  sectionsOnShelf: number;
  busy: boolean;
  onInsert: (position: 'above' | 'below') => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const WIDTH = 290;
  const left = containerWidth
    ? Math.min(Math.max(anchor.x, WIDTH / 2 + 8), containerWidth - WIDTH / 2 - 8)
    : anchor.x;

  const atMax = shelfCount >= MAX_SHELVES;
  const atMin = shelfCount <= MIN_SHELVES;
  // Inserting ABOVE L{shelf} renumbers the shelves above it; BELOW renumbers this one too.
  const staleAbove = shelfCount - shelf;
  const staleBelow = shelfCount - shelf + 1;

  return (
    <div
      className="absolute z-20 rounded-xl border border-tt-cyan/70 p-3 shadow-2xl"
      style={{
        width: WIDTH, left, top: anchor.y + 14, transform: 'translateX(-50%)',
        background: '#0a0e14', boxShadow: '0 18px 50px rgba(0,0,0,.75)',
      }}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-bold text-tt-text">Shelf L{shelf}</div>
          <div className="text-[11px] text-tt-muted">
            {sectionsOnShelf} section{sectionsOnShelf === 1 ? '' : 's'}
          </div>
        </div>
        <button onClick={onClose} className="shrink-0 text-xs text-tt-muted hover:text-tt-text cursor-pointer">✕</button>
      </div>

      <div className="space-y-1.5">
        <button
          onClick={() => onInsert('above')}
          disabled={busy || atMax}
          className="w-full rounded-lg border border-tt-border px-2 py-2 text-left text-xs text-tt-text disabled:opacity-40 cursor-pointer"
        >
          <b>Add a shelf above</b> this one
          <span className="block text-[10px] text-tt-muted">
            becomes L{shelf + 1}
            {staleAbove > 0 && ` · ${staleAbove} shelf${staleAbove === 1 ? '' : 'ves'} renumber`}
          </span>
        </button>
        <button
          onClick={() => onInsert('below')}
          disabled={busy || atMax}
          className="w-full rounded-lg border border-tt-border px-2 py-2 text-left text-xs text-tt-text disabled:opacity-40 cursor-pointer"
        >
          <b>Add a shelf below</b> this one
          <span className="block text-[10px] text-tt-muted">
            becomes L{shelf} · {staleBelow} shelf{staleBelow === 1 ? '' : 'ves'} renumber
          </span>
        </button>
      </div>

      {atMax && (
        <p className="mt-2 text-[10px] text-tt-muted">
          A rack holds at most {MAX_SHELVES} shelves.
        </p>
      )}

      <button
        onClick={onRemove}
        disabled={busy || atMin}
        className="mt-2 w-full rounded-lg border border-tt-red px-2 py-2 text-left text-xs text-tt-red disabled:opacity-40 cursor-pointer"
      >
        <b>Remove this shelf</b>
        <span className="block text-[10px] opacity-80">
          {atMin
            ? `a rack needs at least ${MIN_SHELVES} shelves`
            : `${sectionsOnShelf} section${sectionsOnShelf === 1 ? '' : 's'} destroyed${staleAbove > 0 ? ` · ${staleAbove} shelf${staleAbove === 1 ? '' : 'ves'} renumber` : ''}`}
        </span>
      </button>

      <p className="mt-2 text-[10px] leading-relaxed text-tt-muted">
        Renumbered shelves keep working — the barcodes are permanent — but their printed labels
        will show the wrong level until reprinted.
      </p>
    </div>
  );
}
