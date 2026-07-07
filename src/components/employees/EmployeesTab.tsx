'use client';

import { useMemo, useState } from 'react';
import { fmt } from '@/lib/calculations';
import { computePay, shiftHours, nextPayday, generateRecurringShifts, type GeneratedShift } from '@/lib/employees';
import { useEmployees, type EmployeeInput } from '@/hooks/useEmployees';
import { useShifts } from '@/hooks/useShifts';
import { useShiftRules, type ShiftRuleInput } from '@/hooks/useShiftRules';
import type { Employee, EmployeeStatus, Shift, ShiftRule } from '@/types';

interface EmployeesTabProps {
  // The selected pay period, driven by the dashboard's global FiltersBar. Nulls = all time.
  dateFrom: string | null;
  dateTo: string | null;
}

type SubView = 'roster' | 'shifts' | 'pay';

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
  const { shifts, isLoading: shiftsLoading, addShift, deleteShift } = useShifts(dateFrom, dateTo);
  const {
    rules,
    exceptions,
    isLoading: rulesLoading,
    addRule,
    toggleRuleActive,
    deleteRule,
    upsertException,
  } = useShiftRules();

  // Recurring instances computed for the selected period (rule − exceptions).
  const generated = useMemo(
    () => generateRecurringShifts(rules, exceptions, dateFrom, dateTo),
    [rules, exceptions, dateFrom, dateTo],
  );

  // Employee add/edit modal
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Employee | null>(null);
  const [form, setForm] = useState<EmployeeInput>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Pay counts one-off shifts + generated recurring instances for the period.
  const pay = useMemo(
    () => computePay(employees, [...shifts, ...generated]),
    [employees, shifts, generated],
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
          {(['roster', 'shifts', 'pay'] as SubView[]).map((v) => (
            <button
              key={v}
              onClick={() => setSubView(v)}
              className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                subView === v ? 'bg-white/10 text-tt-text' : 'text-tt-muted hover:text-tt-text hover:bg-white/5'
              }`}
            >
              {v === 'roster' ? 'Roster' : v === 'shifts' ? 'Shifts' : 'Pay'}
            </button>
          ))}
        </div>
        <span className="text-xs text-tt-muted">
          Period: <span className="text-tt-text font-medium">{periodLabel}</span>
        </span>
      </div>

      {subView === 'roster' && (
        <RosterView
          employees={employees}
          isLoading={isLoading}
          onAdd={openAdd}
          onEdit={openEdit}
          onDelete={handleDelete}
        />
      )}

      {subView === 'shifts' && (
        <ShiftsView
          employees={employees}
          shifts={shifts}
          generated={generated}
          rules={rules}
          isLoading={shiftsLoading || rulesLoading}
          onAddOneOff={async (input) => {
            await addShift.mutateAsync(input);
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
        />
      )}

      {subView === 'pay' && (
        <div className="bg-tt-card border border-tt-border rounded-[14px] backdrop-blur-xl overflow-hidden">
          <div className="px-6 py-5 border-b border-tt-border flex items-center justify-between">
            <h2 className="text-base font-semibold text-tt-text">Pay Owed</h2>
            <span className="text-xs text-tt-muted">{periodLabel}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-tt-border">
                  <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Employee</th>
                  <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Role</th>
                  <th className="text-right px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Hourly Rate</th>
                  <th className="text-right px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Hours</th>
                  <th className="text-right px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Pay Owed</th>
                  <th className="text-right px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Next Payday</th>
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
                    <td className="px-5 py-3 text-[13px] text-tt-text text-right tabular-nums">{nextPayday(employee.hire_date) ?? '—'}</td>
                  </tr>
                ))}
                {pay.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-5 py-12 text-center text-tt-muted text-sm">No employees yet</td>
                  </tr>
                )}
              </tbody>
              {pay.length > 0 && (
                <tfoot>
                  <tr className="border-t border-tt-border">
                    <td className="px-5 py-3 text-[13px] font-semibold text-tt-text" colSpan={3}>Total</td>
                    <td className="px-5 py-3 text-[13px] font-semibold text-tt-text text-right tabular-nums">{fmtHours(totals.hours)}</td>
                    <td className="px-5 py-3 text-[13px] font-semibold text-tt-green text-right tabular-nums">{fmt(totals.pay)}</td>
                    <td className="px-5 py-3" />
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
  onAdd,
  onEdit,
  onDelete,
}: {
  employees: Employee[];
  isLoading: boolean;
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
                <td colSpan={7} className="px-5 py-12 text-center text-tt-muted text-sm">
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
  | { kind: 'oneoff'; id: string; employee_id: string; date: string; start_time: string; end_time: string }
  | {
      kind: 'recurring';
      id: string;
      rule_id: string;
      employee_id: string;
      date: string;
      start_time: string;
      end_time: string;
      modified: boolean;
    };

function ShiftsView({
  employees,
  shifts,
  generated,
  rules,
  isLoading,
  onAddOneOff,
  onDeleteOneOff,
  onAddRule,
  onDeleteRule,
  onToggleRule,
  onSkipInstance,
  onModifyInstance,
}: {
  employees: Employee[];
  shifts: Shift[];
  generated: GeneratedShift[];
  rules: ShiftRule[];
  isLoading: boolean;
  onAddOneOff: (input: { employee_id: string; date: string; start_time: string; end_time: string }) => Promise<void>;
  onDeleteOneOff: (id: string) => Promise<void>;
  onAddRule: (input: ShiftRuleInput) => Promise<void>;
  onDeleteRule: (id: string) => Promise<void>;
  onToggleRule: (id: string, active: boolean) => Promise<void>;
  onSkipInstance: (ruleId: string, date: string) => Promise<void>;
  onModifyInstance: (ruleId: string, date: string, start: string, end: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<'oneoff' | 'recurring'>('oneoff');

  // One-off form
  const [employeeId, setEmployeeId] = useState('');
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');

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

  // One-off shifts + generated recurring instances, newest first.
  const rows = useMemo<DisplayRow[]>(() => {
    const combined: DisplayRow[] = [
      ...shifts.map(
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
        }),
      ),
    ];
    return combined.sort(
      (a, b) => b.date.localeCompare(a.date) || a.start_time.localeCompare(b.start_time),
    );
  }, [shifts, generated]);

  function toggleDay(v: number) {
    setRDays((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  }

  async function handleAddOneOff() {
    if (!employeeId || !date || !startTime || !endTime) {
      setError('Employee, date, start and end time are all required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onAddOneOff({ employee_id: employeeId, date, start_time: startTime, end_time: endTime });
      setDate('');
      setStartTime('');
      setEndTime('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
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
                <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className={inputCls} />
              </Field>
            </div>
            {error && <p className="text-xs text-tt-red mt-3">{error}</p>}
            <div className="mt-4">
              <button
                onClick={handleAddOneOff}
                disabled={submitting}
                className="px-4 py-2 rounded-lg bg-gradient-to-r from-tt-cyan to-[#4db8c0] text-black text-[13px] font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {submitting ? 'Adding…' : '+ Add Shift'}
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
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-[rgba(255,255,255,0.04)] hover:bg-tt-card-hover transition-colors">
                  <td className="px-5 py-3 text-xs text-tt-muted">{row.date}</td>
                  <td className="px-5 py-3 text-[13px] text-tt-text">{nameById.get(row.employee_id) || 'Unknown'}</td>
                  <td className="px-5 py-3">
                    {row.kind === 'recurring' ? (
                      <span className="inline-flex items-center gap-1">
                        <span className="text-[10px] font-semibold px-2 py-1 rounded-md bg-tt-cyan/15 text-tt-cyan">Recurring</span>
                        {row.modified && (
                          <span className="text-[10px] font-semibold px-2 py-1 rounded-md bg-tt-yellow/15 text-tt-yellow">Modified</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-[10px] font-semibold px-2 py-1 rounded-md bg-tt-muted/15 text-tt-muted">One-off</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-xs text-tt-muted tabular-nums">{row.start_time.slice(0, 5)}</td>
                  <td className="px-5 py-3 text-xs text-tt-muted tabular-nums">{row.end_time.slice(0, 5)}</td>
                  <td className="px-5 py-3 text-[13px] text-tt-text text-right tabular-nums">{shiftHours(row.start_time, row.end_time).toFixed(2)}</td>
                  <td className="px-5 py-3 text-center whitespace-nowrap">
                    {row.kind === 'oneoff' ? (
                      <button
                        onClick={() => onDeleteOneOff(row.id)}
                        className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-tt-red/15 text-tt-red hover:bg-tt-red/25 transition-colors"
                      >
                        Delete
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
              ))}
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
    </div>
  );
}
