'use client';

import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { fmtDateLA, fmtTimeRangeLA, isOvernight } from '@/lib/schedule/format';

// SHIFT TRADE REQUESTS — the manager's final say on a one-for-one swap two employees have already
// agreed to. Sits beside PickupRequestsPanel with the same visual language and the same rules:
// approve is ONE transactional RPC (lensed_approve_shift_trade) that re-checks both shifts before
// swapping them; decline records the decision and moves nothing.
//
// The manager sees BOTH shifts and BOTH people — that is the decision being made — never a raw id.

export interface TradeRequest {
  trade_id: string;
  requester_name: string;
  target_name: string;
  requester_shift: { instance_id: string; shift_date: string; starts_at: string; ends_at: string; hours: number };
  target_shift: { instance_id: string; shift_date: string; starts_at: string; ends_at: string; hours: number };
  coworker_responded_at: string | null;
  created_at: string;
}

function Side({ name, shift }: { name: string; shift: TradeRequest['requester_shift'] }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[13px] font-semibold text-tt-text">{name}</p>
      <p className="text-[13px] tabular-nums text-tt-text">
        {fmtDateLA(shift.starts_at)} · {fmtTimeRangeLA(shift.starts_at, shift.ends_at)}
        {isOvernight(shift.starts_at, shift.ends_at) && <span className="ml-1 text-tt-muted">🌙 +1d</span>}
      </p>
    </div>
  );
}

// PREVIEW SEAM — same shape as PickupRequestsPanel's. Supplied only by /preview/employee-portal.
export default function TradeRequestsPanel({
  previewTrades, onPreviewAct,
}: {
  previewTrades?: TradeRequest[];
  onPreviewAct?: (tradeId: string, action: 'approve' | 'decline') => void;
} = {}) {
  const qc = useQueryClient();
  const [trades, setTrades] = useState<TradeRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (previewTrades) {
      setTrades(previewTrades);
      setError(null);
      setLoading(false);
      return;
    }
    try {
      const res = await fetch('/api/admin/schedule/trades', { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Failed (${res.status})`);
      setTrades(body.trades ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [previewTrades]);

  useEffect(() => { load(); }, [load]);

  async function act(t: TradeRequest, action: 'approve' | 'decline') {
    if (onPreviewAct) { onPreviewAct(t.trade_id, action); return; }
    setBusyId(t.trade_id);
    setError(null);
    try {
      const res = await fetch('/api/admin/schedule/trades', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tradeId: t.trade_id, action }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Failed (${res.status})`);
      setTrades((prev) => prev.filter((x) => x.trade_id !== t.trade_id));
      // Two assignments moved: every schedule surface keyed on shift_instances is stale.
      await qc.invalidateQueries({ queryKey: ['shift_instances'] });
      await load();
    } catch (e) {
      setError((e as Error).message);
      await load(); // resync — the world may have moved under this queue
    } finally {
      setBusyId(null);
    }
  }

  if (loading || (trades.length === 0 && !error)) return null;

  return (
    <div className="rounded-[14px] border border-tt-cyan/30 bg-tt-cyan/10 px-5 py-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-tt-cyan/25 px-1.5 text-xs font-bold text-tt-cyan">
          {trades.length}
        </span>
        <span className="text-sm font-semibold text-tt-text">shift trade{trades.length === 1 ? '' : 's'} to approve</span>
      </div>
      {error && <p className="mb-2 text-xs text-tt-red">{error}</p>}
      <ul className="flex flex-col gap-2">
        {trades.map((t) => (
          <li key={t.trade_id} className="rounded-lg border border-tt-border bg-tt-card/60 px-4 py-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_1fr] sm:items-center sm:gap-3">
              <Side name={t.requester_name} shift={t.requester_shift} />
              <span className="text-sm text-tt-muted" aria-label="swaps with">⇄</span>
              <Side name={t.target_name} shift={t.target_shift} />
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-[12px] text-tt-muted">
                <span className="font-semibold text-tt-green">{t.target_name.split(' ')[0]} accepted</span>
                {' '}· nothing changes until you approve
              </p>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={() => act(t, 'decline')} disabled={busyId === t.trade_id}
                  className="rounded-lg bg-white/5 px-3 py-1.5 text-xs font-semibold text-tt-muted transition-colors hover:bg-white/10 hover:text-tt-text disabled:opacity-50"
                >Decline Trade</button>
                <button
                  type="button"
                  onClick={() => act(t, 'approve')} disabled={busyId === t.trade_id}
                  className="rounded-lg bg-tt-cyan/20 px-3 py-1.5 text-xs font-semibold text-tt-cyan transition-colors hover:bg-tt-cyan/30 disabled:opacity-50"
                >{busyId === t.trade_id ? '…' : 'Approve Trade'}</button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
