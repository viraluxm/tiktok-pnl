'use client';

import { useMemo, useState } from 'react';
import type { Employee } from '@/types';
import { useShifts } from '@/hooks/useShifts';
import { useShiftRules } from '@/hooks/useShiftRules';
import { generateRecurringShifts } from '@/lib/employees';
import {
  buildWeekModel,
  weekRangeForAnchor,
  mondayOfISO,
  addDaysISO,
  localTodayISO,
  parseYMD,
  type RoleFilterValue,
} from '@/lib/weeklySchedule';
import RoleFilter from './RoleFilter';
import WeeklyShiftGrid from './WeeklyShiftGrid';
import ShiftEditorModal, { type EditorIntent } from './ShiftEditorModal';
import { makeEditorHandlers } from './editorHandlers';

function longDate(iso: string): string {
  return parseYMD(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// The weekly employee shift calendar — the default Team view. Owns the selected week
// (Mon→Sun) which scopes BOTH the shifts DB query and recurring generation, so opening the
// Team tab never loads the whole shift history.
export default function WeeklyShiftView({ employees }: { employees: Employee[] }) {
  const today = useMemo(() => localTodayISO(), []);
  // Anchor = any date in the selected week; normalised to its Monday.
  const [anchor, setAnchor] = useState<string>(() => mondayOfISO(today));
  const [roleFilter, setRoleFilter] = useState<RoleFilterValue>('all');
  const [editorIntent, setEditorIntent] = useState<EditorIntent | null>(null);

  const week = useMemo(() => weekRangeForAnchor(anchor), [anchor]);

  // Week-scoped data. Nulls would fetch all history — we always pass the Mon→Sun window.
  const { shifts, addShift, updateShift, deleteShift } = useShifts(week.start, week.end);
  const { rules, exceptions, upsertException } = useShiftRules();

  const materialized = useMemo(
    () => new Set(shifts.filter((s) => s.source_rule_id).map((s) => `${s.source_rule_id}|${s.date}`)),
    [shifts],
  );
  // Recurring occurrences ONLY for the selected week.
  const generated = useMemo(
    () => generateRecurringShifts(rules, exceptions, week.start, week.end, materialized),
    [rules, exceptions, week.start, week.end, materialized],
  );

  const groups = useMemo(
    () => buildWeekModel({ employees, shifts, generated, weekDates: week.dates, roleFilter }),
    [employees, shifts, generated, week.dates, roleFilter],
  );

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of employees) m.set(e.id, e.name);
    return (id: string) => m.get(id) || 'Unknown';
  }, [employees]);

  const isThisWeek = week.start === mondayOfISO(today);
  // Default date for the global "Add Shift": today if it's in the visible week, else Monday.
  const defaultAddDate = today >= week.start && today <= week.end ? today : week.start;

  const handlers = useMemo(
    () => makeEditorHandlers({ employees, nameById, addShift, updateShift, deleteShift, upsertException }),
    [employees, nameById, addShift, updateShift, deleteShift, upsertException],
  );

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setAnchor(addDaysISO(week.start, -7))}
            aria-label="Previous week"
            className="w-8 h-8 rounded-lg border border-tt-border text-tt-muted hover:bg-tt-card-hover hover:text-tt-text transition-colors"
          >←</button>
          <button
            type="button"
            onClick={() => setAnchor(mondayOfISO(today))}
            disabled={isThisWeek}
            className={`px-3 h-8 rounded-lg border text-xs font-semibold transition-colors ${
              isThisWeek ? 'border-tt-border text-tt-muted/50 cursor-default' : 'border-tt-border text-tt-text hover:bg-tt-card-hover'
            }`}
          >
            This week
          </button>
          <button
            type="button"
            onClick={() => setAnchor(addDaysISO(week.start, 7))}
            aria-label="Next week"
            className="w-8 h-8 rounded-lg border border-tt-border text-tt-muted hover:bg-tt-card-hover hover:text-tt-text transition-colors"
          >→</button>
          <span className="ml-1 text-sm text-tt-text font-medium tabular-nums">
            Week of {longDate(week.start)} – {longDate(week.end)}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <RoleFilter value={roleFilter} onChange={setRoleFilter} />
          <button
            type="button"
            onClick={() => setEditorIntent({ mode: 'create', employeeId: '', date: defaultAddDate })}
            className="px-4 py-2 rounded-lg bg-gradient-to-r from-tt-cyan to-[#4db8c0] text-black text-[13px] font-semibold hover:opacity-90 transition-opacity"
          >
            + Add Shift
          </button>
        </div>
      </div>

      <WeeklyShiftGrid
        groups={groups}
        weekDates={week.dates}
        todayISO={today}
        roleFilter={roleFilter}
        onAddCell={(employeeId, date) => setEditorIntent({ mode: 'create', employeeId, date })}
        onOpenCard={(card) => setEditorIntent({ mode: 'card', card })}
      />

      {/* Legend — labels + colors (never color alone). */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-tt-muted">
        <span className="flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-full bg-tt-cyan" />Live Hosts</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-full bg-tt-magenta-soft" />Fulfillment</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-full bg-tt-muted" />Other</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-full bg-tt-yellow" />Open / no end time</span>
        <span>🌙 +1d = overnight</span>
        <span className="text-tt-red">⚠ Overlap</span>
      </div>

      {editorIntent && (
        <ShiftEditorModal intent={editorIntent} handlers={handlers} onClose={() => setEditorIntent(null)} />
      )}
    </div>
  );
}
