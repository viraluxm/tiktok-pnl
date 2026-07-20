'use client';

import { useEffect, useMemo, useState } from 'react';
import { shiftHours } from '@/lib/employees';

// Read-only calendar view of the SAME shift rows the list shows. Display only — no
// add/edit/drag. Consumes the rows ShiftsView already builds (one-off ∪ open ∪
// generated recurring), so there is no new fetch, endpoint, or DB access here.
export interface CalendarShift {
  id: string;
  kind: 'oneoff' | 'recurring';
  employee_id: string;
  date: string;            // 'YYYY-MM-DD' (calendar date, tz-naive)
  start_time: string;      // 'HH:MM' or 'HH:MM:SS'
  end_time: string | null; // null = open shift (in progress)
}

// Consistent per-employee color across the whole calendar so coverage/overlap reads
// at a glance. Indexed by the employee's position (stable) — inline style, never a
// dynamic tailwind class (those get purged).
const PALETTE = [
  '#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444',
  '#a855f7', '#ec4899', '#14b8a6', '#f97316', '#84cc16',
];

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ── date helpers (tz-naive; a shift.date is a plain calendar day) ──
function parseYMD(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
function toYMD(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function startOfWeek(d: Date): Date {
  return addDays(d, -d.getDay()); // Sunday-based
}
function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// 'HH:MM[:SS]' → minutes since midnight.
function minutesOf(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
// 'HH:MM[:SS]' → 'H:MMam/pm' compact.
function fmtHM(t: string): string {
  const [hRaw, m] = t.split(':').map(Number);
  const h = hRaw % 12 === 0 ? 12 : hRaw % 12;
  const ap = hRaw < 12 ? 'a' : 'p';
  return `${h}:${String(m || 0).padStart(2, '0')}${ap}`;
}
function nowHM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const DAY_MIN = 1440;
const WEEK_COL_H = 560; // px height of a day column (24h)

interface Positioned {
  s: CalendarShift;
  startMin: number;   // minutes from midnight on this day
  endMin: number;     // clamped to <= 1440 for the block on THIS day
  overnight: boolean; // ends after midnight (has a continuation next day)
  contEnd: number | null; // minutes into the NEXT day it continues to (for the stub)
  open: boolean;
  lane: number;
  lanes: number;
}

export default function ShiftCalendar({
  rows,
  nameById,
  employees,
}: {
  rows: CalendarShift[];
  nameById: Map<string, string>;
  employees: { id: string }[];
}) {
  const [grain, setGrain] = useState<'week' | 'month'>('month');

  // Live tick so open ("in progress") shifts extend to "now".
  const [nowTick, setNowTick] = useState(() => 0);
  useEffect(() => {
    const t = setInterval(() => setNowTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const colorFor = useMemo(() => {
    const idx = new Map<string, number>();
    employees.forEach((e, i) => idx.set(e.id, i));
    return (employeeId: string) => PALETTE[(idx.get(employeeId) ?? 0) % PALETTE.length];
  }, [employees]);

  // Anchor the initial view on the latest shift so shifts are visible immediately
  // (the rows are already period-scoped upstream); fall back to today.
  const [anchor, setAnchor] = useState<Date>(() => {
    const dates = rows.map((r) => r.date).sort();
    return dates.length ? parseYMD(dates[dates.length - 1]) : new Date();
  });

  // Shifts grouped by their START calendar day.
  const byDay = useMemo(() => {
    const m = new Map<string, CalendarShift[]>();
    for (const r of rows) {
      if (!m.has(r.date)) m.set(r.date, []);
      m.get(r.date)!.push(r);
    }
    for (const arr of m.values()) arr.sort((a, b) => minutesOf(a.start_time) - minutesOf(b.start_time));
    return m;
  }, [rows]);

  // Continuation stubs (overnight tail) keyed by the NEXT day.
  const contByDay = useMemo(() => {
    const m = new Map<string, { s: CalendarShift; endMin: number }[]>();
    for (const r of rows) {
      if (r.end_time == null) continue;
      const st = minutesOf(r.start_time);
      const en = minutesOf(r.end_time);
      if (en <= st) {
        const next = toYMD(addDays(parseYMD(r.date), 1));
        if (!m.has(next)) m.set(next, []);
        m.get(next)!.push({ s: r, endMin: en });
      }
    }
    return m;
  }, [rows]);

  // Lane-pack a day's shifts so overlapping ones sit side-by-side (readable overlap).
  function positionDay(day: Date): Positioned[] {
    const key = toYMD(day);
    const list = byDay.get(key) ?? [];
    const nowMin = minutesOf(nowHM());
    const base: Omit<Positioned, 'lane' | 'lanes'>[] = list.map((s) => {
      const startMin = minutesOf(s.start_time);
      const open = s.end_time == null;
      const rawEnd = open ? Math.max(nowMin, startMin + 15) : minutesOf(s.end_time!);
      const overnight = !open && rawEnd <= startMin;
      const endMin = overnight ? DAY_MIN : Math.min(rawEnd, DAY_MIN);
      return {
        s, startMin, endMin, overnight, open,
        contEnd: overnight ? rawEnd : null,
      };
    });
    // Interval-graph lane assignment.
    const withLanes: Positioned[] = [];
    const laneEnds: number[] = [];
    for (const b of base.sort((a, z) => a.startMin - z.startMin)) {
      let lane = laneEnds.findIndex((e) => e <= b.startMin);
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(b.endMin); }
      else laneEnds[lane] = b.endMin;
      withLanes.push({ ...b, lane, lanes: 0 });
    }
    const lanes = Math.max(1, laneEnds.length);
    return withLanes.map((p) => ({ ...p, lanes }));
  }

  const label = (s: CalendarShift) =>
    `${nameById.get(s.employee_id) || 'Unknown'} · ${fmtHM(s.start_time)}–${s.end_time == null ? 'now' : fmtHM(s.end_time)}`;

  // ── header: grain toggle + nav ──
  const header = (
    <div className="flex items-center justify-between gap-3 mb-3">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setAnchor(grain === 'week' ? addDays(anchor, -7) : new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1))}
          className="w-8 h-8 rounded-lg border border-tt-border text-tt-muted hover:bg-tt-card-hover hover:text-tt-text transition-colors"
          aria-label="Previous"
        >‹</button>
        <button
          onClick={() => setAnchor(new Date())}
          className="px-3 h-8 rounded-lg border border-tt-border text-xs font-semibold text-tt-muted hover:bg-tt-card-hover hover:text-tt-text transition-colors"
        >Today</button>
        <button
          onClick={() => setAnchor(grain === 'week' ? addDays(anchor, 7) : new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1))}
          className="w-8 h-8 rounded-lg border border-tt-border text-tt-muted hover:bg-tt-card-hover hover:text-tt-text transition-colors"
          aria-label="Next"
        >›</button>
        <span className="ml-2 text-sm font-semibold text-tt-text">
          {grain === 'week'
            ? (() => { const s = startOfWeek(anchor); const e = addDays(s, 6); return `${MONTHS[s.getMonth()].slice(0, 3)} ${s.getDate()} – ${MONTHS[e.getMonth()].slice(0, 3)} ${e.getDate()}`; })()
            : `${MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}`}
        </span>
      </div>
      <div className="flex gap-1 bg-white/5 rounded-lg p-0.5">
        {(['week', 'month'] as const).map((g) => (
          <button
            key={g}
            onClick={() => setGrain(g)}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
              grain === g ? 'bg-white/10 text-tt-text' : 'text-tt-muted hover:text-tt-text'
            }`}
          >
            {g === 'week' ? 'Week' : 'Month'}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="bg-tt-card border border-tt-border rounded-[14px] backdrop-blur-xl p-6" data-testid="shift-calendar">
      {header}
      {rows.length === 0 && <p className="text-sm text-tt-muted">No shifts in this period.</p>}
      {grain === 'week' ? <WeekGrid /> : <MonthGrid />}
    </div>
  );

  // ── Week view ──
  function WeekGrid() {
    const weekStart = startOfWeek(anchor);
    const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    const today = new Date();
    void nowTick; // re-render open blocks on tick
    return (
      <div className="overflow-x-auto">
        <div className="min-w-[640px]">
          {/* day headers */}
          <div className="grid" style={{ gridTemplateColumns: `40px repeat(7, 1fr)` }}>
            <div />
            {days.map((d) => (
              <div key={toYMD(d)} className={`px-1 pb-1 text-center text-[11px] font-semibold ${sameDay(d, today) ? 'text-tt-cyan' : 'text-tt-muted'}`}>
                {DOW[d.getDay()]} {d.getDate()}
              </div>
            ))}
          </div>
          {/* grid body: hour rail + 7 day columns */}
          <div className="grid" style={{ gridTemplateColumns: `40px repeat(7, 1fr)` }}>
            {/* hour rail */}
            <div className="relative" style={{ height: WEEK_COL_H }}>
              {Array.from({ length: 9 }, (_, i) => i * 3).map((h) => (
                <div key={h} className="absolute right-1 text-[9px] text-tt-muted -translate-y-1/2" style={{ top: (h / 24) * WEEK_COL_H }}>
                  {h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`}
                </div>
              ))}
            </div>
            {days.map((d) => {
              const positioned = positionDay(d);
              const conts = contByDay.get(toYMD(d)) ?? [];
              return (
                <div key={toYMD(d)} className="relative border-l border-tt-border/40" style={{ height: WEEK_COL_H }}>
                  {/* 3-hour gridlines */}
                  {Array.from({ length: 8 }, (_, i) => (i + 1) * 3).map((h) => (
                    <div key={h} className="absolute left-0 right-0 border-t border-tt-border/20" style={{ top: (h / 24) * WEEK_COL_H }} />
                  ))}
                  {/* overnight continuation stubs from the previous day (00:00→end) */}
                  {conts.map(({ s, endMin }) => {
                    const color = colorFor(s.employee_id);
                    return (
                      <div key={`c-${s.id}`} title={label(s) + ' (cont.)'}
                        className="absolute left-0.5 rounded-md px-1 text-[9px] font-semibold text-white/90 overflow-hidden"
                        style={{ top: 0, height: Math.max(12, (endMin / DAY_MIN) * WEEK_COL_H), width: 'calc(100% - 4px)', background: color, opacity: 0.55, borderTop: `2px dashed rgba(255,255,255,0.5)` }}>
                        ↳ {fmtHM(s.start_time)}
                      </div>
                    );
                  })}
                  {/* shift blocks (lane-packed) */}
                  {positioned.map((p) => {
                    const color = colorFor(p.s.employee_id);
                    const top = (p.startMin / DAY_MIN) * WEEK_COL_H;
                    const height = Math.max(14, ((p.endMin - p.startMin) / DAY_MIN) * WEEK_COL_H);
                    const w = `calc(${100 / p.lanes}% - 3px)`;
                    const left = `calc(${(100 / p.lanes) * p.lane}% + 1px)`;
                    return (
                      <div key={p.s.id} title={label(p.s) + (p.overnight ? ' (+1d)' : '') + (p.s.kind === 'recurring' ? ' · recurring' : ' · one-off')}
                        className="absolute rounded-md px-1 py-0.5 text-[9px] leading-tight font-semibold text-white overflow-hidden"
                        style={{ top, height, left, width: w, background: color, boxShadow: p.open ? '0 0 0 2px rgba(16,185,129,0.9) inset' : undefined }}>
                        <div className="truncate">{nameById.get(p.s.employee_id) || 'Unknown'}</div>
                        <div className="truncate opacity-90">
                          {fmtHM(p.s.start_time)}–{p.s.end_time == null ? 'now' : fmtHM(p.s.end_time)}{p.overnight ? ' +1d' : ''}
                        </div>
                        <div className="opacity-80">{p.s.kind === 'recurring' ? '↻' : '•'}{p.open ? ' · in shift' : ''}</div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  // ── Month view ──
  function MonthGrid() {
    void nowTick;
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const gridStart = startOfWeek(first);
    const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i)); // 6 weeks
    const today = new Date();
    return (
      <div>
        <div className="grid grid-cols-7 mb-1">
          {DOW.map((d) => <div key={d} className="text-center text-[11px] font-semibold text-tt-muted">{d}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-px bg-tt-border/30 rounded-lg overflow-hidden">
          {cells.map((d) => {
            const inMonth = d.getMonth() === anchor.getMonth();
            const list = (byDay.get(toYMD(d)) ?? []);
            const conts = (contByDay.get(toYMD(d)) ?? []);
            const shown = list.slice(0, 3);
            const extra = list.length - shown.length;
            return (
              <div key={toYMD(d)} className={`min-h-[92px] p-1.5 ${inMonth ? 'bg-tt-card' : 'bg-tt-card/40'}`}>
                <div className={`text-[10px] font-semibold mb-1 ${sameDay(d, today) ? 'text-tt-cyan' : inMonth ? 'text-tt-text' : 'text-tt-muted'}`}>{d.getDate()}</div>
                <div className="space-y-0.5">
                  {conts.map(({ s }) => (
                    <div key={`c-${s.id}`} title={label(s) + ' (cont.)'} className="flex items-center gap-1 text-[9px] text-tt-muted truncate">
                      <span className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: colorFor(s.employee_id), opacity: 0.6 }} />
                      <span className="truncate">↳ {nameById.get(s.employee_id) || 'Unknown'} {s.end_time ? `–${fmtHM(s.end_time)}` : ''}</span>
                    </div>
                  ))}
                  {shown.map((s) => (
                    <div key={s.id} title={label(s) + (s.kind === 'recurring' ? ' · recurring' : ' · one-off')}
                      className="flex items-center gap-1 text-[9px] truncate rounded px-1 py-0.5"
                      style={{ background: `${colorFor(s.employee_id)}26` }}>
                      <span className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: colorFor(s.employee_id) }} />
                      <span className="truncate text-tt-text">
                        {nameById.get(s.employee_id) || 'Unknown'} {fmtHM(s.start_time)}–{s.end_time == null ? 'now' : fmtHM(s.end_time)}
                        {s.end_time != null && minutesOf(s.end_time) <= minutesOf(s.start_time) ? '+1d' : ''}
                      </span>
                      {s.kind === 'recurring' && <span className="ml-auto text-tt-muted flex-shrink-0">↻</span>}
                      {s.end_time == null && <span className="ml-auto text-tt-green flex-shrink-0">•</span>}
                    </div>
                  ))}
                  {extra > 0 && <div className="text-[9px] text-tt-muted pl-1">+{extra} more</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }
}
