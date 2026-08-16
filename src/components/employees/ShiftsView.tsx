'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { paidShiftHours, generateRecurringShifts } from '@/lib/employees';
import { confirmErrorMessage, clockErrorToken } from '@/lib/timeclock';
import { enterFullscreen } from '@/lib/fullscreen';
import { useShifts } from '@/hooks/useShifts';
import { useShiftRules } from '@/hooks/useShiftRules';
import { useShiftInstances } from '@/hooks/useShiftInstances';
import { useHostLiveHours } from '@/hooks/useHostLiveHours';
import { resolveScheduledSpan, employeeHasActiveRules, scheduleAppliesToDate } from '@/lib/schedule/scheduledSpan';
import { computeConfirmFlags, IMPLAUSIBLE_SPAN_HOURS } from '@/lib/schedule/confirmFlags';
import { liveHoursForHostDate, formatLiveHours } from '@/lib/schedule/liveHours';
import type { Employee, Shift, ShiftRule, ShiftSource } from '@/types';
import CalendarView from './weekly/CalendarView';
import { Field, WEEKDAYS, daysLabel, inputCls } from './shared';
import MobileDataCard from '@/components/ui/MobileDataCard';

// The production Shifts view: an Add Shift card (One-off / Recurring), a Recurring Rules
// table, and a "Shifts This Period" list — all under a List / Calendar toggle. This is
// restored ~verbatim from origin/main; the ONLY change is that the Calendar branch now
// renders the new interactive weekly employee grid (WeeklyShiftView) instead of the old
// read-only ShiftCalendar. Both List and Calendar drive the SAME hooks/mutations.
//
// Self-contained (owns its own data hooks) so it fetches only when the Shifts tab is
// mounted — opening Team on the default Roster tab no longer loads shift history. The List
// still loads the dashboard FiltersBar range; the Calendar loads only its selected week.

type DisplayRow =
  | {
      kind: 'oneoff';
      id: string;
      employee_id: string;
      date: string;
      start_time: string;
      end_time: string | null;
      source: ShiftSource;
      confirmed_at: string | null;
      break_minutes: number;
      // Real punch instants (migration 072) — carried so paidShiftHours uses the TRUE span, not the
      // 24h-wrapping wall clock. Load-bearing for the over-span confirm flag (a 34h forgotten
      // clock-out must read as 34h, not a wrapped 10h). NULL on manual/recurring shifts.
      clock_in_at: string | null;
      clock_out_at: string | null;
      // migration 072: reconciler stamped a capped clock-out on a forgotten/over-long punch.
      // The hours shown are a POLICY DEFAULT, not measured — surface loudly + gate confirm.
      auto_closed: boolean;
    }
  | {
      kind: 'recurring';
      id: string;
      rule_id: string;
      employee_id: string;
      date: string;
      start_time: string;
      end_time: string;
      modified: boolean;
      skipped: boolean;
    };

export default function ShiftsView({
  employees,
  dateFrom,
  dateTo,
}: {
  employees: Employee[];
  dateFrom: string | null;
  dateTo: string | null;
}) {
  const { shifts, openShifts, isLoading: shiftsLoading, addShift, endShift, deleteShift, confirmShift } = useShifts(dateFrom, dateTo);
  const router = useRouter();
  const {
    rules,
    exceptions,
    isLoading: rulesLoading,
    addRule,
    toggleRuleActive,
    deleteRule,
    upsertException,
    deleteException,
  } = useShiftRules();

  // (rule|date) pairs already frozen into real `shifts` rows (source_rule_id set) — the
  // generator excludes these so a materialized day is counted once. See migration 055.
  const materialized = useMemo(
    () => new Set(shifts.filter((s) => s.source_rule_id).map((s) => `${s.source_rule_id}|${s.date}`)),
    [shifts],
  );
  const generated = useMemo(
    () => generateRecurringShifts(rules, exceptions, dateFrom, dateTo, materialized),
    [rules, exceptions, dateFrom, dateTo, materialized],
  );
  const isLoading = shiftsLoading || rulesLoading;

  // Count of time-clock shifts in this period awaiting a manager's confirmation (they are
  // excluded from Pay until confirmed). Drives the review banner + is a quick "todo" signal.
  const timeClockPending = useMemo(
    () => shifts.filter((s) => s.source === 'time_clock' && s.confirmed_at == null).length,
    [shifts],
  );

  // Confirm-time validation inputs (display/review only — never pay): schedule instances for span
  // precedence #1, and live-session intervals for the host live-hours column.
  const { instances } = useShiftInstances(dateFrom, dateTo);
  const { sessions: liveSessions } = useHostLiveHours();

  // Data-completeness (NOT a per-shift flag): employees who have punches but NO active rule at all.
  // Per the refinement, these are surfaced ONCE here rather than flagging every shift they work.
  const unscheduledPunchers = useMemo(() => {
    const punchers = new Set(shifts.filter((s) => s.source === 'time_clock').map((s) => s.employee_id));
    const nameById = new Map(employees.map((e) => [e.id, e.name]));
    return [...punchers].filter((id) => !employeeHasActiveRules(id, rules)).map((id) => nameById.get(id) || 'Unknown');
  }, [shifts, rules, employees]);

  const [mode, setMode] = useState<'oneoff' | 'recurring'>('oneoff');
  // Default to the Calendar view (the new interactive weekly grid). List remains a toggle.
  const [view, setView] = useState<'list' | 'calendar'>('calendar');

  // One-off form
  const [employeeId, setEmployeeId] = useState('');
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [currentlyInShift, setCurrentlyInShift] = useState(false);

  const [endingShift, setEndingShift] = useState<
    { id: string; name: string; date: string; start_time: string; end_time: string } | null
  >(null);

  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Recurring form
  const [rEmployeeId, setREmployeeId] = useState('');
  const [rDays, setRDays] = useState<Set<number>>(new Set());
  const [rStart, setRStart] = useState('');
  const [rEnd, setREnd] = useState('');
  const [rStartDate, setRStartDate] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState<
    { ruleId: string; date: string; name: string; start: string; end: string } | null
  >(null);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of employees) m.set(e.id, e.name);
    return m;
  }, [employees]);
  const roleById = useMemo(() => new Map(employees.map((e) => [e.id, e.role])), [employees]);

  // Host live-session hours beside clocked hours (host time-clock rows only). Four data states —
  // known / insufficient / not-attributed / zero — so an attribution gap never reads as 0 worked.
  function hostLiveLabel(row: DisplayRow): string | null {
    if (row.kind !== 'oneoff' || row.source !== 'time_clock') return null;
    if ((roleById.get(row.employee_id) ?? '').toLowerCase() !== 'host') return null;
    return formatLiveHours(liveHoursForHostDate(liveSessions, row.employee_id, row.date));
  }

  // Only non-former employees can be picked for new shifts / rules.
  const selectable = useMemo(() => employees.filter((e) => e.status !== 'former'), [employees]);

  const openByEmployee = useMemo(() => {
    const m = new Set<string>();
    for (const s of openShifts) m.add(s.employee_id);
    return m;
  }, [openShifts]);

  const rows = useMemo<DisplayRow[]>(() => {
    const oneoffById = new Map<string, Shift>();
    for (const s of [...shifts, ...openShifts]) oneoffById.set(s.id, s);
    const combined: DisplayRow[] = [
      ...[...oneoffById.values()].map(
        (s): DisplayRow => ({
          kind: 'oneoff',
          id: s.id,
          employee_id: s.employee_id,
          date: s.date,
          start_time: s.start_time,
          end_time: s.end_time,
          source: s.source,
          confirmed_at: s.confirmed_at,
          break_minutes: s.break_minutes,
          clock_in_at: s.clock_in_at ?? null,
          clock_out_at: s.clock_out_at ?? null,
          auto_closed: s.auto_closed ?? false,
        }),
      ),
      ...generated.map(
        (g): DisplayRow => ({
          kind: 'recurring',
          id: g.id,
          rule_id: g.rule_id,
          employee_id: g.employee_id,
          date: g.date,
          start_time: g.start_time,
          end_time: g.end_time,
          modified: g.modified,
          skipped: g.skipped,
        }),
      ),
    ];
    return combined.sort((a, b) => b.date.localeCompare(a.date) || a.start_time.localeCompare(b.start_time));
  }, [shifts, openShifts, generated]);

  function toggleDay(v: number) {
    setRDays((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  }

  function minsOf(t: string): number {
    const [h, m] = t.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  }

  async function handleAddOneOff() {
    if (!employeeId || !date || !startTime || (!currentlyInShift && !endTime)) {
      setError(
        currentlyInShift
          ? 'Employee, date and start time are required'
          : 'Employee, date, start and end time are all required',
      );
      return;
    }
    // Reject a zero-length shift (end == start); end < start is a valid overnight shift.
    if (!currentlyInShift && minsOf(startTime) === minsOf(endTime)) {
      setError('Start and end time cannot be the same.');
      return;
    }
    if (currentlyInShift && openByEmployee.has(employeeId)) {
      setError(`${nameById.get(employeeId) || 'This person'} already has an open shift — end it first.`);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await addShift.mutateAsync({
        employee_id: employeeId,
        date,
        start_time: startTime,
        end_time: currentlyInShift ? null : endTime,
      });
      setDate('');
      setStartTime('');
      setEndTime('');
      setCurrentlyInShift(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  function elapsedLabel(dateStr: string, start: string): string {
    const startMs = new Date(`${dateStr}T${start}`).getTime();
    if (!Number.isFinite(startMs)) return '—';
    const mins = Math.max(0, Math.floor((nowTick - startMs) / 60000));
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  async function saveEndShift() {
    if (!endingShift) return;
    if (!endingShift.end_time) {
      alert('End time is required');
      return;
    }
    if (minsOf(endingShift.end_time) === minsOf(endingShift.start_time)) {
      alert('End time must be different from the start time.');
      return;
    }
    try {
      await endShift.mutateAsync({
        id: endingShift.id,
        end_time: endingShift.end_time.length === 5 ? `${endingShift.end_time}:00` : endingShift.end_time,
      });
      setEndingShift(null);
    } catch (err) {
      alert((err as Error).message);
    }
  }

  async function handleAddRule() {
    if (!rEmployeeId || rDays.size === 0 || !rStart || !rEnd || !rStartDate) {
      setError('Employee, at least one weekday, start/end time and a start date are required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await addRule.mutateAsync({
        employee_id: rEmployeeId,
        days_of_week: [...rDays].sort((a, b) => a - b),
        start_time: rStart,
        end_time: rEnd,
        start_date: rStartDate,
      });
      setRDays(new Set());
      setRStart('');
      setREnd('');
      setRStartDate('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSkip(row: Extract<DisplayRow, { kind: 'recurring' }>) {
    if (!confirm(`Skip this recurring shift on ${row.date}? The rule keeps generating other days.`)) return;
    try {
      await upsertException.mutateAsync({ rule_id: row.rule_id, date: row.date, type: 'skip' });
    } catch (err) {
      alert((err as Error).message);
    }
  }

  async function handleClear(row: Extract<DisplayRow, { kind: 'recurring' }>) {
    try {
      await deleteException.mutateAsync({ rule_id: row.rule_id, date: row.date });
    } catch (err) {
      alert((err as Error).message);
    }
  }

  async function handleDeleteRule(rule: ShiftRule) {
    if (!confirm('Delete this recurring rule? Future shifts stop generating. Past pay already calculated is unaffected, and one-off shifts are untouched.')) return;
    try {
      await deleteRule.mutateAsync(rule.id);
    } catch (err) {
      alert((err as Error).message);
    }
  }

  async function handleDeleteOneOff(id: string) {
    try {
      await deleteShift.mutateAsync(id);
    } catch (err) {
      alert((err as Error).message);
    }
  }

  // Enter real browser fullscreen from THIS click gesture, wait for it to settle (granted or
  // denied), THEN navigate — so it's part of the user gesture (not a delayed effect on the
  // destination route, which browsers can reject). Client-side push keeps the same document,
  // so fullscreen persists into the kiosk. If denied, we still navigate (kiosk fallback covers it).
  async function openTimeClock() {
    await enterFullscreen();
    router.push('/dashboard/time-clock');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function handleConfirmShift(row: any, confirmed: boolean) {
    // On CONFIRM, surface review flags in the existing acknowledgement — flag, never block. This
    // reuses the auto-closed window.confirm pattern; nothing here changes pay (confirmation only
    // gates a time_clock shift into Pay; the flags are validation/review).
    if (confirmed) {
      const warnings: string[] = [];

      // Auto-closed: hours are a policy default, not measured (existing behaviour, kept).
      if (row.auto_closed) {
        const hrs = typeof paidShiftHours(row) === 'number' ? paidShiftHours(row).toFixed(2) : '—';
        warnings.push(
          `⚠ Auto-closed at the cap — the ${hrs}h shown is a POLICY DEFAULT, not measured. Correct the finish time on the time entry first if it's wrong.`,
        );
      }

      // Confirm-time validation flags (time-clock shifts only).
      if (row.source === 'time_clock') {
        const scheduled = resolveScheduledSpan({
          employeeId: row.employee_id,
          date: row.date,
          instances,
          rules,
          exceptions,
        });
        const flags = computeConfirmFlags({
          clockedHours: paidShiftHours(row),
          breakMinutes: row.break_minutes ?? 0,
          scheduled,
          employeeHasRules: employeeHasActiveRules(row.employee_id, rules),
          scheduleAppliesToDate: scheduleAppliesToDate(row.employee_id, row.date, rules),
        });

        // HARD BLOCK: an implausible span (>14h) is a forgotten clock-out, never a real shift
        // (the longest legitimate shift here is ~12.6h). Refuse the confirm outright — there is
        // no "confirm anyway" — so a 20–80h span can't be paid. The fix is to correct the
        // clock-out time; until then the shift stays unconfirmed and unpaid. Client-side workflow
        // gate only: the confirm RPC is still callable directly, so this is not a security boundary.
        if (flags.some((f) => f.kind === 'implausible_span')) {
          const hrs = paidShiftHours(row).toFixed(2);
          alert(
            `Can't confirm this shift.\n\n` +
              `Clocked span is ${hrs}h, which exceeds ${IMPLAUSIBLE_SPAN_HOURS}h — almost certainly a ` +
              `forgotten clock-out, not a real shift.\n\n` +
              `Fix: correct the clock-out time on this punch first. Until then the shift stays ` +
              `unconfirmed and is not paid.`,
          );
          return;
        }

        for (const f of flags) warnings.push(`${f.severity === 'warn' ? '⚠' : '•'} ${f.message}`);
      }

      if (warnings.length > 0) {
        const ok = window.confirm(`Review before confirming:\n\n${warnings.join('\n')}\n\nConfirm anyway?`);
        if (!ok) return;
      }
    }
    try {
      await confirmShift.mutateAsync({ id: row.id, confirmed });
    } catch (err) {
      alert(confirmErrorMessage(clockErrorToken(err)));
    }
  }

  async function saveEditing() {
    if (!editing) return;
    if (!editing.start || !editing.end) {
      alert('Start and end time are required');
      return;
    }
    try {
      await upsertException.mutateAsync({
        rule_id: editing.ruleId,
        date: editing.date,
        type: 'modified',
        modified_start: editing.start,
        modified_end: editing.end,
      });
      setEditing(null);
    } catch (err) {
      alert((err as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      {/* Open the full-screen time-clock kiosk + List | Calendar view toggle */}
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={openTimeClock}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-tt-cyan/15 text-tt-cyan hover:bg-tt-cyan/25 transition-colors cursor-pointer"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-tt-cyan" />
          Open Time Clock
        </button>
        <div className="flex gap-1 bg-white/5 rounded-lg p-0.5">
          {(['list', 'calendar'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                view === v ? 'bg-white/10 text-tt-text' : 'text-tt-muted hover:text-tt-text'
              }`}
            >
              {v === 'list' ? 'List' : 'Calendar'}
            </button>
          ))}
        </div>
      </div>

      {timeClockPending > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-tt-yellow/30 bg-tt-yellow/10 px-5 py-4">
          <div className="text-sm text-tt-text">
            <span className="font-semibold">{timeClockPending}</span> time-clock shift{timeClockPending === 1 ? '' : 's'}{' '}
            need{timeClockPending === 1 ? 's' : ''} confirmation.
            <span className="text-tt-muted"> They stay out of Pay until you confirm them.</span>
          </div>
          <button
            onClick={() => setView('list')}
            className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold bg-tt-yellow/20 text-tt-yellow hover:bg-tt-yellow/30 transition-colors"
          >
            Review in list
          </button>
        </div>
      )}

      {/* Data-completeness (not a per-shift flag): employees who punch but have no schedule set. */}
      {unscheduledPunchers.length > 0 && (
        <div className="rounded-[14px] border border-tt-border bg-tt-card/60 px-5 py-3 text-sm text-tt-muted">
          <span className="font-semibold text-tt-text">{unscheduledPunchers.length}</span> employee
          {unscheduledPunchers.length === 1 ? '' : 's'} punch but have no schedule set:{' '}
          <span className="text-tt-text">{unscheduledPunchers.join(', ')}</span>. Add rules so their shifts can be validated.
        </div>
      )}

      {view === 'calendar' ? (
        <CalendarView employees={employees} />
      ) : (
        <>
          {/* Add shift */}
          <div className="bg-tt-card border border-tt-border rounded-[14px] backdrop-blur-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-tt-text">Add Shift</h2>
              <div className="flex gap-1 bg-white/5 rounded-lg p-0.5">
                {(['oneoff', 'recurring'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => { setMode(m); setError(null); }}
                    className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                      mode === m ? 'bg-white/10 text-tt-text' : 'text-tt-muted hover:text-tt-text'
                    }`}
                  >
                    {m === 'oneoff' ? 'One-off' : 'Recurring'}
                  </button>
                ))}
              </div>
            </div>

            {selectable.length === 0 ? (
              <p className="text-sm text-tt-muted">Add an employee first before logging shifts.</p>
            ) : mode === 'oneoff' ? (
              <>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <Field label="Employee">
                    <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className={`${inputCls} appearance-none`}>
                      <option value="" className="bg-tt-card text-tt-muted">Select…</option>
                      {selectable.map((e) => (
                        <option key={e.id} value={e.id} className="bg-tt-card text-tt-text">{e.name}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Date">
                    <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
                  </Field>
                  <Field label="Start">
                    <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className={inputCls} />
                  </Field>
                  <Field label="End">
                    {currentlyInShift ? (
                      <div className={`${inputCls} flex items-center text-tt-muted`}>In progress</div>
                    ) : (
                      <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className={inputCls} />
                    )}
                  </Field>
                </div>
                <label className="mt-3 flex items-center gap-2 cursor-pointer select-none w-fit">
                  <input
                    type="checkbox"
                    checked={currentlyInShift}
                    onChange={(e) => { setCurrentlyInShift(e.target.checked); setError(null); }}
                    className="accent-tt-cyan w-4 h-4"
                  />
                  <span className="text-[13px] text-tt-text">Currently in shift <span className="text-tt-muted">(no end time yet)</span></span>
                </label>
                {error && <p className="text-xs text-tt-red mt-3">{error}</p>}
                <div className="mt-4">
                  <button
                    onClick={handleAddOneOff}
                    disabled={submitting}
                    className="px-4 py-2 rounded-lg bg-gradient-to-r from-tt-cyan to-[#4db8c0] text-black text-[13px] font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    {submitting ? 'Adding…' : currentlyInShift ? '+ Start Shift' : '+ Add Shift'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <Field label="Employee">
                    <select value={rEmployeeId} onChange={(e) => setREmployeeId(e.target.value)} className={`${inputCls} appearance-none`}>
                      <option value="" className="bg-tt-card text-tt-muted">Select…</option>
                      {selectable.map((e) => (
                        <option key={e.id} value={e.id} className="bg-tt-card text-tt-text">{e.name}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Start Date">
                    <input type="date" value={rStartDate} onChange={(e) => setRStartDate(e.target.value)} className={inputCls} />
                  </Field>
                  <Field label="Start">
                    <input type="time" value={rStart} onChange={(e) => setRStart(e.target.value)} className={inputCls} />
                  </Field>
                  <Field label="End">
                    <input type="time" value={rEnd} onChange={(e) => setREnd(e.target.value)} className={inputCls} />
                  </Field>
                </div>
                <div className="mt-4">
                  <label className="text-[11px] text-tt-muted uppercase tracking-wide block mb-2">Repeats on</label>
                  <div className="flex flex-wrap gap-2">
                    {WEEKDAYS.map((d) => {
                      const on = rDays.has(d.value);
                      return (
                        <button
                          key={d.value}
                          type="button"
                          onClick={() => toggleDay(d.value)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                            on ? 'bg-tt-cyan text-black' : 'bg-white/5 text-tt-muted hover:text-tt-text'
                          }`}
                        >
                          {d.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {error && <p className="text-xs text-tt-red mt-3">{error}</p>}
                <div className="mt-4">
                  <button
                    onClick={handleAddRule}
                    disabled={submitting}
                    className="px-4 py-2 rounded-lg bg-gradient-to-r from-tt-cyan to-[#4db8c0] text-black text-[13px] font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    {submitting ? 'Adding…' : '+ Add Recurring Shift'}
                  </button>
                </div>
              </>
            )}
          </div>

          {/* Recurring rules */}
          {rules.length > 0 && (
            <div className="bg-tt-card border border-tt-border rounded-[14px] backdrop-blur-xl overflow-hidden">
              <div className="px-6 py-5 border-b border-tt-border">
                <h2 className="text-base font-semibold text-tt-text">Recurring Rules</h2>
                <p className="text-xs text-tt-muted mt-1">Deleting a rule stops future generation. Past pay already calculated is unaffected; one-off shifts are untouched.</p>
              </div>
              {/* Desktop / tablet table */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b border-tt-border">
                      <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Employee</th>
                      <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Days</th>
                      <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Time</th>
                      <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">From</th>
                      <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Status</th>
                      <th className="text-center px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rules.map((r) => (
                      <tr key={r.id} className="border-b border-[rgba(255,255,255,0.04)] hover:bg-tt-card-hover transition-colors">
                        <td className="px-5 py-3 text-[13px] text-tt-text">{nameById.get(r.employee_id) || 'Unknown'}</td>
                        <td className="px-5 py-3 text-xs text-tt-muted">{daysLabel(r.days_of_week)}</td>
                        <td className="px-5 py-3 text-xs text-tt-muted tabular-nums">{r.start_time.slice(0, 5)}–{r.end_time.slice(0, 5)}</td>
                        <td className="px-5 py-3 text-xs text-tt-muted tabular-nums">{r.start_date}</td>
                        <td className="px-5 py-3">
                          <span className={`text-[10px] font-semibold px-2 py-1 rounded-md ${r.active ? 'bg-tt-green/15 text-tt-green' : 'bg-tt-muted/15 text-tt-muted'}`}>
                            {r.active ? 'Active' : 'Paused'}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-center whitespace-nowrap">
                          <button
                            onClick={() => toggleRuleActive.mutateAsync({ id: r.id, active: !r.active }).catch((e) => alert((e as Error).message))}
                            className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-white/5 text-tt-muted hover:text-tt-text transition-colors"
                          >
                            {r.active ? 'Pause' : 'Resume'}
                          </button>
                          <button
                            onClick={() => handleDeleteRule(r)}
                            className="ml-2 px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-tt-red/15 text-tt-red hover:bg-tt-red/25 transition-colors"
                          >
                            Delete Rule
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards — same rules data + handlers as the table above */}
              <div className="md:hidden p-4 space-y-3">
                {rules.map((r) => (
                  <MobileDataCard
                    key={r.id}
                    title={nameById.get(r.employee_id) || 'Unknown'}
                    subtitle={daysLabel(r.days_of_week)}
                    badge={
                      <span className={`text-[10px] font-semibold px-2 py-1 rounded-md ${r.active ? 'bg-tt-green/15 text-tt-green' : 'bg-tt-muted/15 text-tt-muted'}`}>
                        {r.active ? 'Active' : 'Paused'}
                      </span>
                    }
                    stats={[
                      { label: 'Time', value: <span className="tabular-nums">{r.start_time.slice(0, 5)}–{r.end_time.slice(0, 5)}</span> },
                      { label: 'From', value: <span className="tabular-nums">{r.start_date}</span> },
                    ]}
                    actions={
                      <>
                        <button
                          onClick={() => toggleRuleActive.mutateAsync({ id: r.id, active: !r.active }).catch((e) => alert((e as Error).message))}
                          className="rounded-lg text-[11px] font-semibold bg-white/5 text-tt-muted hover:text-tt-text transition-colors"
                        >
                          {r.active ? 'Pause' : 'Resume'}
                        </button>
                        <button
                          onClick={() => handleDeleteRule(r)}
                          className="rounded-lg text-[11px] font-semibold bg-tt-red/15 text-tt-red hover:bg-tt-red/25 transition-colors"
                        >
                          Delete Rule
                        </button>
                      </>
                    }
                  />
                ))}
              </div>
            </div>
          )}

          {/* Shift list (one-off + generated recurring) */}
          <div className="bg-tt-card border border-tt-border rounded-[14px] backdrop-blur-xl overflow-hidden">
            <div className="px-6 py-5 border-b border-tt-border">
              <h2 className="text-base font-semibold text-tt-text">Shifts This Period</h2>
            </div>
            {/* Desktop / tablet table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-tt-border">
                    <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Date</th>
                    <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Employee</th>
                    <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Type</th>
                    <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Start</th>
                    <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">End</th>
                    <th className="text-right px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Hours</th>
                    <th className="text-center px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const skipped = row.kind === 'recurring' && row.skipped;
                    const isOpen = row.kind === 'oneoff' && row.end_time == null;
                    return (
                      <tr key={row.id} className={`border-b border-[rgba(255,255,255,0.04)] hover:bg-tt-card-hover transition-colors ${skipped ? 'opacity-60' : ''}`}>
                        <td className="px-5 py-3 text-xs text-tt-muted">{row.date}</td>
                        <td className="px-5 py-3 text-[13px] text-tt-text">{nameById.get(row.employee_id) || 'Unknown'}</td>
                        <td className="px-5 py-3">
                          {row.kind === 'recurring' ? (
                            <span className="inline-flex items-center gap-1">
                              <span className="text-[10px] font-semibold px-2 py-1 rounded-md bg-tt-cyan/15 text-tt-cyan">Recurring</span>
                              {row.modified && <span className="text-[10px] font-semibold px-2 py-1 rounded-md bg-tt-yellow/15 text-tt-yellow">Modified</span>}
                              {row.skipped && <span className="text-[10px] font-semibold px-2 py-1 rounded-md bg-tt-red/15 text-tt-red">Skipped</span>}
                            </span>
                          ) : isOpen ? (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-md bg-tt-green/15 text-tt-green">
                              <span className="w-1.5 h-1.5 rounded-full bg-tt-green animate-pulse" />In progress
                            </span>
                          ) : row.source === 'time_clock' ? (
                            <span className="inline-flex flex-wrap items-center gap-1">
                              <span className="text-[10px] font-semibold px-2 py-1 rounded-md bg-tt-cyan/15 text-tt-cyan">Time Clock</span>
                              {row.auto_closed && (
                                <span
                                  title="Reconciler auto-closed a forgotten punch at the hour cap — the hours shown are a policy default, not measured. Verify before confirming."
                                  className="text-[10px] font-semibold px-2 py-1 rounded-md bg-tt-red/20 text-tt-red"
                                >
                                  ⚠ Auto-closed
                                </span>
                              )}
                              {row.confirmed_at == null ? (
                                <span className="text-[10px] font-semibold px-2 py-1 rounded-md bg-tt-yellow/15 text-tt-yellow">Needs confirmation</span>
                              ) : (
                                <span className="text-[10px] font-semibold px-2 py-1 rounded-md bg-tt-green/15 text-tt-green">Confirmed</span>
                              )}
                              {row.break_minutes > 0 && (
                                <span className="text-[10px] font-semibold px-2 py-1 rounded-md bg-tt-muted/15 text-tt-muted">{row.break_minutes}m break</span>
                              )}
                            </span>
                          ) : (
                            <span className="text-[10px] font-semibold px-2 py-1 rounded-md bg-tt-muted/15 text-tt-muted">One-off</span>
                          )}
                        </td>
                        <td className="px-5 py-3 text-xs text-tt-muted tabular-nums">{row.start_time.slice(0, 5)}</td>
                        <td className="px-5 py-3 text-xs text-tt-muted tabular-nums">{isOpen ? '—' : (row.end_time ?? '').slice(0, 5)}</td>
                        <td className={`px-5 py-3 text-[13px] text-right tabular-nums ${skipped ? 'text-tt-muted line-through' : isOpen ? 'text-tt-green' : 'text-tt-text'}`}>
                          {isOpen ? elapsedLabel(row.date, row.start_time) : paidShiftHours(row).toFixed(2)}
                          {hostLiveLabel(row) && (
                            <div className="mt-0.5 text-[10px] font-normal text-tt-muted whitespace-nowrap">{hostLiveLabel(row)}</div>
                          )}
                        </td>
                        <td className="px-5 py-3 text-center whitespace-nowrap">
                          {row.kind === 'oneoff' ? (
                            <>
                              {isOpen && (
                                <button
                                  onClick={() =>
                                    setEndingShift({
                                      id: row.id,
                                      name: nameById.get(row.employee_id) || 'Unknown',
                                      date: row.date,
                                      start_time: row.start_time,
                                      end_time: new Date().toTimeString().slice(0, 5),
                                    })
                                  }
                                  className="mr-2 px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-tt-green/15 text-tt-green hover:bg-tt-green/25 transition-colors"
                                >
                                  Shift Ended
                                </button>
                              )}
                              {!isOpen && row.source === 'time_clock' && (
                                row.confirmed_at == null ? (
                                  <button
                                    onClick={() => handleConfirmShift(row, true)}
                                    className="mr-2 px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-tt-green/15 text-tt-green hover:bg-tt-green/25 transition-colors"
                                  >
                                    Confirm
                                  </button>
                                ) : (
                                  <button
                                    onClick={() => handleConfirmShift(row, false)}
                                    className="mr-2 px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-white/5 text-tt-muted hover:text-tt-text transition-colors"
                                  >
                                    Unconfirm
                                  </button>
                                )
                              )}
                              <button
                                onClick={() => handleDeleteOneOff(row.id)}
                                className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-tt-red/15 text-tt-red hover:bg-tt-red/25 transition-colors"
                              >
                                Delete
                              </button>
                            </>
                          ) : row.skipped ? (
                            <button
                              onClick={() => handleClear(row)}
                              className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-tt-green/15 text-tt-green hover:bg-tt-green/25 transition-colors"
                            >
                              Restore
                            </button>
                          ) : (
                            <>
                              <button
                                onClick={() =>
                                  setEditing({
                                    ruleId: row.rule_id,
                                    date: row.date,
                                    name: nameById.get(row.employee_id) || 'Unknown',
                                    start: row.start_time.slice(0, 5),
                                    end: row.end_time.slice(0, 5),
                                  })
                                }
                                className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-tt-cyan/15 text-tt-cyan hover:bg-tt-cyan/25 transition-colors"
                              >
                                Edit
                              </button>
                              {row.modified && (
                                <button
                                  onClick={() => handleClear(row)}
                                  className="ml-2 px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-white/5 text-tt-muted hover:text-tt-text transition-colors"
                                >
                                  Revert
                                </button>
                              )}
                              <button
                                onClick={() => handleSkip(row)}
                                className="ml-2 px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-tt-red/15 text-tt-red hover:bg-tt-red/25 transition-colors"
                              >
                                Skip
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-5 py-12 text-center text-tt-muted text-sm">
                        {isLoading ? 'Loading…' : 'No shifts for this period'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Mobile cards — same rows data + handlers as the table above */}
            <div className="md:hidden p-4 space-y-3">
              {rows.map((row) => {
                const skipped = row.kind === 'recurring' && row.skipped;
                const isOpen = row.kind === 'oneoff' && row.end_time == null;
                return (
                  <MobileDataCard
                    key={row.id}
                    className={skipped ? 'opacity-60' : ''}
                    title={nameById.get(row.employee_id) || 'Unknown'}
                    subtitle={row.date}
                    badge={
                      row.kind === 'recurring' ? (
                        <span className="inline-flex flex-wrap items-center justify-end gap-1">
                          <span className="text-[10px] font-semibold px-2 py-1 rounded-md bg-tt-cyan/15 text-tt-cyan">Recurring</span>
                          {row.modified && <span className="text-[10px] font-semibold px-2 py-1 rounded-md bg-tt-yellow/15 text-tt-yellow">Modified</span>}
                          {row.skipped && <span className="text-[10px] font-semibold px-2 py-1 rounded-md bg-tt-red/15 text-tt-red">Skipped</span>}
                        </span>
                      ) : isOpen ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-md bg-tt-green/15 text-tt-green">
                          <span className="w-1.5 h-1.5 rounded-full bg-tt-green animate-pulse" />In progress
                        </span>
                      ) : row.source === 'time_clock' ? (
                        <span className="inline-flex flex-wrap items-center justify-end gap-1">
                          <span className="text-[10px] font-semibold px-2 py-1 rounded-md bg-tt-cyan/15 text-tt-cyan">Time Clock</span>
                          {row.auto_closed && (
                            <span className="text-[10px] font-semibold px-2 py-1 rounded-md bg-tt-red/20 text-tt-red">⚠ Auto-closed</span>
                          )}
                          {row.confirmed_at == null ? (
                            <span className="text-[10px] font-semibold px-2 py-1 rounded-md bg-tt-yellow/15 text-tt-yellow">Needs confirmation</span>
                          ) : (
                            <span className="text-[10px] font-semibold px-2 py-1 rounded-md bg-tt-green/15 text-tt-green">Confirmed</span>
                          )}
                          {row.break_minutes > 0 && (
                            <span className="text-[10px] font-semibold px-2 py-1 rounded-md bg-tt-muted/15 text-tt-muted">{row.break_minutes}m break</span>
                          )}
                        </span>
                      ) : (
                        <span className="text-[10px] font-semibold px-2 py-1 rounded-md bg-tt-muted/15 text-tt-muted">One-off</span>
                      )
                    }
                    stats={[
                      { label: 'Start', value: <span className="tabular-nums">{row.start_time.slice(0, 5)}</span> },
                      { label: 'End', value: <span className="tabular-nums">{isOpen ? '—' : (row.end_time ?? '').slice(0, 5)}</span> },
                      {
                        label: 'Hours',
                        value: (
                          <span className={`tabular-nums ${skipped ? 'text-tt-muted line-through' : isOpen ? 'text-tt-green' : ''}`}>
                            {isOpen ? elapsedLabel(row.date, row.start_time) : paidShiftHours(row).toFixed(2)}
                          </span>
                        ),
                      },
                      ...(hostLiveLabel(row) ? [{ label: 'Live', value: <span className="text-tt-muted">{hostLiveLabel(row)}</span> }] : []),
                    ]}
                    actions={
                      row.kind === 'oneoff' ? (
                        <>
                          {isOpen && (
                            <button
                              onClick={() =>
                                setEndingShift({
                                  id: row.id,
                                  name: nameById.get(row.employee_id) || 'Unknown',
                                  date: row.date,
                                  start_time: row.start_time,
                                  end_time: new Date().toTimeString().slice(0, 5),
                                })
                              }
                              className="rounded-lg text-[11px] font-semibold bg-tt-green/15 text-tt-green hover:bg-tt-green/25 transition-colors"
                            >
                              Shift Ended
                            </button>
                          )}
                          {!isOpen && row.source === 'time_clock' && (
                            row.confirmed_at == null ? (
                              <button
                                onClick={() => handleConfirmShift(row, true)}
                                className="rounded-lg text-[11px] font-semibold bg-tt-green/15 text-tt-green hover:bg-tt-green/25 transition-colors"
                              >
                                Confirm
                              </button>
                            ) : (
                              <button
                                onClick={() => handleConfirmShift(row, false)}
                                className="rounded-lg text-[11px] font-semibold bg-white/5 text-tt-muted hover:text-tt-text transition-colors"
                              >
                                Unconfirm
                              </button>
                            )
                          )}
                          <button
                            onClick={() => handleDeleteOneOff(row.id)}
                            className="rounded-lg text-[11px] font-semibold bg-tt-red/15 text-tt-red hover:bg-tt-red/25 transition-colors"
                          >
                            Delete
                          </button>
                        </>
                      ) : row.skipped ? (
                        <button
                          onClick={() => handleClear(row)}
                          className="rounded-lg text-[11px] font-semibold bg-tt-green/15 text-tt-green hover:bg-tt-green/25 transition-colors"
                        >
                          Restore
                        </button>
                      ) : (
                        <>
                          <button
                            onClick={() =>
                              setEditing({
                                ruleId: row.rule_id,
                                date: row.date,
                                name: nameById.get(row.employee_id) || 'Unknown',
                                start: row.start_time.slice(0, 5),
                                end: row.end_time.slice(0, 5),
                              })
                            }
                            className="rounded-lg text-[11px] font-semibold bg-tt-cyan/15 text-tt-cyan hover:bg-tt-cyan/25 transition-colors"
                          >
                            Edit
                          </button>
                          {row.modified && (
                            <button
                              onClick={() => handleClear(row)}
                              className="rounded-lg text-[11px] font-semibold bg-white/5 text-tt-muted hover:text-tt-text transition-colors"
                            >
                              Revert
                            </button>
                          )}
                          <button
                            onClick={() => handleSkip(row)}
                            className="rounded-lg text-[11px] font-semibold bg-tt-red/15 text-tt-red hover:bg-tt-red/25 transition-colors"
                          >
                            Skip
                          </button>
                        </>
                      )
                    }
                  />
                );
              })}
              {rows.length === 0 && (
                <div className="px-5 py-12 text-center text-tt-muted text-sm">
                  {isLoading ? 'Loading…' : 'No shifts for this period'}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* Edit recurring instance (writes a 'modified' exception for that date) */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setEditing(null)} />
          <div className="relative bg-tt-card border border-tt-border rounded-t-2xl sm:rounded-2xl p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] w-full sm:max-w-sm sm:mx-4 shadow-2xl max-h-[90dvh] overflow-y-auto">
            <div className="flex items-start justify-between mb-1">
              <h3 className="text-base font-semibold text-tt-text">Edit This Occurrence</h3>
              <button onClick={() => setEditing(null)} className="text-tt-muted hover:text-tt-text transition-colors p-1">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <p className="text-xs text-tt-muted mb-4">
              {editing.name} · {editing.date}. Changes apply to this date only; the rule keeps generating other days.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Start">
                <input type="time" value={editing.start} onChange={(e) => setEditing({ ...editing, start: e.target.value })} className={inputCls} />
              </Field>
              <Field label="End">
                <input type="time" value={editing.end} onChange={(e) => setEditing({ ...editing, end: e.target.value })} className={inputCls} />
              </Field>
            </div>
            <div className="flex gap-3 pt-5">
              <button onClick={() => setEditing(null)} className="flex-1 min-h-[44px] py-2.5 rounded-xl text-sm font-semibold text-tt-muted hover:text-tt-text bg-white/5 hover:bg-white/10 transition-colors">Cancel</button>
              <button onClick={saveEditing} className="flex-1 min-h-[44px] py-2.5 rounded-xl text-sm font-semibold bg-tt-cyan text-black hover:bg-tt-cyan/90 transition-colors">Save</button>
            </div>
          </div>
        </div>
      )}

      {/* End an open shift — end defaults to NOW but is editable before saving. */}
      {endingShift && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setEndingShift(null)} />
          <div className="relative bg-tt-card border border-tt-border rounded-t-2xl sm:rounded-2xl p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] w-full sm:max-w-sm sm:mx-4 shadow-2xl max-h-[90dvh] overflow-y-auto">
            <div className="flex items-start justify-between mb-1">
              <h3 className="text-base font-semibold text-tt-text">End Shift</h3>
              <button onClick={() => setEndingShift(null)} className="text-tt-muted hover:text-tt-text transition-colors p-1">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <p className="text-xs text-tt-muted mb-4">
              {endingShift.name} · {endingShift.date}, started {endingShift.start_time.slice(0, 5)}. Adjust the end time if it wasn&apos;t just now.
            </p>
            <Field label="End time">
              <input type="time" value={endingShift.end_time} onChange={(e) => setEndingShift({ ...endingShift, end_time: e.target.value })} className={inputCls} />
            </Field>
            <div className="flex gap-3 pt-5">
              <button onClick={() => setEndingShift(null)} className="flex-1 min-h-[44px] py-2.5 rounded-xl text-sm font-semibold text-tt-muted hover:text-tt-text bg-white/5 hover:bg-white/10 transition-colors">Cancel</button>
              <button onClick={saveEndShift} className="flex-1 min-h-[44px] py-2.5 rounded-xl text-sm font-semibold bg-tt-cyan text-black hover:bg-tt-cyan/90 transition-colors">End Shift</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
