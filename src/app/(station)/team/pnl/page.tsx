'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend, Filler,
} from 'chart.js';
import { Line, Bar } from 'react-chartjs-2';
import { getLineChartOptions, getBarChartOptions } from '@/lib/chart-options';
import MemberNav from '@/components/member/MemberNav';

// Member 'pnl' scope — owner-scoped live-show P&L, rendered under the bare (station) layout. Mirrors
// the owner PnlTab's By-Show and By-Period lenses, fed by /api/member/pnl/* (pnl_*_as, 089). Net
// profit here is gross-margin only; the header spells that out so a member never reads it as true net.

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend, Filler);

// ── types (mirror usePnl row shapes) ──
interface ShowRow { session_id: string; title: string | null; started_at: string | null; ended_at: string | null; auctions: number; units: number; gmv_cents: number; cogs_cents: number; net_profit_cents: number }
interface PeriodRow { day: string; units: number; revenue_cents: number; cogs_cents: number; net_profit_cents: number }
interface HourRow { hour_start: string; hour_of_day: number; auctions: number; units: number; revenue_cents: number; cogs_cents: number; net_profit_cents: number }

// PostgREST returns numeric/bigint as strings — coerce.
const num = (v: unknown): number => (v == null ? 0 : Number(v));

// ── formatting (copied from PnlTab) ──
const money = (c: number) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (v: number | null) => (v == null ? '—' : `${v.toFixed(1)}%`);
const marginOf = (net: number, revenue: number): number | null => (revenue > 0 ? (net / revenue) * 100 : null);
const netClass = (v: number) => (v >= 0 ? 'text-tt-green' : 'text-tt-red');
function fmtShowWhen(iso: string | null): string {
  if (!iso) return 'Unknown';
  try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch { return iso; }
}
function fmtDuration(start: string | null, end: string | null): string {
  if (!start || !end) return '—';
  const s = new Date(start).getTime(); const e = new Date(end).getTime();
  if (isNaN(s) || isNaN(e) || e < s) return '—';
  const mins = Math.round((e - s) / 60000); const h = Math.floor(mins / 60); const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function hourLabel(h: number): string {
  const to12 = (x: number) => { const hr = ((x % 24) + 24) % 24; return { h12: hr % 12 === 0 ? 12 : hr % 12, ap: hr < 12 ? 'AM' : 'PM' }; };
  const a = to12(h); const b = to12(h + 1);
  return a.ap === b.ap ? `${a.h12}–${b.h12} ${a.ap}` : `${a.h12} ${a.ap}–${b.h12} ${b.ap}`;
}
// Local date (America/Los_Angeles) as YYYY-MM-DD, for the date inputs' defaults.
const fmtPT = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(d);

function Loading({ label }: { label: string }) {
  return <div className="flex items-center justify-center py-16 text-tt-muted"><div className="w-5 h-5 border-2 border-tt-muted border-t-transparent rounded-full animate-spin mr-3" />{label}</div>;
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-tt-border bg-tt-card py-16 text-center text-sm text-tt-muted">{children}</div>;
}
function StatCard({ label, value, valueClass = 'text-tt-text' }: { label: string; value: string; valueClass?: string }) {
  return <div className="bg-tt-card border border-tt-border rounded-[14px] p-5"><div className="text-xs text-tt-muted mb-1">{label}</div><div className={`text-2xl font-bold tabular-nums ${valueClass}`}>{value}</div></div>;
}

type Lens = 'show' | 'period';

export default function MemberPnlPage() {
  const [lens, setLens] = useState<Lens>('show');
  const [from, setFrom] = useState(() => fmtPT(new Date(Date.now() - 6 * 86400000))); // last 7 days
  const [to, setTo] = useState(() => fmtPT(new Date()));

  return (
    <main className="min-h-screen bg-tt-bg text-tt-text p-6 max-w-4xl mx-auto">
      <MemberNav active="pnl" />

      <div className="mb-5">
        <h1 className="text-2xl font-bold">Live-show P&amp;L</h1>
        {/* VERBATIM-in-spirit of PnlTab's caveat, plus labor — a member must not read this as true net. */}
        <p className="text-[11px] text-tt-muted mt-1 leading-snug max-w-2xl">
          Live-auction captures only: net profit is revenue × 94% − COGS. Excludes shipping,
          ads/affiliate, labor, and refunds — it is a gross margin, not true net profit.
        </p>
      </div>

      {/* Date range */}
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <label className="text-xs text-tt-muted">From
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)}
            className="mt-1 block rounded-lg border border-tt-border bg-white/5 px-3 py-1.5 text-sm text-tt-text outline-none focus:ring-1 focus:ring-tt-cyan/50" />
        </label>
        <label className="text-xs text-tt-muted">To
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)}
            className="mt-1 block rounded-lg border border-tt-border bg-white/5 px-3 py-1.5 text-sm text-tt-text outline-none focus:ring-1 focus:ring-tt-cyan/50" />
        </label>
      </div>

      {/* Lens toggle */}
      <div className="flex flex-wrap gap-1 mb-6">
        {([['show', 'By Show'], ['period', 'By Period']] as const).map(([v, label]) => (
          <button key={v} onClick={() => setLens(v)}
            className={`px-4 py-1.5 rounded-full text-xs font-medium transition-all ${lens === v ? 'bg-tt-cyan text-black' : 'bg-tt-card-hover text-tt-muted hover:text-tt-text'}`}>
            {label}
          </button>
        ))}
      </div>

      {lens === 'show' ? <ByShow from={from} to={to} /> : <ByPeriod from={from} to={to} />}
    </main>
  );
}

// ══ By Show ═══════════════════════════════════════════════════════════════
function ByShow({ from, to }: { from: string; to: string }) {
  const [data, setData] = useState<ShowRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let alive = true; setLoading(true); setErr(null); setExpanded(null);
    fetch(`/api/member/pnl/by-show?from=${from}&to=${to}`)
      .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `Failed (${r.status})`); return j; })
      .then((j) => { if (!alive) return; setData(((j.rows ?? []) as Record<string, unknown>[]).map((r) => ({
        session_id: String(r.session_id), title: (r.title as string | null) ?? null,
        started_at: (r.started_at as string | null) ?? null, ended_at: (r.ended_at as string | null) ?? null,
        auctions: num(r.auctions), units: num(r.units), gmv_cents: num(r.gmv_cents),
        cogs_cents: num(r.cogs_cents), net_profit_cents: num(r.net_profit_cents),
      }))); })
      .catch((e) => { if (alive) setErr((e as Error).message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [from, to]);

  if (loading) return <Loading label="Loading P&L by show…" />;
  if (err) return <div className="rounded-xl border-2 border-tt-red/50 bg-tt-red/10 px-4 py-3 text-tt-red font-semibold">{err}</div>;
  if (data.length === 0) return <Empty>No shows with sales in this period.</Empty>;

  return (
    <div className="rounded-2xl border border-tt-border bg-tt-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-tt-border text-tt-muted text-xs uppercase tracking-wide">
            <th className="px-4 py-3 font-medium text-left">Show</th>
            <th className="px-4 py-3 font-medium text-right">Duration</th>
            <th className="px-4 py-3 font-medium text-right">Auctions</th>
            <th className="px-4 py-3 font-medium text-right">Units</th>
            <th className="px-4 py-3 font-medium text-right">GMV</th>
            <th className="px-4 py-3 font-medium text-right">Net profit</th>
            <th className="px-4 py-3 font-medium text-right">Margin %</th>
          </tr>
        </thead>
        <tbody>
          {data.map((s) => {
            const isOpen = expanded === s.session_id;
            return (
              <Fragment key={s.session_id}>
                <tr onClick={() => setExpanded(isOpen ? null : s.session_id)}
                  className="border-b border-tt-border last:border-0 cursor-pointer hover:bg-tt-card-hover">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className={`text-tt-muted transition-transform ${isOpen ? 'rotate-90' : ''}`}>▸</span>
                      <div>
                        <div className="font-medium">{s.title || 'Live session'}</div>
                        <div className="text-[11px] text-tt-muted">{fmtShowWhen(s.started_at)}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-tt-muted">{fmtDuration(s.started_at, s.ended_at)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{s.auctions.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{s.units.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{money(s.gmv_cents)}</td>
                  <td className={`px-4 py-3 text-right tabular-nums font-semibold ${netClass(s.net_profit_cents)}`}>{money(s.net_profit_cents)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{pct(marginOf(s.net_profit_cents, s.gmv_cents))}</td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={7} className="px-4 py-4 bg-tt-bg/40 border-b border-tt-border">
                      <HourlyBreakdown sessionId={s.session_id} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function HourlyBreakdown({ sessionId }: { sessionId: string }) {
  const [data, setData] = useState<HourRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true; setLoading(true); setErr(null);
    fetch(`/api/member/pnl/show-hourly?session_id=${encodeURIComponent(sessionId)}`)
      .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `Failed (${r.status})`); return j; })
      .then((j) => { if (!alive) return; setData(((j.rows ?? []) as Record<string, unknown>[]).map((r) => ({
        hour_start: String(r.hour_start), hour_of_day: num(r.hour_of_day), auctions: num(r.auctions), units: num(r.units),
        revenue_cents: num(r.revenue_cents), cogs_cents: num(r.cogs_cents), net_profit_cents: num(r.net_profit_cents),
      }))); })
      .catch((e) => { if (alive) setErr((e as Error).message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [sessionId]);

  const chart = useMemo(() => ({
    labels: data.map((h) => hourLabel(h.hour_of_day)),
    datasets: [{ label: 'Revenue', data: data.map((h) => h.revenue_cents / 100), backgroundColor: 'rgba(105, 201, 208, 0.55)', borderColor: '#69C9D0', borderWidth: 1, borderRadius: 4 }],
  }), [data]);

  if (loading) return <div className="text-xs text-tt-muted py-4">Loading hourly breakdown…</div>;
  if (err) return <div className="text-xs text-tt-red py-4">{err}</div>;
  if (data.length === 0) return <div className="text-xs text-tt-muted py-4">No hourly sales in this window.</div>;

  return (
    <div>
      <div className="text-xs font-semibold text-tt-muted mb-2">Revenue per hour (seller local time)</div>
      <div className="h-[180px] mb-4"><Bar data={chart} options={getBarChartOptions()} /></div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[420px]">
          <thead>
            <tr className="border-b border-tt-border text-tt-muted text-xs uppercase tracking-wide">
              <th className="px-3 py-2 font-medium text-left">Hour</th>
              <th className="px-3 py-2 font-medium text-right">Auctions</th>
              <th className="px-3 py-2 font-medium text-right">Units</th>
              <th className="px-3 py-2 font-medium text-right">Revenue</th>
              <th className="px-3 py-2 font-medium text-right">Net profit</th>
              <th className="px-3 py-2 font-medium text-right">Margin %</th>
            </tr>
          </thead>
          <tbody>
            {data.map((h) => (
              <tr key={h.hour_start} className="border-b border-tt-border last:border-0">
                <td className="px-3 py-2">{hourLabel(h.hour_of_day)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{h.auctions.toLocaleString()}</td>
                <td className="px-3 py-2 text-right tabular-nums">{h.units.toLocaleString()}</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(h.revenue_cents)}</td>
                <td className={`px-3 py-2 text-right tabular-nums ${netClass(h.net_profit_cents)}`}>{money(h.net_profit_cents)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{pct(marginOf(h.net_profit_cents, h.revenue_cents))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ══ By Period ═════════════════════════════════════════════════════════════
function ByPeriod({ from, to }: { from: string; to: string }) {
  const [data, setData] = useState<PeriodRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true; setLoading(true); setErr(null);
    fetch(`/api/member/pnl/by-period?from=${from}&to=${to}`)
      .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `Failed (${r.status})`); return j; })
      .then((j) => { if (!alive) return; setData(((j.rows ?? []) as Record<string, unknown>[]).map((r) => ({
        day: String(r.day), units: num(r.units), revenue_cents: num(r.revenue_cents),
        cogs_cents: num(r.cogs_cents), net_profit_cents: num(r.net_profit_cents),
      }))); })
      .catch((e) => { if (alive) setErr((e as Error).message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [from, to]);

  const lineData = useMemo(() => ({
    labels: data.map((d) => d.day),
    datasets: [
      { label: 'Net Profit', data: data.map((d) => d.net_profit_cents / 100), borderColor: '#69C9D0', backgroundColor: 'rgba(105, 201, 208, 0.1)', tension: 0.4, pointRadius: 3, pointBackgroundColor: '#69C9D0', fill: true, yAxisID: 'y' },
      { label: 'Revenue', data: data.map((d) => d.revenue_cents / 100), borderColor: '#EE1D52', backgroundColor: 'rgba(238, 29, 82, 0.08)', tension: 0.4, pointRadius: 3, pointBackgroundColor: '#EE1D52', fill: false, yAxisID: 'y' },
    ],
  }), [data]);

  const totals = useMemo(() => data.reduce((acc, d) => ({ revenue: acc.revenue + d.revenue_cents, net: acc.net + d.net_profit_cents, units: acc.units + d.units }), { revenue: 0, net: 0, units: 0 }), [data]);

  if (loading) return <Loading label="Loading P&L by period…" />;
  if (err) return <div className="rounded-xl border-2 border-tt-red/50 bg-tt-red/10 px-4 py-3 text-tt-red font-semibold">{err}</div>;
  if (data.length === 0) return <Empty>No sales in this period.</Empty>;

  const options = { ...getLineChartOptions('$'), plugins: { legend: { display: true, labels: { color: '#888', font: { size: 11 } } } } };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Revenue" value={money(totals.revenue)} />
        <StatCard label="Net profit *" value={money(totals.net)} valueClass={netClass(totals.net)} />
        <StatCard label="Units sold" value={totals.units.toLocaleString()} />
      </div>
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-5">
        <h3 className="text-sm font-semibold text-tt-muted mb-4">Daily net profit &amp; revenue</h3>
        <div className="relative h-[340px]"><Line data={lineData} options={options} /></div>
      </div>
      <p className="text-[11px] text-tt-muted">* Gross margin (revenue × 94% − COGS), not true net — see the note above.</p>
    </div>
  );
}
