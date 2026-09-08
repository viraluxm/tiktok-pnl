'use client';

import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { fmtDateLA, fmtTimeRangeLA, isOvernight } from '@/lib/schedule/format';

// SHIFT PICKUP REQUESTS (Phase 2). Sits beside PendingClaimsPanel rather than inside it: the two
// queues share a table but not a vocabulary or a write path — approve here is one transactional
// RPC (lensed_approve_shift_pickup), not a pair of PostgREST updates — and merging them would mean
// one component branching on `kind` in every line. Same visual language, same spot in the page.
//
// The manager sees BOTH sides of the swap: who dropped it (still responsible until this is
// approved) and who wants it. That is the decision they are actually making.

interface PickupRequest {
  claim_id: string;
  shift_instance_id: string;
  offer_id: string;
  shift_date: string;
  starts_at: string;
  ends_at: string;
  offered_by_name: string;
  requester_name: string;
}

// PREVIEW SEAM. `previewRequests` supplies fixture rows instead of fetching, and `onPreviewAct`
// replaces the approve/decline POST. Supplied only by /preview/employee-portal; production renders
// this component with no props, exactly as before.
export default function PickupRequestsPanel({
  previewRequests, onPreviewAct,
}: {
  previewRequests?: PickupRequest[];
  onPreviewAct?: (claimId: string, action: 'approve' | 'decline') => void;
} = {}) {
  const qc = useQueryClient();
  const [requests, setRequests] = useState<PickupRequest[]>([]);
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
      const res = await fetch('/api/admin/schedule/pickups', { cache: 'no-store' });
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

  async function act(r: PickupRequest, action: 'approve' | 'decline') {
    if (onPreviewAct) { onPreviewAct(r.claim_id, action); return; }   // preview: local state only
    setBusyId(r.claim_id);
    setError(null);
    try {
      // The identifiers are echoed from the row the manager is looking at; the RPC re-checks that
      // they still agree with the DB, so a stale queue refuses instead of moving the wrong shift.
      const res = await fetch('/api/admin/schedule/pickups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          claimId: r.claim_id, action,
          shiftInstanceId: r.shift_instance_id, offerId: r.offer_id,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Failed (${res.status})`);
      setRequests((prev) => prev.filter((x) => x.claim_id !== r.claim_id));
      // An approval moves an assignment, so every schedule surface keyed on shift_instances is
      // stale: the month calendar, the roster's week counts and the builder's cached weeks.
      await qc.invalidateQueries({ queryKey: ['shift_instances'] });
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
          shift pickup request{requests.length === 1 ? '' : 's'}
        </span>
      </div>
      {error && <p className="mb-2 text-xs text-tt-red">{error}</p>}
      <ul className="flex flex-col gap-2">
        {requests.map((r) => (
          <li key={r.claim_id} className="rounded-lg border border-tt-border bg-tt-card/60 px-4 py-3">
            <p className="text-sm font-medium text-tt-text">
              {fmtDateLA(r.starts_at)} · {fmtTimeRangeLA(r.starts_at, r.ends_at)}
              {isOvernight(r.starts_at, r.ends_at) && <span className="ml-1.5 text-tt-muted">🌙 +1d</span>}
            </p>
            <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
              <div className="text-[13px]">
                <p className="text-tt-text"><span className="font-semibold">{r.offered_by_name}</span> <span className="text-tt-muted">dropping shift</span></p>
                <p className="text-tt-text"><span className="font-semibold">{r.requester_name}</span> <span className="text-tt-muted">wants to pick it up</span></p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  onClick={() => act(r, 'decline')} disabled={busyId === r.claim_id}
                  className="rounded-lg bg-white/5 px-3 py-1.5 text-xs font-semibold text-tt-muted transition-colors hover:bg-white/10 hover:text-tt-text disabled:opacity-50"
                >Decline</button>
                <button
                  onClick={() => act(r, 'approve')} disabled={busyId === r.claim_id}
                  className="rounded-lg bg-tt-cyan/20 px-3 py-1.5 text-xs font-semibold text-tt-cyan transition-colors hover:bg-tt-cyan/30 disabled:opacity-50"
                >{busyId === r.claim_id ? '…' : 'Approve'}</button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
