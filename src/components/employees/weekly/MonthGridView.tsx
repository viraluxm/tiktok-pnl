'use client';

import { useState } from 'react';
import {
  densityLevel, formatDelta, isPaydayISO,
  type CalendarDay, type DayPerson,
} from '@/lib/schedule/calendarModel';
import { WEEKDAY_LABELS, isInMonth, parseYMD, formatTime12 } from '@/lib/weeklySchedule';
import PersonAvatar from './PersonAvatar';
import HoverCard, { type HoverPayload } from './HoverCard';

// PRESENTATION ONLY — takes an already-built day model and draws it. Split from
// ScheduleMonthCalendar (which owns the queries) so the grid can be rendered from fixtures.

// Five faces plus an overflow chip. Most days run 10–20 people, and past ~5 the stack wraps to a
// third row and the month stops being scannable — the headcount badge and the day overlay carry
// the rest. Display cap only; every person is still in the model and in the overlay.
export const MAX_AVATARS = 5;

// Density tint is OFF — every cell sits on the page's own black.
//
// Busyness is already carried by the headcount badge and the size of the avatar stack, which are
// the two things the eye lands on first. Tinting the cell behind them encoded the same fact a
// third time, more weakly, and made the grid look busier than the data it described.
//
// Kept as a table rather than deleted: the level is still computed and passed in, so restoring
// the ramp is a one-line edit here.
export const DENSITY_BG = [
  'bg-transparent',
  'bg-transparent',
  'bg-transparent',
  'bg-transparent',
  'bg-transparent',
] as const;

function dayNum(iso: string): number {
  return parseYMD(iso).getUTCDate();
}

// What the hover card says about one person. Returned as lines so the card can style them.
export function personTooltipLines(p: DayPerson): { head: string; sub: string[] } {
  const sub: string[] = [];
  if (p.punch) {
    sub.push(p.punch.isOpen
      ? `Clocked in ${formatTime12(p.punch.start_time)} — still on the clock`
      : `Clocked ${formatTime12(p.punch.start_time)}–${formatTime12(p.punch.end_time as string)} · ${p.punch.hours}h`);
  } else {
    sub.push('No punch');
  }
  if (p.scheduled) {
    let line = `Scheduled ${formatTime12(p.scheduled.start_time)}–${formatTime12(p.scheduled.end_time)} · ${p.scheduled.hours}h`;
    if (p.deltaHours != null) line += ` · ${formatDelta(p.deltaHours)}`;
    sub.push(line);
  } else if (!p.wasScheduled) {
    sub.push('Not scheduled');
  }
  if (p.state === 'pending') sub.push('Needs confirmation');
  if (p.state === 'no_show') sub.push('Did not clock in');
  return { head: p.role ? `${p.name} · ${p.role}` : p.name, sub };
}

// Hover state lives at grid level; HoverCard portals it out of the blurred panel so it is not
// drawn underneath the day cells.
const EMPTY_DAY = (date: string): CalendarDay => ({
  date, people: [], headcount: 0, pendingCount: 0, openCount: 0, scheduledCount: 0, clockedCount: 0,
});

function DayCell({
  day, inMonth, isToday, isPayday, level, onOpenDay, onAddDay, onHover,
}: {
  day: CalendarDay;
  inMonth: boolean;
  isToday: boolean;
  isPayday: boolean;
  level: 0 | 1 | 2 | 3 | 4;
  onOpenDay: (date: string) => void;
  onAddDay: (date: string) => void;
  onHover: (h: HoverPayload | null) => void;
}) {
  const shown = day.people.slice(0, MAX_AVATARS);
  const more = day.people.length - shown.length;

  return (
    <div
      onClick={() => (day.headcount > 0 ? onOpenDay(day.date) : onAddDay(day.date))}
      title={day.headcount > 0 ? 'Click to see this day' : 'Click to add a shift'}
      className={`group relative flex min-h-[104px] cursor-pointer flex-col gap-1.5 border-b border-r border-[rgba(255,255,255,0.04)] p-2 text-left transition-colors ${DENSITY_BG[level]} ${inMonth ? '' : 'opacity-40'} hover:bg-white/[0.06]`}
    >
      <div className="flex items-center justify-between gap-1">
        <span
          className={`min-w-5 rounded px-1 text-center text-[11px] leading-5 tabular-nums ${
            isToday ? 'bg-tt-cyan font-bold text-black' : inMonth ? 'text-tt-text' : 'text-tt-muted'
          }`}
        >
          {dayNum(day.date)}
        </span>
        <div className="flex items-center gap-1">
          {isPayday && (
            <span className="rounded bg-tt-green/15 px-1 text-[8px] font-bold uppercase tracking-wide text-tt-green" title="Payday">pay</span>
          )}
          {day.pendingCount > 0 && (
            <span
              className="rounded bg-tt-yellow/20 px-1 text-[9px] font-bold tabular-nums text-tt-yellow"
              title={`${day.pendingCount} punch${day.pendingCount === 1 ? '' : 'es'} awaiting confirmation`}
            >{day.pendingCount}!</span>
          )}
          {day.headcount > 0 && <span className="text-[11px] font-bold tabular-nums text-tt-text">{day.headcount}</span>}
        </div>
      </div>

      {day.headcount > 0 ? (
        <>
          <div className="flex flex-wrap gap-1">
            {shown.map((p) => (
              <span
                key={`${p.employee_id}|${p.punch?.id ?? p.scheduled?.id ?? 'x'}`}
                onMouseEnter={(e) => {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const { head, sub } = personTooltipLines(p);
                  onHover({ x: r.left + r.width / 2, y: r.top, head, lines: sub });
                }}
                onMouseLeave={() => onHover(null)}
              >
                <PersonAvatar name={p.name} state={p.state} size="md" title={null} onClick={() => onOpenDay(day.date)} />
              </span>
            ))}
            {more > 0 && (
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-white/10 text-[9px] font-bold text-tt-muted">+{more}</span>
            )}
          </div>
          <span className="mt-auto text-[9.5px] text-tt-muted">
            {day.headcount} {day.headcount === 1 ? 'person' : 'people'}
          </span>
        </>
      ) : (
        <span className="mt-auto text-[10px] text-tt-muted/0 transition-colors group-hover:text-tt-muted">+ add</span>
      )}
    </div>
  );
}

export default function MonthGridView({
  days, byDate, anchor, todayISO, payAnchor, peak, onOpenDay, onAddDay,
}: {
  days: string[];
  byDate: Map<string, CalendarDay>;
  anchor: string;
  todayISO: string;
  payAnchor: string;
  peak: number;
  onOpenDay: (date: string) => void;
  onAddDay: (date: string) => void;
}) {
  const [hover, setHover] = useState<HoverPayload | null>(null);
  return (
    <>
      <div className="hidden overflow-hidden rounded-[14px] border border-tt-border bg-tt-bg md:block">
        <div className="overflow-x-auto">
          <div className="min-w-[760px]">
            <div className="grid grid-cols-7 border-b border-tt-border">
              {WEEKDAY_LABELS.map((d) => (
                <div key={d} className="px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-tt-muted">{d}</div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {days.map((d) => {
                const cell = byDate.get(d) ?? EMPTY_DAY(d);
                return (
                  <DayCell
                    key={d} day={cell}
                    inMonth={isInMonth(d, anchor)} isToday={d === todayISO}
                    isPayday={isPaydayISO(d, payAnchor)}
                    level={densityLevel(cell.headcount, peak)}
                    onOpenDay={onOpenDay} onAddDay={onAddDay} onHover={setHover}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <HoverCard hover={hover} />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1 text-[10px] text-tt-muted">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-white/25 ring-2 ring-tt-cyan" />On the clock</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-white/25 ring-2 ring-tt-yellow" />Needs confirmation</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-white/25 ring-2 ring-tt-red/70" />Scheduled, no punch</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-white/25 ring-1 ring-white/20" />Confirmed</span>
        {peak > 0 && <span className="ml-auto">Busiest day: {peak} people</span>}
      </div>
    </>
  );
}
