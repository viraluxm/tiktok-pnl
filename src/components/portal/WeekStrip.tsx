'use client';

import { addDaysISO } from '@/lib/schedule/timezone';
import { weekStripModel, fmtMonthDay, mondayOf, weekLabel } from '@/lib/schedule/portalModel';
import type { PortalShift } from '@/lib/schedule/portalTypes';
import { ChevronLeft, ChevronRight } from './icons';

// The Monday→Sunday strip. Seven equal cells that always fit a phone (7 × ~41px at 320px), a clear
// selected state (filled), a today state that is NOT colour alone (ring + underline + aria-current),
// a 4px dot under scheduled days (yellow when that shift is offered), and a slightly larger dot on
// the day Home leads with. Week navigation is the chevron pair above it.

export function WeekStrip({
  weekStart, todayISO, selected, shiftsByDate, nextShiftDate, onSelect, onWeek, compact,
}: {
  weekStart: string;
  todayISO: string;
  selected: string;
  shiftsByDate: ReadonlyMap<string, Pick<PortalShift, 'offer_state'>>;
  nextShiftDate: string | null;
  onSelect: (date: string) => void;
  onWeek: (weekStart: string) => void;
  /** hide the week header row (the parent draws its own) */
  compact?: boolean;
}) {
  const cells = weekStripModel({ weekStart, todayISO, selected, shiftsByDate, nextShiftDate });
  const isThisWeek = weekStart === mondayOf(todayISO);
  const label = weekLabel(weekStart, todayISO);
  const navBtn = 'flex h-9 w-9 items-center justify-center rounded-lg text-tt-muted transition-colors hover:bg-white/10 hover:text-tt-text focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/70';

  return (
    <div>
      {!compact && (
        <div className="mb-2">
          <div className="flex items-center justify-between">
            <button type="button" aria-label="Previous week" className={navBtn} onClick={() => onWeek(addDaysISO(weekStart, -7))}>
              <ChevronLeft size={20} />
            </button>
            {/* The relation to the real current week is part of the heading, so a past week can never
                read as "this week"; the return control below is a button, not a caption. */}
            <p className="text-sm font-semibold text-tt-text" aria-live="polite">
              {label && <span className={`font-medium ${isThisWeek ? 'text-tt-cyan' : 'text-tt-muted'}`}>{label} · </span>}
              {fmtMonthDay(weekStart)} – {fmtMonthDay(addDaysISO(weekStart, 6))}
            </p>
            <button type="button" aria-label="Next week" className={navBtn} onClick={() => onWeek(addDaysISO(weekStart, 7))}>
              <ChevronRight size={20} />
            </button>
          </div>
          {!isThisWeek && (
            <div className="mt-1 flex justify-center">
              <button
                type="button"
                onClick={() => onWeek(mondayOf(todayISO))}
                className="rounded-full bg-tt-cyan/15 px-3 py-1 text-xs font-semibold text-tt-cyan transition-colors hover:bg-tt-cyan/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/70"
              >
                Back to this week
              </button>
            </div>
          )}
        </div>
      )}
      <div role="listbox" aria-label="Days of the week" className="grid grid-cols-7 gap-1">
        {cells.map((c) => {
          const label = `${c.dow} ${c.day}${c.isToday ? ', today' : ''}${c.hasShift ? ', scheduled' : ', off'}${c.isNext ? ', next shift' : ''}${c.isOffered ? ', offered' : ''}`;
          return (
            <button
              key={c.date}
              type="button"
              role="option"
              aria-selected={c.isSelected}
              aria-current={c.isToday ? 'date' : undefined}
              aria-label={label}
              onClick={() => onSelect(c.date)}
              className={`flex min-h-[60px] flex-col items-center justify-center gap-0.5 rounded-xl py-1.5 transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/70 ${
                c.isSelected
                  ? 'bg-tt-cyan text-black'
                  : c.isToday
                    ? 'bg-white/[0.06] text-tt-text ring-1 ring-inset ring-tt-cyan/60 hover:bg-white/10'
                    : c.isPast
                      ? 'text-tt-muted/70 hover:bg-white/[0.06]'
                      : 'text-tt-text hover:bg-white/[0.06]'
              }`}
            >
              <span className={`text-[10px] font-bold tracking-wide ${c.isSelected ? 'text-black/70' : 'text-tt-muted'}`}>{c.dow}</span>
              <span className={`text-[15px] font-semibold leading-none tabular-nums ${c.isToday && !c.isSelected ? 'underline decoration-tt-cyan decoration-2 underline-offset-[5px]' : ''}`}>{c.day}</span>
              <span className="flex h-2 items-center" aria-hidden>
                {c.hasShift && (
                  <span
                    className={`block rounded-full ${c.isNext ? 'h-1.5 w-1.5' : 'h-1 w-1'} ${
                      c.isSelected ? 'bg-black/70' : c.isOffered ? 'bg-tt-yellow' : 'bg-tt-cyan'
                    }`}
                  />
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
