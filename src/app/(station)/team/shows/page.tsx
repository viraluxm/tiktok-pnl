'use client';

import { useEffect, useMemo, useState } from 'react';
import MemberNav from '@/components/member/MemberNav';

// Member 'shows' scope — READ-ONLY live-show detail under the bare (station) layout. Mirrors the
// owner Shows tab's read side: session list → expand to the board (items + coverage). NO write
// actions (no bind/unbind/reconcile/payouts/create-SKU/export) and NO cost or margin anywhere —
// that separation is what makes `shows` distinct from `pnl`. Fed by owner-scoped /api/member/shows/*.

interface ShowSession {
  id: string; title: string | null; channel_handle: string | null; store_name: string | null;
  host_name: string | null; started_at: string | null; ended_at: string | null; status: string | null;
}
interface BoardSku { inventory_sku_id: string; sku_number: number | null; title: string | null; qty: number | null }
interface BoardItem {
  id: string; order_id: string | null; auction_number: number; status: string | null;
  sold_price_cents: number | null; won_price_cents: number | null; tiktok_title: string | null;
  seller_sku_hint: string | null; payment_failed: boolean; synced_status: string | null;
  buyer_handle: string | null; units: number; unbound?: boolean; skus: BoardSku[];
}
interface Coverage {
  total_synced: number; captured_but_unbound_count: number; missed_capture_count: number;
  catalog_count: number; room_unknown_count: number;
}

const money = (c: number | null) =>
  c == null ? '—' : `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
function fmtWhen(iso: string | null): string {
  if (!iso) return 'Unknown';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : iso;
}
function fmtDuration(ms: number | null): string {
  if (ms == null || ms <= 0) return '—';
  const mins = Math.round(ms / 60000); const h = Math.floor(mins / 60); const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function MemberShowsPage() {
  const [sessions, setSessions] = useState<ShowSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let alive = true; setLoading(true); setErr(null);
    fetch('/api/member/shows')
      .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `Failed (${r.status})`); return j; })
      .then((j) => { if (alive) setSessions((j.sessions ?? []) as ShowSession[]); })
      .catch((e) => { if (alive) setErr((e as Error).message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  return (
    <main className="min-h-screen bg-tt-bg text-tt-text p-6 max-w-4xl mx-auto">
      <MemberNav active="shows" />
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Shows</h1>
        <p className="mt-1 text-sm text-tt-muted">Live-show detail — read only. Sale value shown; no cost or margin.</p>
      </div>

      {loading && sessions.length === 0 && <div className="text-lg text-tt-muted">Loading shows…</div>}
      {err && <div className="rounded-xl border-2 border-tt-red/50 bg-tt-red/10 px-4 py-3 text-tt-red font-semibold">{err}</div>}
      {!loading && !err && sessions.length === 0 && (
        <div className="rounded-2xl border border-tt-border bg-tt-card px-6 py-10 text-center text-tt-muted">No shows.</div>
      )}

      <div className="space-y-3">
        {sessions.map((s) => {
          const isOpen = expanded === s.id;
          return (
            <div key={s.id} className="rounded-2xl border border-tt-border bg-tt-card overflow-hidden">
              <button
                onClick={() => setExpanded(isOpen ? null : s.id)}
                className="w-full flex items-start justify-between gap-3 px-4 py-3 text-left hover:bg-tt-card-hover"
              >
                <div className="min-w-0">
                  <div className="font-semibold text-tt-text truncate">{s.channel_handle || 'TikTok Live'}</div>
                  <div className="mt-0.5 text-xs text-tt-muted">
                    {s.host_name ? `${s.host_name} · ` : ''}
                    {s.store_name ?? <span className="font-semibold text-tt-red">Unmapped store</span>}
                    {' · '}{fmtWhen(s.started_at)}
                  </div>
                </div>
                <div className="shrink-0 text-xs text-tt-muted">{isOpen ? 'Close' : 'View'}</div>
              </button>
              {isOpen && <ShowDetail sessionId={s.id} />}
            </div>
          );
        })}
      </div>
    </main>
  );
}

function ShowDetail({ sessionId }: { sessionId: string }) {
  const [items, setItems] = useState<BoardItem[] | null>(null);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    let alive = true; setLoading(true); setErr(null);
    const getJson = async (url: string) => { const r = await fetch(url); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `Failed (${r.status})`); return j; };
    Promise.all([
      getJson(`/api/member/shows/${sessionId}/board`),
      getJson(`/api/member/shows/${sessionId}/duration`).catch(() => ({ duration_ms: null })),
      getJson(`/api/member/shows/${sessionId}/coverage`).catch(() => null),
    ])
      .then(([board, dur, cov]) => {
        if (!alive) return;
        setItems((board.items ?? []) as BoardItem[]);
        setWarning((board.warning as string | null) ?? null);
        setDurationMs((dur?.duration_ms as number | null) ?? null);
        setCoverage(cov as Coverage | null);
      })
      .catch((e) => { if (alive) setErr((e as Error).message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [sessionId]);

  const unboundCount = useMemo(() => (items ?? []).filter((i) => i.unbound).length, [items]);

  if (loading) return <div className="border-t border-tt-border px-4 py-4 text-sm text-tt-muted">Loading show…</div>;
  if (err) return <div className="border-t border-tt-border px-4 py-4 text-sm text-tt-red">{err}</div>;

  return (
    <div className="border-t border-tt-border p-4 space-y-4">
      {/* Summary strip */}
      <div className="flex flex-wrap gap-4 text-sm">
        <div><span className="text-tt-muted">Duration </span><span className="font-semibold tabular-nums">{fmtDuration(durationMs)}</span></div>
        <div><span className="text-tt-muted">Auctions </span><span className="font-semibold tabular-nums">{(items ?? []).length.toLocaleString()}</span></div>
        {unboundCount > 0 && (
          <div className="rounded-full bg-tt-yellow/15 px-2 py-0.5 text-xs font-semibold text-tt-yellow">{unboundCount} unbound</div>
        )}
      </div>

      {warning && <div className="rounded-lg border border-tt-yellow/40 bg-tt-yellow/10 px-3 py-2 text-xs text-tt-yellow">{warning}</div>}

      {/* Coverage panel */}
      {coverage && (
        <div className="rounded-xl border border-tt-border bg-tt-bg/40 p-3">
          <div className="text-[11px] uppercase tracking-wide text-tt-muted mb-2">Order coverage</div>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
            <Stat label="Synced" value={coverage.total_synced} />
            <Stat label="Captured, unbound" value={coverage.captured_but_unbound_count} />
            <Stat label="Missed captures" value={coverage.missed_capture_count} warn={coverage.missed_capture_count > 0} />
            <Stat label="Catalog sales" value={coverage.catalog_count} />
            <Stat label="Room unknown" value={coverage.room_unknown_count} />
          </div>
        </div>
      )}

      {/* Items table — revenue only, NO cost/margin column. */}
      <div className="overflow-x-auto rounded-xl border border-tt-border">
        <table className="w-full text-sm min-w-[560px]">
          <thead>
            <tr className="border-b border-tt-border text-tt-muted text-xs uppercase tracking-wide">
              <th className="px-3 py-2 text-left font-medium">Lot</th>
              <th className="px-3 py-2 text-left font-medium">Item</th>
              <th className="px-3 py-2 text-left font-medium">Buyer</th>
              <th className="px-3 py-2 text-right font-medium">Units</th>
              <th className="px-3 py-2 text-right font-medium">Won</th>
              <th className="px-3 py-2 text-right font-medium">Sold</th>
            </tr>
          </thead>
          <tbody>
            {(items ?? []).map((it) => (
              <tr key={it.id} className="border-b border-tt-border last:border-0">
                <td className="px-3 py-2 tabular-nums text-tt-muted">{it.seller_sku_hint ?? (it.auction_number || '—')}</td>
                <td className="px-3 py-2">
                  <div className="text-tt-text truncate max-w-[220px]">{it.tiktok_title || 'Unknown item'}</div>
                  <div className="text-[11px] text-tt-muted">
                    {it.unbound ? <span className="text-tt-yellow">Unbound</span> : it.status}
                    {it.payment_failed ? ' · payment failed' : ''}
                  </div>
                </td>
                <td className="px-3 py-2 text-tt-muted">{it.buyer_handle ? `@${it.buyer_handle}` : '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums">{it.units || '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(it.won_price_cents)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(it.sold_price_cents)}</td>
              </tr>
            ))}
            {(items ?? []).length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-tt-muted">No auctions in this show.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value, warn = false }: { label: string; value: number; warn?: boolean }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-tt-muted">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${warn ? 'text-tt-red' : 'text-tt-text'}`}>{value.toLocaleString()}</div>
    </div>
  );
}
