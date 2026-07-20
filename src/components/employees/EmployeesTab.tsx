'use client';

import { useEffect, useMemo, useState } from 'react';
import { fmt } from '@/lib/calculations';
import { computePay, shiftHours, generateRecurringShifts, payPeriodFor, paydayAtOffset, fmtPayDate, fmtMonthDay, type GeneratedShift } from '@/lib/employees';
import { useEmployees, type EmployeeInput } from '@/hooks/useEmployees';
import { useShifts } from '@/hooks/useShifts';
import { useShiftRules, type ShiftRuleInput } from '@/hooks/useShiftRules';
import type { Employee, EmployeeStatus, Shift, ShiftRule } from '@/types';
import AuctionPerformanceCard from './AuctionPerformanceCard';
import { AspHitBadge, BelowBreakEvenBadge } from './HostPerformanceBadges';
import { useHostPerformance, type HostAgg } from '@/hooks/useHostPerformance';
import ShiftCalendar, { type CalendarShift } from './ShiftCalendar';

interface EmployeesTabProps {
  // The selected pay period, driven by the dashboard's global FiltersBar. Nulls = all time.
  dateFrom: string | null;
  dateTo: string | null;
}

type SubView = 'roster' | 'shifts' | 'pay' | 'auctions';

const ROLE_PRESETS = ['host', 'fulfillment', 'manager', 'support', 'other'];
const STATUSES: EmployeeStatus[] = ['active', 'probation', 'former'];

const EMPTY_FORM: EmployeeInput = {
  name: '',
  role: 'host',
  status: 'active',
  hourly_rate: 0,
  hire_date: null,
  probation_end_date: null,
};

function fmtHours(h: number): string {
  return `${h.toFixed(2)} hr`;
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function StatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase();
  let color = 'bg-tt-muted/15 text-tt-muted';
  if (s === 'active') color = 'bg-tt-green/15 text-tt-green';
  else if (s === 'probation') color = 'bg-tt-yellow/15 text-tt-yellow';
  return (
    <span className={`text-[10px] font-semibold px-2 py-1 rounded-md ${color}`}>
      {titleCase(status)}
    </span>
  );
}

export default function EmployeesTab({ dateFrom, dateTo }: EmployeesTabProps) {
  const [subView, setSubView] = useState<SubView>('roster');
  const { employees, isLoading, addEmployee, updateEmployee, deleteEmployee } = useEmployees();
  // Per-host auction badges (Roster). Read-only; empty until 056 attribution accrues.
  const { data: hostPerf } = useHostPerformance();
  const { shifts, openShifts, isLoading: shiftsLoading, addShift, endShift, deleteShift } = useShifts(dateFrom, dateTo);
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

  // (rule|date) pairs already frozen into real `shifts` rows (source_rule_id set).
  // The generator excludes these so a materialized day is counted once (by the row),
  // never twice (row + projection). See migration 055 / generateRecurringShifts.
  const materialized = useMemo(
    () => new Set(shifts.filter((s) => s.source_rule_id).map((s) => `${s.source_rule_id}|${s.date}`)),
    [shifts],
  );

  // Recurring instances computed for the selected period (rule − exceptions − materialized).
  const generated = useMemo(
    () => generateRecurringShifts(rules, exceptions, dateFrom, dateTo, materialized),
    [rules, exceptions, dateFrom, dateTo, materialized],
  );

  // Employee add/edit modal
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Employee | null>(null);
  const [form, setForm] = useState<EmployeeInput>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // ── PAY VIEW: scoped to the GLOBAL BIWEEKLY PAY PERIOD, not the FiltersBar ──────────
  // The Pay tab's Hours/Owed are for the current pay period's [start, end] window (the
  // 2 weeks a payday pays for), independent of whatever the dashboard filter says. This
  // is the fix: the old code scoped pay to the FiltersBar, so "all time" showed LIFETIME
  // earnings and read as a running balance. periodOffset drives prev/next navigation.
  const [periodOffset, setPeriodOffset] = useState(0);
  const payday = useMemo(() => paydayAtOffset(periodOffset), [periodOffset]);
  const period = useMemo(() => payPeriodFor(payday), [payday]);

  // Shifts for the pay-period window — a SEPARATE fetch from the FiltersBar-scoped one,
  // via the same hook (same auth/store/RLS scoping). Changing the FiltersBar can't move
  // these numbers; only the period does.
  const { shifts: periodShifts } = useShifts(period.start, period.end);
  const periodMaterialized = useMemo(
    () => new Set(periodShifts.filter((s) => s.source_rule_id).map((s) => `${s.source_rule_id}|${s.date}`)),
    [periodShifts],
  );
  // Recurring instances for the period, with the SAME materialized-exclusion guard as the
  // Shifts view — a materialized recurring day is counted once (real row), never doubled.
  const periodGenerated = useMemo(
    () => generateRecurringShifts(rules, exceptions, period.start, period.end, periodMaterialized),
    [rules, exceptions, period.start, period.end, periodMaterialized],
  );
  // Reuse computePay's exact hours×rate math (open shifts excluded, skipped excluded).
  const pay = useMemo(
    () => computePay(employees, [...periodShifts, ...periodGenerated.filter((g) => !g.skipped)]),
    [employees, periodShifts, periodGenerated],
  );
  const totals = useMemo(
    () => pay.reduce((acc, p) => ({ hours: acc.hours + p.hours, pay: acc.pay + p.pay }), { hours: 0, pay: 0 }),
    [pay],
  );

  function openAdd() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setModalOpen(true);
  }

  function openEdit(e: Employee) {
    setEditing(e);
    setForm({
      name: e.name,
      role: e.role,
      status: e.status,
      hourly_rate: e.hourly_rate,
      hire_date: e.hire_date,
      probation_end_date: e.probation_end_date,
    });
    setFormError(null);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditing(null);
    setFormError(null);
  }

  async function handleSave() {
    if (!form.name.trim()) {
      setFormError('Name is required');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const payload: EmployeeInput = {
        ...form,
        name: form.name.trim(),
        hourly_rate: Number(form.hourly_rate) || 0,
        hire_date: form.hire_date || null,
        probation_end_date: form.probation_end_date || null,
      };
      if (editing) {
        await updateEmployee.mutateAsync({ id: editing.id, ...payload });
      } else {
        await addEmployee.mutateAsync(payload);
      }
      closeModal();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(e: Employee) {
    if (!confirm(`Remove ${e.name}? Their shifts will be deleted too.`)) return;
    try {
      await deleteEmployee.mutateAsync(e.id);
    } catch (err) {
      alert((err as Error).message);
    }
  }

  const periodLabel = dateFrom || dateTo
    ? `${dateFrom || '…'} → ${dateTo || '…'}`
    : 'All time';

  return (
    <div>
      {/* Sub navigation */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex gap-2">
          {(['roster', 'shifts', 'pay', 'auctions'] as SubView[]).map((v) => (
            <button
              key={v}
              onClick={() => setSubView(v)}
              className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                subView === v ? 'bg-white/10 text-tt-text' : 'text-tt-muted hover:text-tt-text hover:bg-white/5'
              }`}
            >
              {v === 'roster' ? 'Roster' : v === 'shifts' ? 'Shifts' : v === 'pay' ? 'Pay' : 'Auctions'}
            </button>
          ))}
        </div>
        {/* The FiltersBar drives Roster/Shifts, but the Pay view is scoped to its OWN
            biweekly pay period (independent of the filter). Hide this label there so it
            can't imply the pay numbers respond to the dashboard filter. */}
        {subView !== 'pay' && subView !== 'auctions' && (
          <span className="text-xs text-tt-muted">
            Period: <span className="text-tt-text font-medium">{periodLabel}</span>
          </span>
        )}
      </div>

      {subView === 'roster' && (
        <RosterView
          employees={employees}
          isLoading={isLoading}
          hostPerf={hostPerf?.hosts ?? {}}
          onAdd={openAdd}
          onEdit={openEdit}
          onDelete={handleDelete}
        />
      )}

      {subView === 'shifts' && (
        <ShiftsView
          employees={employees}
          shifts={shifts}
          openShifts={openShifts}
          generated={generated}
          rules={rules}
          isLoading={shiftsLoading || rulesLoading}
          onAddOneOff={async (input) => {
            await addShift.mutateAsync(input);
          }}
          onEndShift={async (id, end_time) => {
            await endShift.mutateAsync({ id, end_time });
          }}
          onDeleteOneOff={async (id) => {
            await deleteShift.mutateAsync(id);
          }}
          onAddRule={async (input) => {
            await addRule.mutateAsync(input);
          }}
          onDeleteRule={async (id) => {
            await deleteRule.mutateAsync(id);
          }}
          onToggleRule={async (id, active) => {
            await toggleRuleActive.mutateAsync({ id, active });
          }}
          onSkipInstance={async (rule_id, date) => {
            await upsertException.mutateAsync({ rule_id, date, type: 'skip' });
          }}
          onModifyInstance={async (rule_id, date, start, end) => {
            await upsertException.mutateAsync({
              rule_id,
              date,
              type: 'modified',
              modified_start: start,
              modified_end: end,
            });
          }}
          onClearException={async (rule_id, date) => {
            await deleteException.mutateAsync({ rule_id, date });
          }}
        />
      )}

      {subView === 'auctions' && <AuctionPerformanceCard />}

      {subView === 'pay' && (
        <div className="bg-tt-card border border-tt-border rounded-[14px] backdrop-blur-xl overflow-hidden">
          <div className="px-6 py-5 border-b border-tt-border">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold text-tt-text">Pay owed — this pay period</h2>
                <p className="text-xs text-tt-muted mt-1 max-w-md">
                  Hours &amp; pay for the current biweekly period only — not lifetime, and not a running
                  balance. Independent of the dashboard date filter.
                </p>
              </div>
              {/* Current pay period + payday, with prev/next navigation. */}
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => setPeriodOffset((o) => o - 1)}
                  aria-label="Previous pay period"
                  className="w-8 h-8 rounded-lg border border-tt-border text-tt-muted hover:bg-tt-card-hover hover:text-tt-text transition-colors cursor-pointer"
                >←</button>
                <div className="text-right min-w-[9.5rem]">
                  <div className="text-[13px] font-semibold text-tt-text tabular-nums">
                    {fmtMonthDay(period.start)} – {fmtMonthDay(period.end)}
                  </div>
                  <div className="text-[11px] text-tt-muted">Payday: {fmtPayDate(payday)}</div>
                </div>
                <button
                  onClick={() => setPeriodOffset((o) => o + 1)}
                  aria-label="Next pay period"
                  className="w-8 h-8 rounded-lg border border-tt-border text-tt-muted hover:bg-tt-card-hover hover:text-tt-text transition-colors cursor-pointer"
                >→</button>
              </div>
            </div>
            {periodOffset !== 0 && (
              <button
                onClick={() => setPeriodOffset(0)}
                className="mt-2 text-[11px] text-tt-cyan hover:underline cursor-pointer"
              >
                ← Back to current period
              </button>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-tt-border">
                  <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Employee</th>
                  <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Role</th>
                  <th className="text-right px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Hourly Rate</th>
                  <th className="text-right px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Hours (period)</th>
                  <th className="text-right px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Pay Owed (period)</th>
                </tr>
              </thead>
              <tbody>
                {pay.map(({ employee, hours, pay: owed }) => (
                  <tr key={employee.id} className="border-b border-[rgba(255,255,255,0.04)] hover:bg-tt-card-hover transition-colors">
                    <td className="px-5 py-3 text-[13px] text-tt-text">{employee.name}</td>
                    <td className="px-5 py-3 text-xs text-tt-muted">{titleCase(employee.role)}</td>
                    <td className="px-5 py-3 text-[13px] text-tt-text text-right tabular-nums">{fmt(employee.hourly_rate)}</td>
                    <td className="px-5 py-3 text-[13px] text-tt-text text-right tabular-nums">{fmtHours(hours)}</td>
                    <td className="px-5 py-3 text-[13px] font-semibold text-tt-green text-right tabular-nums">{fmt(owed)}</td>
                  </tr>
                ))}
                {pay.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-5 py-12 text-center text-tt-muted text-sm">No employees yet</td>
                  </tr>
                )}
              </tbody>
              {pay.length > 0 && (
                <tfoot>
                  <tr className="border-t border-tt-border">
                    <td className="px-5 py-3 text-[13px] font-semibold text-tt-text" colSpan={3}>Total for {fmtMonthDay(period.start)} – {fmtMonthDay(period.end)}</td>
                    <td className="px-5 py-3 text-[13px] font-semibold text-tt-text text-right tabular-nums">{fmtHours(totals.hours)}</td>
                    <td className="px-5 py-3 text-[13px] font-semibold text-tt-green text-right tabular-nums">{fmt(totals.pay)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      )}

      {/* Add / edit employee modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={closeModal} />
          <div className="relative bg-tt-card border border-tt-border rounded-2xl p-6 w-full max-w-md mx-4 shadow-2xl">
            <div className="flex items-start justify-between mb-5">
              <h3 className="text-base font-semibold text-tt-text">{editing ? 'Edit Employee' : 'Add Employee'}</h3>
              <button onClick={closeModal} className="text-tt-muted hover:text-tt-text transition-colors p-1">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="space-y-4">
              <Field label="Name">
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Jane Doe"
                  className="w-full bg-white/5 border border-tt-border rounded-xl px-4 py-2.5 text-sm text-tt-text placeholder:text-tt-muted/50 focus:outline-none focus:ring-1 focus:ring-tt-cyan/50"
                />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Role">
                  <select
                    value={form.role}
                    onChange={(e) => setForm({ ...form, role: e.target.value })}
                    className="w-full bg-white/5 border border-tt-border rounded-xl px-4 py-2.5 text-sm text-tt-text focus:outline-none focus:ring-1 focus:ring-tt-cyan/50 appearance-none"
                  >
                    {ROLE_PRESETS.map((r) => (
                      <option key={r} value={r} className="bg-tt-card text-tt-text">{titleCase(r)}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Status">
                  <select
                    value={form.status}
                    onChange={(e) => setForm({ ...form, status: e.target.value as EmployeeStatus })}
                    className="w-full bg-white/5 border border-tt-border rounded-xl px-4 py-2.5 text-sm text-tt-text focus:outline-none focus:ring-1 focus:ring-tt-cyan/50 appearance-none"
                  >
                    {STATUSES.map((s) => (
                      <option key={s} value={s} className="bg-tt-card text-tt-text">{titleCase(s)}</option>
                    ))}
                  </select>
                </Field>
              </div>

              <Field label="Hourly Rate ($)">
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={form.hourly_rate}
                  onChange={(e) => setForm({ ...form, hourly_rate: e.target.valueAsNumber || 0 })}
                  className="w-full bg-white/5 border border-tt-border rounded-xl px-4 py-2.5 text-sm text-tt-text focus:outline-none focus:ring-1 focus:ring-tt-cyan/50"
                />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Hire Date">
                  <input
                    type="date"
                    value={form.hire_date || ''}
                    onChange={(e) => setForm({ ...form, hire_date: e.target.value || null })}
                    className="w-full bg-white/5 border border-tt-border rounded-xl px-4 py-2.5 text-sm text-tt-text focus:outline-none focus:ring-1 focus:ring-tt-cyan/50"
                  />
                </Field>
                <Field label="Probation Ends">
                  <input
                    type="date"
                    value={form.probation_end_date || ''}
                    onChange={(e) => setForm({ ...form, probation_end_date: e.target.value || null })}
                    className="w-full bg-white/5 border border-tt-border rounded-xl px-4 py-2.5 text-sm text-tt-text focus:outline-none focus:ring-1 focus:ring-tt-cyan/50"
                  />
                </Field>
              </div>

              {formError && (
                <div className="p-3 bg-tt-red/10 rounded-xl">
                  <p className="text-xs text-tt-red">{formError}</p>
                </div>
              )}

              <div className="flex gap-3 pt-1">
                <button
                  onClick={closeModal}
                  disabled={saving}
                  className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-tt-muted hover:text-tt-text bg-white/5 hover:bg-white/10 transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-tt-cyan text-black hover:bg-tt-cyan/90 transition-colors disabled:opacity-50"
                >
                  {saving ? 'Saving…' : editing ? 'Save Changes' : 'Add Employee'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[11px] text-tt-muted uppercase tracking-wide block mb-2">{label}</label>
      {children}
    </div>
  );
}

function RosterView({
  employees,
  isLoading,
  hostPerf,
  onAdd,
  onEdit,
  onDelete,
}: {
  employees: Employee[];
  isLoading: boolean;
  hostPerf: Record<string, HostAgg>;
  onAdd: () => void;
  onEdit: (e: Employee) => void;
  onDelete: (e: Employee) => void;
}) {
  return (
    <div className="bg-tt-card border border-tt-border rounded-[14px] backdrop-blur-xl overflow-hidden">
      <div className="px-6 py-5 border-b border-tt-border flex items-center justify-between">
        <h2 className="text-base font-semibold text-tt-text">Team Roster</h2>
        <button
          onClick={onAdd}
          className="px-4 py-2 rounded-lg bg-gradient-to-r from-tt-cyan to-[#4db8c0] text-black text-[13px] font-semibold hover:opacity-90 transition-opacity"
        >
          + Add Employee
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-tt-border">
              <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Name</th>
              <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Role</th>
              <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Status</th>
              <th className="text-right px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Hourly Rate</th>
              <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Hire Date</th>
              <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Probation Ends</th>
              <th className="text-center px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">ASP Hit (7d)</th>
              <th className="text-center px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Below Break-even (14d)</th>
              <th className="text-center px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {employees.map((e) => (
              <tr key={e.id} className="border-b border-[rgba(255,255,255,0.04)] hover:bg-tt-card-hover transition-colors">
                <td className="px-5 py-3 text-[13px] text-tt-text">{e.name}</td>
                <td className="px-5 py-3 text-xs text-tt-muted">{titleCase(e.role)}</td>
                <td className="px-5 py-3"><StatusBadge status={e.status} /></td>
                <td className="px-5 py-3 text-[13px] text-tt-text text-right tabular-nums">{fmt(e.hourly_rate)}</td>
                <td className="px-5 py-3 text-xs text-tt-muted">{e.hire_date || '—'}</td>
                <td className="px-5 py-3 text-xs text-tt-muted">{e.probation_end_date || '—'}</td>
                {/* Performance badges: HOSTS ONLY. Other roles (e.g. fulfillment) show nothing. */}
                <td className="px-5 py-3 text-center">
                  {e.role?.toLowerCase() === 'host' ? <AspHitBadge agg={hostPerf[e.id]} /> : null}
                </td>
                <td className="px-5 py-3 text-center">
                  {e.role?.toLowerCase() === 'host' ? <BelowBreakEvenBadge agg={hostPerf[e.id]} /> : null}
                </td>
                <td className="px-5 py-3 text-center whitespace-nowrap">
                  <button
                    onClick={() => onEdit(e)}
                    className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-tt-cyan/15 text-tt-cyan hover:bg-tt-cyan/25 transition-colors"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => onDelete(e)}
                    className="ml-2 px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-tt-red/15 text-tt-red hover:bg-tt-red/25 transition-colors"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {employees.length === 0 && (
              <tr>
                <td colSpan={9} className="px-5 py-12 text-center text-tt-muted text-sm">
                  {isLoading ? 'Loading…' : 'No employees yet — add your first team member'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Weekdays in Mon–Sun display order, mapped to getUTCDay() numbers.
const WEEKDAYS: { label: string; value: number }[] = [
  { label: 'Mon', value: 1 },
  { label: 'Tue', value: 2 },
  { label: 'Wed', value: 3 },
  { label: 'Thu', value: 4 },
  { label: 'Fri', value: 5 },
  { label: 'Sat', value: 6 },
  { label: 'Sun', value: 0 },
];

function daysLabel(days: number[]): string {
  const set = new Set(days);
  const picked = WEEKDAYS.filter((d) => set.has(d.value)).map((d) => d.label);
  return picked.length ? picked.join(', ') : '—';
}

type DisplayRow =
  | { kind: 'oneoff'; id: string; employee_id: string; date: string; start_time: string; end_time: string | null }
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

function ShiftsView({
  employees,
  shifts,
  openShifts,
  generated,
  rules,
  isLoading,
  onAddOneOff,
  onEndShift,
  onDeleteOneOff,
  onAddRule,
  onDeleteRule,
  onToggleRule,
  onSkipInstance,
  onModifyInstance,
  onClearException,
}: {
  employees: Employee[];
  shifts: Shift[];
  openShifts: Shift[];
  generated: GeneratedShift[];
  rules: ShiftRule[];
  isLoading: boolean;
  onAddOneOff: (input: { employee_id: string; date: string; start_time: string; end_time: string | null }) => Promise<void>;
  onEndShift: (id: string, end_time: string) => Promise<void>;
  onDeleteOneOff: (id: string) => Promise<void>;
  onAddRule: (input: ShiftRuleInput) => Promise<void>;
  onDeleteRule: (id: string) => Promise<void>;
  onToggleRule: (id: string, active: boolean) => Promise<void>;
  onSkipInstance: (ruleId: string, date: string) => Promise<void>;
  onModifyInstance: (ruleId: string, date: string, start: string, end: string) => Promise<void>;
  onClearException: (ruleId: string, date: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<'oneoff' | 'recurring'>('oneoff');
  // List (default, current behavior) vs read-only Calendar view of the same rows.
  const [view, setView] = useState<'list' | 'calendar'>('list');

  // One-off form
  const [employeeId, setEmployeeId] = useState('');
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  // "Currently in shift": save with end_time NULL (open shift). Hides the End field.
  const [currentlyInShift, setCurrentlyInShift] = useState(false);

  // End-shift modal for closing an open shift (end defaults to now, editable).
  const [endingShift, setEndingShift] = useState<
    { id: string; name: string; date: string; start_time: string; end_time: string } | null
  >(null);

  // Ticks so open-shift elapsed durations update live (every 30s — minute-granularity display).
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

  // Edit-instance (modify exception) modal
  const [editing, setEditing] = useState<
    { ruleId: string; date: string; name: string; start: string; end: string } | null
  >(null);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of employees) m.set(e.id, e.name);
    return m;
  }, [employees]);

  // Employees who currently have an OPEN shift — the UI guard against a 2nd open shift.
  const openByEmployee = useMemo(() => {
    const m = new Set<string>();
    for (const s of openShifts) m.add(s.employee_id);
    return m;
  }, [openShifts]);

  // One-off shifts + generated recurring instances, newest first. Open shifts are
  // unioned in (deduped by id) so an in-progress shift is ALWAYS visible even if it
  // started before the selected pay period.
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
    return combined.sort(
      (a, b) => b.date.localeCompare(a.date) || a.start_time.localeCompare(b.start_time),
    );
  }, [shifts, openShifts, generated]);

  // Same rows, shaped for the read-only calendar. Skipped recurring instances are
  // excluded (a skipped day is NOT coverage). No new data — a pure re-projection.
  const calendarShifts = useMemo<CalendarShift[]>(
    () =>
      rows
        .filter((r) => !(r.kind === 'recurring' && r.skipped))
        .map((r) => ({
          id: r.id,
          kind: r.kind,
          employee_id: r.employee_id,
          date: r.date,
          start_time: r.start_time,
          end_time: r.end_time,
        })),
    [rows],
  );

  function toggleDay(v: number) {
    setRDays((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  }

  async function handleAddOneOff() {
    // Open shift: end is omitted; completed shift: end required (unchanged from before).
    if (!employeeId || !date || !startTime || (!currentlyInShift && !endTime)) {
      setError(
        currentlyInShift
          ? 'Employee, date and start time are required'
          : 'Employee, date, start and end time are all required',
      );
      return;
    }
    // Guard (UI): block a 2nd open shift for the same person. The DB partial unique
    // index is the authoritative backstop; this is the friendly pre-check.
    if (currentlyInShift && openByEmployee.has(employeeId)) {
      setError(`${nameById.get(employeeId) || 'This person'} already has an open shift — end it first.`);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onAddOneOff({
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

  // Elapsed since an open shift's start (date + start_time, local wall-clock) → "2h 14m".
  function elapsedLabel(dateStr: string, startTime: string): string {
    const start = new Date(`${dateStr}T${startTime}`).getTime();
    if (!Number.isFinite(start)) return '—';
    const mins = Math.max(0, Math.floor((nowTick - start) / 60000));
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  // Minutes since midnight for an 'HH:MM[:SS]' time.
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
    // Reject only a ZERO-LENGTH shift (end exactly equals start). end < start is a
    // valid OVERNIGHT shift (crossed midnight) — shiftHours() adds 24h for it, matching
    // how the rest of the app treats past-midnight ranges.
    if (minsOf(endingShift.end_time) === minsOf(endingShift.start_time)) {
      alert('End time must be different from the start time.');
      return;
    }
    try {
      await onEndShift(endingShift.id, endingShift.end_time.length === 5 ? `${endingShift.end_time}:00` : endingShift.end_time);
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
      await onAddRule({
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
      await onSkipInstance(row.rule_id, row.date);
    } catch (err) {
      alert((err as Error).message);
    }
  }

  // Restore (un-skip) or revert (un-modify): both just clear the date's exception.
  async function handleClear(row: Extract<DisplayRow, { kind: 'recurring' }>) {
    try {
      await onClearException(row.rule_id, row.date);
    } catch (err) {
      alert((err as Error).message);
    }
  }

  async function handleDeleteRule(rule: ShiftRule) {
    if (!confirm('Delete this recurring rule? Future shifts stop generating. Past pay already calculated is unaffected, and one-off shifts are untouched.')) return;
    try {
      await onDeleteRule(rule.id);
    } catch (err) {
      alert((err as Error).message);
    }
  }

  async function saveEditing() {
    if (!editing) return;
    if (!editing.start || !editing.end) {
      alert('Start and end time are required');
      return;
    }
    try {
      await onModifyInstance(editing.ruleId, editing.date, editing.start, editing.end);
      setEditing(null);
    } catch (err) {
      alert((err as Error).message);
    }
  }

  const inputCls =
    'w-full bg-white/5 border border-tt-border rounded-xl px-4 py-2.5 text-sm text-tt-text focus:outline-none focus:ring-1 focus:ring-tt-cyan/50';

  return (
    <div className="space-y-6">
      {/* List | Calendar view toggle (List is the default, unchanged view). */}
      <div className="flex items-center justify-end">
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

      {view === 'calendar' ? (
        <ShiftCalendar rows={calendarShifts} nameById={nameById} employees={employees} />
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
                onClick={() => {
                  setMode(m);
                  setError(null);
                }}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                  mode === m ? 'bg-white/10 text-tt-text' : 'text-tt-muted hover:text-tt-text'
                }`}
              >
                {m === 'oneoff' ? 'One-off' : 'Recurring'}
              </button>
            ))}
          </div>
        </div>

        {employees.length === 0 ? (
          <p className="text-sm text-tt-muted">Add an employee first before logging shifts.</p>
        ) : mode === 'oneoff' ? (
          <>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <Field label="Employee">
                <select
                  value={employeeId}
                  onChange={(e) => setEmployeeId(e.target.value)}
                  className={`${inputCls} appearance-none`}
                >
                  <option value="" className="bg-tt-card text-tt-muted">Select…</option>
                  {employees.map((e) => (
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
                <select
                  value={rEmployeeId}
                  onChange={(e) => setREmployeeId(e.target.value)}
                  className={`${inputCls} appearance-none`}
                >
                  <option value="" className="bg-tt-card text-tt-muted">Select…</option>
                  {employees.map((e) => (
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
          <div className="overflow-x-auto">
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
                        onClick={() => onToggleRule(r.id, !r.active)}
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
        </div>
      )}

      {/* Shift list (one-off + generated recurring) */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] backdrop-blur-xl overflow-hidden">
        <div className="px-6 py-5 border-b border-tt-border">
          <h2 className="text-base font-semibold text-tt-text">Shifts This Period</h2>
        </div>
        <div className="overflow-x-auto">
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
                        {row.modified && (
                          <span className="text-[10px] font-semibold px-2 py-1 rounded-md bg-tt-yellow/15 text-tt-yellow">Modified</span>
                        )}
                        {row.skipped && (
                          <span className="text-[10px] font-semibold px-2 py-1 rounded-md bg-tt-red/15 text-tt-red">Skipped</span>
                        )}
                      </span>
                    ) : isOpen ? (
                      <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-md bg-tt-green/15 text-tt-green">
                        <span className="w-1.5 h-1.5 rounded-full bg-tt-green animate-pulse" />In progress
                      </span>
                    ) : (
                      <span className="text-[10px] font-semibold px-2 py-1 rounded-md bg-tt-muted/15 text-tt-muted">One-off</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-xs text-tt-muted tabular-nums">{row.start_time.slice(0, 5)}</td>
                  <td className="px-5 py-3 text-xs text-tt-muted tabular-nums">{isOpen ? '—' : (row.end_time ?? '').slice(0, 5)}</td>
                  <td className={`px-5 py-3 text-[13px] text-right tabular-nums ${skipped ? 'text-tt-muted line-through' : isOpen ? 'text-tt-green' : 'text-tt-text'}`}>{isOpen ? elapsedLabel(row.date, row.start_time) : shiftHours(row.start_time, row.end_time).toFixed(2)}</td>
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
                                end_time: new Date().toTimeString().slice(0, 5), // default: now, editable
                              })
                            }
                            className="mr-2 px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-tt-green/15 text-tt-green hover:bg-tt-green/25 transition-colors"
                          >
                            Shift Ended
                          </button>
                        )}
                        <button
                          onClick={() => onDeleteOneOff(row.id)}
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
      </div>

      {/* Edit recurring instance (writes a 'modified' exception for that date) */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setEditing(null)} />
          <div className="relative bg-tt-card border border-tt-border rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl">
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
              <button
                onClick={() => setEditing(null)}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-tt-muted hover:text-tt-text bg-white/5 hover:bg-white/10 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={saveEditing}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-tt-cyan text-black hover:bg-tt-cyan/90 transition-colors"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* End an open shift — end defaults to NOW but is editable before saving. */}
      {endingShift && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setEndingShift(null)} />
          <div className="relative bg-tt-card border border-tt-border rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl">
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
              <input
                type="time"
                value={endingShift.end_time}
                onChange={(e) => setEndingShift({ ...endingShift, end_time: e.target.value })}
                className={inputCls}
              />
            </Field>
            <div className="flex gap-3 pt-5">
              <button
                onClick={() => setEndingShift(null)}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-tt-muted hover:text-tt-text bg-white/5 hover:bg-white/10 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={saveEndShift}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-tt-cyan text-black hover:bg-tt-cyan/90 transition-colors"
              >
                End Shift
              </button>
            </div>
          </div>
        </div>
      )}
      </>
      )}
    </div>
  );
}
