'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Employee } from '@/types';
import PersonAvatar from './PersonAvatar';
import { titleCase } from '../shared';

// Manager queue for time-off requests, and the chip that opens it.
//
// Deciding here records the decision only — it never creates or deletes a shift. The point of a
// request is to be visible BEFORE the period is built, so the schedule is made around it. Handing
// back a shift that already exists is the release/claim flow, which is separate and keeps its own
// allowance (see src/lib/schedule/drops.ts).

export interface TimeOffRow {
  id: string;
  employee_id: string;
  start_date: string;
  end_date: string;
  reason: string | null;
  status: 'pending' | 'approved' | 'denied';
  decision_note: string | null;
  created_at: string;
}

function fmt(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

export function useTimeOff() {
  const [rows, setRows] = useState<TimeOffRow[]>([]);
  // A bump forces a refetch after a decision. setRows lands in the promise callback, not in the
  // effect body, so this subscribes to an external system rather than cascading a render
  // (react-hooks/set-state-in-effect). `alive` drops a response that resolves after unmount.
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    fetch('/api/admin/time-off')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive && j) setRows(j.requests ?? []); })
      .catch(() => { /* the chip simply stays hidden */ });
    return () => { alive = false; };
  }, [nonce]);

  return { rows, reload, pending: rows.filter((r) => r.status === 'pending') };
}

export default function TimeOffQueue({
  rows, employees, onClose, onChanged,
}: {
  rows: TimeOffRow[];
  employees: Employee[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const byId = new Map(employees.map((e) => [e.id, e]));

  async function decide(id: string, status: 'approved' | 'denied') {
    setBusy(id);
    await fetch('/api/admin/time-off', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status }),
    });
    setBusy(null);
    onChanged();
  }

  const pending = rows.filter((r) => r.status === 'pending');
  const decided = rows.filter((r) => r.status !== 'pending');

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 sm:p-8"
      onClick={onClose} role="dialog" aria-modal="true" aria-label="Time-off requests"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl rounded-2xl border border-tt-border bg-tt-card p-5"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-tt-text">Time-off requests</h2>
            <p className="mt-0.5 text-xs text-tt-muted">
              {pending.length} awaiting a decision · approving records it, it does not change any shift
            </p>
          </div>
          <button
            type="button" onClick={onClose} aria-label="Close"
            className="h-8 w-8 shrink-0 rounded-lg border border-tt-border text-tt-muted hover:bg-tt-card-hover"
          >✕</button>
        </div>

        {rows.length === 0 && (
          <p className="py-10 text-center text-sm text-tt-muted">No requests.</p>
        )}

        <div className="space-y-1.5">
          {pending.map((r) => {
            const emp = byId.get(r.employee_id);
            return (
              <div key={r.id} className="flex items-center gap-3 rounded-xl border border-tt-yellow/30 bg-tt-yellow/[0.04] px-3 py-2.5">
                <PersonAvatar name={emp?.name ?? 'Unknown'} state="pending" size="md" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold text-tt-text">
                    {emp?.name ?? 'Unknown'}
                    <span className="ml-1.5 text-[10px] font-normal text-tt-muted">{titleCase(emp?.role ?? '')}</span>
                  </div>
                  <div className="text-[12px] tabular-nums text-tt-text">
                    {fmt(r.start_date)}{r.end_date !== r.start_date && ` – ${fmt(r.end_date)}`}
                  </div>
                  {r.reason && <div className="truncate text-[11px] text-tt-muted">{r.reason}</div>}
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <button
                    type="button" onClick={() => decide(r.id, 'approved')} disabled={busy === r.id}
                    className="rounded-lg border border-tt-green/40 px-2.5 py-1.5 text-[11px] font-semibold text-tt-green hover:bg-tt-green/10 disabled:opacity-40"
                  >Approve</button>
                  <button
                    type="button" onClick={() => decide(r.id, 'denied')} disabled={busy === r.id}
                    className="rounded-lg border border-tt-border px-2.5 py-1.5 text-[11px] font-semibold text-tt-muted hover:bg-tt-card-hover disabled:opacity-40"
                  >Deny</button>
                </div>
              </div>
            );
          })}
        </div>

        {decided.length > 0 && (
          <>
            <h3 className="mt-5 mb-2 text-[10px] font-bold uppercase tracking-wider text-tt-muted">Decided</h3>
            <div className="space-y-1.5">
              {decided.map((r) => {
                const emp = byId.get(r.employee_id);
                return (
                  <div key={r.id} className="flex items-center gap-3 rounded-xl border border-tt-border px-3 py-2 opacity-70">
                    <PersonAvatar name={emp?.name ?? 'Unknown'} state="confirmed" size="sm" />
                    <div className="min-w-0 flex-1">
                      <span className="text-[12px] font-semibold text-tt-text">{emp?.name ?? 'Unknown'}</span>
                      <span className="ml-2 text-[11px] tabular-nums text-tt-muted">
                        {fmt(r.start_date)}{r.end_date !== r.start_date && ` – ${fmt(r.end_date)}`}
                      </span>
                    </div>
                    <span className={`shrink-0 text-[11px] font-semibold capitalize ${r.status === 'approved' ? 'text-tt-green' : 'text-tt-muted'}`}>
                      {r.status}
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
