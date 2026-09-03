'use client';

import { useMemo } from 'react';
import { parseYMD } from '@/lib/weeklySchedule';
import type { CalendarDay, DayPerson } from '@/lib/schedule/calendarModel';
import PersonCard from './PersonCard';

// Everything awaiting confirmation across the month, in one place — reached by clicking the
// "N to confirm" chip. Each tile carries its own date because this list spans days, and each
// offers Edit as well as Confirm: a wrong punch (a forgotten clock-out reading 19h) needs
// fixing, and withholding confirmation is not a fix.

function shortDate(iso: string): string {
  return parseYMD(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export default function PendingConfirmModal({
  byDate,
  monthLabel,
  onClose,
  onConfirm,
  onEdit,
}: {
  byDate: Map<string, CalendarDay>;
  monthLabel: string;
  onClose: () => void;
  onConfirm: (shiftId: string, confirmed: boolean) => Promise<void>;
  onEdit: (shiftId: string) => void;
}) {
  // Oldest first: the longest-waiting punch is the one most likely to hold up a pay period.
  const pending = useMemo(() => {
    const out: { date: string; person: DayPerson }[] = [];
    for (const d of [...byDate.keys()].sort()) {
      for (const p of byDate.get(d)!.people) {
        if (p.state === 'pending') out.push({ date: d, person: p });
      }
    }
    return out;
  }, [byDate]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm sm:p-8"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Shifts awaiting confirmation"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-5xl rounded-[16px] border border-tt-border bg-tt-card p-5 shadow-2xl backdrop-blur-xl"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-tt-text">
              {pending.length} shift{pending.length === 1 ? '' : 's'} need confirmation
            </h3>
            <p className="mt-0.5 text-xs text-tt-muted">
              {monthLabel} · they stay out of Pay until confirmed. Edit anything that looks wrong before confirming.
            </p>
          </div>
          <button
            type="button" onClick={onClose} aria-label="Close"
            className="h-8 w-8 shrink-0 rounded-lg border border-tt-border text-tt-muted transition-colors hover:bg-tt-card-hover hover:text-tt-text"
          >✕</button>
        </div>

        {pending.length === 0 ? (
          <p className="py-6 text-center text-sm text-tt-muted">Nothing left to confirm this month.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {pending.map(({ date, person }) => (
              <PersonCard
                key={`${person.employee_id}|${person.punch?.id ?? date}`}
                person={person}
                dateLabel={shortDate(date)}
                onConfirm={onConfirm}
                onEdit={onEdit}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
