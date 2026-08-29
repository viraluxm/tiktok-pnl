'use client';

import { useMemo, useState } from 'react';
import SkuThumb from '@/components/common/SkuThumb';
import {
  useMapping,
  useCreateRack,
  useUpdateRack,
  useDeleteRack,
  useAssignSlot,
  NeedsConfirmation,
  type MappingRack,
  type MappingSlot,
  type MappingSku,
} from '@/hooks/useMapping';
import { deriveRoute, pickerLabel, slotAddress, type StartCorner, type Side } from '@/lib/mapping/route';
import {
  MIN_SHELVES, MAX_SHELVES, MIN_SECTIONS, MAX_SECTIONS, SIDES,
} from '@/lib/mapping/shape';

// Inventory → Mapping.
//
// The floor plan is the point of this screen: you place racks the way they physically sit,
// and the aisles and the picking route fall out of that placement rather than being
// configured separately. A grid that has to be kept in sync with a hand-written walking
// order would just be two things to get wrong.
//
// Everything derived here (aisles, route, unmapped SKUs) is computed client-side from the
// single /api/inventory/mapping payload, using the same pure functions the pick path will
// use — so what this screen shows and what the picker walks cannot drift apart.

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
  const assignSlot = useAssignSlot();

  const [selectedRackId, setSelectedRackId] = useState<string | null>(null);
  const [editingSlotId, setEditingSlotId] = useState<string | null>(null);
  const [skuSearch, setSkuSearch] = useState('');
  const [bothSides, setBothSides] = useState(false);
  const [startCorner, setStartCorner] = useState<StartCorner>('top-left');
  const [msg, setMsg] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ row: number; col: number } | null>(null);
  const [newName, setNewName] = useState('');
  const [newShelves, setNewShelves] = useState(2);
  const [newSections, setNewSections] = useState(2);
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

  // Occupied rows in physical order. Aisle k sits above the k-th occupied row; the last
  // aisle sits below the final row. This mirrors deriveRoute exactly — see lib/mapping/route.ts.
  const occupiedRows = useMemo(
    () => Array.from(new Set(racks.map((r) => r.grid_row))).sort((a, b) => a - b),
    [racks],
  );
  const maxCol = useMemo(
    () => racks.reduce((m, r) => Math.max(m, r.grid_col), -1),
    [racks],
  );
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
          `${e.message} ${e.assignedLost} assigned slot${e.assignedLost === 1 ? '' : 's'} would be cleared` +
            (names ? `, leaving ${names} unmapped.` : '.') +
            ' Use "Resize anyway" to confirm.',
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

  return (
    <div className="space-y-6 p-1">
      {/* ── Summary ───────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Racks" value={racks.length} />
        <Tile label="Slots" value={slots.length} />
        <Tile label="Slots filled" value={`${assignedSkuIds.size ? slots.filter((s) => s.inventory_sku_id).length : 0}`} />
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
              Drag a rack to move it. Side <b>A</b> always faces up, <b>B</b> faces down — so two racks in
              neighbouring rows share the aisle between them.
            </p>
          </div>
          <label className="flex items-center gap-2 text-xs text-tt-muted">
            Route starts at
            <select
              value={startCorner}
              onChange={(e) => setStartCorner(e.target.value as StartCorner)}
              className="rounded-lg border border-tt-border bg-tt-card px-2 py-1 text-tt-text"
            >
              {CORNERS.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
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
                          run(
                            () => updateRack.mutateAsync({ id, grid_row: row, grid_col: col }),
                            'Rack moved.',
                          );
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

            {/* A fresh row below the floor, so a rack can always be placed in a new aisle. */}
            <div className="flex gap-2 border-t border-dashed border-tt-border pt-2">
              {columns.map((col) => (
                <DropCell
                  key={col}
                  hint="new row"
                  onDrop={() => {
                    if (!dragRackId) return;
                    const id = dragRackId;
                    setDragRackId(null);
                    run(
                      () => updateRack.mutateAsync({
                        id, grid_row: (occupiedRows[occupiedRows.length - 1] ?? 0) + 1, grid_col: col,
                      }),
                      'Rack moved to a new row.',
                    );
                  }}
                  onAdd={() =>
                    setAdding({ row: (occupiedRows[occupiedRows.length - 1] ?? -1) + 1, col })
                  }
                />
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ── Add a rack ────────────────────────────────────────────────────── */}
      {adding && (
        <section className="rounded-2xl border border-tt-cyan/60 bg-tt-card p-4">
          <h3 className="mb-3 text-sm font-semibold text-tt-text">
            New rack at row {adding.row}, column {adding.col}
          </h3>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Name">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="R1"
                className="w-24 rounded-lg border border-tt-border bg-tt-card px-2 py-1.5 text-sm text-tt-text"
              />
            </Field>
            <Field label={`Shelves (${MIN_SHELVES}–${MAX_SHELVES})`}>
              <NumberStepper value={newShelves} min={MIN_SHELVES} max={MAX_SHELVES} onChange={setNewShelves} />
            </Field>
            <Field label={`Sections per shelf (${MIN_SECTIONS}–${MAX_SECTIONS})`}>
              <NumberStepper value={newSections} min={MIN_SECTIONS} max={MAX_SECTIONS} onChange={setNewSections} />
            </Field>
            <div className="text-xs text-tt-muted">
              = <b className="text-tt-text">{newShelves * newSections * 2} slots</b>
              <div>both faces of {newShelves * newSections} sections</div>
            </div>
            <button
              disabled={!newName.trim() || createRack.isPending}
              onClick={() =>
                run(async () => {
                  await createRack.mutateAsync({
                    name: newName.trim(),
                    grid_row: adding.row,
                    grid_col: adding.col,
                    shelf_count: newShelves,
                    sections_per_shelf: newSections,
                  });
                  setAdding(null);
                  setNewName('');
                }, `Rack ${newName.trim()} added with ${newShelves * newSections * 2} slots.`)
              }
              className="rounded-lg bg-tt-green px-3 py-1.5 text-sm font-bold text-black disabled:opacity-40 cursor-pointer"
            >
              Add rack
            </button>
            <button
              onClick={() => setAdding(null)}
              className="text-sm text-tt-muted underline cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </section>
      )}

      {/* ── Selected rack ─────────────────────────────────────────────────── */}
      {selectedRack && (
        <RackPanel
          rack={selectedRack}
          slots={slotsByRack.get(selectedRack.id) ?? []}
          skuById={skuById}
          onClose={() => { setSelectedRackId(null); setEditingSlotId(null); }}
          onEditSlot={(id) => { setEditingSlotId(id); setSkuSearch(''); setBothSides(false); }}
          editingSlotId={editingSlotId}
          onResize={(shelves, sections, confirmDestructive) =>
            run(
              () => updateRack.mutateAsync({
                id: selectedRack.id,
                shelf_count: shelves,
                sections_per_shelf: sections,
                confirm_destructive: confirmDestructive,
              }),
              'Rack resized.',
            )
          }
          onRename={(name) =>
            run(() => updateRack.mutateAsync({ id: selectedRack.id, name }), 'Rack renamed.')
          }
          onDelete={(confirm) =>
            run(async () => {
              await deleteRack.mutateAsync({ id: selectedRack.id, confirm });
              setSelectedRackId(null);
            }, 'Rack deleted.')
          }
          busy={updateRack.isPending || deleteRack.isPending}
        />
      )}

      {/* SKU picker for the slot being edited. */}
      {editingSlot && selectedRack && (
        <SlotAssigner
          slot={editingSlot}
          rack={selectedRack}
          skus={skus}
          skuById={skuById}
          search={skuSearch}
          setSearch={setSkuSearch}
          bothSides={bothSides}
          setBothSides={setBothSides}
          busy={assignSlot.isPending}
          onPick={(skuId) =>
            run(async () => {
              await assignSlot.mutateAsync({ slotId: editingSlot.id, skuId, bothSides });
              setEditingSlotId(null);
            }, skuId ? 'SKU assigned.' : 'Slot cleared.')
          }
          onCancel={() => setEditingSlotId(null)}
        />
      )}

      {/* ── Route preview ─────────────────────────────────────────────────── */}
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
                {s.overridden && <span className="text-[11px] text-tt-cyan">pinned</span>}
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* ── Unmapped SKUs ─────────────────────────────────────────────────── */}
      <section>
        <h3 className="mb-1 text-sm font-semibold text-tt-text">
          Unmapped SKUs {unmappedSkus.length > 0 && <span className="text-tt-muted">({unmappedSkus.length})</span>}
        </h3>
        {unmappedSkus.length === 0 ? (
          <p className="text-xs text-tt-green">Every active SKU has a slot.</p>
        ) : (
          <>
            <p className="mb-2 text-xs text-tt-muted">
              These sort <b>last</b> on the pick screen and fall back to SKU-number order until they
              are placed — mapping is safe to do a few at a time.
            </p>
            <div className="flex flex-wrap gap-2">
              {unmappedSkus.slice(0, 60).map((s) => (
                <span
                  key={s.id}
                  className="flex items-center gap-2 rounded-lg border border-tt-border bg-tt-card px-2 py-1"
                >
                  <SkuThumb url={s.thumbnail_url} />
                  <span className="text-xs">
                    <b className="text-tt-text">#{s.sku_number}</b>
                    <span className="ml-1 text-tt-muted">{s.title}</span>
                  </span>
                </span>
              ))}
              {unmappedSkus.length > 60 && (
                <span className="self-center text-xs text-tt-muted">
                  + {unmappedSkus.length - 60} more
                </span>
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
      <button
        onClick={onAdd}
        className="mt-3 rounded-lg bg-tt-green px-3 py-1.5 text-sm font-bold text-black cursor-pointer"
      >
        Add the first rack
      </button>
    </div>
  );
}

// The lane between two rows of racks. Naming the faces reachable from it is the whole point:
// it shows at a glance that one standing position serves two different racks.
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
  const total = slots.length;
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
          {rack.shelf_count} × {rack.sections_per_shelf} · {total} slots
        </div>
        <div className={`text-[11px] tabular-nums ${filled === total ? 'text-tt-green' : 'text-tt-muted'}`}>
          {filled}/{total} filled
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

function RackPanel({
  rack, slots, skuById, onClose, onEditSlot, editingSlotId, onResize, onRename, onDelete, busy,
}: {
  rack: MappingRack;
  slots: MappingSlot[];
  skuById: Map<string, MappingSku>;
  onClose: () => void;
  onEditSlot: (slotId: string) => void;
  editingSlotId: string | null;
  onResize: (shelves: number, sections: number, confirmDestructive?: boolean) => void;
  onRename: (name: string) => void;
  onDelete: (confirm?: boolean) => void;
  busy: boolean;
}) {
  const [shelves, setShelves] = useState(rack.shelf_count);
  const [sections, setSections] = useState(rack.sections_per_shelf);
  const [name, setName] = useState(rack.name);

  const shapeChanged = shelves !== rack.shelf_count || sections !== rack.sections_per_shelf;
  const shrinking = shelves < rack.shelf_count || sections < rack.sections_per_shelf;

  const slotAt = (shelf: number, section: number, side: Side) =>
    slots.find((s) => s.shelf_index === shelf && s.section_index === section && s.side === side);

  // Shelf 1 is the bottom, so render highest-first to match how the rack actually looks.
  const shelfRows = Array.from({ length: rack.shelf_count }, (_, i) => rack.shelf_count - i);
  const sectionCols = Array.from({ length: rack.sections_per_shelf }, (_, i) => i + 1);

  return (
    <section className="rounded-2xl border border-tt-border bg-tt-card p-4">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-tt-text">Rack {rack.name}</h3>
        <button onClick={onClose} className="text-xs text-tt-muted underline cursor-pointer">Close</button>
      </header>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-24 rounded-lg border border-tt-border bg-tt-card px-2 py-1.5 text-sm text-tt-text"
          />
        </Field>
        {name !== rack.name && (
          <button
            onClick={() => onRename(name)}
            disabled={busy || !name.trim()}
            className="rounded-lg border border-tt-border px-2 py-1.5 text-xs text-tt-text disabled:opacity-40 cursor-pointer"
          >
            Rename
          </button>
        )}
        <Field label={`Shelves (${MIN_SHELVES}–${MAX_SHELVES})`}>
          <NumberStepper value={shelves} min={MIN_SHELVES} max={MAX_SHELVES} onChange={setShelves} />
        </Field>
        <Field label={`Sections (${MIN_SECTIONS}–${MAX_SECTIONS})`}>
          <NumberStepper value={sections} min={MIN_SECTIONS} max={MAX_SECTIONS} onChange={setSections} />
        </Field>
        {shapeChanged && (
          <>
            <button
              onClick={() => onResize(shelves, sections)}
              disabled={busy}
              className="rounded-lg bg-tt-green px-3 py-1.5 text-sm font-bold text-black disabled:opacity-40 cursor-pointer"
            >
              Resize to {shelves * sections * 2} slots
            </button>
            {shrinking && (
              <button
                onClick={() => onResize(shelves, sections, true)}
                disabled={busy}
                className="rounded-lg border border-tt-red px-3 py-1.5 text-sm font-bold text-tt-red disabled:opacity-40 cursor-pointer"
              >
                Resize anyway
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
        <button
          onClick={() => onDelete(true)}
          disabled={busy}
          className="rounded-lg border border-tt-red px-2 py-1.5 text-xs text-tt-red disabled:opacity-40 cursor-pointer"
        >
          Delete anyway
        </button>
      </div>

      {/* Slot grid: one row per shelf, each section showing both faces. */}
      <div className="space-y-2 overflow-x-auto">
        {shelfRows.map((shelf) => (
          <div key={shelf} className="flex items-stretch gap-2">
            <div className="flex w-10 shrink-0 items-center justify-center rounded-lg bg-tt-card-hover text-xs font-bold text-tt-muted">
              L{shelf}
            </div>
            {sectionCols.map((section) => (
              <div key={section} className="w-40 shrink-0 rounded-lg border border-tt-border p-1">
                <div className="mb-1 text-center text-[10px] text-tt-muted">S{section}</div>
                {SIDES.map((side) => {
                  const slot = slotAt(shelf, section, side);
                  if (!slot) return null;
                  const sku = slot.inventory_sku_id ? skuById.get(slot.inventory_sku_id) : null;
                  const isEditing = slot.id === editingSlotId;
                  return (
                    <button
                      key={side}
                      onClick={() => onEditSlot(slot.id)}
                      title={`${slotAddress(rack.name, side, shelf, section)} · ${slot.slot_code}`}
                      className={`mb-1 flex w-full items-center gap-1.5 rounded-md border px-1.5 py-1 text-left ${
                        isEditing
                          ? 'border-tt-cyan bg-tt-cyan/10'
                          : sku
                            ? 'border-tt-green/50 bg-tt-green/5'
                            : 'border-dashed border-tt-border'
                      } cursor-pointer`}
                    >
                      <span className="w-3 shrink-0 text-[10px] font-bold text-tt-muted">{side}</span>
                      {sku ? (
                        <>
                          <SkuThumb url={sku.thumbnail_url} />
                          <span className="min-w-0 flex-1 truncate text-[11px] text-tt-text">
                            #{sku.sku_number}
                          </span>
                        </>
                      ) : (
                        <span className="flex-1 text-[11px] text-tt-muted">empty</span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-tt-muted">
        The picker sees <b>{pickerLabel(rack.name, 'A', 1)}</b>-style guidance; the section number is on
        the printed label for whoever places stock.
      </p>
    </section>
  );
}

function SlotAssigner({
  slot, rack, skus, skuById, search, setSearch, bothSides, setBothSides, busy, onPick, onCancel,
}: {
  slot: MappingSlot;
  rack: MappingRack;
  skus: MappingSku[];
  skuById: Map<string, MappingSku>;
  search: string;
  setSearch: (s: string) => void;
  bothSides: boolean;
  setBothSides: (b: boolean) => void;
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
        <label className="flex items-center gap-2 text-xs text-tt-muted">
          <input
            type="checkbox"
            checked={bothSides}
            onChange={(e) => setBothSides(e.target.checked)}
          />
          Picked from both sides
        </label>
        {current && (
          <button
            onClick={() => onPick(null)}
            disabled={busy}
            className="rounded-lg border border-tt-border px-2 py-1.5 text-xs text-tt-muted hover:text-tt-red disabled:opacity-40 cursor-pointer"
          >
            Clear slot
          </button>
        )}
      </div>

      {bothSides && (
        <p className="mb-2 text-[11px] text-tt-cyan">
          Applies to face {slot.side === 'A' ? 'B' : 'A'} of the same section too — the picker then
          reaches it from whichever aisle comes first.
        </p>
      )}

      <div className="flex max-h-64 flex-wrap gap-2 overflow-y-auto">
        {matches.slice(0, 80).map((s) => (
          <button
            key={s.id}
            onClick={() => onPick(s.id)}
            disabled={busy}
            className={`flex items-center gap-2 rounded-lg border px-2 py-1 disabled:opacity-40 cursor-pointer ${
              s.id === slot.inventory_sku_id
                ? 'border-tt-green bg-tt-green/10'
                : 'border-tt-border hover:bg-tt-card-hover'
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
