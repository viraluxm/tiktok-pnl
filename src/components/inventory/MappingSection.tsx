'use client';

import { useMemo, useState } from 'react';
import SkuThumb from '@/components/common/SkuThumb';
import RackDetail from './RackDetail';
import RackIsometric from './RackIsometric';
import { deriveRoute, type StartCorner } from '@/lib/mapping/route';
import { MIN_SHELVES, MAX_SHELVES, type SectionSide } from '@/lib/mapping/shape';
import {
  useMapping, useCreateRack, useUpdateRack, useDeleteRack,
  useAddSection, useDeleteSection, useSetSectionSide, useAssignSlot,
  NeedsConfirmation,
  type MappingRack, type MappingSlot,
} from '@/hooks/useMapping';

// Inventory → Mapping.
//
// Two screens, never both at once: ALL RACKS and ONE RACK.
//
// ALL RACKS leads with a gallery — every rack drawn, click one to open it — because that is
// the actual navigation. Beneath it sits the FLOOR PLAN, which answers a different question:
// where the racks physically sit. That matters because the floor plan is the INPUT to the
// picking route, not a picture of one — aisles and walking order are derived from placement,
// so there is no separate order to maintain and get out of sync.

const CORNERS: { value: StartCorner; label: string }[] = [
  { value: 'top-left', label: 'Top-left' },
  { value: 'top-right', label: 'Top-right' },
  { value: 'bottom-left', label: 'Bottom-left' },
  { value: 'bottom-right', label: 'Bottom-right' },
];

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
  const [startCorner, setStartCorner] = useState<StartCorner>('top-left');
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<(() => void) | null>(null);
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
  const stopByKey = useMemo(() => new Map(stops.map((s) => [`${s.rackId}:${s.side}`, s])), [stops]);
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

  /**
   * Run a mutation, turning a 409 into a message plus a one-click confirm rather than making
   * the operator hunt for a differently-worded button. `retry` re-runs the same call with the
   * confirmation flag set.
   */
  const run = async (fn: () => Promise<unknown>, ok: string, retry?: () => Promise<unknown>) => {
    setMsg(null);
    setConfirmAction(null);
    try {
      await fn();
      setMsg(ok);
    } catch (e) {
      if (e instanceof NeedsConfirmation) {
        const names = e.skusUnmapped
          .map((id) => skuById.get(id)).filter(Boolean)
          .map((s) => `#${s!.sku_number}`).join(', ');
        setMsg(
          `${e.message} ${e.assignedLost} section${e.assignedLost === 1 ? '' : 's'} would be cleared` +
          (names ? `, leaving ${names} unmapped.` : '.'),
        );
        if (retry) setConfirmAction(() => () => run(retry, ok));
      } else {
        setMsg(e instanceof Error ? e.message : 'Something went wrong');
      }
    }
  };

  if (isPending || !data) return <div className="p-4 text-sm text-tt-muted">Loading mapping…</div>;
  if (error) {
    return (
      <div className="p-4 text-sm text-tt-red">
        {error instanceof Error ? error.message : 'Failed to load mapping'}
      </div>
    );
  }

  const busy =
    updateRack.isPending || deleteRack.isPending || addSection.isPending ||
    deleteSection.isPending || setSectionSide.isPending || assignSlot.isPending;

  const banner = msg ? (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-tt-border bg-tt-card px-3 py-2 text-sm text-tt-text">
      <span className="min-w-0 flex-1">{msg}</span>
      {confirmAction && (
        <button
          onClick={confirmAction}
          className="rounded-lg border border-tt-red px-2 py-1 text-xs font-bold text-tt-red cursor-pointer"
        >
          Do it anyway
        </button>
      )}
      <button
        onClick={() => { setMsg(null); setConfirmAction(null); }}
        className="text-xs text-tt-muted underline cursor-pointer"
      >
        dismiss
      </button>
    </div>
  ) : null;

  // ── ONE RACK ─────────────────────────────────────────────────────────────
  if (selectedRack) {
    return (
      <div className="space-y-4 p-1">
        {banner}
        <RackDetail
          key={selectedRack.id}
          rack={selectedRack}
          slots={slotsByRack.get(selectedRack.id) ?? []}
          skus={skus}
          skuById={skuById}
          busy={busy}
          onBack={() => { setSelectedRackId(null); setMsg(null); setConfirmAction(null); }}
          onAddSection={(shelf, side) =>
            run(() => addSection.mutateAsync({ rack_id: selectedRack.id, shelf_index: shelf, side }),
              `Section added to side ${side === 'AB' ? 'A+B' : side}.`)
          }
          onAssign={(slotId, skuId) =>
            run(() => assignSlot.mutateAsync({ slotId, skuId }),
              skuId ? 'SKU assigned.' : 'Section cleared.')
          }
          onSetSide={(slotId, side: SectionSide) =>
            run(() => setSectionSide.mutateAsync({ slotId, side }),
              side === 'AB' ? 'Now picked from both aisles.' : `Now picked from side ${side}.`)
          }
          onDeleteSection={(slotId) =>
            run(
              () => deleteSection.mutateAsync({ slotId }),
              'Section removed.',
              () => deleteSection.mutateAsync({ slotId, confirm: true }),
            )
          }
          onShelves={(n) =>
            run(
              () => updateRack.mutateAsync({ id: selectedRack.id, shelf_count: n }),
              'Shelves updated.',
              () => updateRack.mutateAsync({
                id: selectedRack.id, shelf_count: n, confirm_destructive: true,
              }),
            )
          }
          onDeleteRack={() =>
            run(
              async () => {
                await deleteRack.mutateAsync({ id: selectedRack.id });
                setSelectedRackId(null);
              },
              'Rack deleted.',
              async () => {
                await deleteRack.mutateAsync({ id: selectedRack.id, confirm: true });
                setSelectedRackId(null);
              },
            )
          }
        />
      </div>
    );
  }

  // ── ALL RACKS ────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5 p-1">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Racks" value={racks.length} />
        <Tile label="Sections" value={slots.length} />
        <Tile label="Sections filled" value={slots.filter((s) => s.inventory_sku_id).length} />
        <Tile
          label="SKUs unmapped"
          value={unmappedSkus.length}
          tone={unmappedSkus.length > 0 ? 'warn' : 'ok'}
        />
      </div>

      {banner}

      {/* The gallery is the way in: every rack, drawn, click one to open it. The floor plan
          below is a different job — it says where they SIT, which is what the route needs. */}
      <section>
        <h3 className="text-sm font-semibold text-tt-text">All racks</h3>
        <p className="mb-2 text-xs text-tt-muted">Click a rack to lay out its shelves and sections.</p>

        {racks.length === 0 ? (
          <EmptyFloor onAdd={() => setAdding(firstFreeCell(racks))} />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {racks.map((rack) => {
              const rs = slotsByRack.get(rack.id) ?? [];
              const filled = rs.filter((x) => x.inventory_sku_id).length;
              const outOfStock = rs.filter((x) => {
                const sk = x.inventory_sku_id ? skuById.get(x.inventory_sku_id) : null;
                return sk && sk.qty_on_hand <= 0;
              }).length;
              return (
                <button
                  key={rack.id}
                  onClick={() => setSelectedRackId(rack.id)}
                  className="rounded-2xl border border-tt-border bg-tt-card p-3 text-left transition-colors hover:border-tt-green/60 hover:bg-tt-card-hover cursor-pointer"
                >
                  <div className="mb-1 flex items-baseline justify-between gap-2">
                    <span className="text-lg font-extrabold text-tt-text">{rack.name}</span>
                    <span className="text-[11px] text-tt-muted">
                      {rack.shelf_count} shelves · {rs.length} sections
                    </span>
                  </div>
                  <div className="pointer-events-none rounded-xl bg-tt-card-hover/30 py-1">
                    <RackIsometric
                      shelfCount={rack.shelf_count}
                      slots={rs}
                      skuById={skuById}
                      selectedSlotId={null}
                      viewSide="A"
                      readOnly
                      maxHeightRem={12}
                      canAddToShelf={() => false}
                      onPickSection={() => {}}
                      onAddSection={() => {}}
                    />
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
                    <span className={rs.length > 0 && filled === rs.length ? 'text-tt-green' : 'text-tt-muted'}>
                      {rs.length === 0 ? 'no sections yet' : `${filled}/${rs.length} filled`}
                    </span>
                    {outOfStock > 0 && (
                      <span className="rounded bg-tt-red/15 px-1.5 py-0.5 font-bold text-tt-red">
                        {outOfStock} out of stock
                      </span>
                    )}
                  </div>
                </button>
              );
            })}

            <button
              onClick={() => setAdding(firstFreeCell(racks))}
              className="flex min-h-40 items-center justify-center rounded-2xl border-2 border-dashed border-tt-border/70 text-sm text-tt-muted hover:border-tt-green/60 hover:text-tt-text cursor-pointer"
            >
              + Add rack
            </button>
          </div>
        )}
      </section>

      {racks.length > 0 && (
        <section>
          <header className="mb-2 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-tt-text">Floor plan</h3>
              <p className="text-xs text-tt-muted">
                Where each rack physically sits — drag one to move it. This is what the picking
                route is worked out from.
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

          <div className="space-y-1 overflow-x-auto rounded-2xl border border-tt-border bg-tt-card p-3">
            {occupiedRows.map((row, i) => (
              <div key={row}>
                <AisleBand index={i} faces={stops.filter((x) => x.aisle === i)} />
                <div className="flex gap-2 py-1">
                  {columns.map((col) => {
                    const rack = racks.find((r) => r.grid_row === row && r.grid_col === col);
                    return rack ? (
                      <RackCard
                        key={col}
                        rack={rack}
                        slots={slotsByRack.get(rack.id) ?? []}
                        stopA={stopByKey.get(`${rack.id}:A`)?.position}
                        stopB={stopByKey.get(`${rack.id}:B`)?.position}
                        onOpen={() => setSelectedRackId(rack.id)}
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
                  <AisleBand
                    index={occupiedRows.length}
                    faces={stops.filter((x) => x.aisle === occupiedRows.length)}
                  />
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
        </section>
      )}

      {adding && (
        <section className="rounded-2xl border border-tt-cyan/60 bg-tt-card p-4">
          <h3 className="mb-1 text-sm font-semibold text-tt-text">
            New rack at row {adding.row + 1}, column {adding.col + 1}
          </h3>
          <p className="mb-3 text-xs text-tt-muted">
            How many shelves? You divide them into sections on the next screen.
          </p>
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-1">
              <button
                onClick={() => setNewShelves(Math.max(MIN_SHELVES, newShelves - 1))}
                disabled={newShelves <= MIN_SHELVES}
                className="h-8 w-8 rounded-lg border border-tt-border text-tt-text disabled:opacity-30 cursor-pointer"
              >
                −
              </button>
              <span className="w-8 text-center text-sm font-bold tabular-nums text-tt-text">{newShelves}</span>
              <button
                onClick={() => setNewShelves(Math.min(MAX_SHELVES, newShelves + 1))}
                disabled={newShelves >= MAX_SHELVES}
                className="h-8 w-8 rounded-lg border border-tt-border text-tt-text disabled:opacity-30 cursor-pointer"
              >
                +
              </button>
              <span className="ml-2 text-xs text-tt-muted">shelves</span>
            </div>
            <button
              disabled={createRack.isPending}
              onClick={() =>
                run(async () => {
                  const res = await createRack.mutateAsync({
                    grid_row: adding.row, grid_col: adding.col, shelf_count: newShelves,
                  });
                  setAdding(null);
                  // Straight into the rack — the next thing to do is always divide its shelves.
                  if (res?.rack?.id) setSelectedRackId(res.rack.id);
                }, 'Rack added — divide its shelves into sections.')
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
              {unmappedSkus.slice(0, 40).map((s) => (
                <span key={s.id} className="flex items-center gap-2 rounded-lg border border-tt-border bg-tt-card px-2 py-1">
                  <SkuThumb url={s.thumbnail_url} />
                  <span className="text-xs">
                    <b className="text-tt-text">#{s.sku_number}</b>
                    <span className="ml-1 text-tt-muted">{s.title}</span>
                  </span>
                </span>
              ))}
              {unmappedSkus.length > 40 && (
                <span className="self-center text-xs text-tt-muted">+ {unmappedSkus.length - 40} more</span>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

/**
 * First unoccupied cell, scanning left-to-right then down. Lets "Add rack" from the gallery
 * place the rack without asking for coordinates — the floor plan is where you position it.
 */
function firstFreeCell(racks: MappingRack[]): { row: number; col: number } {
  const taken = new Set(racks.map((r) => `${r.grid_row}:${r.grid_col}`));
  for (let row = 0; row < 50; row++) {
    for (let col = 0; col < 50; col++) {
      if (!taken.has(`${row}:${col}`)) return { row, col };
    }
  }
  return { row: 0, col: 0 };
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

function AisleBand({ index, faces }: { index: number; faces: { label: string; position: number }[] }) {
  const ordered = faces.slice().sort((a, b) => a.position - b.position);
  return (
    <div className="flex items-center gap-2 rounded-lg bg-tt-card-hover/40 px-2 py-1">
      <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-tt-muted">
        Aisle {index + 1}
      </span>
      <span className="h-px flex-1 bg-tt-border" />
      <span className="shrink-0 text-[11px] text-tt-muted">
        {ordered.length ? `reach ${ordered.map((f) => f.label).join(' · ')}` : 'nothing reachable'}
      </span>
    </div>
  );
}

function RackCard({
  rack, slots, stopA, stopB, onOpen, onDragStart,
}: {
  rack: MappingRack;
  slots: MappingSlot[];
  stopA?: number;
  stopB?: number;
  onOpen: () => void;
  onDragStart: () => void;
}) {
  const filled = slots.filter((s) => s.inventory_sku_id).length;
  return (
    <button
      draggable
      onDragStart={onDragStart}
      onClick={onOpen}
      className="w-36 shrink-0 rounded-xl border-2 border-tt-border bg-tt-card p-2 text-left transition-colors hover:border-tt-green/60 hover:bg-tt-card-hover cursor-grab active:cursor-grabbing"
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
