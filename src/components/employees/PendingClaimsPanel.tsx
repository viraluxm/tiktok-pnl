'use client';

import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { fmtDateLA, fmtTimeRangeLA } from '@/lib/schedule/format';

// PENDING-CLAIMS PANEL (Part 7). Lists shift_claims WHERE status = 'pending' — an OT claim only
// exists here because projected week > 40h, and the OT gate STAYS human. Approve assigns the
// instance to the claimer + writes the withheld 'claimed' event; reject leaves it on the board.
// The count sits in the same spot as the time-clock confirmation banner.

interface PendingClaim {
  claim_id: string;
  claimer_name: string;
  shift_date: string;
  starts_at: string;
  ends_at: string;
  projected_week_hours: number | null;
  instance_status: string;
}

export default function PendingClaimsPanel() {
  const qc = useQueryClient();
  const [claims, setClaims] = useState<PendingClaim[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/schedule/claims', { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Failed (${res.status})`);
      setClaims(body.claims ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function act(claimId: string, action: 'approve' | 'reject') {
    setBusyId(claimId);
    setError(null);
    try {
      const res = await fetch('/api/admin/schedule/claims', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claimId, action }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Failed (${res.status})`);
      // Drop it locally for instant feedback, then reconcile with the server + refresh the calendar
      // (an approval flips a board instance to claimed).
      setClaims((prev) => prev.filter((c) => c.claim_id !== claimId));
      await qc.invalidateQueries({ queryKey: ['shift_instances'] });
      await load();
    } catch (e) {
      setError((e as Error).message);
      await load(); // resync — the claim may have changed under us
    } finally {
      setBusyId(null);
    }
  }

  if (loading || (claims.length === 0 && !error)) return null; // nothing pending → stay quiet

  return (
    <div className="rounded-[14px] border border-tt-yellow/30 bg-tt-yellow/10 px-5 py-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-tt-yellow/25 px-1.5 text-xs font-bold text-tt-yellow">
          {claims.length}
        </span>
        <span className="text-sm font-semibold text-tt-text">
          overtime claim{claims.length === 1 ? '' : 's'} awaiting your approval
        </span>
      </div>
      {error && <p className="mb-2 text-xs text-tt-red">{error}</p>}
      <ul className="flex flex-col gap-2">
        {claims.map((c) => {
          const hrs = c.projected_week_hours;
          return (
            <li
              key={c.claim_id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-tt-border bg-tt-card/60 px-4 py-3"
            >
              <div className="text-sm text-tt-text">
                <span className="font-semibold">{c.claimer_name}</span>{' '}
                <span className="text-tt-muted">wants</span>{' '}
                {c.starts_at ? `${fmtDateLA(c.starts_at)}, ${fmtTimeRangeLA(c.starts_at, c.ends_at)}` : c.shift_date}
                {hrs != null && (
                  <span className="text-tt-muted"> · projected {Math.round(hrs * 10) / 10}h this week</span>
                )}
                {c.instance_status !== 'released' && (
                  <span className="ml-1 text-tt-red">· shift no longer on the board</span>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  onClick={() => act(c.claim_id, 'approve')}
                  disabled={busyId === c.claim_id}
                  className="rounded-lg bg-tt-cyan/20 px-3 py-1.5 text-xs font-semibold text-tt-cyan transition-colors hover:bg-tt-cyan/30 disabled:opacity-50"
                >
                  {busyId === c.claim_id ? '…' : 'Approve'}
                </button>
                <button
                  onClick={() => act(c.claim_id, 'reject')}
                  disabled={busyId === c.claim_id}
                  className="rounded-lg bg-white/5 px-3 py-1.5 text-xs font-semibold text-tt-muted transition-colors hover:bg-white/10 hover:text-tt-text disabled:opacity-50"
                >
                  Reject
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
