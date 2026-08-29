'use client';

import { useMemo, useState } from 'react';
import SkuThumb from '@/components/common/SkuThumb';
import {
  useMapping,
  useCreateRack,
  useUpdateRack,
  useDeleteRack,
  useAddSection,
  useDeleteSection,
  useSetSectionSide,
  useAssignSlot,
  NeedsConfirmation,
  type MappingRack,
  type MappingSlot,
  type MappingSku,
} from '@/hooks/useMapping';
import RackIsometric from './RackIsometric';
import { deriveRoute, slotAddress, type StartCorner } from '@/lib/mapping/route';
import {
  canAddSection, isReachableFrom,
  MIN_SHELVES, MAX_SHELVES,
  type SectionSide, type RackSide,
} from '@/lib/mapping/shape';

// Inventory → Mapping.
//
// Two ideas carry this screen:
//
// 1. The floor plan is the INPUT, not a picture of one. You place racks the way they
//    physically sit, and the aisles and picking route are derived from that placement — so
//    there is no walking order to maintain separately and get out of sync.
//
// 2. A rack is drawn as a rack. Shelves stack, sections sit on them, and each section shows
//    which aisle you reach it from. A section is one physical space: adding one never
//    creates a matching one on the far side.

const CORNERS: { value: StartCorner; label: string }[] = [
  { value: 'top-left', label: 'Top-left' },
  { value: 'top-right', label: 'Top-right' },
  { value: 'bottom-left', label: 'Bottom-left' },
  { value: 'bottom-right', label: 'Bottom-right' },
];

// A → B → both → A. Cycling in place beats a dropdown for a three-state property you set
// while looking at the rack.
const NEXT_SIDE: Record<SectionSide, SectionSide> = { A: 'B', B: 'AB', AB: 'A' };
const SIDE_LABEL: Record<SectionSide, string> = { A: 'A', B: 'B', AB: 'A+B' };

export default function MappingSection() {
  const { data, isPending, error } = useMapping();
  const createRack = useCreateRack();
  const updateRack = useUpdateRack();
  const deleteRack = useDeleteRack();
  const addSection = useAddSection();
  const deleteSection = useDeleteSection();
  const setSectionSide = useSetSectionSide();
  const assignSlot = useAssignSlot();

  const [selectedRackId, setSelectedRackId] = useState<string | null>(null);
  const [editingSlotId, setEditingSlotId] = useState<string | null>(null);
  const [skuSearch, setSkuSearch] = useState('');
  const [startCorner, setStartCorner] = useState<StartCorner>('top-left');
  const [msg, setMsg] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ row: number; col: number } | null>(null);
  const [newShelves, setNewShelves] = useState(3);
  const [dragRackId, setDragRackId] = useState<string | null>(null);

  const racks = useMemo(() => data?.racks ?? [], [data]);
  const slots = useMemo(() => data?.slots ?? [], [data]);
  const skus = useMemo(() => data?.skus ?? [], [data]);

  const skuById = useMemo(() => new Map(skus.map((s) => [s.id, s])), [skus]);
  const slotsByRack = useMemo(() => {
    const m = new Map<string, MappingSlot[]>();
    for (const s of slots) {
      const arr = m.get(s.rack_id);
      if (arr) arr.push(s);
      else m.set(s.rack_id, [s]);
    }
    return m;
  }, [slots]);

  const assignedSkuIds = useMemo(
    () => new Set(slots.map((s) => s.inventory_sku_id).filter(Boolean) as string[]),
    [slots],
  );
  const unmappedSkus = useMemo(
    () => skus.filter((s) => !assignedSkuIds.has(s.id)),
    [skus, assignedSkuIds],
  );

  const stops = useMemo(() => deriveRoute(racks, startCorner), [racks, startCorner]);
  const stopByKey = useMemo(
    () => new Map(stops.map((s) => [`${s.rackId}:${s.side}`, s])),
    [stops],
  );

  const occupiedRows = useMemo(
    () => Array.from(new Set(racks.map((r) => r.grid_row))).sort((a, b) => a - b),
    [racks],
  );
  const maxCol = useMemo(() => racks.reduce((m, r) => Math.max(m, r.grid_col), -1), [racks]);
  const columns = useMemo(
    () => Array.from({ length: Math.max(maxCol + 2, 3) }, (_, i) => i),
    [maxCol],
  );

  const selectedRack = racks.find((r) => r.id === selectedRackId) ?? null;
  const editingSlot = slots.find((s) => s.id === editingSlotId) ?? null;

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
    } catch (e) {
      if (e instanceof NeedsConfirmation) {
        const names = e.skusUnmapped
          .map((id) => skuById.get(id))
          .filter(Boolean)
          .map((s) => `#${s!.sku_number}`)
          .join(', ');
        setMsg(
          `${e.message} ${e.assignedLost} section${e.assignedLost === 1 ? '' : 's'} would be cleared` +
            (names ? `, leaving ${names} unmapped.` : '.') +
            ' Use the red button to confirm.',
        );
      } else {
        setMsg(e instanceof Error ? e.message : 'Something went wrong');
      }
    }
  };

  const facesOnAisle = (aisleIndex: number) =>
    stops.filter((s) => s.aisle === aisleIndex).sort((a, b) => a.position - b.position);

  // isPending, NOT isLoading. The query is `enabled: !!user`, and a DISABLED TanStack query
  // reports isLoading === false while still having no data — so gating on isLoading rendered
  // the whole tab from `undefined` during the first paint. That showed "0 racks" and, far
  // worse, "Every active SKU has a section" when in fact nothing was mapped at all: an empty
  // state that asserts the opposite of the truth. Gate on isPending and on data being present.
  if (isPending || !data) return <div className="p-4 text-sm text-tt-muted">Loading mapping…</div>;
  if (error) {
    return (
      <div className="p-4 text-sm text-tt-red">
        {error instanceof Error ? error.message : 'Failed to load mapping'}
      </div>
    );
  }

  const filledCount = slots.filter((s) => s.inventory_sku_id).length;

  return (
    <div className="space-y-6 p-1">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Racks" value={racks.length} />
        <Tile label="Sections" value={slots.length} />
        <Tile label="Sections filled" value={filledCount} />
        <Tile
          label="SKUs unmapped"
          value={unmappedSkus.length}
          tone={unmappedSkus.length > 0 ? 'warn' : 'ok'}
        />
      </div>

      {msg && (
        <div className="rounded-xl border border-tt-border bg-tt-card px-3 py-2 text-sm text-tt-text">
          {msg}
          <button onClick={() => setMsg(null)} className="ml-3 text-xs text-tt-muted underline cursor-pointer">
            dismiss
          </button>
        </div>
      )}

      {/* ── Selected rack — drawn as a rack ───────────────────────────────── */}
      {selectedRack && (
        <RackView
          key={selectedRack.id}
          rack={selectedRack}
          slots={slotsByRack.get(selectedRack.id) ?? []}
          skuById={skuById}
          editingSlotId={editingSlotId}
          aisleA={stopByKey.get(`${selectedRack.id}:A`)?.aisle}
          aisleB={stopByKey.get(`${selectedRack.id}:B`)?.aisle}
          busy={
            updateRack.isPending || deleteRack.isPending ||
            addSection.isPending || deleteSection.isPending || setSectionSide.isPending
          }
          onClose={() => { setSelectedRackId(null); setEditingSlotId(null); }}
          onEditSlot={(id) => { setEditingSlotId(id); setSkuSearch(''); }}
          onAddSection={(shelf) =>
            run(() => addSection.mutateAsync({ rack_id: selectedRack.id, shelf_index: shelf, side: 'A' }),
              'Section added to the front row — click it to change which aisle it faces.')
          }
          onCycleSide={(slot) =>
            run(() => setSectionSide.mutateAsync({ slotId: slot.id, side: NEXT_SIDE[slot.side] }),
              `Section now picked from ${SIDE_LABEL[NEXT_SIDE[slot.side]]}.`)
          }
          onDeleteSection={(slotId, confirm) =>
            run(async () => {
              await deleteSection.mutateAsync({ slotId, confirm });
              if (slotId === editingSlotId) setEditingSlotId(null);
            }, 'Section removed.')
          }
          onShelves={(n, confirmDestructive) =>
            run(() => updateRack.mutateAsync({
              id: selectedRack.id, shelf_count: n, confirm_destructive: confirmDestructive,
            }), 'Shelves updated.')
          }
          onDelete={(confirm) =>
            run(async () => {
              await deleteRack.mutateAsync({ id: selectedRack.id, confirm });
              setSelectedRackId(null);
            }, 'Rack deleted.')
          }
        />
      )}

      {editingSlot && selectedRack && (
        <SlotAssigner
          slot={editingSlot}
          rack={selectedRack}
          skus={skus}
          skuById={skuById}
          search={skuSearch}
          setSearch={setSkuSearch}
          busy={assignSlot.isPending}
          onPick={(skuId) =>
            run(async () => {
              await assignSlot.mutateAsync({ slotId: editingSlot.id, skuId });
              setEditingSlotId(null);
            }, skuId ? 'SKU assigned.' : 'Section cleared.')
          }
          onCancel={() => setEditingSlotId(null)}
        />
      )}

      {/* ── Floor plan ────────────────────────────────────────────────────── */}
      <section>
        <header className="mb-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-tt-text">Floor plan</h3>
            <p className="text-xs text-tt-muted">
              Where each rack physically sits. Click one to lay out its shelves; drag it to move it.
            </p>
          </div>
          <label className="flex items-center gap-2 text-xs text-tt-muted">
            Route starts at
            <select
              value={startCorner}
              onChange={(e) => setStartCorner(e.target.value as StartCorner)}
              className="rounded-lg border border-tt-border bg-tt-card px-2 py-1 text-tt-text"
            >
              {CORNERS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </label>
        </header>

        <FloorPlanLegend />

        {racks.length === 0 ? (
          <EmptyFloor onAdd={() => setAdding({ row: 0, col: 0 })} />
        ) : (
          <div className="space-y-1 overflow-x-auto rounded-2xl border border-tt-border bg-tt-card p-3">
            {occupiedRows.map((row, i) => (
              <div key={row}>
                <AisleBand index={i} faces={facesOnAisle(i)} />
                <div className="flex gap-2 py-1">
                  {columns.map((col) => {
                    const rack = racks.find((r) => r.grid_row === row && r.grid_col === col);
                    return rack ? (
                      <RackCard
                        key={col}
                        rack={rack}
                        slots={slotsByRack.get(rack.id) ?? []}
                        selected={rack.id === selectedRackId}
                        stopA={stopByKey.get(`${rack.id}:A`)?.position}
                        stopB={stopByKey.get(`${rack.id}:B`)?.position}
                        onSelect={() => { setSelectedRackId(rack.id); setEditingSlotId(null); }}
                        onDragStart={() => setDragRackId(rack.id)}
                      />
                    ) : (
                      <DropCell
                        key={col}
                        onDrop={() => {
                          if (!dragRackId) return;
                          const id = dragRackId;
                          setDragRackId(null);
                          run(() => updateRack.mutateAsync({ id, grid_row: row, grid_col: col }), 'Rack moved.');
                        }}
                        onAdd={() => setAdding({ row, col })}
                      />
                    );
                  })}
                </div>
                {i === occupiedRows.length - 1 && (
                  <AisleBand index={occupiedRows.length} faces={facesOnAisle(occupiedRows.length)} />
                )}
              </div>
            ))}

            <div className="flex gap-2 border-t border-dashed border-tt-border pt-2">
              {columns.map((col) => (
                <DropCell
                  key={col}
                  hint="new row"
                  onDrop={() => {
                    if (!dragRackId) return;
                    const id = dragRackId;
                    setDragRackId(null);
                    run(() => updateRack.mutateAsync({
                      id, grid_row: (occupiedRows[occupiedRows.length - 1] ?? 0) + 1, grid_col: col,
                    }), 'Rack moved to a new row.');
                  }}
                  onAdd={() => setAdding({ row: (occupiedRows[occupiedRows.length - 1] ?? -1) + 1, col })}
                />
              ))}
            </div>
          </div>
        )}
      </section>

      {adding && (
        <section className="rounded-2xl border border-tt-cyan/60 bg-tt-card p-4">
          <h3 className="mb-1 text-sm font-semibold text-tt-text">
            New rack at row {adding.row + 1}, column {adding.col + 1}
          </h3>
          <p className="mb-3 text-xs text-tt-muted">
            How many shelves? You divide them into sections afterwards.
          </p>
          <div className="flex flex-wrap items-end gap-4">
            <Field label={`Shelves (${MIN_SHELVES}–${MAX_SHELVES})`}>
              <NumberStepper value={newShelves} min={MIN_SHELVES} max={MAX_SHELVES} onChange={setNewShelves} />
            </Field>
            <button
              disabled={createRack.isPending}
              onClick={() =>
                run(async () => {
                  const res = await createRack.mutateAsync({
                    grid_row: adding.row, grid_col: adding.col, shelf_count: newShelves,
                  });
                  setAdding(null);
                  if (res?.rack?.id) setSelectedRackId(res.rack.id);
                }, 'Rack added — now divide its shelves into sections.')
              }
              className="rounded-lg bg-tt-green px-3 py-1.5 text-sm font-bold text-black disabled:opacity-40 cursor-pointer"
            >
              Add rack
            </button>
            <button onClick={() => setAdding(null)} className="text-sm text-tt-muted underline cursor-pointer">
              Cancel
            </button>
          </div>
        </section>
      )}

      {stops.length > 0 && (
        <section>
          <h3 className="mb-1 text-sm font-semibold text-tt-text">Picking route</h3>
          <p className="mb-2 text-xs text-tt-muted">
            Derived from the floor plan. Pick lines are sorted by this order, so everything at one
            stop is picked before moving on.
          </p>
          <ol className="flex flex-wrap gap-2">
            {stops.map((s) => (
              <li
                key={`${s.rackId}:${s.side}`}
                className="flex items-center gap-2 rounded-lg border border-tt-border bg-tt-card px-2.5 py-1.5 text-sm"
              >
                <span className="text-xs tabular-nums text-tt-muted">{s.position + 1}</span>
                <span className="font-bold text-tt-text">{s.label}</span>
                <span className="text-[11px] text-tt-muted">aisle {s.aisle + 1}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section>
        <h3 className="mb-1 text-sm font-semibold text-tt-text">
          Unmapped SKUs {unmappedSkus.length > 0 && <span className="text-tt-muted">({unmappedSkus.length})</span>}
        </h3>
        {unmappedSkus.length === 0 ? (
          <p className="text-xs text-tt-green">Every active SKU has a section.</p>
        ) : (
          <>
            <p className="mb-2 text-xs text-tt-muted">
              These sort <b>last</b> on the pick screen and fall back to SKU-number order until they
              are placed — mapping is safe to do a few at a time.
            </p>
            <div className="flex flex-wrap gap-2">
              {unmappedSkus.slice(0, 60).map((s) => (
                <span key={s.id} className="flex items-center gap-2 rounded-lg border border-tt-border bg-tt-card px-2 py-1">
                  <SkuThumb url={s.thumbnail_url} />
                  <span className="text-xs">
                    <b className="text-tt-text">#{s.sku_number}</b>
                    <span className="ml-1 text-tt-muted">{s.title}</span>
                  </span>
                </span>
              ))}
              {unmappedSkus.length > 60 && (
                <span className="self-center text-xs text-tt-muted">+ {unmappedSkus.length - 60} more</span>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

/* ── Pieces ──────────────────────────────────────────────────────────────── */

function Tile({ label, value, tone }: { label: string; value: number | string; tone?: 'ok' | 'warn' }) {
  const color = tone === 'warn' ? 'text-tt-red' : tone === 'ok' ? 'text-tt-green' : 'text-tt-text';
  return (
    <div className="rounded-xl border border-tt-border bg-tt-card px-3 py-2">
      <div className={`text-xl font-extrabold tabular-nums ${color}`}>{value}</div>
      <div className="text-[11px] text-tt-muted">{label}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-tt-muted">{label}</span>
      {children}
    </label>
  );
}

function NumberStepper({
  value, min, max, onChange,
}: { value: number; min: number; max: number; onChange: (n: number) => void }) {
  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
        className="h-8 w-8 rounded-lg border border-tt-border text-tt-text disabled:opacity-30 cursor-pointer"
      >
        −
      </button>
      <span className="w-8 text-center text-sm font-bold tabular-nums text-tt-text">{value}</span>
      <button
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
        className="h-8 w-8 rounded-lg border border-tt-border text-tt-text disabled:opacity-30 cursor-pointer"
      >
        +
      </button>
    </div>
  );
}

// A small picture of the one rule the floor plan runs on. Explaining it in prose did not
// land; two rows and the lane between them show it in one glance.
function FloorPlanLegend() {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-4 rounded-xl border border-tt-border/60 bg-tt-card/50 px-3 py-2">
      <div className="shrink-0">
        <div className="text-[10px] uppercase tracking-wide text-tt-muted">aisle</div>
        <div className="my-0.5 flex items-center gap-1">
          <span className="rounded bg-tt-card-hover px-2 py-1 text-[10px] font-bold text-tt-text">R1</span>
          <span className="rounded bg-tt-card-hover px-2 py-1 text-[10px] font-bold text-tt-text">R3</span>
        </div>
        <div className="h-1 rounded bg-tt-green/40" />
        <div className="my-0.5 flex items-center gap-1">
          <span className="rounded bg-tt-card-hover px-2 py-1 text-[10px] font-bold text-tt-text">R2</span>
          <span className="rounded bg-tt-card-hover px-2 py-1 text-[10px] font-bold text-tt-text">R4</span>
        </div>
        <div className="text-[10px] uppercase tracking-wide text-tt-muted">aisle</div>
      </div>
      <p className="min-w-48 flex-1 text-[11px] leading-relaxed text-tt-muted">
        Racks in the same row sit side by side. The lane <b className="text-tt-green">between two rows is
        an aisle</b>, and each rack shows one face to the lane above it (<b>side A</b>) and one to the
        lane below (<b>side B</b>). So standing in the green aisle you can reach <b>R1&apos;s B side</b> and{' '}
        <b>R2&apos;s A side</b> without moving — which is what the picking route is built from.
      </p>
    </div>
  );
}

function EmptyFloor({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="rounded-2xl border border-dashed border-tt-border bg-tt-card p-8 text-center">
      <p className="text-sm text-tt-text">No racks yet.</p>
      <p className="mx-auto mt-1 max-w-md text-xs text-tt-muted">
        Add your racks and place them the way they physically sit. Aisles and the picking route are
        worked out from that placement — you never set a walking order by hand.
      </p>
      <button onClick={onAdd} className="mt-3 rounded-lg bg-tt-green px-3 py-1.5 text-sm font-bold text-black cursor-pointer">
        Add the first rack
      </button>
    </div>
  );
}

function AisleBand({ index, faces }: { index: number; faces: { label: string }[] }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-tt-card-hover/40 px-2 py-1">
      <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-tt-muted">
        Aisle {index + 1}
      </span>
      <span className="h-px flex-1 bg-tt-border" />
      <span className="shrink-0 text-[11px] text-tt-muted">
        {faces.length ? `reach ${faces.map((f) => f.label).join(' · ')}` : 'nothing reachable'}
      </span>
    </div>
  );
}

function RackCard({
  rack, slots, selected, stopA, stopB, onSelect, onDragStart,
}: {
  rack: MappingRack;
  slots: MappingSlot[];
  selected: boolean;
  stopA?: number;
  stopB?: number;
  onSelect: () => void;
  onDragStart: () => void;
}) {
  const filled = slots.filter((s) => s.inventory_sku_id).length;
  return (
    <button
      draggable
      onDragStart={onDragStart}
      onClick={onSelect}
      className={`w-36 shrink-0 rounded-xl border-2 p-2 text-left transition-colors cursor-grab active:cursor-grabbing ${
        selected ? 'border-tt-green bg-tt-green/10' : 'border-tt-border bg-tt-card hover:bg-tt-card-hover'
      }`}
    >
      <div className="text-[10px] text-tt-muted">
        A side {stopA != null && <span className="text-tt-cyan">· stop {stopA + 1}</span>}
      </div>
      <div className="my-1 rounded-lg bg-tt-card-hover px-2 py-2 text-center">
        <div className="text-lg font-extrabold text-tt-text">{rack.name}</div>
        <div className="text-[11px] text-tt-muted">
          {rack.shelf_count} shelves · {slots.length} sections
        </div>
        <div className={`text-[11px] tabular-nums ${slots.length > 0 && filled === slots.length ? 'text-tt-green' : 'text-tt-muted'}`}>
          {slots.length === 0 ? 'no sections yet' : `${filled}/${slots.length} filled`}
        </div>
      </div>
      <div className="text-right text-[10px] text-tt-muted">
        {stopB != null && <span className="text-tt-cyan">stop {stopB + 1} · </span>}B side
      </div>
    </button>
  );
}

function DropCell({ onDrop, onAdd, hint }: { onDrop: () => void; onAdd: () => void; hint?: string }) {
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); onDrop(); }}
      className={`flex w-36 shrink-0 items-center justify-center rounded-xl border-2 border-dashed transition-colors ${
        over ? 'border-tt-green bg-tt-green/10' : 'border-tt-border/60'
      }`}
      style={{ minHeight: '96px' }}
    >
      <button onClick={onAdd} className="text-xs text-tt-muted hover:text-tt-text cursor-pointer">
        + {hint ?? 'rack'}
      </button>
    </div>
  );
}

// The rack, drawn as a rack: aisle above, shelves stacked top to bottom, aisle below. A
// section's accent bar sits on the edge facing the aisle it is picked from — both edges when
// it is picked from both — so the layout is readable without counting badges.
function RackView({
  rack, slots, skuById, editingSlotId, aisleA, aisleB, busy,
  onClose, onEditSlot, onAddSection, onCycleSide, onDeleteSection, onShelves, onDelete,
}: {
  rack: MappingRack;
  slots: MappingSlot[];
  skuById: Map<string, MappingSku>;
  editingSlotId: string | null;
  aisleA?: number;
  aisleB?: number;
  busy: boolean;
  onClose: () => void;
  onEditSlot: (slotId: string) => void;
  onAddSection: (shelf: number) => void;
  onCycleSide: (slot: MappingSlot) => void;
  onDeleteSection: (slotId: string, confirm?: boolean) => void;
  onShelves: (n: number, confirmDestructive?: boolean) => void;
  onDelete: (confirm?: boolean) => void;
}) {
  const [shelves, setShelves] = useState(rack.shelf_count);
  const shelvesChanged = shelves !== rack.shelf_count;
  const shrinking = shelves < rack.shelf_count;

  const faceCount = (face: RackSide) => slots.filter((s) => isReachableFrom(s.side, face)).length;
  const selected = slots.find((s) => s.id === editingSlotId) ?? null;

  return (
    <section className="rounded-2xl border border-tt-border bg-tt-card p-4">
      <header className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h3 className="text-base font-bold text-tt-text">Rack {rack.name}</h3>
          <span className="text-[11px] text-tt-muted">
            {rack.shelf_count} shelves · {slots.length} sections ·{' '}
            {slots.filter((s) => s.inventory_sku_id).length} filled
          </span>
        </div>
        <button onClick={onClose} className="text-xs text-tt-muted underline cursor-pointer">Close</button>
      </header>

      {/* Back row first, because that is what the drawing shows furthest away. */}
      <AisleEdge side="B" aisle={aisleB} count={faceCount('B')} position="top" />

      <RackIsometric
        shelfCount={rack.shelf_count}
        slots={slots}
        skuById={skuById}
        selectedSlotId={editingSlotId}
        canAddToShelf={(shelf) => !busy && canAddSection(slots, shelf, 'A')}
        onPickSection={(slot) => onEditSlot(slot.id)}
        onAddSection={onAddSection}
      />

      <AisleEdge side="A" aisle={aisleA} count={faceCount('A')} position="bottom" />

      {/* Controls for the section you clicked. They live in HTML rather than on the drawing:
          small angled shapes are poor click targets, and a section needs three actions. */}
      {selected ? (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-tt-cyan/50 bg-tt-cyan/5 px-3 py-2">
          <span className="text-xs font-semibold text-tt-text">
            S{selected.section_index} · shelf {selected.shelf_index}
          </span>
          <span className="font-mono text-[10px] text-tt-muted">{selected.slot_code}</span>
          <span className="h-4 w-px bg-tt-border" />
          <button
            onClick={() => onCycleSide(selected)}
            disabled={busy}
            className="rounded-lg border border-tt-border px-2 py-1 text-xs font-bold text-tt-text disabled:opacity-40 cursor-pointer"
          >
            Picked from: {SIDE_LABEL[selected.side]} → {SIDE_LABEL[NEXT_SIDE[selected.side]]}
          </button>
          <button
            onClick={() => onDeleteSection(selected.id, false)}
            disabled={busy}
            className="rounded-lg border border-tt-border px-2 py-1 text-xs text-tt-muted hover:text-tt-red disabled:opacity-40 cursor-pointer"
          >
            Remove section
          </button>
          <span className="text-[11px] text-tt-muted">Assign a SKU to it below.</span>
        </div>
      ) : (
        <p className="mt-3 text-[11px] leading-relaxed text-tt-muted">
          Click a box to assign a SKU to it, or a dashed <b>+</b> to divide a shelf once more. Front
          row is <b>side A</b>, back row is <b>side B</b>, and a{' '}
          <b className="text-tt-cyan">teal box spanning both rows</b> is one space picked from either
          aisle.
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-tt-border pt-3">
        <Field label={`Shelves (${MIN_SHELVES}–${MAX_SHELVES})`}>
          <NumberStepper value={shelves} min={MIN_SHELVES} max={MAX_SHELVES} onChange={setShelves} />
        </Field>
        {shelvesChanged && (
          <>
            <button
              onClick={() => onShelves(shelves)}
              disabled={busy}
              className="rounded-lg bg-tt-green px-3 py-1.5 text-sm font-bold text-black disabled:opacity-40 cursor-pointer"
            >
              {shrinking ? `Remove down to ${shelves}` : `Add up to ${shelves}`}
            </button>
            {shrinking && (
              <button
                onClick={() => onShelves(shelves, true)}
                disabled={busy}
                className="rounded-lg border border-tt-red px-3 py-1.5 text-sm font-bold text-tt-red disabled:opacity-40 cursor-pointer"
              >
                Remove anyway
              </button>
            )}
          </>
        )}
        <span className="flex-1" />
        <button
          onClick={() => onDelete(false)}
          disabled={busy}
          className="rounded-lg border border-tt-border px-2 py-1.5 text-xs text-tt-muted hover:text-tt-red disabled:opacity-40 cursor-pointer"
        >
          Delete rack
        </button>
      </div>
    </section>
  );
}

function AisleEdge({
  side, aisle, count, position,
}: { side: RackSide; aisle?: number; count: number; position: 'top' | 'bottom' }) {
  return (
    <div
      className={`flex items-center gap-2 px-2 py-1 text-[10px] uppercase tracking-wide text-tt-muted ${
        position === 'top' ? 'border-b border-dashed border-tt-border' : 'border-t border-dashed border-tt-border'
      }`}
    >
      <span className="font-bold text-tt-text">Side {side}</span>
      <span>{aisle != null ? `opens onto aisle ${aisle + 1}` : 'not placed on the floor plan'}</span>
      <span className="h-px flex-1 bg-tt-border" />
      <span className="tabular-nums">{count} reachable</span>
    </div>
  );
}

function SlotAssigner({
  slot, rack, skus, skuById, search, setSearch, busy, onPick, onCancel,
}: {
  slot: MappingSlot;
  rack: MappingRack;
  skus: MappingSku[];
  skuById: Map<string, MappingSku>;
  search: string;
  setSearch: (s: string) => void;
  busy: boolean;
  onPick: (skuId: string | null) => void;
  onCancel: () => void;
}) {
  const current = slot.inventory_sku_id ? skuById.get(slot.inventory_sku_id) : null;
  const q = search.trim().toLowerCase();
  const matches = q
    ? skus.filter(
        (s) =>
          String(s.sku_number).includes(q) ||
          s.title.toLowerCase().includes(q) ||
          s.barcode.toLowerCase().includes(q),
      )
    : skus;

  return (
    <section className="rounded-2xl border border-tt-cyan/60 bg-tt-card p-4">
      <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-tt-text">
            {slot.side === 'AB'
              ? `${rack.name} L${slot.shelf_index} S${slot.section_index} · picked from both aisles`
              : slotAddress(rack.name, slot.side, slot.shelf_index, slot.section_index)}
          </h3>
          <p className="font-mono text-[11px] text-tt-muted">{slot.slot_code}</p>
        </div>
        <button onClick={onCancel} className="text-xs text-tt-muted underline cursor-pointer">Cancel</button>
      </header>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search or scan a SKU…"
          className="min-w-48 flex-1 rounded-lg border border-tt-border bg-tt-card px-2 py-1.5 text-sm text-tt-text"
        />
        {current && (
          <button
            onClick={() => onPick(null)}
            disabled={busy}
            className="rounded-lg border border-tt-border px-2 py-1.5 text-xs text-tt-muted hover:text-tt-red disabled:opacity-40 cursor-pointer"
          >
            Clear section
          </button>
        )}
      </div>

      <div className="flex max-h-64 flex-wrap gap-2 overflow-y-auto">
        {matches.slice(0, 80).map((s) => (
          <button
            key={s.id}
            onClick={() => onPick(s.id)}
            disabled={busy}
            className={`flex items-center gap-2 rounded-lg border px-2 py-1 disabled:opacity-40 cursor-pointer ${
              s.id === slot.inventory_sku_id ? 'border-tt-green bg-tt-green/10' : 'border-tt-border hover:bg-tt-card-hover'
            }`}
          >
            <SkuThumb url={s.thumbnail_url} />
            <span className="text-xs">
              <b className="text-tt-text">#{s.sku_number}</b>
              <span className="ml-1 text-tt-muted">{s.title}</span>
            </span>
          </button>
        ))}
        {matches.length === 0 && <p className="text-xs text-tt-muted">No SKU matches “{search}”.</p>}
      </div>
    </section>
  );
}
