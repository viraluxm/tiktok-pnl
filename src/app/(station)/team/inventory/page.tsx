'use client';

import { useEffect, useMemo, useState } from 'react';
import MemberNav from '@/components/member/MemberNav';

// Member 'inventory' scope — stock + reorder view, rendered under the bare (station) route group
// (server layout, no app chrome), same shape as /team/binding. Data comes from the owner-scoped
// /api/member/inventory (pnl_reorder_by_sku_as + inventory_skus thumbnail/unit-cost). Deliberately
// NO revenue/margin — this scope must never see P&L.

// Copied VERBATIM from PnlTab's enrichSku so the reorder signal is identical to the owner's P&L
// tab — do NOT invent a different formula. SAFETY_BUFFER_DAYS is PnlTab's hardcoded 3.
const SAFETY_BUFFER_DAYS = 3;

interface InvRow {
  sku_id: string;
  sku_number: number | null;
  title: string | null;
  thumbnail_url: string | null;
  qty_on_hand: number | null;
  unit_cost_cents: number | null;
  reorder_point: number | null;
  lead_time_days: number | null;
  reorder_units: number;
  reorder_window_days: number;
}

interface EnrichedRow extends InvRow {
  daysOfCover: number | null; // null => no velocity (never runs out) or no data
  reorderFlag: boolean;
}

function enrich(r: InvRow): EnrichedRow {
  const qty = r.qty_on_hand ?? 0;
  const velocity = r.reorder_window_days > 0 ? r.reorder_units / r.reorder_window_days : 0;
  const daysOfCover = velocity > 0 ? qty / velocity : null;
  const hasLead = r.lead_time_days != null;
  const reorderFlag =
    hasLead && daysOfCover != null && daysOfCover <= (r.lead_time_days as number) + SAFETY_BUFFER_DAYS;
  return { ...r, daysOfCover, reorderFlag };
}

function money(cents: number | null): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtCover(d: number | null): string {
  return d == null ? '—' : `${Math.round(d)}d`;
}

export default function MemberInventoryPage() {
  const [rows, setRows] = useState<InvRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/member/inventory');
        const json = await res.json();
        if (!alive) return;
        if (!res.ok) throw new Error(json.error ?? `Failed to load (${res.status})`);
        setRows((json.skus ?? []) as InvRow[]);
      } catch (e) {
        if (alive) setErr((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const enriched = rows.map(enrich);
    const filtered = q
      ? enriched.filter(
          (r) =>
            String(r.sku_number ?? '').includes(q) ||
            (r.title ?? '').toLowerCase().includes(q),
        )
      : enriched;
    // Most urgent reorder first: flagged rows first, then fewest days-of-cover
    // (null cover = no velocity = never runs out → sorts last).
    return [...filtered].sort((a, b) => {
      if (a.reorderFlag !== b.reorderFlag) return a.reorderFlag ? -1 : 1;
      const da = a.daysOfCover ?? Infinity;
      const db = b.daysOfCover ?? Infinity;
      return da - db;
    });
  }, [rows, query]);

  const flaggedCount = useMemo(() => visible.filter((r) => r.reorderFlag).length, [visible]);

  return (
    <main className="min-h-screen bg-tt-bg text-tt-text p-6 max-w-4xl mx-auto">
      <MemberNav active="inventory" />

      <div className="mb-6">
        <h1 className="text-2xl font-bold">Inventory</h1>
        <p className="mt-1 text-sm text-tt-muted">
          Stock on hand and reorder signal. Days-of-cover uses the trailing sell-through velocity.
        </p>
        <div className="mt-2 text-sm font-semibold text-tt-text">
          {rows.length.toLocaleString()} SKUs{flaggedCount > 0 ? ` · ${flaggedCount} need reorder` : ''}
        </div>
      </div>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by # or title…"
        className="mb-4 w-full rounded-xl border border-tt-border bg-white/5 px-3 py-2 text-sm text-tt-text outline-none focus:ring-1 focus:ring-tt-cyan/50"
      />

      {loading && rows.length === 0 && <div className="text-lg text-tt-muted">Loading inventory…</div>}
      {err && <div className="rounded-xl border-2 border-tt-red/50 bg-tt-red/10 px-4 py-3 text-tt-red font-semibold">{err}</div>}

      {!loading && !err && visible.length === 0 && (
        <div className="rounded-2xl border border-tt-border bg-tt-card px-6 py-10 text-center text-tt-muted">
          {rows.length === 0 ? 'No SKUs found.' : 'No SKUs match your search.'}
        </div>
      )}

      {visible.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-tt-border bg-tt-card">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-tt-border">
                <th className="text-left px-3 py-2 text-[11px] text-tt-muted uppercase tracking-wide">SKU</th>
                <th className="text-right px-3 py-2 text-[11px] text-tt-muted uppercase tracking-wide">On hand</th>
                <th className="text-right px-3 py-2 text-[11px] text-tt-muted uppercase tracking-wide">Unit cost</th>
                <th className="text-right px-3 py-2 text-[11px] text-tt-muted uppercase tracking-wide">Days cover</th>
                <th className="text-right px-3 py-2 text-[11px] text-tt-muted uppercase tracking-wide">Reorder</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.sku_id} className="border-b border-[rgba(255,255,255,0.04)]">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-3 min-w-0">
                      {r.thumbnail_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={r.thumbnail_url} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover bg-black/30" />
                      ) : (
                        <div className="h-10 w-10 shrink-0 rounded-lg bg-black/30" />
                      )}
                      <div className="min-w-0">
                        <div className="text-[13px] text-tt-text truncate">{r.title || 'Untitled'}</div>
                        <div className="text-[11px] text-tt-muted tabular-nums">#{r.sku_number ?? '—'}</div>
                      </div>
                    </div>
                  </td>
                  <td className={`px-3 py-2 text-right text-[13px] tabular-nums ${(r.qty_on_hand ?? 0) < 0 ? 'text-tt-red' : 'text-tt-text'}`}>
                    {r.qty_on_hand ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-[13px] text-tt-text tabular-nums">{money(r.unit_cost_cents)}</td>
                  <td className="px-3 py-2 text-right text-[13px] text-tt-text tabular-nums">{fmtCover(r.daysOfCover)}</td>
                  <td className="px-3 py-2 text-right">
                    {r.reorderFlag ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-tt-red/15 px-2 py-0.5 text-[11px] font-semibold text-tt-red">
                        <span className="h-1.5 w-1.5 rounded-full bg-tt-red" /> Reorder now
                      </span>
                    ) : (
                      <span className="text-[11px] text-tt-muted">OK</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
