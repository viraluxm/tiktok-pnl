'use client';

import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { fmtDateLA, fmtTimeRangeLA, isOvernight } from '@/lib/schedule/format';

// SHIFT REQUESTS — capacity-derived availability (migration 156). Its own queue beside the pickup
// and trade panels, because the decision is a different one: a pickup MOVES a shift between two
// people, a trade SWAPS two, and this one CREATES a shift nobody owned because the floor has room.
//
// The manager sees the staffing the decision is actually about — "8 / 10 scheduled · 2 shifts
// available" — recomputed at read time, so a queue left open for ten minutes shows current numbers.
// Approval re-checks all of it inside the RPC anyway; this is so the decision is informed, not so
// the client can be trusted.

export interface ShiftRequestRow {
  request_id: string;
  employee_name: string;
  block_label: string | null;
  team: string;
  shift_date: string;
  starts_at: string;
  ends_at: string;
  staffed: number;
  /** null = this block has no configured capacity, so approval will refuse. */
  capacity: number | null;
  available: number;
  closed: boolean;
}

// PREVIEW SEAM, identical to PickupRequestsPanel's: `previewRequests` supplies fixture rows instead
// of fetching and `onPreviewAct` replaces the POST. Production renders this with no props.
export default function ShiftRequestsPanel({
  previewRequests, onPreviewAct,
}: {
  previewRequests?: ShiftRequestRow[];
  onPreviewAct?: (requestId: string, action: 'approve' | 'decline') => void;
} = {}) {
  const qc = useQueryClient();
  const [requests, setRequests] = useState<ShiftRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (previewRequests) {                 // preview: fixture rows, no fetch
      setRequests(previewRequests);
      setError(null);
      setLoading(false);
      return;
    }
    try {
      const res = await fetch('/api/admin/schedule/shift-requests', { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Failed (${res.status})`);
      setRequests(body.requests ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [previewRequests]);

  useEffect(() => { load(); }, [load]);

  async function act(r: ShiftRequestRow, action: 'approve' | 'decline') {
    if (onPreviewAct) { onPreviewAct(r.request_id, action); return; }   // preview: local state only
    setBusyId(r.request_id);
    setError(null);
    try {
      const res = await fetch('/api/admin/schedule/shift-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: r.request_id, action }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Failed (${res.status})`);
      setRequests((prev) => prev.filter((x) => x.request_id !== r.request_id));
      // An approval CREATES a shift, so every surface keyed on shift_instances is stale — and so
      // is the capacity outlook, whose availability just dropped by one.
      await qc.invalidateQueries({ queryKey: ['shift_instances'] });
      await qc.invalidateQueries({ queryKey: ['capacity'] });
      await load();
    } catch (e) {
      setError((e as Error).message);
      await load(); // resync — someone else may have decided it first
    } finally {
      setBusyId(null);
    }
  }

  if (loading || (requests.length === 0 && !error)) return null;

  return (
    <div className="rounded-[14px] border border-tt-cyan/30 bg-tt-cyan/10 px-5 py-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-tt-cyan/25 px-1.5 text-xs font-bold text-tt-cyan">
          {requests.length}
        </span>
        <span className="text-sm font-semibold text-tt-text">
          shift request{requests.length === 1 ? '' : 's'}
        </span>
      </div>
      {error && <p className="mb-2 text-xs text-tt-red">{error}</p>}
      <ul className="flex flex-col gap-2">
        {requests.map((r) => {
          // Full is not an error state in this list — the request is still real and still
          // declinable. It is labelled so the manager knows approving it will be refused.
          // An unconfigured block cannot be approved into at all; it is flagged like a full one so
          // the manager sees why before they click, and the RPC refuses if they do.
          const full = r.closed || r.capacity == null || r.available <= 0;
          return (
            <li key={r.request_id} className="rounded-lg border border-tt-border bg-tt-card/60 px-4 py-3">
              <p className="text-sm font-medium text-tt-text">
                {fmtDateLA(r.starts_at)} · {fmtTimeRangeLA(r.starts_at, r.ends_at)}
                {isOvernight(r.starts_at, r.ends_at) && <span className="ml-1.5 text-tt-muted">🌙 +1d</span>}
                {r.block_label && <span className="ml-1.5 text-tt-muted">· {r.block_label}</span>}
              </p>
              <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
                <div className="text-[13px]">
                  <p className="text-tt-text"><span className="font-semibold">{r.employee_name}</span> <span className="text-tt-muted">wants this shift</span></p>
                  <p className={full ? 'font-semibold text-tt-yellow' : 'text-tt-muted'}>
                    <span className="tabular-nums">{r.capacity == null ? r.staffed : `${r.staffed} / ${r.capacity}`}</span> scheduled
                    {' · '}
                    {r.capacity == null ? 'capacity not configured'
                      : r.closed ? 'availability closed'
                        : r.available > 0 ? `${r.available} shift${r.available === 1 ? '' : 's'} available` : 'fully staffed'}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    onClick={() => act(r, 'decline')} disabled={busyId === r.request_id}
                    className="rounded-lg bg-white/5 px-3 py-1.5 text-xs font-semibold text-tt-muted transition-colors hover:bg-white/10 hover:text-tt-text disabled:opacity-50"
                  >Decline</button>
                  <button
                    onClick={() => act(r, 'approve')} disabled={busyId === r.request_id}
                    className="rounded-lg bg-tt-cyan/20 px-3 py-1.5 text-xs font-semibold text-tt-cyan transition-colors hover:bg-tt-cyan/30 disabled:opacity-50"
                  >{busyId === r.request_id ? '…' : 'Approve'}</button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
