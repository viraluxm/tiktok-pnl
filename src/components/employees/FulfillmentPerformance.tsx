'use client';

import { useState } from 'react';
import { useFulfillmentPerformance } from '@/hooks/useFulfillmentPerformance';
import {
  SHOP_TIMEZONE, zonedDayKey, addDaysISO, formatPickDuration,
} from '@/lib/shipping/pickerPerformance';
import {
  subtotalByTrack, formatCentsPerUnit, formatDollars, formatHours, formatTrack,
  MAX_PLAUSIBLE_PUNCH_HOURS,
  type PickerCostRow, type CostBlock, type FulfillmentTrack,
} from '@/lib/shipping/pickCostEconomics';

// Team → Performance → Fulfillment: a simple daily SUMMARY per picker (never individual
// scans). Read-only. No rankings, grades, charts, or leaderboards — Phase 1 scope.

// The fulfillment day currently in progress. Note this is NOT always the current calendar
// date: zonedDayKey uses the 4:00 AM boundary, so between midnight and 4:00 AM this returns
// the PREVIOUS date — which is correct, the night crew is still on that shift day.
function todayISO(): string {
  return zonedDayKey(Date.now(), SHOP_TIMEZONE);
}

function dayLabel(dayISO: string): string {
  const [y, m, d] = dayISO.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const base = dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  return dayISO === todayISO() ? `${base} · Today` : base;
}

/**
 * Which cost figure to show, and whether it is a projection.
 *
 * A time-clock punch is held back from pay until a manager confirms it, and confirmation
 * typically lands the next day — so on the day in progress the CONFIRMED cost is usually
 * $0 over real work, which would render as an outright wrong number. Whenever any hours are
 * still pending we show the projected figure (confirmed + pending) marked with a leading "~",
 * so the value is useful now and visibly provisional. The payroll gate itself is untouched.
 */
function costFigure(confirmed: number | null, projected: number | null, pendingHours: number): {
  text: string; provisional: boolean;
} {
  if (pendingHours > 0 && projected != null) return { text: `~${formatCentsPerUnit(projected)}`, provisional: true };
  if (confirmed != null) return { text: formatCentsPerUnit(confirmed), provisional: false };
  if (projected != null) return { text: `~${formatCentsPerUnit(projected)}`, provisional: true };
  return { text: '—', provisional: false };
}

// Big, scannable summary card. `provisional` dims the value and adds a footnote marker so a
// projected number never reads as settled.
function SummaryCard({ label, value, provisional = false, note }: {
  label: string; value: string; provisional?: boolean; note?: string;
}) {
  return (
    <div className="rounded-2xl border border-tt-border bg-tt-card px-5 py-4">
      <div className="text-xs uppercase tracking-wide text-tt-muted">{label}</div>
      <div className={`text-4xl font-extrabold mt-2 tabular-nums leading-none ${provisional ? 'text-tt-muted' : 'text-tt-text'}`}>
        {value}
      </div>
      {note && <div className="text-[10px] text-tt-muted mt-1.5">{note}</div>}
    </div>
  );
}

const COLS = [
  'Picker', 'SKUs', 'Boxes', 'Paid Hours', '$ / Box', '$ / SKU',
  'Average Pick Time', 'Active Picking Time',
];

function Cell({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-tt-muted sm:hidden">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${muted ? 'text-tt-muted' : 'text-tt-text'}`}>{value}</div>
    </div>
  );
}

// Sub-type chip. Display only — nothing in the app gates on the track (migration 121), so a
// 'Packer' is still a fully eligible picker and this chip never implies a restriction.
function TrackChip({ track }: { track: FulfillmentTrack | null }) {
  const color = track === 'picker' ? 'bg-tt-cyan/15 text-tt-cyan'
    : track === 'packer' ? 'bg-tt-magenta-soft/15 text-tt-magenta-soft'
      : track === 'flex' ? 'bg-tt-green/15 text-tt-green'
        : 'bg-tt-muted/15 text-tt-muted';
  return (
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${color}`}>{formatTrack(track)}</span>
  );
}

function PickerRow({ p }: { p: PickerCostRow }) {
  const perBox = costFigure(p.cost.cost_per_box_cents, p.cost.cost_per_box_cents_projected, p.cost.pending_hours);
  const perSku = costFigure(p.cost.cost_per_order_cents, p.cost.cost_per_order_cents_projected, p.cost.pending_hours);
  const hours = p.cost.payable_hours + p.cost.pending_hours;

  // On the clock all shift, zero boxes. NOT proof of idleness — packing, receiving, restocking
  // and cleanup write no rows anywhere, so they read as zero too. Flagged, never judged.
  const idle = p.on_clock && p.boxes_completed === 0;

  return (
    <div className={`grid grid-cols-2 sm:grid-cols-8 gap-x-4 gap-y-1.5 items-center px-4 py-2.5 rounded-xl border bg-tt-card ${idle ? 'border-tt-yellow/40' : 'border-tt-border'}`}>
      <div className="col-span-2 sm:col-span-1 min-w-0">
        <div className="font-semibold text-tt-text truncate" title={p.name}>{p.name}</div>
        <div className="mt-0.5"><TrackChip track={p.fulfillment_track} /></div>
      </div>
      <Cell label="SKUs" value={String(p.orders_picked)} muted={idle} />
      <Cell label="Boxes" value={String(p.boxes_completed)} muted={idle} />
      <Cell label="Paid Hours" value={formatHours(hours)} />
      <Cell label="$ / Box" value={perBox.text} muted={perBox.provisional} />
      <Cell label="$ / SKU" value={perSku.text} muted={perSku.provisional} />
      <Cell label="Average Pick Time" value={formatPickDuration(p.avg_pick_ms)} />
      <Cell label="Active Picking Time" value={formatPickDuration(p.active_pick_ms)} />
    </div>
  );
}

// Cost roll-up per track, so picker cost can be read against packer cost instead of both
// being flattened into one crew average that describes neither.
function TrackSubtotals({ rows }: { rows: PickerCostRow[] }) {
  const subs = subtotalByTrack(rows);
  if (subs.length < 2) return null; // one bucket == the crew figure already shown above

  return (
    <div className="mb-5">
      <div className="text-[10px] uppercase tracking-wide text-tt-muted mb-1.5 px-1">By track</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
        {subs.map((s) => {
          const perBox = costFigure(s.cost.cost_per_box_cents, s.cost.cost_per_box_cents_projected, s.cost.pending_hours);
          const perSku = costFigure(s.cost.cost_per_order_cents, s.cost.cost_per_order_cents_projected, s.cost.pending_hours);
          const hours = s.cost.payable_hours + s.cost.pending_hours;
          return (
            <div key={s.track ?? 'unset'} className="rounded-xl border border-tt-border bg-tt-card px-3.5 py-3">
              <div className="flex items-center justify-between gap-2">
                <TrackChip track={s.track} />
                <span className="text-[10px] text-tt-muted">
                  {s.people} {s.people === 1 ? 'person' : 'people'} · {formatHours(hours)}h
                </span>
              </div>
              <div className="mt-2 flex items-baseline gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-tt-muted">$ / Box</div>
                  <div className={`text-lg font-bold tabular-nums ${perBox.provisional ? 'text-tt-muted' : 'text-tt-text'}`}>{perBox.text}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-tt-muted">$ / SKU</div>
                  <div className={`text-lg font-bold tabular-nums ${perSku.provisional ? 'text-tt-muted' : 'text-tt-text'}`}>{perSku.text}</div>
                </div>
              </div>
              <div className="mt-1.5 text-[10px] text-tt-muted tabular-nums">
                {s.boxes_completed} boxes · {s.orders_picked} SKUs
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function FulfillmentPerformance() {
  const [day, setDay] = useState<string>(() => todayISO());
  const { data, isLoading, isError } = useFulfillmentPerformance(day);

  const isToday = day === todayISO();
  const summary = data?.summary;
  const rows: PickerCostRow[] = data?.rows ?? [];
  const unassigned = data?.unassigned ?? null;
  const cost: CostBlock | undefined = data?.cost;
  const hasAnything = rows.length > 0 || !!unassigned;

  const pendingHours = cost?.pending_hours ?? 0;
  const crewPerBox = costFigure(cost?.cost_per_box_cents ?? null, cost?.cost_per_box_cents_projected ?? null, pendingHours);
  const crewPerSku = costFigure(cost?.cost_per_order_cents ?? null, cost?.cost_per_order_cents_projected ?? null, pendingHours);
  const crewHours = (cost?.payable_hours ?? 0) + pendingHours;
  const crewCents = (cost?.payable_cents ?? 0) + (cost?.pending_cents ?? 0);
  const unproductiveHours = data?.unproductive_hours ?? 0;
  const unproductiveCents = data?.unproductive_cents ?? 0;

  return (
    <div>
      {/* Day navigation */}
      <div className="flex flex-wrap items-center gap-2 mb-5">
        <button
          onClick={() => setDay((d) => addDaysISO(d, -1))}
          className="min-h-[40px] px-3 py-2 rounded-lg border border-tt-border text-sm text-tt-text hover:bg-tt-card-hover transition-colors cursor-pointer"
        >‹ Prev</button>
        <button
          onClick={() => setDay(todayISO())}
          disabled={isToday}
          className="min-h-[40px] px-3 py-2 rounded-lg border border-tt-border text-sm text-tt-text hover:bg-tt-card-hover transition-colors cursor-pointer disabled:opacity-40"
        >Today</button>
        <button
          onClick={() => setDay((d) => addDaysISO(d, 1))}
          disabled={isToday}
          title={isToday ? 'No future days' : undefined}
          className="min-h-[40px] px-3 py-2 rounded-lg border border-tt-border text-sm text-tt-text hover:bg-tt-card-hover transition-colors cursor-pointer disabled:opacity-40"
        >Next ›</button>
        <input
          type="date"
          value={day}
          max={todayISO()}
          onChange={(e) => { if (e.target.value) setDay(e.target.value); }}
          className="min-h-[40px] px-3 py-2 rounded-lg bg-tt-card border border-tt-border text-sm text-tt-text cursor-pointer"
        />
        <span className="text-sm text-tt-muted ml-1">{dayLabel(day)}</span>
      </div>

      {/* A fulfillment day runs 4:00 AM → 4:00 AM, not midnight → midnight, so the night crew's
          17:00–01:00 shift stays on ONE day instead of being split in half. Stated explicitly
          because it is otherwise surprising: at 2:00 AM, "Today" is still the previous date. */}
      <p className="text-xs text-tt-muted">
        A fulfillment day runs 4:00 AM – 4:00 AM Pacific, so overnight shifts count as one day.
      </p>

      {isLoading && <div className="text-sm text-tt-muted">Loading picker performance…</div>}
      {isError && <div className="text-sm text-tt-red">Failed to load picker performance.</div>}

      {!isLoading && !isError && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-5 mt-4">
            <SummaryCard label="SKUs Picked" value={String(summary?.orders_picked ?? 0)} />
            <SummaryCard label="Boxes Completed" value={String(summary?.boxes_completed ?? 0)} />
            <SummaryCard label="Active Pickers" value={String(summary?.active_pickers ?? 0)} />
            <SummaryCard
              label="$ / Box"
              value={crewPerBox.text}
              provisional={crewPerBox.provisional}
              note={crewHours > 0 ? `${formatDollars(crewCents)} over ${formatHours(crewHours)}h on the clock` : undefined}
            />
            <SummaryCard
              label="$ / SKU"
              value={crewPerSku.text}
              provisional={crewPerSku.provisional}
              note="Falls as bundling deepens — judge people on $ / Box"
            />
            <SummaryCard label="Average Pick Time" value={formatPickDuration(summary?.avg_pick_ms ?? null)} />
          </div>

          {/* Pending-confirmation banner. Without this, a "~" figure looks like a rounding
              quirk rather than "a manager has not confirmed these punches yet". */}
          {pendingHours > 0 && (
            <div className="mb-4 rounded-xl border border-tt-yellow/40 bg-tt-yellow/5 px-4 py-2.5 text-xs text-tt-text">
              <span className="font-semibold">{formatHours(pendingHours)}h awaiting manager confirmation.</span>{' '}
              Figures marked <span className="tabular-nums">~</span> include those hours as a projection —
              payroll pays only confirmed hours, so the settled cost may differ.
            </div>
          )}

          {/* Forgotten clock-outs. These are held OUT of every figure above — a single 47h
              punch would otherwise double the day's apparent cost — but they must be visible,
              because the fix is a manager editing the punch, not a different metric. */}
          {(data?.suspect_punches ?? 0) > 0 && (
            <div className="mb-4 rounded-xl border border-tt-red/40 bg-tt-red/5 px-4 py-2.5 text-xs text-tt-text">
              <span className="font-semibold">
                {data?.suspect_punches} unclosed punch{data?.suspect_punches === 1 ? '' : 'es'}
                {' '}({formatHours(data?.suspect_hours ?? 0)}h) excluded from cost.
              </span>{' '}
              A single punch over {MAX_PLAUSIBLE_PUNCH_HOURS}h is a missed clock-out, not a shift.
              Fix it in Shifts so the day&rsquo;s cost is right.
            </div>
          )}

          {/* Hours that produced no boxes. This is what makes the crew $ / Box worse than any
              individual picker's, so it is stated rather than left to look like everyone
              underperformed. Packing/receiving/restocking write no rows — a question, not a verdict. */}
          {unproductiveHours > 0 && (
            <div className="mb-4 rounded-xl border border-tt-border bg-tt-card px-4 py-2.5 text-xs text-tt-muted">
              <span className="font-semibold text-tt-text">
                {formatHours(unproductiveHours)}h ({formatDollars(unproductiveCents)}) on the clock completed no boxes.
              </span>{' '}
              Packing, receiving, restocking and cleanup write no rows, so they also read as zero here.
            </div>
          )}

          {rows.length > 0 && <TrackSubtotals rows={rows} />}

          {/* Column header (desktop) */}
          {rows.length > 0 && (
            <div className="hidden sm:grid grid-cols-8 gap-x-4 px-4 pb-1 text-[10px] uppercase tracking-wide text-tt-muted">
              {COLS.map((h) => <div key={h}>{h}</div>)}
            </div>
          )}

          {/* Picker rows */}
          <div className="flex flex-col gap-1.5">
            {rows.map((p) => (
              <PickerRow key={p.picker_employee_id ?? `snap:${p.name}`} p={p} />
            ))}

            {/* Unassigned completed boxes (historical / unattributed) */}
            {unassigned && (
              <div className="grid grid-cols-2 sm:grid-cols-8 gap-x-4 gap-y-1.5 items-center px-4 py-2.5 rounded-xl border border-dashed border-tt-border bg-tt-card/50">
                <div className="col-span-2 sm:col-span-1 font-semibold text-tt-muted">Unassigned</div>
                <Cell label="SKUs" value={String(unassigned.orders_picked)} muted />
                <Cell label="Boxes" value={String(unassigned.boxes_completed)} muted />
                <Cell label="Paid Hours" value="—" muted />
                <Cell label="$ / Box" value="—" muted />
                <Cell label="$ / SKU" value="—" muted />
                <Cell label="Average Pick Time" value="—" muted />
                <Cell label="Active Picking Time" value="—" muted />
              </div>
            )}
          </div>

          {/* Empty state */}
          {!hasAnything && (
            <div className="rounded-xl border border-tt-border bg-tt-card px-4 py-8 text-center text-sm text-tt-muted">
              No completed picks on this day.
              {(data?.eligible_picker_count ?? 0) > 0 && (
                <> {data?.eligible_picker_count} fulfillment picker{data?.eligible_picker_count === 1 ? '' : 's'} on the roster.</>
              )}
            </div>
          )}

          {/* Short explanatory note */}
          {rows.length > 0 && (
            <div className="mt-4 text-[11px] text-tt-muted space-y-1">
              <p>
                One SKU = one order = one auction won. A box is one label — the physical package a
                picker completes.
              </p>
              <p>
                Cost is hours × rate over the boxes and SKUs completed, on the same 4:00 AM day
                boundary. Pick time measures from loading a box until successful completion.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
