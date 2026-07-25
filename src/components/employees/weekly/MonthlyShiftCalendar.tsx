'use client';

import { useMemo, useState } from 'react';
import type { Employee } from '@/types';
import { useShifts } from '@/hooks/useShifts';
import { useShiftRules } from '@/hooks/useShiftRules';
import { generateRecurringShifts } from '@/lib/employees';
import {
  buildMonthModel,
  monthGridDays,
  addMonthsISO,
  startOfMonthISO,
  monthTitle,
  isInMonth,
  localTodayISO,
  WEEKDAY_LABELS,
  type RoleFilterValue,
  type WeekShiftCard,
} from '@/lib/weeklySchedule';
import RoleFilter from './RoleFilter';
import MonthlyDayCell from './MonthlyDayCell';
import DayShiftDetailsModal from './DayShiftDetailsModal';
import ShiftEditorModal, { type EditorIntent } from './ShiftEditorModal';
import { makeEditorHandlers } from './editorHandlers';

// Interactive, role-organized month calendar. The selected month drives the shift query
// AND recurring generation for the FULL visible grid range (incl. adjacent-month days),
// and reuses the same editor + mutations as the weekly grid.
export default function MonthlyShiftCalendar({ employees }: { employees: Employee[] }) {
  const today = useMemo(() => localTodayISO(), []);
  const [anchor, setAnchor] = useState<string>(() => startOfMonthISO(today));
  const [roleFilter, setRoleFilter] = useState<RoleFilterValue>('all');
  const [editorIntent, setEditorIntent] = useState<EditorIntent | null>(null);
  const [detailsDate, setDetailsDate] = useState<string | null>(null);

  const grid = useMemo(() => monthGridDays(anchor), [anchor]);

  // Range-controlled: fetch/generate across the WHOLE visible grid, not just the 1st–last.
  const { shifts, addShift, updateShift, deleteShift } = useShifts(grid.gridStart, grid.gridEnd);
  const { rules, exceptions, upsertException } = useShiftRules();

  const materialized = useMemo(
    () => new Set(shifts.filter((s) => s.source_rule_id).map((s) => `${s.source_rule_id}|${s.date}`)),
    [shifts],
  );
  const generated = useMemo(
    () => generateRecurringShifts(rules, exceptions, grid.gridStart, grid.gridEnd, materialized),
    [rules, exceptions, grid.gridStart, grid.gridEnd, materialized],
  );
  const byDate = useMemo(
    () => buildMonthModel({ employees, shifts, generated, gridDays: grid.days, roleFilter }),
    [employees, shifts, generated, grid.days, roleFilter],
  );

  const nameById = useMemo(() => {
    const m = new Map(employees.map((e) => [e.id, e.name]));
    return (id: string) => m.get(id) || 'Unknown';
  }, [employees]);

  const handlers = useMemo(
    () => makeEditorHandlers({ employees, nameById, addShift, updateShift, deleteShift, upsertException }),
    [employees, nameById, addShift, updateShift, deleteShift, upsertException],
  );

  const isThisMonth = anchor === startOfMonthISO(today);

  const openAddDay = (date: string) => { setDetailsDate(null); setEditorIntent({ mode: 'create', employeeId: '', date }); };
  const openCard = (card: WeekShiftCard) => { setDetailsDate(null); setEditorIntent({ mode: 'card', card }); };

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setAnchor(addMonthsISO(anchor, -1))}
            aria-label="Previous month"
            className="w-8 h-8 rounded-lg border border-tt-border text-tt-muted hover:bg-tt-card-hover hover:text-tt-text transition-colors"
          >←</button>
          <button
            type="button"
            onClick={() => setAnchor(startOfMonthISO(today))}
            disabled={isThisMonth}
            className={`px-3 h-8 rounded-lg border text-xs font-semibold transition-colors ${
              isThisMonth ? 'border-tt-border text-tt-muted/50 cursor-default' : 'border-tt-border text-tt-text hover:bg-tt-card-hover'
            }`}
          >
            This month
          </button>
          <button
            type="button"
            onClick={() => setAnchor(addMonthsISO(anchor, 1))}
            aria-label="Next month"
            className="w-8 h-8 rounded-lg border border-tt-border text-tt-muted hover:bg-tt-card-hover hover:text-tt-text transition-colors"
          >→</button>
          <span className="ml-1 text-sm text-tt-text font-medium">{monthTitle(anchor)}</span>
        </div>
        <RoleFilter value={roleFilter} onChange={setRoleFilter} />
      </div>

      {/* Month grid */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] backdrop-blur-xl overflow-hidden">
        <div className="overflow-x-auto">
          <div className="min-w-[720px]">
            {/* Weekday header (Mon→Sun) */}
            <div className="grid grid-cols-7 border-b border-tt-border">
              {WEEKDAY_LABELS.map((label) => (
                <div key={label} className="px-2 py-2 text-center text-[11px] font-semibold text-tt-muted uppercase tracking-wide border-r border-[rgba(255,255,255,0.04)] last:border-r-0">
                  {label}
                </div>
              ))}
            </div>
            {/* Weeks */}
            {grid.weeks.map((week, wi) => (
              <div key={wi} className="grid grid-cols-7">
                {week.map((day) => (
                  <MonthlyDayCell
                    key={day}
                    date={day}
                    inMonth={isInMonth(day, anchor)}
                    isToday={day === today}
                    entries={byDate.get(day) ?? []}
                    onAddDay={openAddDay}
                    onOpenDay={(d) => setDetailsDate(d)}
                    onOpenCard={openCard}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Legend — labels + colors (never color alone). */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-tt-muted">
        <span className="flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-full bg-tt-cyan" />Live Hosts</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-full bg-tt-magenta-soft" />Fulfillment</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-full bg-tt-muted" />Other</span>
        <span>🌙 = overnight (ends next day)</span>
      </div>

      {detailsDate && (
        <DayShiftDetailsModal
          date={detailsDate}
          entries={byDate.get(detailsDate) ?? []}
          onClose={() => setDetailsDate(null)}
          onAddDay={openAddDay}
          onOpenCard={openCard}
        />
      )}

      {editorIntent && (
        <ShiftEditorModal intent={editorIntent} handlers={handlers} onClose={() => setEditorIntent(null)} />
      )}
    </div>
  );
}
