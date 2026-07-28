'use client';

import { useState } from 'react';
import { useFulfillmentPerformance } from '@/hooks/useFulfillmentPerformance';
import {
  SHOP_TIMEZONE, zonedDayKey, addDaysISO, formatPickDuration, formatRate, type PickerDayStats,
} from '@/lib/shipping/pickerPerformance';

// Team → Performance → Fulfillment: a simple daily SUMMARY per picker (never individual
// scans). Read-only. No rankings, grades, charts, or leaderboards — Phase 1 scope.

function todayISO(): string {
  return zonedDayKey(Date.now(), SHOP_TIMEZONE);
}

function dayLabel(dayISO: string): string {
  const [y, m, d] = dayISO.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const base = dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  return dayISO === todayISO() ? `${base} · Today` : base;
}

// Big, scannable summary card.
function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-tt-border bg-tt-card px-5 py-4">
      <div className="text-xs uppercase tracking-wide text-tt-muted">{label}</div>
      <div className="text-4xl font-extrabold text-tt-text mt-2 tabular-nums leading-none">{value}</div>
    </div>
  );
}

const COLS = ['Picker', 'Orders', 'Boxes', 'Average Pick Time', 'Active Picking Time', 'Orders / Active Hour'];

function Cell({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-tt-muted sm:hidden">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${muted ? 'text-tt-muted' : 'text-tt-text'}`}>{value}</div>
    </div>
  );
}

function PickerRow({ p }: { p: PickerDayStats }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-6 gap-x-4 gap-y-1.5 items-center px-4 py-2.5 rounded-xl border border-tt-border bg-tt-card">
      <div className="col-span-2 sm:col-span-1 font-semibold text-tt-text truncate" title={p.name}>{p.name}</div>
      <Cell label="Orders" value={String(p.orders_picked)} />
      <Cell label="Boxes" value={String(p.boxes_completed)} />
      <Cell label="Average Pick Time" value={formatPickDuration(p.avg_pick_ms)} />
      <Cell label="Active Picking Time" value={formatPickDuration(p.active_pick_ms)} />
      <Cell label="Orders / Active Hour" value={formatRate(p.orders_per_active_hour)} />
    </div>
  );
}

export default function FulfillmentPerformance() {
  const [day, setDay] = useState<string>(() => todayISO());
  const { data, isLoading, isError } = useFulfillmentPerformance(day);

  const isToday = day === todayISO();
  const summary = data?.summary;
  const pickers = data?.pickers ?? [];
  const unassigned = data?.unassigned ?? null;
  const hasAnything = pickers.length > 0 || !!unassigned;

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

      {isLoading && <div className="text-sm text-tt-muted">Loading picker performance…</div>}
      {isError && <div className="text-sm text-tt-red">Failed to load picker performance.</div>}

      {!isLoading && !isError && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
            <SummaryCard label="Orders Picked" value={String(summary?.orders_picked ?? 0)} />
            <SummaryCard label="Boxes Completed" value={String(summary?.boxes_completed ?? 0)} />
            <SummaryCard label="Average Pick Time" value={formatPickDuration(summary?.avg_pick_ms ?? null)} />
            <SummaryCard label="Active Pickers" value={String(summary?.active_pickers ?? 0)} />
          </div>

          {/* Column header (desktop) */}
          {pickers.length > 0 && (
            <div className="hidden sm:grid grid-cols-6 gap-x-4 px-4 pb-1 text-[10px] uppercase tracking-wide text-tt-muted">
              {COLS.map((h) => <div key={h}>{h}</div>)}
            </div>
          )}

          {/* Picker rows */}
          <div className="flex flex-col gap-1.5">
            {pickers.map((p) => (
              <PickerRow key={p.picker_employee_id ?? `snap:${p.name}`} p={p} />
            ))}

            {/* Unassigned completed boxes (historical / unattributed) */}
            {unassigned && (
              <div className="grid grid-cols-2 sm:grid-cols-6 gap-x-4 gap-y-1.5 items-center px-4 py-2.5 rounded-xl border border-dashed border-tt-border bg-tt-card/50">
                <div className="col-span-2 sm:col-span-1 font-semibold text-tt-muted">Unassigned</div>
                <Cell label="Orders" value={String(unassigned.orders_picked)} muted />
                <Cell label="Boxes" value={String(unassigned.boxes_completed)} muted />
                <Cell label="Average Pick Time" value="—" muted />
                <Cell label="Active Picking Time" value="—" muted />
                <Cell label="Orders / Active Hour" value="—" muted />
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
          {pickers.length > 0 && (
            <div className="mt-4 text-[11px] text-tt-muted">
              Pick time measures from loading a box until successful completion.
            </div>
          )}
        </>
      )}
    </div>
  );
}
