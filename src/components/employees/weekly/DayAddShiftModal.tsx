'use client';

import { useMemo, useState } from 'react';
import type { Employee } from '@/types';
import { validateShiftTimes } from '@/lib/weeklySchedule';
import PersonAvatar from './PersonAvatar';
import HoverCard, { type HoverPayload } from './HoverCard';

// Add people to ONE day, opened by clicking that day. The date is already known, so it is a
// heading rather than a field, and the employee picker is a multi-select icon grid — a crew that
// shares a shift is one action, not one dialog each.
//
// ── Why there are two modes ───────────────────────────────────────────────────
// These write to DIFFERENT tables with different consequences, and the distinction is the whole
// reason this modal exists:
//
//   Scheduled Shift      → `shift_instances`. The PLAN. Never payable. This is what a biweekly
//                           schedule is made of, and what the personal clock-in links check against.
//   Worked / Missed Punch → `shifts` with source 'manual'. A payable time entry, exactly like a
//                           punch (isPayableShift pays a manual row, with no separate confirmation
//                           step — the manager entering it IS the approval). This is the MANAGER
//                           CORRECTION workflow: forgot to clock in, forgot to clock out with no
//                           usable punch, worked before being added to Lensed, or a historical
//                           day being backfilled. Any date is allowed, including the past.
//
// Defaulting to Scheduled matters. If building next fortnight's schedule wrote payable rows,
// every future shift would become hours owed with nobody having worked them.
//
// The worked mode is deliberately DEMOTED: it lives behind an "Advanced" disclosure with its own
// warning and a differently-coloured save button, because the two outcomes were previously two
// equal-weight tabs and picking the wrong one is a silent payroll error. It stays here (rather than
// being removed) because this modal is currently the only manager surface that can record a missed
// punch as worked time; a dedicated correction surface is a later change.

type Mode = 'scheduled' | 'worked';

function titleCaseRole(role: string | null | undefined): string {
  const r = (role ?? '').trim();
  return r ? r.charAt(0).toUpperCase() + r.slice(1).toLowerCase() : 'No role set';
}

// The picker shows initials only, so the card is the only place a name appears — build it the
// same way for pointer and keyboard.
function hoverFor(el: HTMLElement, name: string, role: string | null | undefined, selected: boolean): HoverPayload {
  const r = el.getBoundingClientRect();
  return {
    x: r.left + r.width / 2,
    y: r.top,
    head: name,
    lines: [titleCaseRole(role), selected ? 'Selected — click to remove' : 'Click to add'],
  };
}

export default function DayAddShiftModal({
  dateLabel,
  employees,
  onClose,
  onCreateScheduled,
  onCreateWorked,
}: {
  dateLabel: string;
  employees: Employee[];
  onClose: () => void;
  onCreateScheduled: (employeeIds: string[], startTime: string, endTime: string) => Promise<void>;
  onCreateWorked: (employeeIds: string[], startTime: string, endTime: string | null) => Promise<void>;
}) {
  const [mode, setMode] = useState<Mode>('scheduled');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [openEnded, setOpenEnded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<HoverPayload | null>(null);

  // Former staff can't be scheduled or paid.
  const selectable = useMemo(
    () => employees.filter((e) => e.status !== 'former').sort((a, b) => a.name.localeCompare(b.name)),
    [employees],
  );
  const grouped = useMemo(() => {
    const g: { label: string; list: Employee[] }[] = [];
    for (const key of ['fulfillment', 'host']) {
      const list = selectable.filter((e) => (e.role ?? '').trim().toLowerCase() === key);
      if (list.length) g.push({ label: key === 'host' ? 'Live Hosts' : 'Fulfillment', list });
    }
    const rest = selectable.filter((e) => !['fulfillment', 'host'].includes((e.role ?? '').trim().toLowerCase()));
    if (rest.length) g.push({ label: 'Other', list: rest });
    return g;
  }, [selectable]);

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // 'worked' + open-ended is the only case with no end time (they clock out normally later).
  const isOpen = mode === 'worked' && openEnded;
  const check = start && (end || isOpen) ? validateShiftTimes(start, isOpen ? null : end) : null;

  async function save() {
    setError(null);
    if (picked.size === 0) return setError('Pick at least one person.');
    if (!start) return setError('Start time is required.');
    if (!isOpen && !end) return setError('End time is required.');
    setBusy(true);
    try {
      const ids = [...picked];
      if (mode === 'scheduled') await onCreateScheduled(ids, start, end);
      else await onCreateWorked(ids, start, isOpen ? null : end);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm sm:p-8"
      onClick={onClose} role="dialog" aria-modal="true" aria-label={`Add shifts on ${dateLabel}`}
    >
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-2xl rounded-[16px] border border-tt-border bg-tt-card p-5 shadow-2xl backdrop-blur-xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-tt-text">
              {mode === 'worked' ? `Record worked time on ${dateLabel}` : `Schedule for ${dateLabel}`}
            </h3>
            <p className="mt-0.5 text-xs text-tt-muted">
              {picked.size === 0 ? 'Pick everyone who shares this shift.' : `${picked.size} selected`}
            </p>
          </div>
          <button
            type="button" onClick={onClose} aria-label="Close"
            className="h-8 w-8 shrink-0 rounded-lg border border-tt-border text-tt-muted transition-colors hover:bg-tt-card-hover hover:text-tt-text"
          >✕</button>
        </div>

        <p className={`mb-4 rounded-lg border px-3 py-2 text-[11px] leading-snug ${
          mode === 'worked' ? 'border-tt-yellow/40 bg-tt-yellow/10 text-tt-yellow' : 'border-tt-border bg-white/[0.02] text-tt-muted'
        }`}>
          {mode === 'scheduled'
            ? 'Adds these people to the schedule for this day. This never adds worked hours to payroll.'
            : 'Creates payable worked time — exactly like a punch, counted toward payroll immediately. Use only when no usable time-clock record exists.'}
        </p>

        {/* Employee picker */}
        <div className="mb-4 max-h-[280px] space-y-3 overflow-y-auto">
          {grouped.map((g) => (
            <div key={g.label}>
              <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-tt-muted">{g.label}</div>
              <div className="flex flex-wrap gap-2">
                {g.list.map((e) => {
                  const on = picked.has(e.id);
                  return (
                    <button
                      key={e.id} type="button" onClick={() => toggle(e.id)} aria-pressed={on}
                      aria-label={e.name}
                      // Pointer and keyboard get the SAME card — a keyboard user picking from 41
                      // initials needs the name at least as much as a mouse user does.
                      onMouseEnter={(ev) => setHover(hoverFor(ev.currentTarget, e.name, e.role, on))}
                      onMouseLeave={() => setHover(null)}
                      onFocus={(ev) => setHover(hoverFor(ev.currentTarget, e.name, e.role, on))}
                      onBlur={() => setHover(null)}
                      className={`rounded-full p-0.5 transition-transform hover:scale-110 focus:outline-none ${
                        on ? 'ring-2 ring-tt-cyan' : 'ring-1 ring-transparent'
                      }`}
                    >
                      <PersonAvatar name={e.name} state={on ? 'confirmed' : 'scheduled'} size="lg" title={null} />
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Times */}
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-tt-muted">Start</span>
            <input
              type="time" value={start} onChange={(e) => setStart(e.target.value)}
              className="w-full rounded-xl border border-tt-input-border bg-tt-input-bg px-3 py-2.5 text-sm text-tt-text focus:border-tt-cyan focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-tt-muted">End</span>
            <input
              type="time" value={end} disabled={isOpen} onChange={(e) => setEnd(e.target.value)}
              className="w-full rounded-xl border border-tt-input-border bg-tt-input-bg px-3 py-2.5 text-sm text-tt-text focus:border-tt-cyan focus:outline-none disabled:opacity-40"
            />
          </label>
        </div>

        {/* Advanced: the payable correction path. Collapsed by default so scheduling a crew never
            shows a payroll control; opening it is an explicit act. */}
        <details className="mt-3 rounded-lg border border-tt-border bg-white/[0.02]" open={mode === 'worked'}>
          <summary className="cursor-pointer select-none px-3 py-2 text-[11px] font-semibold text-tt-muted hover:text-tt-text">
            Advanced · Record worked time instead
          </summary>
          <div className="space-y-2 border-t border-tt-border px-3 py-2">
            <label className="flex items-start gap-2 text-sm text-tt-text">
              <input
                type="checkbox" checked={mode === 'worked'} className="mt-0.5 h-4 w-4"
                onChange={(e) => { setMode(e.target.checked ? 'worked' : 'scheduled'); if (!e.target.checked) setOpenEnded(false); }}
              />
              <span>
                Record as <span className="font-semibold">worked time (payable)</span>
                <span className="block text-[11px] text-tt-muted">For a missed punch: forgot to clock in/out, or worked before being added. Pays these hours.</span>
              </span>
            </label>
            {mode === 'worked' && (
              <label className="flex items-center gap-2 pl-6 text-sm text-tt-text">
                <input type="checkbox" checked={openEnded} onChange={(e) => setOpenEnded(e.target.checked)} className="h-4 w-4" />
                Currently in shift <span className="text-tt-muted">(no end time yet — they clock out normally)</span>
              </label>
            )}
          </div>
        </details>

        {check && (
          <p className={`mt-3 rounded-lg px-3 py-2 text-[11px] ${check.error ? 'bg-tt-red/10 text-tt-red' : 'bg-white/[0.03] text-tt-muted'}`}>
            {check.error ?? [
              isOpen ? 'Open shift — no end time yet.' : `${check.hours} h each`,
              check.overnight ? 'Ends the next day — overnight.' : null,
              check.longWarning ? '⚠ Unusually long — double-check the times.' : null,
            ].filter(Boolean).join(' · ')}
          </p>
        )}
        {error && <p className="mt-3 rounded-lg bg-tt-red/10 px-3 py-2 text-[11px] text-tt-red">{error}</p>}

        <HoverCard hover={hover} />

        <div className="mt-4 flex gap-3">
          <button
            type="button" onClick={onClose}
            className="flex-1 rounded-xl bg-white/5 py-2.5 text-sm font-semibold text-tt-muted transition-colors hover:bg-white/10 hover:text-tt-text"
          >Cancel</button>
          <button
            type="button" onClick={save} disabled={busy || picked.size === 0}
            className={`flex-1 rounded-xl py-2.5 text-sm font-semibold text-black transition-colors disabled:opacity-50 ${
              mode === 'worked' ? 'bg-tt-yellow hover:bg-tt-yellow/90' : 'bg-tt-cyan hover:bg-tt-cyan/90'
            }`}
          >
            {busy ? 'Saving…'
              : mode === 'worked' ? (picked.size > 1 ? `Record worked time · ${picked.size}` : 'Record worked time')
                : picked.size > 1 ? `Schedule ${picked.size} people` : 'Schedule shift'}
          </button>
        </div>
      </div>
    </div>
  );
}
