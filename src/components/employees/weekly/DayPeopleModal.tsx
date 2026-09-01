'use client';

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
}: {
  day: CalendarDay;
  dateLabel: string;
  onClose: () => void;
  onConfirm: (shiftId: string, confirmed: boolean) => Promise<void>;
  onEdit: (shiftId: string) => void;
  onAddShift: (date: string) => void;
}) {
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
              />
            ))}
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
