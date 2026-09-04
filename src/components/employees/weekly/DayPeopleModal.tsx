'use client';

import { useState } from 'react';
import type { CalendarDay } from '@/lib/schedule/calendarModel';
import PersonCard from './PersonCard';

// The day overlay — a grid of person tiles rather than a stack of rows. At 10–20 people a day,
// rows force a long scroll and every line looks the same; tiles let the eye land on a face first
// and scan a whole crew in one pass.
export default function DayPeopleModal({
  day,
  dateLabel,
  onClose,
  onConfirm,
  onEdit,
  onAddShift,
  onRemoveScheduled,
}: {
  day: CalendarDay;
  dateLabel: string;
  onClose: () => void;
  onConfirm: (shiftId: string, confirmed: boolean) => Promise<void>;
  onEdit: (shiftId: string) => void;
  onAddShift: (date: string) => void;
  /** Remove a one-off scheduled shift. Absent → the tiles offer no Remove action. */
  onRemoveScheduled?: (instanceId: string) => Promise<void>;
}) {
  // The confirmation lives HERE, not on the tile: this component already knows the human date
  // label, and a full sentence does not fit in a 5-across avatar tile. PersonCard only asks.
  const [pending, setPending] = useState<{ instanceId: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function confirmRemoval() {
    if (!pending || !onRemoveScheduled) return;
    setBusy(true);
    setErr(null);
    try {
      await onRemoveScheduled(pending.instanceId);
      setPending(null);
    } catch (e) {
      // The server's refusal text is already manager-readable (SHIFT_REMOVAL_MESSAGES).
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm sm:p-8"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Shifts for ${dateLabel}`}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-5xl rounded-[16px] border border-tt-border bg-tt-card p-5 shadow-2xl backdrop-blur-xl"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-tt-text">{dateLabel}</h3>
            <p className="mt-0.5 text-xs text-tt-muted">
              {day.clockedCount} clocked in · {day.scheduledCount} scheduled
              {day.pendingCount > 0 && <span className="text-tt-yellow"> · {day.pendingCount} need confirmation</span>}
            </p>
          </div>
          <button
            type="button" onClick={onClose} aria-label="Close"
            className="h-8 w-8 shrink-0 rounded-lg border border-tt-border text-tt-muted transition-colors hover:bg-tt-card-hover hover:text-tt-text"
          >✕</button>
        </div>

        {day.people.length === 0 ? (
          <p className="py-6 text-center text-sm text-tt-muted">Nobody on this day.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {day.people.map((p) => (
              <PersonCard
                key={`${p.employee_id}|${p.punch?.id ?? p.scheduled?.id ?? 'x'}`}
                person={p}
                onConfirm={onConfirm}
                onEdit={onEdit}
                onRemoveScheduled={
                  onRemoveScheduled ? (instanceId) => { setErr(null); setPending({ instanceId, name: p.name }); } : undefined
                }
              />
            ))}
          </div>
        )}

        {pending && (
          <div className="mt-4 rounded-xl border border-tt-red/40 bg-tt-red/[0.07] p-4">
            <p className="text-sm font-semibold text-tt-text">
              Remove {pending.name}&apos;s scheduled shift on {dateLabel}?
            </p>
            <p className="mt-1 text-xs leading-snug text-tt-muted">
              This removes it from their schedule. It does not delete worked hours or payroll history.
            </p>
            {err && <p className="mt-2 text-xs text-tt-red">{err}</p>}
            <div className="mt-3 flex gap-2">
              <button
                type="button" disabled={busy} onClick={() => { setPending(null); setErr(null); }}
                className="flex-1 rounded-lg bg-white/5 py-2 text-xs font-semibold text-tt-muted transition-colors hover:bg-white/10 hover:text-tt-text disabled:opacity-50"
              >Cancel</button>
              <button
                type="button" disabled={busy} onClick={confirmRemoval}
                className="flex-1 rounded-lg bg-tt-red/20 py-2 text-xs font-semibold text-tt-red transition-colors hover:bg-tt-red/30 disabled:opacity-50"
              >{busy ? 'Removing…' : 'Remove Shift'}</button>
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={() => { onClose(); onAddShift(day.date); }}
          className="mt-4 w-full rounded-lg border border-dashed border-tt-border py-2 text-xs font-semibold text-tt-muted transition-colors hover:border-tt-cyan/50 hover:text-tt-cyan"
        >
          + Add a shift on this day
        </button>
      </div>
    </div>
  );
}
