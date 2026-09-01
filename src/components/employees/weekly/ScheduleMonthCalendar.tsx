'use client';

import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Employee } from '@/types';
import { useShifts } from '@/hooks/useShifts';
import { useShiftRules } from '@/hooks/useShiftRules';
import { useShiftInstances } from '@/hooks/useShiftInstances';
import { generateRecurringShifts, PAY_ANCHOR } from '@/lib/employees';
import { laWallClockOf } from '@/lib/schedule/timezone';
import {
  buildCalendarDays, maxHeadcount,
  type CalPunch, type CalScheduled, type CalendarView,
} from '@/lib/schedule/calendarModel';
import {
  monthGridDays, monthTitle, addMonthsISO, startOfMonthISO, isInMonth, localTodayISO,
  WEEKDAY_LABELS, parseYMD, indexWeekCards, type RoleFilterValue, type WeekShiftCard,
} from '@/lib/weeklySchedule';
import RoleFilter from './RoleFilter';
import PersonAvatar from './PersonAvatar';
import MonthGridView, { MAX_AVATARS } from './MonthGridView';
import DayPeopleModal from './DayPeopleModal';
import PendingConfirmModal from './PendingConfirmModal';
import TimeOffQueue, { useTimeOff } from './TimeOffQueue';
import DayAddShiftModal from './DayAddShiftModal';
import ShiftEditorModal, { type EditorIntent } from './ShiftEditorModal';
import { makeEditorHandlers } from './editorHandlers';

// The month calendar, rebuilt around PEOPLE instead of text rows.
//
// Three views, because one calendar cannot answer two different questions at once:
//   Clock-ins  — what actually happened (and what payroll will pay)
//   Scheduled  — who we expect to show up
//   All        — the punch, with its schedule underneath and the difference between them
//
// A person appears ONCE per day in every view. The old grid drew a scheduled shift and its
// matching punch as two separate cards, so a normal day looked like double coverage.

const VIEWS: { key: CalendarView; label: string }[] = [
  { key: 'clocked', label: 'Clock-ins' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'all', label: 'All' },
];

function fullDateLabel(iso: string): string {
  return parseYMD(iso).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

function dayNum(iso: string): number {
  return parseYMD(iso).getUTCDate();
}

export default function ScheduleMonthCalendar({ employees }: { employees: Employee[] }) {
  const today = useMemo(() => localTodayISO(), []);
  const [anchor, setAnchor] = useState<string>(() => startOfMonthISO(today));
  const [view, setView] = useState<CalendarView>('all');
  const [roleFilter, setRoleFilter] = useState<RoleFilterValue>('all');
  const [openDate, setOpenDate] = useState<string | null>(null);
  const [showPending, setShowPending] = useState(false);
  const [showTimeOff, setShowTimeOff] = useState(false);
  const { rows: timeOffRows, reload: reloadTimeOff, pending: timeOffPending } = useTimeOff();
  const [addOnDate, setAddOnDate] = useState<string | null>(null);
  const [editorIntent, setEditorIntent] = useState<EditorIntent | null>(null);

  const qc = useQueryClient();
  const grid = useMemo(() => monthGridDays(anchor), [anchor]);

  const { shifts, addShift, updateShift, deleteShift, confirmShift } = useShifts(grid.gridStart, grid.gridEnd);
  const { rules, exceptions, upsertException } = useShiftRules();
  const { instances } = useShiftInstances(grid.gridStart, grid.gridEnd);

  // Punches = time-clock rows only. Manual one-offs are a correction to the record, so they read
  // as punches here too — they are what pay uses. Rows materialized from a rule are the PLAN and
  // are excluded (isPayableShift drops them from pay for the same reason).
  const punches: CalPunch[] = useMemo(
    () => shifts
      .filter((s) => s.source_rule_id == null)
      .map((s) => ({
        id: s.id,
        source: s.source ?? null,
        employee_id: s.employee_id,
        date: s.date,
        start_time: s.start_time,
        end_time: s.end_time,
        clock_in_at: s.clock_in_at ?? null,
        clock_out_at: s.clock_out_at ?? null,
        break_minutes: s.break_minutes ?? 0,
        confirmed_at: s.confirmed_at ?? null,
        auto_closed: s.auto_closed === true,
      })),
    [shifts],
  );

  // Scheduled = shift_instances ∪ recurring projections, flattened to LA wall clock. Both are
  // real today (10 active rules, plus admin-posted one-time instances), so the view shows both
  // and the model gives an instance precedence over a rule for the same person-day.
  const materialized = useMemo(
    () => new Set(shifts.filter((s) => s.source_rule_id).map((s) => `${s.source_rule_id}|${s.date}`)),
    [shifts],
  );
  const generated = useMemo(
    () => generateRecurringShifts(rules, exceptions, grid.gridStart, grid.gridEnd, materialized),
    [rules, exceptions, grid.gridStart, grid.gridEnd, materialized],
  );
  const scheduled: CalScheduled[] = useMemo(() => {
    const out: CalScheduled[] = [];
    for (const i of instances) {
      // A released shift has no assignee and a cancelled/missed one is not coverage.
      if (!i.employee_id || i.released_at) continue;
      if (i.status !== 'scheduled' && i.status !== 'claimed' && i.status !== 'worked') continue;
      out.push({
        id: i.id,
        employee_id: i.employee_id,
        date: i.shift_date,
        start_time: laWallClockOf(i.starts_at).time,
        end_time: laWallClockOf(i.ends_at).time,
        origin: 'instance',
      });
    }
    for (const g of generated) {
      if (g.skipped) continue;
      out.push({
        id: g.id, employee_id: g.employee_id, date: g.date,
        start_time: g.start_time, end_time: g.end_time, origin: 'rule',
      });
    }
    return out;
  }, [instances, generated]);

  const byDate = useMemo(
    () => buildCalendarDays({
      employees: employees.map((e) => ({ id: e.id, name: e.name, role: e.role })),
      punches, scheduled, days: grid.days, view, todayISO: today, roleFilter,
    }),
    [employees, punches, scheduled, grid.days, view, today, roleFilter],
  );
  const peak = useMemo(() => maxHeadcount(byDate), [byDate]);

  // Editing a punch reuses ShiftEditorModal, which prefills from the punch INSTANTS
  // (shiftEditPrefill). Build its cards from the same rows with the shared indexer so the editor
  // can never open at a different basis than the calendar displays.
  const cardById = useMemo(() => {
    const m = new Map<string, WeekShiftCard>();
    for (const arr of indexWeekCards(shifts, [], new Set(grid.days)).values()) {
      for (const c of arr) m.set(c.id, c);
    }
    return m;
  }, [shifts, grid.days]);

  const openEditor = (shiftId: string) => {
    const card = cardById.get(shiftId);
    if (card) setEditorIntent({ mode: 'card', card });
  };

  const nameById = useMemo(() => {
    const m = new Map(employees.map((e) => [e.id, e.name]));
    return (id: string) => m.get(id) || 'Unknown';
  }, [employees]);
  const handlers = useMemo(
    () => makeEditorHandlers({ employees, nameById, addShift, updateShift, deleteShift, upsertException }),
    [employees, nameById, addShift, updateShift, deleteShift, upsertException],
  );

  const isThisMonth = anchor === startOfMonthISO(today);
  const openDay = openDate ? byDate.get(openDate) ?? null : null;

  const monthPending = useMemo(() => {
    let n = 0;
    for (const d of byDate.values()) if (isInMonth(d.date, anchor)) n += d.pendingCount;
    return n;
  }, [byDate, anchor]);

  async function handleConfirm(shiftId: string, confirmed: boolean) {
    await confirmShift.mutateAsync({ id: shiftId, confirmed });
  }

  // PLAN. Writes shift_instances via the admin route — non-payable, and what the personal
  // clock-in links validate against. One row per selected person.
  async function createScheduled(employeeIds: string[], startTime: string, endTime: string) {
    const roleById = new Map(employees.map((e) => [e.id, e.role]));
    for (const employeeId of employeeIds) {
      const res = await fetch('/api/admin/schedule/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: addOnDate, startTime, endTime, employeeId, role: roleById.get(employeeId) ?? null }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? 'Could not post the scheduled shift.');
      }
    }
    await qc.invalidateQueries({ queryKey: ['shift_instances'] });
  }

  // PAYABLE. Writes a `shifts` row — the same thing a punch produces, so only for corrections.
  async function createWorked(employeeIds: string[], startTime: string, endTime: string | null) {
    for (const employee_id of employeeIds) {
      await addShift.mutateAsync({ employee_id, date: addOnDate as string, start_time: startTime, end_time: endTime });
    }
  }

  return (
    <div className="space-y-3">
      {/* Controls: month nav · view · role */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-2">
          <button
            type="button" onClick={() => setAnchor(addMonthsISO(anchor, -1))} aria-label="Previous month"
            className="h-8 w-8 rounded-lg border border-tt-border text-tt-muted transition-colors hover:bg-tt-card-hover hover:text-tt-text"
          >←</button>
          <button
            type="button" onClick={() => setAnchor(startOfMonthISO(today))} disabled={isThisMonth}
            className={`h-8 rounded-lg border px-3 text-xs font-semibold transition-colors ${
              isThisMonth ? 'cursor-default border-tt-border text-tt-muted/50' : 'border-tt-border text-tt-text hover:bg-tt-card-hover'
            }`}
          >This month</button>
          <button
            type="button" onClick={() => setAnchor(addMonthsISO(anchor, 1))} aria-label="Next month"
            className="h-8 w-8 rounded-lg border border-tt-border text-tt-muted transition-colors hover:bg-tt-card-hover hover:text-tt-text"
          >→</button>
          <span className="ml-1 text-sm font-medium text-tt-text">{monthTitle(anchor)}</span>
          {monthPending > 0 && (
            <button
              type="button"
              onClick={() => setShowPending(true)}
              title="Review everything awaiting confirmation"
              className="rounded-full bg-tt-yellow/15 px-2.5 py-0.5 text-[10px] font-bold text-tt-yellow transition-colors hover:bg-tt-yellow/25"
            >
              {monthPending} to confirm
            </button>
          )}
          {timeOffPending.length > 0 && (
            <button
              type="button"
              onClick={() => setShowTimeOff(true)}
              title="Review time-off requests"
              className="rounded-full bg-tt-cyan/15 px-2.5 py-0.5 text-[10px] font-bold text-tt-cyan transition-colors hover:bg-tt-cyan/25"
            >
              {timeOffPending.length} time-off
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div className="flex gap-1 rounded-lg bg-white/5 p-0.5" role="group" aria-label="Calendar contents">
            {VIEWS.map((v) => (
              <button
                key={v.key} type="button" onClick={() => setView(v.key)} aria-pressed={view === v.key}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                  view === v.key ? 'bg-white/10 text-tt-text' : 'text-tt-muted hover:text-tt-text'
                }`}
              >{v.label}</button>
            ))}
          </div>
          <RoleFilter value={roleFilter} onChange={setRoleFilter} />
        </div>
      </div>

      <MonthGridView
        days={grid.days}
        byDate={byDate}
        anchor={anchor}
        todayISO={today}
        payAnchor={PAY_ANCHOR}
        peak={peak}
        onOpenDay={setOpenDate}
        onAddDay={setAddOnDate}
      />

      {/* Mobile agenda — same model, days with people only */}
      <div className="space-y-2 md:hidden">
        {grid.days.filter((d) => isInMonth(d, anchor) && (byDate.get(d)?.headcount ?? 0) > 0).map((d) => {
          const cell = byDate.get(d)!;
          return (
            <button
              key={d} type="button" onClick={() => setOpenDate(d)}
              className="flex w-full items-center gap-3 rounded-xl border border-tt-border bg-tt-card p-3 text-left"
            >
              <span className="w-10 shrink-0 text-center">
                <span className={`block text-lg font-bold tabular-nums ${d === today ? 'text-tt-cyan' : 'text-tt-text'}`}>{dayNum(d)}</span>
                <span className="block text-[9px] uppercase text-tt-muted">{WEEKDAY_LABELS[(grid.days.indexOf(d)) % 7]}</span>
              </span>
              <span className="flex flex-1 flex-wrap gap-1">
                {cell.people.slice(0, MAX_AVATARS).map((p) => (
                  <PersonAvatar key={`${p.employee_id}|${p.punch?.id ?? p.scheduled?.id ?? 'x'}`} name={p.name} state={p.state} size="sm" />
                ))}
                {cell.headcount > MAX_AVATARS && (
                  <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-white/10 text-[9px] font-bold text-tt-muted">
                    +{cell.headcount - MAX_AVATARS}
                  </span>
                )}
              </span>
              {cell.pendingCount > 0 && (
                <span className="shrink-0 rounded bg-tt-yellow/20 px-1.5 py-0.5 text-[10px] font-bold text-tt-yellow">{cell.pendingCount}!</span>
              )}
            </button>
          );
        })}
      </div>

      {openDay && (
        <DayPeopleModal
          day={openDay}
          dateLabel={fullDateLabel(openDay.date)}
          onClose={() => setOpenDate(null)}
          onConfirm={handleConfirm}
          onEdit={openEditor}
          onAddShift={setAddOnDate}
        />
      )}

      {addOnDate && (
        <DayAddShiftModal
          dateLabel={fullDateLabel(addOnDate)}
          employees={employees}
          onClose={() => setAddOnDate(null)}
          onCreateScheduled={createScheduled}
          onCreateWorked={createWorked}
        />
      )}

      {showTimeOff && (
        <TimeOffQueue
          rows={timeOffRows}
          employees={employees}
          onClose={() => setShowTimeOff(false)}
          onChanged={reloadTimeOff}
        />
      )}

      {showPending && (
        <PendingConfirmModal
          byDate={byDate}
          monthLabel={monthTitle(anchor)}
          onClose={() => setShowPending(false)}
          onConfirm={handleConfirm}
          onEdit={openEditor}
        />
      )}

      {editorIntent && (
        <ShiftEditorModal intent={editorIntent} handlers={handlers} onClose={() => setEditorIntent(null)} />
      )}
    </div>
  );
}
