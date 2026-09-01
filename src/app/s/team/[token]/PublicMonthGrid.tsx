'use client';

import { avatarHue, initialsOf, type CalendarDay } from '@/lib/schedule/calendarModel';
import { WEEKDAY_LABELS, isInMonth, parseYMD } from '@/lib/weeklySchedule';

// Read-only month grid sized to survive a phone.
//
// At 375px each of seven columns is ~50px, so the cell shows a day number, a headcount, and two
// faces; from `sm` up it relaxes to five. Everything past that lives behind a tap — the grid
// answers "which days are covered and roughly how well", and the day sheet answers "by whom".
//
// No add/edit affordances: this grid is reached by a bearer link and must never imply it can
// write. It shares calendarModel with the admin calendar, so both agree on what a day contains.

function dayNum(iso: string): number {
  return parseYMD(iso).getUTCDate();
}

function Avatar({ name, size }: { name: string; size: 'xs' | 'sm' }) {
  const cls = size === 'xs' ? 'w-5 h-5 text-[8px]' : 'w-6 h-6 text-[9px]';
  return (
    <span
      className={`${cls} inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white`}
      style={{ backgroundColor: `hsl(${avatarHue(name)}, 45%, 42%)` }}
      aria-hidden
    >
      {initialsOf(name)}
    </span>
  );
}

export default function PublicMonthGrid({
  days,
  byDate,
  anchor,
  todayISO,
  onOpenDay,
}: {
  days: string[];
  byDate: Map<string, CalendarDay>;
  anchor: string;
  todayISO: string;
  onOpenDay: (date: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-tt-border">
      <div className="grid grid-cols-7 border-b border-tt-border">
        {WEEKDAY_LABELS.map((d) => (
          <div key={d} className="px-1 py-1.5 text-center text-[9px] font-bold uppercase tracking-wider text-tt-muted">
            {/* One letter is all that fits on a phone; the full label returns at sm. */}
            <span className="sm:hidden">{d[0]}</span>
            <span className="hidden sm:inline">{d}</span>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {days.map((d) => {
          const cell = byDate.get(d);
          const n = cell?.headcount ?? 0;
          const inMonth = isInMonth(d, anchor);
          const people = cell?.people ?? [];

          return (
            <button
              key={d}
              type="button"
              disabled={n === 0}
              onClick={() => onOpenDay(d)}
              aria-label={`${d}, ${n} scheduled`}
              className={`flex min-h-[62px] flex-col items-stretch gap-1 border-b border-r border-[rgba(255,255,255,0.05)] p-1 text-left transition-colors sm:min-h-[92px] sm:p-1.5 ${
                inMonth ? '' : 'opacity-35'
              } ${n > 0 ? 'cursor-pointer hover:bg-white/[0.05]' : 'cursor-default'}`}
            >
              <div className="flex items-center justify-between gap-0.5">
                <span
                  className={`min-w-[16px] rounded px-1 text-center text-[10px] leading-4 tabular-nums sm:text-[11px] ${
                    d === todayISO ? 'bg-tt-cyan font-bold text-black' : inMonth ? 'text-tt-text' : 'text-tt-muted'
                  }`}
                >
                  {dayNum(d)}
                </span>
                {n > 0 && <span className="text-[10px] font-bold tabular-nums text-tt-text sm:text-[11px]">{n}</span>}
              </div>

              {n > 0 && (
                <div className="flex flex-wrap gap-0.5 sm:gap-1">
                  {people.slice(0, 2).map((p) => (
                    <span key={p.employee_id} className="sm:hidden"><Avatar name={p.name} size="xs" /></span>
                  ))}
                  {people.slice(0, 5).map((p) => (
                    <span key={p.employee_id} className="hidden sm:inline"><Avatar name={p.name} size="sm" /></span>
                  ))}
                  {n > 2 && (
                    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-white/10 text-[7.5px] font-bold text-tt-muted sm:hidden">
                      +{n - 2}
                    </span>
                  )}
                  {n > 5 && (
                    <span className="hidden h-6 w-6 items-center justify-center rounded-full bg-white/10 text-[8.5px] font-bold text-tt-muted sm:inline-flex">
                      +{n - 5}
                    </span>
                  )}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
