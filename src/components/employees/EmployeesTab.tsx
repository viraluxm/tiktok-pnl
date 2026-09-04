'use client';

import { useState, useEffect, useMemo } from 'react';
import { fmt } from '@/lib/calculations';
import { useEmployees, type EmployeeInput } from '@/hooks/useEmployees';
import { useShiftInstances } from '@/hooks/useShiftInstances';
import type { Employee, EmployeeStatus, ShiftInstance } from '@/types';
import { laTodayISO, addDaysISO } from '@/lib/schedule/timezone';
import { weekDatesFor, isWorkingInstance, type ScheduleCounts } from '@/lib/schedule/schedulePlan';
import EmployeeScheduleBuilder from './schedule/EmployeeScheduleBuilder';
import PerformanceView from './PerformanceView';
import { useHostPerformance, type HostAgg } from '@/hooks/useHostPerformance';
import ShiftsView from './ShiftsView';
import PayView from './PayView';
import { Field, titleCase, ROLE_PRESETS, STATUSES } from './shared';
import RosterGrid from './RosterGrid';
import EmployeeDetailModal from './EmployeeDetailModal';
import { useScheduleLinks, scheduleLinkUrl, type ScheduleLink } from '@/hooks/useScheduleLinks';
import { ScheduleLinkSection, LINK_WARNING, copyText } from './ScheduleLinkButton';
import { useBadges, type ActiveBadge } from '@/hooks/useBadges';
import { useOverridePins } from '@/hooks/useOverridePins';

interface EmployeesTabProps {
  // The selected period, driven by the dashboard's global FiltersBar. Nulls = all time.
  // Consumed by the Shifts List view (production behavior).
  dateFrom: string | null;
  dateTo: string | null;
}

// Production Team navigation: Roster · Shifts · Pay · Performance. Each view owns its own
// data hooks, so opening Team (default Roster) doesn't fetch shift history — only the
// mounted view fetches. The weekly grid lives inside Shifts → Calendar (see ShiftsView).
// Performance holds a Live Hosts | Fulfillment selector (see PerformanceView).
type SubView = 'roster' | 'shifts' | 'pay' | 'performance';

const EMPTY_FORM: EmployeeInput = {
  name: '',
  role: 'host',
  status: 'active',
  hourly_rate: 0,
  hire_date: null,
  probation_end_date: null,
  fulfillment_track: null,
};

export default function EmployeesTab({ dateFrom, dateTo }: EmployeesTabProps) {
  const [subView, setSubView] = useState<SubView>('roster');

  // One-shot: land on a specific sub-tab when a flow requested it (e.g. Exit Kiosk → Shifts).
  useEffect(() => {
    const s = sessionStorage.getItem('lensed.employeesSubView');
    if (!s) return;
    sessionStorage.removeItem('lensed.employeesSubView');
    if (s === 'roster' || s === 'shifts' || s === 'pay' || s === 'performance') {
      setSubView(s);
    }
  }, []);
  const { employees, isLoading, addEmployee, updateEmployee, deleteEmployee } = useEmployees();
  // Per-host auction badges (Roster). Read-only; empty until 056 attribution accrues.
  const { data: hostPerf } = useHostPerformance();
  // Schedule-link tokens (roster Create/Copy + Edit-modal Revoke/Regenerate).
  const { byEmployee: links, mint: mintLink, revoke: revokeLink } = useScheduleLinks();
  const [linkWarn, setLinkWarn] = useState(false); // shows LINK_WARNING after a link is created
  // Per-employee badge state (roster Issue/Reissue) — a second entry point onto /api/admin/badges,
  // the same routes /admin/badges uses. The rotating QR is NOT provisioned per employee and has no
  // roster action — it's minted on demand from the schedule link.
  const { byEmployee: badges, issue: issueBadge, reissue: reissueBadge } = useBadges();
  // Which employees can authorise a pick override. Having a PIN IS being a lead.
  const { hasPin, setPin: setOverridePin } = useOverridePins();

  // Employee add/edit modal
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Employee | null>(null);
  const [form, setForm] = useState<EmployeeInput>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

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
      fulfillment_track: e.fulfillment_track ?? null,
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

  // Optional convenience: name + URL pairs for every active employee that has a link, for sending
  // one-to-one. (The SMS path supersedes this once phone numbers are live.)
  async function copyAllLinks(): Promise<boolean> {
    const lines = employees
      .filter((e) => e.status === 'active' && links[e.id])
      .map((e) => `${e.name}: ${scheduleLinkUrl(links[e.id].token)}`);
    if (lines.length === 0) return false;
    return copyText(lines.join('\n'));
  }

  const periodLabel = dateFrom || dateTo ? `${dateFrom || '…'} → ${dateTo || '…'}` : 'All time';

  return (
    <div>
      {/* Sub navigation */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div className="flex flex-wrap gap-2">
          {(['roster', 'shifts', 'pay', 'performance'] as SubView[]).map((v) => (
            <button
              key={v}
              onClick={() => setSubView(v)}
              className={`inline-flex items-center justify-center min-h-[44px] md:min-h-0 px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                subView === v ? 'bg-white/10 text-tt-text' : 'text-tt-muted hover:text-tt-text hover:bg-white/5'
              }`}
            >
              {v === 'roster' ? 'Roster' : v === 'shifts' ? 'Shifts' : v === 'pay' ? 'Pay' : 'Performance'}
            </button>
          ))}
        </div>
        {/* The FiltersBar drives the Shifts List view; the Pay view is scoped to its OWN
            biweekly pay period, and the Calendar to its own week — so hide this label there. */}
        {subView !== 'pay' && subView !== 'performance' && (
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
          links={links}
          onMintLink={(id) => mintLink.mutateAsync(id)}
          onLinkCreated={() => setLinkWarn(true)}
          badges={badges}
          onIssueBadge={issueBadge}
          onReissueBadge={reissueBadge}
          leadPins={hasPin}
          onSetLeadPin={(employeeId, pin) => setOverridePin.mutateAsync({ employeeId, pin })}
          onCopyAll={copyAllLinks}
          linkWarn={linkWarn}
          onDismissWarn={() => setLinkWarn(false)}
          onAdd={openAdd}
          onEdit={openEdit}
          onDelete={handleDelete}
        />
      )}

      {subView === 'shifts' && <ShiftsView employees={employees} dateFrom={dateFrom} dateTo={dateTo} />}

      {subView === 'pay' && <PayView employees={employees} />}

      {subView === 'performance' && <PerformanceView />}

      {/* Add / edit employee modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={closeModal} />
          <div className="relative bg-tt-card border border-tt-border rounded-t-2xl sm:rounded-2xl p-6 w-full max-w-md sm:mx-4 max-h-[90dvh] overflow-y-auto shadow-2xl">
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
                    onChange={(e) => setForm({
                      ...form,
                      role: e.target.value,
                      // Leaving fulfillment clears the track — a host must never carry
                      // 'packer', which would show up as a phantom bucket on the cost roll-up.
                      fulfillment_track: e.target.value === 'fulfillment' ? form.fulfillment_track : null,
                    })}
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

              {/* Fulfillment sub-type. Only offered for role 'fulfillment' — it is meaningless
                  on a host, and a stray value would create a phantom bucket on the cost
                  roll-up. DISPLAY AND GROUPING ONLY: nothing gates on it, so a Packer stays a
                  fully eligible picker and a wrong setting can never lock anyone out of
                  picking mid-shift (migration 121). */}
              {form.role === 'fulfillment' && (
                <Field label="Fulfillment Track">
                  <select
                    value={form.fulfillment_track ?? ''}
                    onChange={(e) => setForm({
                      ...form,
                      fulfillment_track: (e.target.value || null) as EmployeeInput['fulfillment_track'],
                    })}
                    className="w-full bg-white/5 border border-tt-border rounded-xl px-4 py-2.5 text-sm text-tt-text focus:outline-none focus:ring-1 focus:ring-tt-cyan/50 appearance-none"
                  >
                    <option value="" className="bg-tt-card text-tt-text">Unset</option>
                    <option value="picker" className="bg-tt-card text-tt-text">Picker</option>
                    <option value="packer" className="bg-tt-card text-tt-text">Packer</option>
                    <option value="flex" className="bg-tt-card text-tt-text">Flex — picks, packs, or floats</option>
                  </select>
                  <p className="mt-1.5 text-[11px] text-tt-muted">
                    Groups the fulfillment cost report. Does not restrict anything — every
                    fulfillment employee can still be credited with a pick.
                  </p>
                </Field>
              )}

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

              {/* Schedule link — only for an existing employee (needs an id). Rare rotate/revoke. */}
              {editing && (
                <ScheduleLinkSection
                  link={links[editing.id] ?? null}
                  onMint={() => mintLink.mutateAsync(editing.id)}
                  onRevoke={(id) => revokeLink.mutateAsync(id)}
                  onCreated={() => setLinkWarn(true)}
                />
              )}

              {formError && (
                <div className="p-3 bg-tt-red/10 rounded-xl">
                  <p className="text-xs text-tt-red">{formError}</p>
                </div>
              )}

              <div className="flex gap-3 pt-1 pb-[env(safe-area-inset-bottom)]">
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

function RosterView({
  employees,
  isLoading,
  hostPerf,
  links,
  onMintLink,
  onLinkCreated,
  badges,
  onIssueBadge,
  onReissueBadge,
  leadPins,
  onSetLeadPin,
  onCopyAll,
  linkWarn,
  onDismissWarn,
  onAdd,
  onEdit,
  onDelete,
}: {
  employees: Employee[];
  isLoading: boolean;
  hostPerf: Record<string, HostAgg>;
  links: Record<string, ScheduleLink>;
  onMintLink: (employeeId: string) => Promise<{ url: string }>;
  onLinkCreated: () => void;
  badges: Record<string, ActiveBadge>;
  onIssueBadge: (employeeId: string) => Promise<void>;
  onReissueBadge: (employeeId: string, badgeId: string) => Promise<void>;
  /** Employees who can authorise a pick override. Having a PIN is being a lead. */
  leadPins: Set<string>;
  onSetLeadPin: (employeeId: string, pin: string | null) => Promise<unknown>;
  onCopyAll: () => Promise<boolean>;
  linkWarn: boolean;
  onDismissWarn: () => void;
  onAdd: () => void;
  onEdit: (e: Employee) => void;
  onDelete: (e: Employee) => void;
}) {
  const [copiedAll, setCopiedAll] = useState(false);
  const [detail, setDetail] = useState<Employee | null>(null);
  const [builderFor, setBuilderFor] = useState<Employee | null>(null);
  const [scheduleNotice, setScheduleNotice] = useState<string | null>(null);
  const anyLinks = employees.some((e) => e.status === 'active' && links[e.id]);

  // Upcoming plan for the whole roster in ONE query: this Mon→Sun week (for the tile counts)
  // through four weeks out (for "Next shift" in the detail). Real shift_instances only — the same
  // ['shift_instances', …] cache prefix the builder invalidates on save, so it refreshes itself.
  // "Now" is captured once when the roster mounts (a useState initializer is the sanctioned place
  // for an impure read) — good enough to decide which shift is "next" for a roster that is open
  // for minutes, not days.
  const [nowMs] = useState(() => Date.now());
  const today = useMemo(() => laTodayISO(new Date(nowMs)), [nowMs]);
  const thisWeek = useMemo(() => weekDatesFor(today), [today]);
  const { instances: upcoming, isLoading: upcomingLoading } = useShiftInstances(thisWeek[0], addDaysISO(today, 28));
  const { weekCounts, nextShiftById } = useMemo(() => {
    const weekCounts: Record<string, number> = {};
    const nextShiftById: Record<string, ShiftInstance> = {};
    const inWeek = new Set(thisWeek);
    for (const i of upcoming) {
      if (!isWorkingInstance(i) || !i.employee_id) continue;
      if (inWeek.has(i.shift_date)) weekCounts[i.employee_id] = (weekCounts[i.employee_id] ?? 0) + 1;
      // "Next" = the earliest shift that has not ended yet (an in-progress shift still counts).
      if (Date.parse(i.ends_at) > nowMs) {
        const cur = nextShiftById[i.employee_id];
        if (!cur || i.starts_at < cur.starts_at) nextShiftById[i.employee_id] = i;
      }
    }
    return { weekCounts, nextShiftById };
  }, [upcoming, thisWeek, nowMs]);

  function openDetail(e: Employee) {
    setScheduleNotice(null);
    setDetail(e);
  }

  function onScheduleSaved(counts: ScheduleCounts, weekCount: number) {
    const changed = counts.created + counts.updated + counts.removed;
    setScheduleNotice(
      changed === 0
        ? 'No changes'
        : `Saved · ${counts.created} added${counts.updated ? `, ${counts.updated} changed` : ''}${counts.removed ? `, ${counts.removed} removed` : ''}${weekCount > 1 ? ` over ${weekCount} weeks` : ''}`,
    );
  }

  async function handleCopyAll() {
    if (await onCopyAll()) {
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 1800);
    }
  }

  return (
    <div className="bg-tt-card border border-tt-border rounded-[14px] backdrop-blur-xl overflow-hidden">
      <div className="px-6 py-5 border-b border-tt-border flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-tt-text">Team Roster</h2>
        <div className="flex items-center gap-2">
          {anyLinks && (
            <button
              onClick={handleCopyAll}
              className="px-3 py-2 rounded-lg text-[13px] font-semibold bg-white/5 text-tt-text hover:bg-white/10 transition-colors"
            >
              {copiedAll ? 'Copied ✓' : 'Copy all links'}
            </button>
          )}
          <button
            onClick={onAdd}
            className="px-4 py-2 rounded-lg bg-gradient-to-r from-tt-cyan to-[#4db8c0] text-black text-[13px] font-semibold hover:opacity-90 transition-opacity"
          >
            + Add Employee
          </button>
        </div>
      </div>

      {/* Personal-link warning — surfaced when a link is created (a real property of the token). */}
      {linkWarn && (
        <div className="px-6 py-3 border-b border-tt-border bg-tt-yellow/10 flex items-start justify-between gap-3">
          <p className="text-xs text-tt-yellow">{LINK_WARNING}</p>
          <button onClick={onDismissWarn} className="shrink-0 text-tt-yellow/70 hover:text-tt-yellow text-xs">Dismiss</button>
        </div>
      )}
      <RosterGrid employees={employees} isLoading={isLoading} onOpen={openDetail} weekCounts={upcomingLoading ? undefined : weekCounts} />

      {detail && (
        <EmployeeDetailModal
          employee={detail}
          hostAgg={hostPerf[detail.id]}
          link={links[detail.id]}
          badge={badges[detail.id] ?? null}
          hourlyRate={fmt(detail.hourly_rate)}
          schedule={{
            isLoading: upcomingLoading,
            nextShift: nextShiftById[detail.id] ?? null,
            weekCount: weekCounts[detail.id] ?? 0,
          }}
          onOpenSchedule={() => setBuilderFor(detail)}
          scheduleNotice={scheduleNotice}
          onClose={() => setDetail(null)}
          onMintLink={onMintLink}
          onLinkCreated={onLinkCreated}
          onIssueBadge={onIssueBadge}
          onReissueBadge={onReissueBadge}
          onEdit={onEdit}
          onDelete={onDelete}
          hasOverridePin={leadPins.has(detail.id)}
          onSetOverridePin={onSetLeadPin}
        />
      )}

      {/* Stacks above the detail (z-60 vs z-50); closing it returns to the refreshed detail. */}
      {builderFor && (
        <EmployeeScheduleBuilder
          employee={builderFor}
          onClose={() => setBuilderFor(null)}
          onSaved={onScheduleSaved}
        />
      )}
    </div>
  );
}
