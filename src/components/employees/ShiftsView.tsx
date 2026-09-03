'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { enterFullscreen } from '@/lib/fullscreen';
import { useShifts } from '@/hooks/useShifts';
import { useShiftRules } from '@/hooks/useShiftRules';
import { employeeHasActiveRules } from '@/lib/schedule/scheduledSpan';
import type { Employee, ShiftRule } from '@/types';
import ScheduleMonthCalendar from './weekly/ScheduleMonthCalendar';
import PendingClaimsPanel from './PendingClaimsPanel';
import TeamScheduleLinkButton from './TeamScheduleLinkButton';
import { Field, daysLabel, inputCls } from './shared';
import MobileDataCard from '@/components/ui/MobileDataCard';

// The Shifts tab: the month calendar, plus a collapsed "Schedule rules" drawer.
//
// The old List view is GONE. It duplicated the calendar for reading and made the page start with
// ~400px of banners and forms before any shift was visible. Everything it could do that the
// calendar cannot — creating and deactivating recurring RULES, and hand-adding a payable
// correction — lives in the drawer below; per-shift review (confirm, edit, add) now happens on
// the calendar itself, where the shift is.
//
// Self-contained (owns its own data hooks) so it fetches only when the Shifts tab is mounted —
// opening Team on the default Roster tab no longer loads shift history.

export default function ShiftsView({
  employees,
  dateFrom,
  dateTo,
}: {
  employees: Employee[];
  dateFrom: string | null;
  dateTo: string | null;
}) {
  const { shifts, endShift } = useShifts(dateFrom, dateTo);
  const router = useRouter();
  const { rules, toggleRuleActive, deleteRule, upsertException } = useShiftRules();

  // Data-completeness (NOT a per-shift flag): employees who have punches but NO active rule at all.
  // Per the refinement, these are surfaced ONCE here rather than flagging every shift they work.
  const unscheduledPunchers = useMemo(() => {
    const punchers = new Set(shifts.filter((s) => s.source === 'time_clock').map((s) => s.employee_id));
    const nameById = new Map(employees.map((e) => [e.id, e.name]));
    return [...punchers].filter((id) => !employeeHasActiveRules(id, rules)).map((id) => nameById.get(id) || 'Unknown');
  }, [shifts, rules, employees]);



  const [endingShift, setEndingShift] = useState<
    { id: string; name: string; date: string; start_time: string; end_time: string } | null
  >(null);



  const [editing, setEditing] = useState<
    { ruleId: string; date: string; name: string; start: string; end: string } | null
  >(null);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of employees) m.set(e.id, e.name);
    return m;
  }, [employees]);



  function minsOf(t: string): number {
    const [h, m] = t.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
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


  async function handleDeleteRule(rule: ShiftRule) {
    if (!confirm('Delete this recurring rule? Future shifts stop generating. Past pay already calculated is unaffected, and one-off shifts are untouched.')) return;
    try {
      await deleteRule.mutateAsync(rule.id);
    } catch (err) {
      alert((err as Error).message);
    }
  }

  // Enter real browser fullscreen from THIS click gesture, wait for it to settle (granted or
  // denied), THEN navigate — so it's part of the user gesture (not a delayed effect on the
  // destination route, which browsers can reject). Client-side push keeps the same document,
  // so fullscreen persists into the kiosk. If denied, we still navigate (kiosk fallback covers it).
  // The IN-USE time clock. Deliberately still /dashboard/time-clock (the tap-a-name kiosk):
  // it is what the warehouse runs every day, and the badge/link rollout is still being trialled.
  // Do not repoint this until that trial is done and the replacement is actually adopted.
  //
  // It could not point at /kiosk in any case — every /api/kiosk/* route re-checks
  // app_metadata.role and 403s an admin, so the badge kiosk is reachable only by the dedicated
  // `timeclock` login on the warehouse machine.
  async function openTimeClock() {
    await enterFullscreen();
    router.push('/dashboard/time-clock');
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
      {/* Open the in-use time clock. The List view is gone — the calendar is the only shift
          surface now, so there is nothing to toggle between. */}
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={openTimeClock}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-tt-cyan/15 text-tt-cyan hover:bg-tt-cyan/25 transition-colors cursor-pointer"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-tt-cyan" />
          Open Time Clock
        </button>
        <TeamScheduleLinkButton />
      </div>

      {/* Pending OT claims awaiting approval — no other surface owns these, so they stay up top. */}
      <PendingClaimsPanel />

      <ScheduleMonthCalendar employees={employees} />

      {/* Recurring rules. The Add Shift and Post One-Time Shift forms are gone — clicking a day
          on the calendar does both, and does them for a whole crew at once. What remains here is
          rule management, which has no calendar equivalent. */}
      <details className="rounded-[14px] border border-tt-border bg-tt-card/60">
        <summary className="cursor-pointer select-none px-5 py-3 text-sm font-semibold text-tt-text">
          Recurring rules
        </summary>
        <div className="space-y-6 border-t border-tt-border p-5">
          {/* Data-completeness (not a per-shift flag): employees who punch but have no schedule. */}
          {unscheduledPunchers.length > 0 && (
            <div className="rounded-[14px] border border-tt-border bg-tt-card/60 px-5 py-3 text-sm text-tt-muted">
              <span className="font-semibold text-tt-text">{unscheduledPunchers.length}</span> employee
              {unscheduledPunchers.length === 1 ? '' : 's'} punch but have no schedule set:{' '}
              <span className="text-tt-text">{unscheduledPunchers.join(', ')}</span>. Add rules so their shifts can be validated.
            </div>
          )}

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

        </div>
      </details>

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
