'use client';

import { useMemo, useState } from 'react';
import {
  buildCalendarDays, avatarHue, initialsOf,
  type CalScheduled, type CalendarDay,
} from '@/lib/schedule/calendarModel';
import {
  monthGridDays, monthTitle, addMonthsISO, startOfMonthISO, formatTime12, parseYMD,
} from '@/lib/weeklySchedule';
import PublicMonthGrid from './PublicMonthGrid';

// Read-only team schedule for managers. A month CALENDAR rather than an agenda list: the
// question this link answers is "which days are covered", which is a shape you read at a glance
// off a grid and have to reconstruct by scrolling through a list.
//
// It builds its day model with the SAME buildCalendarDays the admin calendar uses, in
// 'scheduled' view — so the two can never disagree about what a day contains.
//
// No mutations, no auth, no pay. Filtering is client-side over data already sent.

export interface PublicShift {
  id: string;
  employee_id: string;
  name: string;
  role: string | null;
  date: string;
  start_time: string;
  end_time: string;
}

type RoleView = 'all' | 'host' | 'fulfillment';

const VIEWS: { key: RoleView; label: string }[] = [
  { key: 'all', label: 'Everyone' },
  { key: 'host', label: 'Live Hosts' },
  { key: 'fulfillment', label: 'Fulfillment' },
];

function fullDayLabel(iso: string): string {
  return parseYMD(iso).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
}

export default function TeamScheduleBoard({
  shifts,
  todayISO,
  monthsAhead,
}: {
  shifts: PublicShift[];
  todayISO: string;
  /** How many months past the current one the server fetched — bounds the nav. */
  monthsAhead: number;
}) {
  const [view, setView] = useState<RoleView>('all');
  const [monthOffset, setMonthOffset] = useState(0);
  const [openDate, setOpenDate] = useState<string | null>(null);

  const anchor = useMemo(
    () => addMonthsISO(startOfMonthISO(todayISO), monthOffset),
    [todayISO, monthOffset],
  );
  const grid = useMemo(() => monthGridDays(anchor), [anchor]);

  // Employees + scheduled spans, in the shapes calendarModel expects. Every shift is a plan
  // (there are no punches on this surface), so `punches` is deliberately empty.
  const { employees, scheduled } = useMemo(() => {
    const empById = new Map<string, { id: string; name: string; role: string | null }>();
    const scheduled: CalScheduled[] = [];
    for (const s of shifts) {
      if (!empById.has(s.employee_id)) {
        empById.set(s.employee_id, { id: s.employee_id, name: s.name, role: s.role });
      }
      scheduled.push({
        id: s.id, employee_id: s.employee_id, date: s.date,
        start_time: s.start_time, end_time: s.end_time, origin: 'instance',
      });
    }
    return { employees: [...empById.values()], scheduled };
  }, [shifts]);

  const byDate = useMemo(
    () => buildCalendarDays({
      employees, punches: [], scheduled, days: grid.days,
      view: 'scheduled', todayISO, roleFilter: view,
    }),
    [employees, scheduled, grid.days, todayISO, view],
  );

  const openDay: CalendarDay | null = openDate ? byDate.get(openDate) ?? null : null;
  const timeById = useMemo(() => new Map(shifts.map((s) => [s.id, s])), [shifts]);

  const atStart = monthOffset <= 0;
  const atEnd = monthOffset >= monthsAhead;

  return (
    <div className="min-h-screen bg-tt-bg px-3 py-5 text-tt-text sm:px-4 sm:py-6">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-lg font-semibold">Team schedule</h1>
        <p className="mt-0.5 text-xs text-tt-muted">View only</p>

        <div className="mt-4 flex gap-1 rounded-lg bg-white/5 p-0.5" role="group" aria-label="Filter by role">
          {VIEWS.map((v) => (
            <button
              key={v.key} type="button" onClick={() => setView(v.key)} aria-pressed={view === v.key}
              className={`flex-1 rounded-md px-2 py-2 text-xs font-semibold transition-colors ${
                view === v.key ? 'bg-white/10 text-tt-text' : 'text-tt-muted'
              }`}
            >{v.label}</button>
          ))}
        </div>

        <div className="mt-4 mb-2 flex items-center justify-between gap-2">
          <button
            type="button" onClick={() => setMonthOffset((o) => o - 1)} disabled={atStart}
            aria-label="Previous month"
            className="h-8 w-8 rounded-lg border border-tt-border text-tt-muted transition-colors disabled:opacity-30"
          >←</button>
          <span className="text-sm font-medium">{monthTitle(anchor)}</span>
          <button
            type="button" onClick={() => setMonthOffset((o) => o + 1)} disabled={atEnd}
            aria-label="Next month"
            className="h-8 w-8 rounded-lg border border-tt-border text-tt-muted transition-colors disabled:opacity-30"
          >→</button>
        </div>

        <PublicMonthGrid
          days={grid.days} byDate={byDate} anchor={anchor} todayISO={todayISO}
          onOpenDay={setOpenDate}
        />

        <p className="mt-3 text-center text-[11px] text-tt-muted">Tap a day to see who is on.</p>
      </div>

      {/* Day sheet — bottom-anchored on a phone (thumb reach), centred from sm up. */}
      {openDay && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center sm:p-8"
          onClick={() => setOpenDate(null)}
          role="dialog" aria-modal="true" aria-label={fullDayLabel(openDay.date)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-tt-border bg-tt-card p-4 sm:rounded-2xl"
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold">{fullDayLabel(openDay.date)}</h2>
                <p className="text-xs text-tt-muted">{openDay.headcount} scheduled</p>
              </div>
              <button
                type="button" onClick={() => setOpenDate(null)} aria-label="Close"
                className="h-8 w-8 shrink-0 rounded-lg border border-tt-border text-tt-muted"
              >✕</button>
            </div>

            <div className="space-y-1.5">
              {openDay.people.map((p) => {
                const src = p.scheduled ? timeById.get(p.scheduled.id) : null;
                return (
                  <div key={p.employee_id} className="flex items-center gap-3 rounded-xl border border-tt-border bg-white/[0.02] px-3 py-2">
                    <span
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
                      style={{ backgroundColor: `hsl(${avatarHue(p.name)}, 45%, 42%)` }}
                      aria-hidden
                    >{initialsOf(p.name)}</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-semibold">{p.name}</div>
                      {p.role && <div className="text-[10px] capitalize text-tt-muted">{p.role}</div>}
                    </div>
                    <div className="shrink-0 text-[12px] tabular-nums text-tt-muted">
                      {src ? `${formatTime12(src.start_time)}–${formatTime12(src.end_time)}` : '—'}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
