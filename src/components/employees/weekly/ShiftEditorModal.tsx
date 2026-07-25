'use client';

import { useMemo, useState } from 'react';
import type { Employee } from '@/types';
import {
  validateShiftTimes,
  duplicatePrefill,
  addDaysISO,
  formatTime12,
  nextDayWeekday,
  type WeekShiftCard,
} from '@/lib/weeklySchedule';

// What the modal was opened for.
export type EditorIntent =
  | { mode: 'create'; employeeId: string; date: string } // empty cell / global add
  | { mode: 'card'; card: WeekShiftCard }; // clicked an existing shift

export interface EditorHandlers {
  employees: Employee[];
  nameById: (id: string) => string;
  onCreate: (input: { employee_id: string; date: string; start_time: string; end_time: string | null }) => Promise<void>;
  onUpdate: (id: string, patch: { start_time?: string; end_time?: string | null }) => Promise<void>;
  onDeleteOneOff: (id: string) => Promise<void>;
  onModifyOccurrence: (ruleId: string, date: string, start: string, end: string) => Promise<void>;
  onSkipOccurrence: (ruleId: string, date: string) => Promise<void>;
}

type FormKind = 'create' | 'edit' | 'duplicate' | 'occurrence';

interface FormState {
  kind: FormKind;
  employeeId: string;
  date: string;
  start: string;
  end: string;
  open: boolean;
  // context for save routing
  cardId?: string;
  ruleId?: string | null;
  lockEmployee: boolean;
  lockDate: boolean;
  allowOpen: boolean;
  title: string;
}

const inputCls =
  'w-full bg-white/5 border border-tt-border rounded-xl px-3 py-2 text-sm text-tt-text focus:outline-none focus:ring-1 focus:ring-tt-cyan/50';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[11px] text-tt-muted uppercase tracking-wide block mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function Shell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-tt-card border border-tt-border rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl" role="dialog" aria-modal="true">
        <div className="flex items-start justify-between mb-4">
          <h3 className="text-base font-semibold text-tt-text">{title}</h3>
          <button onClick={onClose} aria-label="Close" className="text-tt-muted hover:text-tt-text transition-colors p-1">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function ShiftEditorModal({
  intent,
  handlers,
  onClose,
}: {
  intent: EditorIntent;
  handlers: EditorHandlers;
  onClose: () => void;
}) {
  const { employees, nameById } = handlers;
  const card = intent.mode === 'card' ? intent.card : null;

  // The actions screen is only for an existing card; create goes straight to the form.
  const [showActions, setShowActions] = useState(intent.mode === 'card');
  const [form, setForm] = useState<FormState | null>(() =>
    intent.mode === 'create'
      ? {
          kind: 'create',
          employeeId: intent.employeeId,
          date: intent.date,
          start: '',
          end: '',
          open: false,
          lockEmployee: false,
          lockDate: false,
          allowOpen: true,
          title: 'Add shift',
        }
      : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validation = useMemo(
    () => (form ? validateShiftTimes(form.start, form.open ? null : form.end, { open: form.open }) : null),
    [form],
  );

  function startEdit() {
    if (!card) return;
    setForm({
      kind: 'edit',
      employeeId: card.employee_id,
      date: card.date,
      start: card.start_time.slice(0, 5),
      end: (card.end_time ?? '').slice(0, 5),
      open: card.isOpen,
      cardId: card.id,
      lockEmployee: true,
      lockDate: true,
      allowOpen: true,
      title: 'Edit shift',
    });
    setError(null);
    setShowActions(false);
  }

  function startEndOpen() {
    if (!card) return;
    const now = new Date().toTimeString().slice(0, 5);
    setForm({
      kind: 'edit',
      employeeId: card.employee_id,
      date: card.date,
      start: card.start_time.slice(0, 5),
      end: now,
      open: false,
      cardId: card.id,
      lockEmployee: true,
      lockDate: true,
      allowOpen: true,
      title: 'End shift',
    });
    setError(null);
    setShowActions(false);
  }

  function startDuplicate(destDate: string) {
    if (!card) return;
    const pre = duplicatePrefill(card);
    setForm({
      kind: 'duplicate',
      employeeId: pre.employee_id,
      date: destDate,
      start: pre.start_time.slice(0, 5),
      end: (pre.end_time ?? '').slice(0, 5),
      open: false,
      lockEmployee: true,
      lockDate: false,
      allowOpen: false,
      title: 'Duplicate shift',
    });
    setError(null);
    setShowActions(false);
  }

  function startModifyOccurrence() {
    if (!card) return;
    setForm({
      kind: 'occurrence',
      employeeId: card.employee_id,
      date: card.date,
      start: card.start_time.slice(0, 5),
      end: (card.end_time ?? '').slice(0, 5),
      open: false,
      ruleId: card.ruleId,
      lockEmployee: true,
      lockDate: true,
      allowOpen: false,
      title: 'Edit this occurrence',
    });
    setError(null);
    setShowActions(false);
  }

  async function handleDelete() {
    if (!card) return;
    if (!confirm('Delete this shift? This cannot be undone.')) return;
    setBusy(true);
    try {
      await handlers.onDeleteOneOff(card.id);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  async function handleSkip() {
    if (!card || !card.ruleId) return;
    if (!confirm(`Skip this recurring shift on ${card.date}? The rule keeps generating other days.`)) return;
    setBusy(true);
    try {
      await handlers.onSkipOccurrence(card.ruleId, card.date);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  async function handleSave() {
    if (!form || !validation) return;
    if (!validation.ok) {
      setError(validation.error);
      return;
    }
    if (!form.employeeId) {
      setError('Please choose an employee.');
      return;
    }
    if (!form.date) {
      setError('Please choose a date.');
      return;
    }
    // Confirm overnight so it's never a surprise.
    if (validation.overnight && !confirm('This shift ends the next day (overnight). Save it?')) return;

    setBusy(true);
    setError(null);
    const end = form.open ? null : form.end;
    try {
      if (form.kind === 'create' || form.kind === 'duplicate') {
        await handlers.onCreate({ employee_id: form.employeeId, date: form.date, start_time: form.start, end_time: end });
      } else if (form.kind === 'edit' && form.cardId) {
        await handlers.onUpdate(form.cardId, { start_time: form.start, end_time: end });
      } else if (form.kind === 'occurrence' && form.ruleId) {
        await handlers.onModifyOccurrence(form.ruleId, form.date, form.start, form.end);
      }
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  // ── Actions screen (existing card) ──────────────────────────────────────────
  if (showActions && card) {
    const frozen = card.isFrozen;
    const recurring = card.kind === 'recurring';
    const btn = 'w-full text-left px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors';
    return (
      <Shell title="Shift" onClose={onClose}>
        <p className="text-xs text-tt-muted mb-4">
          {nameById(card.employee_id)} · {card.date} · {formatTime12(card.start_time)}
          {card.isOpen ? ' – open' : `–${formatTime12(card.end_time as string)}`}
          {card.isOvernight && ` · Ends ${nextDayWeekday(card.date)}`}
        </p>

        {frozen && (
          <p className="text-[11px] text-tt-muted mb-3 p-3 rounded-xl bg-white/5">
            This is a logged recurring shift (payroll history). It can&apos;t be edited or deleted here —
            manage the rule under <span className="text-tt-text font-medium">Recurring Shifts</span>. You can still copy it to another day.
          </p>
        )}

        <div className="space-y-2">
          {!recurring && !card.isOpen && (
            <button className={`${btn} bg-tt-cyan/15 text-tt-cyan hover:bg-tt-cyan/25`} onClick={startEdit}>Edit</button>
          )}
          {!recurring && card.isOpen && (
            <>
              <button className={`${btn} bg-tt-green/15 text-tt-green hover:bg-tt-green/25`} onClick={startEndOpen}>End shift (set end time)</button>
              <button className={`${btn} bg-tt-cyan/15 text-tt-cyan hover:bg-tt-cyan/25`} onClick={startEdit}>Edit start time</button>
            </>
          )}
          {recurring && !frozen && (
            <>
              <button className={`${btn} bg-tt-cyan/15 text-tt-cyan hover:bg-tt-cyan/25`} onClick={startModifyOccurrence}>Edit this occurrence</button>
              <button className={`${btn} bg-tt-red/15 text-tt-red hover:bg-tt-red/25`} onClick={handleSkip} disabled={busy}>Skip this day</button>
            </>
          )}
          <button className={`${btn} bg-white/5 text-tt-text hover:bg-white/10`} onClick={() => startDuplicate(card.date)}>Duplicate</button>
          <button className={`${btn} bg-white/5 text-tt-text hover:bg-white/10`} onClick={() => startDuplicate(addDaysISO(card.date, 1))}>Copy to another day…</button>
          {!recurring && (
            <button className={`${btn} bg-tt-red/15 text-tt-red hover:bg-tt-red/25`} onClick={handleDelete} disabled={busy}>Delete</button>
          )}
        </div>

        {error && <p className="text-xs text-tt-red mt-3">{error}</p>}
      </Shell>
    );
  }

  // ── Form screen (create / edit / duplicate / occurrence) ─────────────────────
  if (!form) return null;
  const empName = form.employeeId ? nameById(form.employeeId) : '';

  return (
    <Shell title={form.title} onClose={onClose}>
      <div className="space-y-3">
        {/* Employee */}
        {form.lockEmployee ? (
          <div className="text-xs text-tt-muted">Employee: <span className="text-tt-text font-medium">{empName || 'Unknown'}</span></div>
        ) : (
          <Field label="Employee">
            <select
              value={form.employeeId}
              onChange={(e) => setForm({ ...form, employeeId: e.target.value })}
              className={`${inputCls} appearance-none`}
            >
              <option value="" className="bg-tt-card text-tt-muted">Select…</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id} className="bg-tt-card text-tt-text">{e.name}</option>
              ))}
            </select>
          </Field>
        )}

        {/* Date */}
        {form.lockDate ? (
          <div className="text-xs text-tt-muted">Date: <span className="text-tt-text font-medium tabular-nums">{form.date}</span></div>
        ) : (
          <Field label={form.kind === 'duplicate' ? 'Copy to date' : 'Date'}>
            <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className={inputCls} />
          </Field>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Start">
            <input type="time" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} className={inputCls} />
          </Field>
          <Field label="End">
            {form.open ? (
              <div className={`${inputCls} flex items-center text-tt-muted`}>In progress</div>
            ) : (
              <input type="time" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} className={inputCls} />
            )}
          </Field>
        </div>

        {form.allowOpen && (
          <label className="flex items-center gap-2 cursor-pointer select-none w-fit">
            <input
              type="checkbox"
              checked={form.open}
              onChange={(e) => setForm({ ...form, open: e.target.checked })}
              className="accent-tt-cyan w-4 h-4"
            />
            <span className="text-[13px] text-tt-text">Currently in shift <span className="text-tt-muted">(no end time yet)</span></span>
          </label>
        )}

        {/* Live duration + overnight / long-shift messaging */}
        {validation && (
          <div className="text-xs rounded-xl bg-white/5 px-3 py-2 space-y-0.5">
            {form.open ? (
              <p className="text-tt-muted">Open shift — no end time yet. Won&apos;t count toward hours until ended.</p>
            ) : validation.ok ? (
              <>
                <p className="text-tt-text">
                  {formatTime12(form.start)}–{formatTime12(form.end)} · <span className="font-semibold tabular-nums">{validation.hours.toFixed(2)} h</span>
                </p>
                {validation.overnight && (
                  <p className="text-tt-yellow">🌙 Ends the next day{form.date ? ` (${nextDayWeekday(form.date)})` : ''} — overnight.</p>
                )}
                {validation.longWarning && <p className="text-tt-yellow">⚠ Unusually long shift ({validation.hours.toFixed(1)}h) — double-check the times.</p>}
              </>
            ) : (
              <p className="text-tt-red">{validation.error}</p>
            )}
          </div>
        )}

        {error && <p className="text-xs text-tt-red">{error}</p>}

        <div className="flex gap-3 pt-1">
          <button
            onClick={() => (intent.mode === 'card' ? setShowActions(true) : onClose())}
            disabled={busy}
            className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-tt-muted hover:text-tt-text bg-white/5 hover:bg-white/10 transition-colors disabled:opacity-50"
          >
            {intent.mode === 'card' ? 'Back' : 'Cancel'}
          </button>
          <button
            onClick={handleSave}
            disabled={busy || (validation != null && !validation.ok)}
            className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-tt-cyan text-black hover:bg-tt-cyan/90 transition-colors disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Shell>
  );
}
