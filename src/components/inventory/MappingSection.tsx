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
  useAssignSlot,
  NeedsConfirmation,
  type MappingRack,
  type MappingSlot,
  type MappingSku,
} from '@/hooks/useMapping';
import { deriveRoute, pickerLabel, slotAddress, type StartCorner } from '@/lib/mapping/route';
import {
  sectionsOn, shelfIndexes, MIN_SHELVES, MAX_SHELVES, MAX_SECTIONS, type Side,
} from '@/lib/mapping/shape';

// Inventory → Mapping.
//
// Two ideas carry this screen:
//
// 1. The floor plan is the INPUT, not a picture of one. You place racks the way they
//    physically sit, and the aisles and picking route are derived from that placement. A
//    grid plus a separately-maintained walking order would just be two things to get out
//    of sync.
//
// 2. A rack is not a uniform grid. You declare its shelves, then divide each shelf FACE
//    into as many sections as that face actually has — side A can hold 4 while side B
//    holds 6. So the rack view shows one side at a time and you flip it, which is also how
//    you stand in front of the real thing.
//
// Everything derived here is computed client-side from the single /api/inventory/mapping
// payload using the same pure functions the pick path will use, so what this screen shows
// and what the picker walks cannot drift apart.

const CORNERS: { value: StartCorner; label: string }[] = [
  { value: 'top-left', label: 'Top-left' },
  { value: 'top-right', label: 'Top-right' },
  { value: 'bottom-left', label: 'Bottom-left' },
  { value: 'bottom-right', label: 'Bottom-right' },
];

export default function MappingSection() {
  const { data, isLoading, error } = useMapping();
  const createRack = useCreateRack();
  const updateRack = useUpdateRack();
  const deleteRack = useDeleteRack();
  const addSection = useAddSection();
  const deleteSection = useDeleteSection();
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

  if (isLoading) return <div className="p-4 text-sm text-tt-muted">Loading mapping…</div>;
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

      {/* ── Floor plan ────────────────────────────────────────────────────── */}
      <section>
        <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-tt-text">Floor plan</h3>
            <p className="text-xs text-tt-muted">
              Drag a rack to move it. Side <b>A</b> always faces up, <b>B</b> faces down — so two racks
              in neighbouring rows share the aisle between them.
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

      {/* ── Add a rack — shelves only ─────────────────────────────────────── */}
      {adding && (
        <section className="rounded-2xl border border-tt-cyan/60 bg-tt-card p-4">
          <h3 className="mb-1 text-sm font-semibold text-tt-text">
            New rack at row {adding.row + 1}, column {adding.col + 1}
          </h3>
          <p className="mb-3 text-xs text-tt-muted">
            How many shelves? You divide each shelf into sections afterwards, one side at a time.
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
                }, 'Rack added — now add sections to its shelves.')
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

      {/* key on rack.id so switching racks resets the panel's own state rather than
          showing the previously selected rack's shelf count. */}
      {selectedRack && (
        <RackPanel
          key={selectedRack.id}
          rack={selectedRack}
          slots={slotsByRack.get(selectedRack.id) ?? []}
          skuById={skuById}
          editingSlotId={editingSlotId}
          busy={updateRack.isPending || deleteRack.isPending || addSection.isPending || deleteSection.isPending}
          onClose={() => { setSelectedRackId(null); setEditingSlotId(null); }}
          onEditSlot={(id) => { setEditingSlotId(id); setSkuSearch(''); }}
          onAddSection={(shelf, side) =>
            run(() => addSection.mutateAsync({ rack_id: selectedRack.id, shelf_index: shelf, side }), 'Section added.')
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
                className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm ${
                  s.overridden ? 'border-tt-cyan/60 bg-tt-cyan/10' : 'border-tt-border bg-tt-card'
                }`}
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
        {faces.length ? faces.map((f) => f.label).join(' · ') : 'nothing reachable'}
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

// One rack, one side at a time. Flipping is how you work on the real thing — you stand on
// one side of it — and it is the only honest way to show faces that have different section
// layouts.
function RackPanel({
  rack, slots, skuById, editingSlotId, busy,
  onClose, onEditSlot, onAddSection, onDeleteSection, onShelves, onDelete,
}: {
  rack: MappingRack;
  slots: MappingSlot[];
  skuById: Map<string, MappingSku>;
  editingSlotId: string | null;
  busy: boolean;
  onClose: () => void;
  onEditSlot: (slotId: string) => void;
  onAddSection: (shelf: number, side: Side) => void;
  onDeleteSection: (slotId: string, confirm?: boolean) => void;
  onShelves: (n: number, confirmDestructive?: boolean) => void;
  onDelete: (confirm?: boolean) => void;
}) {
  const [side, setSide] = useState<Side>('A');
  const [shelves, setShelves] = useState(rack.shelf_count);

  const shelvesChanged = shelves !== rack.shelf_count;
  const shrinking = shelves < rack.shelf_count;

  // Top shelf first, so the panel reads the way the rack looks when you stand at it.
  const rows = shelfIndexes(rack.shelf_count).slice().reverse();
  const thisSideCount = slots.filter((s) => s.side === side).length;

  return (
    <section className="rounded-2xl border border-tt-border bg-tt-card p-4">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-tt-text">Rack {rack.name}</h3>
          <div className="flex overflow-hidden rounded-lg border border-tt-border">
            {(['A', 'B'] as Side[]).map((s) => (
              <button
                key={s}
                onClick={() => setSide(s)}
                className={`px-3 py-1 text-xs font-bold transition-colors cursor-pointer ${
                  side === s ? 'bg-tt-green text-black' : 'text-tt-muted hover:text-tt-text'
                }`}
              >
                Side {s}
              </button>
            ))}
          </div>
          <span className="text-[11px] text-tt-muted">
            {side === 'A' ? 'faces up the floor plan' : 'faces down the floor plan'} · {thisSideCount} section
            {thisSideCount === 1 ? '' : 's'}
          </span>
        </div>
        <button onClick={onClose} className="text-xs text-tt-muted underline cursor-pointer">Close</button>
      </header>

      <div className="mb-4 flex flex-wrap items-end gap-3">
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
              {shrinking ? `Remove down to ${shelves} shelves` : `Add up to ${shelves} shelves`}
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

      <div className="space-y-2">
        {rows.map((shelf) => {
          const sections = sectionsOn(slots, shelf, side);
          const atMax = sections.length >= MAX_SECTIONS;
          return (
            <div key={shelf} className="flex items-stretch gap-2">
              <div className="flex w-12 shrink-0 flex-col items-center justify-center rounded-lg bg-tt-card-hover py-2">
                <span className="text-xs font-bold text-tt-text">L{shelf}</span>
                <span className="text-[10px] text-tt-muted">{sections.length}</span>
              </div>
              <div className="flex flex-1 flex-wrap items-center gap-2 rounded-lg border border-dashed border-tt-border p-2">
                {sections.map((slot) => {
                  const sku = slot.inventory_sku_id ? skuById.get(slot.inventory_sku_id) : null;
                  const isEditing = slot.id === editingSlotId;
                  return (
                    <div
                      key={slot.id}
                      className={`group relative flex w-40 items-center gap-2 rounded-lg border px-2 py-1.5 ${
                        isEditing ? 'border-tt-cyan bg-tt-cyan/10'
                          : sku ? 'border-tt-green/50 bg-tt-green/5'
                          : 'border-tt-border'
                      }`}
                    >
                      <button
                        onClick={() => onEditSlot(slot.id)}
                        title={`${slotAddress(rack.name, side, shelf, slot.section_index)} · ${slot.slot_code}`}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left cursor-pointer"
                      >
                        <span className="shrink-0 text-[10px] font-bold text-tt-muted">S{slot.section_index}</span>
                        {sku ? (
                          <>
                            <SkuThumb url={sku.thumbnail_url} />
                            <span className="min-w-0 flex-1 truncate text-[11px] text-tt-text">#{sku.sku_number}</span>
                          </>
                        ) : (
                          <span className="flex-1 text-[11px] text-tt-muted">empty</span>
                        )}
                      </button>
                      <button
                        onClick={() => onDeleteSection(slot.id, false)}
                        disabled={busy}
                        title="Remove this section"
                        className="shrink-0 px-1 text-xs text-tt-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-tt-red disabled:opacity-30 cursor-pointer"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
                <button
                  onClick={() => onAddSection(shelf, side)}
                  disabled={busy || atMax}
                  title={atMax ? `A shelf face holds at most ${MAX_SECTIONS} sections` : undefined}
                  className="rounded-lg border border-dashed border-tt-border px-3 py-2 text-xs text-tt-muted hover:text-tt-text disabled:opacity-30 cursor-pointer"
                >
                  {atMax ? 'full' : '+ section'}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <p className="mt-3 text-[11px] text-tt-muted">
        The picker sees <b>{pickerLabel(rack.name, side, rack.shelf_count)}</b>-style guidance; the
        section number is on the printed label for whoever places stock. Each side has its own
        layout — flip to set up the other one.
      </p>
    </section>
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
            {slotAddress(rack.name, slot.side, slot.shelf_index, slot.section_index)}
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

      <p className="mb-2 text-[11px] text-tt-muted">
        For a SKU picked from <b>both</b> sides, assign it to a section on side A and one on side B —
        the route then sends the picker to whichever face they reach first.
      </p>

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
