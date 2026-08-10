'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Employee } from '@/types';
import { Field, inputCls } from './shared';

// POST ONE-TIME SHIFT — writes to `shift_instances` (migration 090), NOT `shifts`. This is a
// FUTURE, NON-PAYING scheduled shift, deliberately distinct from "Add Shift" (which records a
// payable worked shift). Two variants off one form:
//   • Unassigned (no employee) → goes straight to the board for anyone eligible to claim. Role is
//     required here because there's no employee to derive it from.
//   • Assigned (pick a person) → lands on that person's "Your Shifts"; they can release it like any
//     other shift. Role is taken from the employee, so the role field is hidden.
export default function AdminOpenShiftForm({ employees }: { employees: Employee[] }) {
  const qc = useQueryClient();
  const selectable = employees.filter((e) => e.status !== 'former');

  const [employeeId, setEmployeeId] = useState(''); // '' = unassigned (post to board)
  const [role, setRole] = useState<'host' | 'fulfillment'>('host');
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const unassigned = employeeId === '';

  async function submit() {
    setError(null);
    setOkMsg(null);
    if (!date || !startTime || !endTime) {
      setError('Date, start and end time are required.');
      return;
    }
    if (startTime === endTime) {
      setError('Start and end time cannot be the same.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/admin/schedule/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date,
          startTime,
          endTime,
          employeeId: unassigned ? null : employeeId,
          role: unassigned ? role : null,
          note: note.trim() || null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Failed (${res.status})`);
      await qc.invalidateQueries({ queryKey: ['shift_instances'] });
      setOkMsg(
        unassigned
          ? 'Posted to the board — eligible employees can now claim it.'
          : `Assigned to ${employees.find((e) => e.id === employeeId)?.name ?? 'employee'} — it's on their schedule.`,
      );
      setDate('');
      setStartTime('');
      setEndTime('');
      setNote('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="bg-tt-card border border-dashed border-tt-cyan/40 rounded-[14px] backdrop-blur-xl p-6">
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-base font-semibold text-tt-text">Post One-Time Shift</h2>
        <span className="rounded-full bg-tt-cyan/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-tt-cyan">
          Schedule
        </span>
      </div>
      <p className="mb-4 text-xs text-tt-muted">
        A future scheduled shift — <span className="text-tt-text">not</span> a worked/payable record. Leave the employee
        blank to post it to the board for anyone to claim, or assign it to one person.
      </p>

      {selectable.length === 0 ? (
        <p className="text-sm text-tt-muted">Add an employee first.</p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <Field label="Employee (optional)">
              <select
                value={employeeId}
                onChange={(e) => { setEmployeeId(e.target.value); setError(null); setOkMsg(null); }}
                className={`${inputCls} appearance-none`}
              >
                <option value="" className="bg-tt-card text-tt-muted">— Unassigned (post to board) —</option>
                {selectable.map((e) => (
                  <option key={e.id} value={e.id} className="bg-tt-card text-tt-text">{e.name}</option>
                ))}
              </select>
            </Field>
            {/* Role only matters when unassigned — otherwise it's the employee's role. */}
            {unassigned ? (
              <Field label="Role (required)">
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as 'host' | 'fulfillment')}
                  className={`${inputCls} appearance-none`}
                >
                  <option value="host" className="bg-tt-card text-tt-text">Host</option>
                  <option value="fulfillment" className="bg-tt-card text-tt-text">Fulfillment</option>
                </select>
              </Field>
            ) : (
              <div className="hidden md:block" aria-hidden />
            )}
            <Field label="Date">
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Start">
                <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className={inputCls} />
              </Field>
              <Field label="End">
                <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className={inputCls} />
              </Field>
            </div>
          </div>

          <div className="mt-3">
            <Field label="Note (optional)">
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. extra Saturday coverage"
                maxLength={500}
                className={inputCls}
              />
            </Field>
          </div>

          {error && <p className="mt-3 text-xs text-tt-red">{error}</p>}
          {okMsg && <p className="mt-3 text-xs text-tt-cyan">{okMsg}</p>}

          <div className="mt-4">
            <button
              onClick={submit}
              disabled={submitting}
              className="rounded-lg border border-tt-cyan/50 bg-tt-cyan/10 px-4 py-2 text-[13px] font-semibold text-tt-cyan transition-colors hover:bg-tt-cyan/20 disabled:opacity-50"
            >
              {submitting ? 'Posting…' : unassigned ? 'Post to Board' : 'Assign Shift'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
