'use client';

import { useState } from 'react';
import {
  monthGridDays, monthTitle, addMonthsISO, startOfMonthISO, isInMonth, parseYMD, WEEKDAY_LABELS,
} from '@/lib/weeklySchedule';
import { addDaysISO, inclusiveDays, TIME_OFF_MAX_DAYS } from '@/lib/schedule/timeOff';

// An inline range calendar, replacing two native date inputs.
//
// The native control was not only ugly here — it could not express the rule this form exists to
// enforce. The pay-period deadline was prose above the fields ("earliest you can request…"), and
// iOS would still happily spin to a locked-out date and refuse on submit. Here the locked-out days
// are simply not tappable, so the rule is visible before anyone tries to break it.
//
// It also collapses two fields into one gesture: tap a day for a single day, tap a second for a
// range. Days beyond the 14-day maximum are disabled the moment a start is chosen, so the other
// server-side limit is visible too.
//
// All date maths reuses the helpers the calendars already share — nothing new is invented here.

function dayNum(iso: string): number {
  return parseYMD(iso).getUTCDate();
}

export default function TimeOffCalendar({
  earliest,
  start,
  end,
  onChange,
}: {
  earliest: string;            // first requestable date; everything before it is locked
  start: string;
  end: string;
  onChange: (start: string, end: string) => void;
}) {
  // Open on the month containing the first date anyone could actually pick.
  const [anchor, setAnchor] = useState(() => startOfMonthISO(earliest || start || new Date().toISOString().slice(0, 10)));
  const grid = monthGridDays(anchor);

  // With a start but no end we are mid-range; the next tap closes it.
  const picking = Boolean(start) && !end;
  const maxEnd = start ? addDaysISO(start, TIME_OFF_MAX_DAYS - 1) : '';

  function disabled(d: string): boolean {
    if (earliest && d < earliest) return true;          // period already built
    if (picking && d < start) return false;             // tapping earlier restarts the range
    if (picking && d > maxEnd) return true;             // would exceed the 14-day maximum
    return false;
  }

  function select(d: string) {
    if (disabled(d)) return;
    if (!start || end) { onChange(d, ''); return; }     // fresh start, or restart after a full range
    if (d < start) { onChange(d, ''); return; }         // tapped earlier → that becomes the start
    onChange(start, d);                                  // closes the range
  }

  const inRange = (d: string) => Boolean(start && end && d >= start && d <= end);
  const isEdge = (d: string) => d === start || (Boolean(end) && d === end);

  return (
    <div className="rounded-xl border border-tt-input-border bg-tt-input-bg p-2">
      <div className="mb-1 flex items-center justify-between">
        <button
          type="button" aria-label="Previous month"
          onClick={() => setAnchor(addMonthsISO(anchor, -1))}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-tt-muted hover:bg-white/10"
        >←</button>
        <span className="text-sm font-semibold text-tt-text">{monthTitle(anchor)}</span>
        <button
          type="button" aria-label="Next month"
          onClick={() => setAnchor(addMonthsISO(anchor, 1))}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-tt-muted hover:bg-white/10"
        >→</button>
      </div>

      <div className="grid grid-cols-7">
        {WEEKDAY_LABELS.map((w) => (
          <div key={w} className="pb-1 text-center text-[10px] font-bold uppercase text-tt-muted">{w[0]}</div>
        ))}

        {grid.days.map((d) => {
          const off = disabled(d);
          const edge = isEdge(d);
          const mid = inRange(d) && !edge;
          return (
            <button
              key={d}
              type="button"
              disabled={off}
              onClick={() => select(d)}
              aria-label={d}
              aria-pressed={edge || mid}
              // 40px keeps every day a real touch target on a 375px screen (7 x ~47px cells).
              className={`flex h-10 items-center justify-center text-[13px] tabular-nums transition-colors ${
                edge
                  ? 'rounded-lg bg-tt-cyan font-bold text-black'
                  : mid
                    ? 'bg-tt-cyan/20 text-tt-text'
                    : off
                      ? 'cursor-not-allowed text-tt-muted/25'
                      : isInMonth(d, anchor)
                        ? 'rounded-lg text-tt-text hover:bg-white/10'
                        : 'rounded-lg text-tt-muted/50 hover:bg-white/10'
              }`}
            >
              {dayNum(d)}
            </button>
          );
        })}
      </div>

      <p className="mt-1.5 min-h-4 px-1 text-center text-[11px] text-tt-muted">
        {!start
          ? 'Tap the day you want off'
          : !end
            ? 'Tap a second day for a range, or send for just this one'
            : `${inclusiveDays(start, end)} days selected`}
      </p>
    </div>
  );
}
