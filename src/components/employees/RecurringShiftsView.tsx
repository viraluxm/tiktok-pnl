'use client';

import { useMemo, useState } from 'react';
import { useShiftRules } from '@/hooks/useShiftRules';
import type { Employee, ShiftRule } from '@/types';
import { Field, WEEKDAYS, inputCls, ruleDescription } from './shared';

// "Regular Schedules" — recurring-rule controls, split out of the old mixed Shifts view.
// Behaviour (add rule / pause / resume / delete, with the pre-mutation freeze) is unchanged;
// only the presentation moved. Per-occurrence skip/modify still lives in Time Records, where
// the individual occurrences are listed.
export default function RecurringShiftsView({ employees }: { employees: Employee[] }) {
  const { rules, isLoading, addRule, toggleRuleActive, deleteRule } = useShiftRules();

  const [rEmployeeId, setREmployeeId] = useState('');
  const [rDays, setRDays] = useState<Set<number>>(new Set());
  const [rStart, setRStart] = useState('');
  const [rEnd, setREnd] = useState('');
  const [rStartDate, setRStartDate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of employees) m.set(e.id, e.name);
    return m;
  }, [employees]);

  // Only schedulable (non-former) employees can be assigned a new recurring rule.
  const selectable = useMemo(() => employees.filter((e) => e.status !== 'former'), [employees]);

  function toggleDay(v: number) {
    setRDays((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
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

  async function handleDeleteRule(rule: ShiftRule) {
    if (!confirm('Delete this recurring rule? Future shifts stop generating. Past pay already calculated is unaffected, and one-off shifts are untouched.')) return;
    try {
      await deleteRule.mutateAsync(rule.id);
    } catch (err) {
      alert((err as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      {/* Add recurring schedule */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] backdrop-blur-xl p-6">
        <h2 className="text-base font-semibold text-tt-text mb-1">Add a regular schedule</h2>
        <p className="text-xs text-tt-muted mb-4">
          A regular schedule repeats on the weekdays you pick, starting from a date, until you pause or delete it.
        </p>
        {selectable.length === 0 ? (
          <p className="text-sm text-tt-muted">Add an active employee first.</p>
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
                {submitting ? 'Adding…' : '+ Add Regular Schedule'}
              </button>
            </div>
          </>
        )}
      </div>

      {/* Existing recurring rules */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] backdrop-blur-xl overflow-hidden">
        <div className="px-6 py-5 border-b border-tt-border">
          <h2 className="text-base font-semibold text-tt-text">Regular schedules</h2>
          <p className="text-xs text-tt-muted mt-1">
            Pausing or deleting a schedule stops future shifts. Hours already worked are kept, and one-off shifts are untouched.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-tt-border">
                <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Employee</th>
                <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Schedule</th>
                <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Status</th>
                <th className="text-center px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} className="border-b border-[rgba(255,255,255,0.04)] hover:bg-tt-card-hover transition-colors">
                  <td className="px-5 py-3 text-[13px] text-tt-text">{nameById.get(r.employee_id) || 'Unknown'}</td>
                  <td className="px-5 py-3 text-xs text-tt-muted tabular-nums">{ruleDescription(r.days_of_week, r.start_time, r.end_time, r.start_date)}</td>
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
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {rules.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-5 py-12 text-center text-tt-muted text-sm">
                    {isLoading ? 'Loading…' : 'No regular schedules yet'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
