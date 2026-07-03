'use client';

/**
 * /pickpack/kpis — org-wide worker KPI dashboard (owner-facing, allowlisted store logins only).
 * Break-aware active-time throughput; basic readable table (no charts). The route enforces the
 * allowlist (403 for non-allowlisted); this page renders "not available" on 403.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

interface Row { worker_id: string; name: string; picks: number; packs: number; shifts: number; active_min: number; break_min: number; items_per_hr: number }
interface Totals { picks: number; packs: number; shifts: number; active_min: number; break_min: number; items_per_hr: number }
const RANGES: Array<{ key: string; label: string }> = [{ key: 'today', label: 'Today' }, { key: '7d', label: '7 days' }, { key: '30d', label: '30 days' }];
function fmtMin(m: number) { return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; }

export default function KpiDashboard() {
  const [range, setRange] = useState('today');
  const [rows, setRows] = useState<Row[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'denied' | 'error'>('loading');

  const load = useCallback(async (r: string) => {
    setState('loading');
    const res = await fetch(`/api/fulfillment/kpis?range=${r}`);
    if (res.status === 403) { setState('denied'); return; }
    if (!res.ok) { setState('error'); return; }
    const json = await res.json();
    setRows(json.rows ?? []); setTotals(json.totals ?? null); setState('ok');
  }, []);
  useEffect(() => { load(range); }, [range, load]);

  if (state === 'denied') return (
    <div className="min-h-screen bg-tt-bg text-tt-text flex flex-col items-center justify-center p-8 text-center">
      <div className="text-xl font-semibold mb-2">Worker KPIs aren&apos;t available for this login.</div>
      <Link href="/pickpack" className="text-tt-cyan underline">Back to fulfillment</Link>
    </div>
  );

  return (
    <div className="min-h-screen bg-tt-bg text-tt-text p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-1">
          <h1 className="text-3xl font-bold">Worker KPIs</h1>
          <Link href="/pickpack" className="text-sm text-tt-cyan underline">Fulfillment</Link>
        </div>
        <p className="text-sm text-tt-muted mb-4">Org-wide (both stores) · throughput uses active time (breaks excluded).</p>

        <div className="flex gap-2 mb-5">
          {RANGES.map((r) => (
            <button key={r.key} onClick={() => setRange(r.key)}
              className={`px-4 py-2 rounded-lg text-sm font-semibold ${range === r.key ? 'bg-tt-cyan text-black' : 'border border-tt-border text-tt-muted'}`}>{r.label}</button>
          ))}
        </div>

        {state === 'loading' && <div className="text-tt-muted text-sm">Loading…</div>}
        {state === 'error' && <div className="text-tt-red text-sm">Failed to load KPIs.</div>}
        {state === 'ok' && (
          <div className="overflow-x-auto rounded-2xl border border-tt-border">
            <table className="w-full text-sm">
              <thead className="bg-tt-card text-tt-muted text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left px-4 py-3">Worker</th>
                  <th className="text-right px-4 py-3">Picks</th>
                  <th className="text-right px-4 py-3">Packs</th>
                  <th className="text-right px-4 py-3">Shifts</th>
                  <th className="text-right px-4 py-3">Active</th>
                  <th className="text-right px-4 py-3">Break</th>
                  <th className="text-right px-4 py-3">Items/hr</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={7} className="px-4 py-6 text-center text-tt-muted">No activity in this range.</td></tr>}
                {rows.map((r) => (
                  <tr key={r.worker_id} className="border-t border-tt-border">
                    <td className="px-4 py-3 font-medium">{r.name}</td>
                    <td className="px-4 py-3 text-right">{r.picks}</td>
                    <td className="px-4 py-3 text-right">{r.packs}</td>
                    <td className="px-4 py-3 text-right">{r.shifts}</td>
                    <td className="px-4 py-3 text-right">{fmtMin(r.active_min)}</td>
                    <td className="px-4 py-3 text-right text-tt-muted">{fmtMin(r.break_min)}</td>
                    <td className="px-4 py-3 text-right font-semibold text-tt-cyan">{r.items_per_hr}</td>
                  </tr>
                ))}
              </tbody>
              {totals && rows.length > 0 && (
                <tfoot className="border-t-2 border-tt-border bg-tt-card font-semibold">
                  <tr>
                    <td className="px-4 py-3">Org total</td>
                    <td className="px-4 py-3 text-right">{totals.picks}</td>
                    <td className="px-4 py-3 text-right">{totals.packs}</td>
                    <td className="px-4 py-3 text-right">{totals.shifts}</td>
                    <td className="px-4 py-3 text-right">{fmtMin(totals.active_min)}</td>
                    <td className="px-4 py-3 text-right text-tt-muted">{fmtMin(totals.break_min)}</td>
                    <td className="px-4 py-3 text-right text-tt-cyan">{totals.items_per_hr}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
