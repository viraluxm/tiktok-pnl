'use client';

import { useMemo, useState } from 'react';
import type { Employee } from '@/types';
import { useShiftInstances } from '@/hooks/useShiftInstances';
import { useScheduleBulk, ScheduleRefusedError } from '@/hooks/useScheduleBulk';
import { laTodayISO, addDaysISO } from '@/lib/schedule/timezone';
import { fmtMonthDay } from '@/lib/schedule/format';
import {
  weekDatesFor, weekStateFromInstances, copyWeekPattern, weekStateIsEmpty, expandRepeat,
  repeatCountUntil, EMPTY_DAY, type WeekState, type DayState, type ExistingInstance, type ScheduleCounts,
} from '@/lib/schedule/schedulePlan';
import { validateShiftTimes, WEEKDAY_LABELS } from '@/lib/weeklySchedule';

// One employee, one week, real dated shift_instances. Opened from the roster's employee detail as
// "Build Schedule" / "Edit Schedule" — same component either way; the only difference is whether
// the week already has rows.
//
// STATE MODEL: the week the manager sees is `base` (what the database has right now, re-derived
// whenever the query refreshes) with `edits` layered on top. Nothing is written until Save, and
// Save sends the WHOLE visible week — every day, working or off — so the server acts on explicit
// intent for each date rather than on whatever happened to be in a half-loaded client. Later
// repeat weeks send working days only (see expandRepeat). Past days are shown, never sent.

type RepeatChoice = 'this' | '2' | '4' | 'until';

const inputCls =
  'rounded-xl border border-tt-input-border bg-tt-input-bg px-3 py-2 text-sm text-tt-text focus:border-tt-cyan focus:outline-none disabled:opacity-40';

function possessive(name: string): string {
  return name.endsWith('s') ? `${name}’` : `${name}’s`;
}

function dayLabel(dateISO: string): string {
  const [y, m, d] = dateISO.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' })
    .format(new Date(Date.UTC(y, m - 1, d)));
}

export default function EmployeeScheduleBuilder({
  employee,
  initialDate,
  onClose,
  onSaved,
}: {
  employee: Employee;
  /** Any date inside the week to open on. Defaults to the current LA week. */
  initialDate?: string;
  onClose: () => void;
  onSaved?: (counts: ScheduleCounts, weekCount: number) => void;
}) {
  const today = useMemo(() => laTodayISO(), []);
  const [weekStart, setWeekStart] = useState<string>(() => weekDatesFor(initialDate ?? today)[0]);
  const week = useMemo(() => weekDatesFor(weekStart), [weekStart]);
  const prevWeek = useMemo(() => weekDatesFor(addDaysISO(weekStart, -7)), [weekStart]);

  const { instances, isLoading } = useShiftInstances(week[0], week[6]);
  const { instances: prevInstances, isLoading: prevLoading } = useShiftInstances(prevWeek[0], prevWeek[6]);
  const { apply } = useScheduleBulk();

  const mine = useMemo(
    () => instances.filter((i) => i.employee_id === employee.id) as ExistingInstance[],
    [instances, employee.id],
  );
  const prevMine = useMemo(
    () => prevInstances.filter((i) => i.employee_id === employee.id) as ExistingInstance[],
    [prevInstances, employee.id],
  );

  const base = useMemo(() => weekStateFromInstances(mine, week), [mine, week]);
  const [edits, setEdits] = useState<Partial<WeekState>>({});
  const state: WeekState = useMemo(() => {
    const s: WeekState = {};
    for (const d of week) s[d] = edits[d] ?? base[d] ?? { ...EMPTY_DAY };
    return s;
  }, [week, base, edits]);
  const dirty = Object.keys(edits).length > 0;

  // Quick fill: one set of hours onto several days at once.
  const [qDays, setQDays] = useState<Set<string>>(new Set());
  const [qStart, setQStart] = useState('');
  const [qEnd, setQEnd] = useState('');

  const [repeat, setRepeat] = useState<RepeatChoice>('this');
  const [untilDate, setUntilDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isPast = (d: string) => d < today;
  const wholeWeekPast = week.every(isPast);
  const isThisWeek = weekStart === weekDatesFor(today)[0];

  function setDay(date: string, patch: Partial<DayState>) {
    setEdits((prev) => ({ ...prev, [date]: { ...(prev[date] ?? base[date] ?? EMPTY_DAY), ...patch } }));
    setNotice(null);
  }

  function goToWeek(nextStart: string) {
    if (dirty && !window.confirm('Discard unsaved changes to this week?')) return;
    setEdits({});
    setQDays(new Set());
    setError(null);
    setNotice(null);
    setWeekStart(nextStart);
  }

  function applyQuickFill() {
    setError(null);
    const check = validateShiftTimes(qStart, qEnd);
    if (!check.ok) return setError(check.error);
    const targets = week.filter((d) => qDays.has(d) && !isPast(d));
    if (targets.length === 0) return setError('Pick at least one day to apply these hours to.');
    setEdits((prev) => {
      const next = { ...prev };
      for (const d of targets) next[d] = { working: true, start: qStart, end: qEnd };
      return next;
    });
    setNotice(null);
  }

  function copyPreviousWeek() {
    setError(null);
    if (prevLoading) return;
    if (weekStateIsEmpty(weekStateFromInstances(prevMine, prevWeek))) {
      setNotice('Nothing was scheduled last week to copy.');
      return;
    }
    const copied = copyWeekPattern(prevMine, prevWeek, week);
    setEdits((prev) => {
      const next = { ...prev };
      for (const d of week) if (!isPast(d)) next[d] = copied[d];
      return next;
    });
    setNotice('Copied last week’s pattern — adjust anything, then Save Schedule.');
  }

  const weekCount =
    repeat === 'this' ? 1 : repeat === '2' ? 2 : repeat === '4' ? 4 : untilDate ? repeatCountUntil(weekStart, untilDate) : 1;

  async function save() {
    setError(null);
    setNotice(null);
    // Client-side completeness: every working day in the visible week needs valid times.
    for (const d of week) {
      const s = state[d];
      if (isPast(d) || !s.working) continue;
      const check = validateShiftTimes(s.start, s.end);
      if (!check.ok) return setError(`${WEEKDAY_LABELS[week.indexOf(d)]}: ${check.error}`);
    }
    if (repeat === 'until' && !untilDate) return setError('Choose the last week to repeat until.');

    const entries = expandRepeat(employee.id, weekStart, state, weekCount, today);
    if (entries.length === 0) return setError('Nothing to save for this week.');

    setBusy(true);
    try {
      if (weekCount > 1) {
        // Later weeks were never on screen, so preview what the repeat would change there.
        const dry = await apply.mutateAsync({ entries, dryRun: true });
        if (dry.updated > 0 || dry.removed > 0) {
          const parts = [
            dry.updated > 0 ? `update ${dry.updated} existing shift${dry.updated === 1 ? '' : 's'}` : null,
            dry.removed > 0 ? `remove ${dry.removed}` : null,
          ].filter(Boolean).join(' and ');
          if (!window.confirm(`Repeating for ${weekCount} weeks will ${parts}. Continue?`)) {
            setBusy(false);
            return;
          }
        }
      }
      const result = await apply.mutateAsync({ entries });
      onSaved?.(result, weekCount);
      onClose();
    } catch (e) {
      setError(e instanceof ScheduleRefusedError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const workingCount = week.filter((d) => state[d].working && !isPast(d)).length;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm sm:p-8"
      onClick={onClose} role="dialog" aria-modal="true" aria-label={`${possessive(employee.name)} schedule`}
    >
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-2xl rounded-[16px] border border-tt-border bg-tt-card p-5 shadow-2xl backdrop-blur-xl">
        {/* Header */}
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-tt-text">{possessive(employee.name)} Schedule</h3>
            <p className="mt-0.5 text-xs text-tt-muted">Working days become real shifts on their schedule. Nothing here affects pay.</p>
          </div>
          <button
            type="button" onClick={onClose} aria-label="Close"
            className="h-8 w-8 shrink-0 rounded-lg border border-tt-border text-tt-muted transition-colors hover:bg-tt-card-hover hover:text-tt-text"
          >✕</button>
        </div>

        {/* Week nav */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button" onClick={() => goToWeek(addDaysISO(weekStart, -7))} aria-label="Previous week"
              className="h-8 w-8 rounded-lg border border-tt-border text-tt-muted transition-colors hover:bg-tt-card-hover hover:text-tt-text"
            >←</button>
            <span className="text-sm font-medium text-tt-text">Week of {fmtMonthDay(week[0])} – {fmtMonthDay(week[6])}</span>
            <button
              type="button" onClick={() => goToWeek(addDaysISO(weekStart, 7))} aria-label="Next week"
              className="h-8 w-8 rounded-lg border border-tt-border text-tt-muted transition-colors hover:bg-tt-card-hover hover:text-tt-text"
            >→</button>
          </div>
          <button
            type="button" onClick={() => goToWeek(weekDatesFor(today)[0])} disabled={isThisWeek}
            className={`h-8 rounded-lg border px-3 text-xs font-semibold transition-colors ${
              isThisWeek ? 'cursor-default border-tt-border text-tt-muted/50' : 'border-tt-border text-tt-text hover:bg-tt-card-hover'
            }`}
          >This week</button>
        </div>

        {/* Quick fill */}
        <div className="mb-4 rounded-xl border border-tt-border bg-white/[0.02] p-3">
          <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-tt-muted">Same hours on several days</div>
          <div className="mb-2 flex flex-wrap gap-1.5" role="group" aria-label="Days to apply hours to">
            {week.map((d, k) => {
              const on = qDays.has(d);
              const past = isPast(d);
              return (
                <button
                  key={d} type="button" disabled={past} aria-pressed={on}
                  onClick={() => setQDays((prev) => { const n = new Set(prev); if (n.has(d)) n.delete(d); else n.add(d); return n; })}
                  className={`h-8 min-w-[44px] rounded-lg border px-2 text-xs font-semibold transition-colors disabled:opacity-30 ${
                    on ? 'border-tt-cyan bg-tt-cyan/15 text-tt-cyan' : 'border-tt-border text-tt-muted hover:text-tt-text'
                  }`}
                >{WEEKDAY_LABELS[k]}</button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="block">
              <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-tt-muted">Start</span>
              <input type="time" value={qStart} onChange={(e) => setQStart(e.target.value)} className={inputCls} />
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-tt-muted">End</span>
              <input type="time" value={qEnd} onChange={(e) => setQEnd(e.target.value)} className={inputCls} />
            </label>
            <button
              type="button" onClick={applyQuickFill} disabled={wholeWeekPast}
              className="h-[38px] rounded-xl bg-white/5 px-3 text-sm font-semibold text-tt-text transition-colors hover:bg-white/10 disabled:opacity-40"
            >Apply to selected days</button>
          </div>
        </div>

        {/* The week */}
        <div className="mb-4 divide-y divide-[rgba(255,255,255,0.05)] rounded-xl border border-tt-border">
          {week.map((d, k) => {
            const s = state[d];
            const past = isPast(d);
            const check = s.working && s.start && s.end ? validateShiftTimes(s.start, s.end) : null;
            return (
              <div key={d} className={`grid grid-cols-[minmax(84px,1fr)_auto_1fr_1fr] items-center gap-2 px-3 py-2 ${past ? 'opacity-50' : ''}`}>
                <div>
                  <div className={`text-sm font-semibold ${d === today ? 'text-tt-cyan' : 'text-tt-text'}`}>{WEEKDAY_LABELS[k]}</div>
                  <div className="text-[11px] text-tt-muted">{dayLabel(d)}{past ? ' · past' : d === today ? ' · today' : ''}</div>
                </div>
                <button
                  type="button" disabled={past || isLoading} aria-pressed={s.working}
                  onClick={() => setDay(d, { working: !s.working })}
                  className={`h-8 rounded-lg border px-2.5 text-xs font-semibold transition-colors disabled:cursor-default ${
                    s.working ? 'border-tt-green/60 bg-tt-green/15 text-tt-green' : 'border-tt-border text-tt-muted hover:text-tt-text'
                  }`}
                >{s.working ? 'Working' : 'Off'}</button>
                <input
                  type="time" value={s.start} disabled={past || !s.working} aria-label={`${WEEKDAY_LABELS[k]} start`}
                  onChange={(e) => setDay(d, { start: e.target.value })} className={inputCls}
                />
                <div className="flex items-center gap-2">
                  <input
                    type="time" value={s.end} disabled={past || !s.working} aria-label={`${WEEKDAY_LABELS[k]} end`}
                    onChange={(e) => setDay(d, { end: e.target.value })} className={`${inputCls} w-full`}
                  />
                  {check && !check.error && (
                    <span className="hidden shrink-0 text-[11px] tabular-nums text-tt-muted sm:inline" title={check.overnight ? 'Ends the next day' : undefined}>
                      {check.hours}h{check.overnight ? ' 🌙' : ''}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Repeat + copy */}
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="block">
              <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-tt-muted">Repeat</span>
              <select value={repeat} onChange={(e) => setRepeat(e.target.value as RepeatChoice)} className={inputCls}>
                <option value="this">This week only</option>
                <option value="2">2 weeks</option>
                <option value="4">4 weeks</option>
                <option value="until">Until a date…</option>
              </select>
            </label>
            {repeat === 'until' && (
              <label className="block">
                <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-tt-muted">Last week to include</span>
                <input type="date" value={untilDate} min={week[6]} onChange={(e) => setUntilDate(e.target.value)} className={inputCls} />
              </label>
            )}
            {weekCount > 1 && (
              <span className="pb-2 text-[11px] text-tt-muted">
                {weekCount} weeks · same days and hours. Other days in later weeks are left as they are.
              </span>
            )}
          </div>
          <button
            type="button" onClick={copyPreviousWeek} disabled={prevLoading || wholeWeekPast}
            className="h-[38px] rounded-xl bg-white/5 px-3 text-sm font-semibold text-tt-text transition-colors hover:bg-white/10 disabled:opacity-40"
          >Copy Previous Week</button>
        </div>

        {isLoading && <p className="mb-3 text-[11px] text-tt-muted">Loading this week…</p>}
        {notice && <p className="mb-3 rounded-lg bg-white/[0.03] px-3 py-2 text-[11px] text-tt-muted">{notice}</p>}
        {error && <p className="mb-3 rounded-lg bg-tt-red/10 px-3 py-2 text-[11px] text-tt-red">{error}</p>}
        {wholeWeekPast && <p className="mb-3 text-[11px] text-tt-muted">This week has already passed — it is shown for reference only.</p>}

        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-tt-muted tabular-nums">
            {workingCount === 0 ? 'No working days' : `${workingCount} working day${workingCount === 1 ? '' : 's'}`}
            {dirty ? ' · unsaved' : ''}
          </span>
          <div className="flex gap-2">
            <button
              type="button" onClick={onClose}
              className="rounded-xl bg-white/5 px-4 py-2.5 text-sm font-semibold text-tt-muted transition-colors hover:bg-white/10 hover:text-tt-text"
            >Cancel</button>
            <button
              type="button" onClick={save} disabled={busy || isLoading || wholeWeekPast}
              className="rounded-xl bg-tt-cyan px-4 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-tt-cyan/90 disabled:opacity-50"
            >{busy ? 'Saving…' : 'Save Schedule'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
