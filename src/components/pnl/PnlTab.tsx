'use client';

import { Fragment, useMemo, useState } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import { Line, Bar } from 'react-chartjs-2';
import { getLineChartOptions, getBarChartOptions } from '@/lib/chart-options';
import {
  usePnlBySku,
  usePnlByShow,
  usePnlShowHourly,
  usePnlByPeriod,
  type PnlSkuRow,
} from '@/hooks/usePnl';

ChartJS.register(
  CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend, Filler,
);

// Reorder safety buffer (days). A SKU is flagged when its days-of-cover falls to
// within lead time + this buffer. Hardcoded on purpose — change here to tune.
const SAFETY_BUFFER_DAYS = 3;

// ── formatting helpers ──────────────────────────────────────────────────
const money = (c: number) =>
  `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (v: number | null) => (v == null ? '—' : `${v.toFixed(1)}%`);

function fmtShowWhen(iso: string | null): string {
  if (!iso) return 'Unknown';
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function fmtDuration(start: string | null, end: string | null): string {
  if (!start || !end) return '—';
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  if (isNaN(s) || isNaN(e) || e < s) return '—';
  const mins = Math.round((e - s) / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// "8–9 PM" clock-hour label from a 0..23 local hour.
function hourLabel(h: number): string {
  const to12 = (x: number) => {
    const hr = ((x % 24) + 24) % 24;
    const ap = hr < 12 ? 'AM' : 'PM';
    const h12 = hr % 12 === 0 ? 12 : hr % 12;
    return { h12, ap };
  };
  const a = to12(h);
  const b = to12(h + 1);
  return a.ap === b.ap ? `${a.h12}–${b.h12} ${a.ap}` : `${a.h12} ${a.ap}–${b.h12} ${b.ap}`;
}

const marginOf = (net: number, revenue: number): number | null =>
  revenue > 0 ? (net / revenue) * 100 : null;
const netClass = (v: number) => (v >= 0 ? 'text-tt-green' : 'text-tt-red');

type Lens = 'sku' | 'show' | 'period';

export default function PnlTab({ dateFrom, dateTo }: { dateFrom: string | null; dateTo: string | null }) {
  const [lens, setLens] = useState<Lens>('sku');

  const lensOptions: Array<{ label: string; value: Lens }> = [
    { label: 'By SKU', value: 'sku' },
    { label: 'By Show', value: 'show' },
    { label: 'By Period', value: 'period' },
  ];

  return (
    <div>
      {/* Lens toggle */}
      <div className="flex gap-1 mb-6">
        {lensOptions.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setLens(opt.value)}
            className={`px-4 py-1.5 rounded-full text-xs font-medium cursor-pointer transition-all ${
              lens === opt.value ? 'bg-tt-cyan text-black' : 'bg-tt-card-hover text-tt-muted hover:text-tt-text'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {lens === 'sku' && <BySkuLens dateFrom={dateFrom} dateTo={dateTo} />}
      {lens === 'show' && <ByShowLens dateFrom={dateFrom} dateTo={dateTo} />}
      {lens === 'period' && <ByPeriodLens dateFrom={dateFrom} dateTo={dateTo} />}
    </div>
  );
}

// ══ shared UI bits ════════════════════════════════════════════════════════
function Loading({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center py-16 text-tt-muted">
      <div className="w-5 h-5 border-2 border-tt-muted border-t-transparent rounded-full animate-spin mr-3" />
      {label}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-tt-border bg-tt-card py-16 text-center text-sm text-tt-muted">
      {children}
    </div>
  );
}

// ══ LENS 1: By SKU ═════════════════════════════════════════════════════════
interface EnrichedSku extends PnlSkuRow {
  daysOfCover: number | null; // null => no velocity (never runs out) or no data
  margin: number | null;
  hasLead: boolean;
  reorderFlag: boolean;
  lowMargin: boolean;
}

type SkuSortKey =
  | 'default' | 'sku_number' | 'title' | 'units_sold' | 'revenue_cents' | 'cogs_cents'
  | 'net_profit_cents' | 'margin' | 'qty_on_hand' | 'daysOfCover' | 'lead_time_days';

function enrichSku(r: PnlSkuRow): EnrichedSku {
  const velocity = r.period_days > 0 ? r.units_sold / r.period_days : 0;
  const daysOfCover = velocity > 0 ? r.qty_on_hand / velocity : null;
  const margin = marginOf(r.net_profit_cents, r.revenue_cents);
  const hasLead = r.lead_time_days != null;
  const reorderFlag =
    hasLead && daysOfCover != null && daysOfCover <= (r.lead_time_days as number) + SAFETY_BUFFER_DAYS;
  const lowMargin = margin != null && margin < 0;
  return { ...r, daysOfCover, margin, hasLead, reorderFlag, lowMargin };
}

const alignClass = (a: 'left' | 'right' | 'center') =>
  a === 'left' ? 'text-left' : a === 'center' ? 'text-center' : 'text-right';

function SortTh({ k, label, align = 'right', sort, onSort }: {
  k: SkuSortKey;
  label: string;
  align?: 'left' | 'right' | 'center';
  sort: { key: SkuSortKey; dir: 'asc' | 'desc' };
  onSort: (k: SkuSortKey) => void;
}) {
  const arrow = sort.key === k ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : '';
  return (
    <th
      onClick={() => onSort(k)}
      className={`px-3 py-3 font-medium cursor-pointer select-none hover:text-tt-text whitespace-nowrap ${alignClass(align)}`}
    >
      {label}{arrow}
    </th>
  );
}

function BySkuLens({ dateFrom, dateTo }: { dateFrom: string | null; dateTo: string | null }) {
  const { data = [], isLoading } = usePnlBySku(dateFrom, dateTo);
  const [sort, setSort] = useState<{ key: SkuSortKey; dir: 'asc' | 'desc' }>({ key: 'default', dir: 'desc' });

  const rows = useMemo(() => {
    const enriched = data.map(enrichSku);
    const dir = sort.dir === 'asc' ? 1 : -1;
    const numCmp = (a: number | null, b: number | null) => {
      // nulls always sort last, regardless of direction
      if (a == null && b == null) return 0;
      if (a == null) return 1;
      if (b == null) return -1;
      return (a - b) * dir;
    };
    const sorted = [...enriched];
    if (sort.key === 'default') {
      // reorder-flagged first, then net profit desc
      sorted.sort(
        (a, b) => Number(b.reorderFlag) - Number(a.reorderFlag) || b.net_profit_cents - a.net_profit_cents,
      );
    } else if (sort.key === 'title') {
      sorted.sort((a, b) => a.title.localeCompare(b.title) * dir);
    } else {
      const k = sort.key as keyof EnrichedSku;
      sorted.sort((a, b) => numCmp(a[k] as number | null, b[k] as number | null));
    }
    return sorted;
  }, [data, sort]);

  function toggleSort(key: SkuSortKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'title' ? 'asc' : 'desc' },
    );
  }

  if (isLoading) return <Loading label="Loading P&L by SKU…" />;
  if (data.length === 0) return <Empty>No SKUs yet.</Empty>;

  return (
    <div className="rounded-2xl border border-tt-border bg-tt-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-tt-border text-tt-muted text-xs uppercase tracking-wide">
            <SortTh k="sku_number" label="SKU" align="left" sort={sort} onSort={toggleSort} />
            <SortTh k="title" label="Item" align="left" sort={sort} onSort={toggleSort} />
            <SortTh k="units_sold" label="Units sold" sort={sort} onSort={toggleSort} />
            <SortTh k="revenue_cents" label="Revenue" sort={sort} onSort={toggleSort} />
            <SortTh k="cogs_cents" label="COGS" sort={sort} onSort={toggleSort} />
            <SortTh k="net_profit_cents" label="Net profit" sort={sort} onSort={toggleSort} />
            <SortTh k="margin" label="Margin %" sort={sort} onSort={toggleSort} />
            <SortTh k="qty_on_hand" label="Qty on hand" sort={sort} onSort={toggleSort} />
            <SortTh k="daysOfCover" label="Days of cover" sort={sort} onSort={toggleSort} />
            <SortTh k="lead_time_days" label="Lead time" sort={sort} onSort={toggleSort} />
            <th className="px-3 py-3 font-medium text-left whitespace-nowrap">Reorder signal</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.sku_id} className={`border-b border-tt-border last:border-0 ${r.is_active ? '' : 'opacity-50'}`}>
              <td className="px-3 py-3 font-mono text-tt-muted">{r.sku_number}</td>
              <td className="px-3 py-3 max-w-[200px] truncate">{r.title || <span className="text-tt-muted">Untitled</span>}</td>
              <td className="px-3 py-3 text-right tabular-nums">{r.units_sold.toLocaleString()}</td>
              <td className="px-3 py-3 text-right tabular-nums">{money(r.revenue_cents)}</td>
              <td className="px-3 py-3 text-right tabular-nums text-tt-muted">{money(r.cogs_cents)}</td>
              <td className={`px-3 py-3 text-right tabular-nums font-semibold ${netClass(r.net_profit_cents)}`}>{money(r.net_profit_cents)}</td>
              <td className={`px-3 py-3 text-right tabular-nums ${r.lowMargin ? 'text-tt-red' : ''}`}>{pct(r.margin)}</td>
              <td className="px-3 py-3 text-right tabular-nums">{r.qty_on_hand.toLocaleString()}</td>
              <td className="px-3 py-3 text-right tabular-nums">
                {r.daysOfCover == null ? <span className="text-tt-muted">—</span> : `${r.daysOfCover.toFixed(1)} d`}
              </td>
              <td className="px-3 py-3 text-right tabular-nums">
                {r.lead_time_days == null ? <span className="text-tt-muted">—</span> : `${r.lead_time_days} d`}
              </td>
              <td className="px-3 py-3">
                <div className="flex flex-col items-start gap-1">
                  {!r.hasLead ? (
                    <span className="text-xs text-tt-muted italic">Set lead time</span>
                  ) : r.reorderFlag ? (
                    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-tt-red/15 text-tt-red text-xs font-semibold">
                      <span className="w-1.5 h-1.5 rounded-full bg-tt-red" />Reorder now
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-tt-green/15 text-tt-green text-xs font-semibold">
                      <span className="w-1.5 h-1.5 rounded-full bg-tt-green" />OK
                    </span>
                  )}
                  {r.lowMargin && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-tt-red/15 text-tt-red text-xs font-medium">
                      Low margin
                    </span>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="px-3 py-2.5 text-[11px] text-tt-muted border-t border-tt-border">
        Days of cover = qty on hand ÷ daily velocity (units sold ÷ days in period). Reorder flags when cover ≤ lead time + {SAFETY_BUFFER_DAYS}-day buffer.
      </div>
    </div>
  );
}

// ══ LENS 2: By Show (+ per-hour drill-down) ════════════════════════════════
function ByShowLens({ dateFrom, dateTo }: { dateFrom: string | null; dateTo: string | null }) {
  const { data = [], isLoading } = usePnlByShow(dateFrom, dateTo);
  const [expanded, setExpanded] = useState<string | null>(null);

  if (isLoading) return <Loading label="Loading P&L by show…" />;
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
                <tr
                  onClick={() => setExpanded(isOpen ? null : s.session_id)}
                  className="border-b border-tt-border last:border-0 cursor-pointer hover:bg-tt-card-hover"
                >
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
                  <tr key={`${s.session_id}-hours`}>
                    <td colSpan={7} className="px-4 py-4 bg-tt-bg/40 border-b border-tt-border">
                      <HourlyBreakdown sessionId={s.session_id} dateFrom={dateFrom} dateTo={dateTo} />
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

function HourlyBreakdown({ sessionId, dateFrom, dateTo }: { sessionId: string; dateFrom: string | null; dateTo: string | null }) {
  const { data = [], isLoading } = usePnlShowHourly(sessionId, dateFrom, dateTo);

  const chart = useMemo(() => ({
    labels: data.map((h) => hourLabel(h.hour_of_day)),
    datasets: [
      {
        label: 'Revenue',
        data: data.map((h) => h.revenue_cents / 100),
        backgroundColor: 'rgba(105, 201, 208, 0.55)',
        borderColor: '#69C9D0',
        borderWidth: 1,
        borderRadius: 4,
      },
    ],
  }), [data]);

  if (isLoading) return <div className="text-xs text-tt-muted py-4">Loading hourly breakdown…</div>;
  if (data.length === 0) return <div className="text-xs text-tt-muted py-4">No hourly sales in this window.</div>;

  return (
    <div>
      <div className="text-xs font-semibold text-tt-muted mb-2">Revenue per hour (seller local time)</div>
      <div className="h-[180px] mb-4">
        <Bar data={chart} options={getBarChartOptions()} />
      </div>
      <table className="w-full text-sm">
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
  );
}

// ══ LENS 3: By Period ══════════════════════════════════════════════════════
function ByPeriodLens({ dateFrom, dateTo }: { dateFrom: string | null; dateTo: string | null }) {
  const { data = [], isLoading } = usePnlByPeriod(dateFrom, dateTo);

  const labels = data.map((d) => d.day);
  const lineData = useMemo(() => ({
    labels,
    datasets: [
      {
        label: 'Net Profit',
        data: data.map((d) => d.net_profit_cents / 100),
        borderColor: '#69C9D0',
        backgroundColor: 'rgba(105, 201, 208, 0.1)',
        tension: 0.4,
        pointRadius: 3,
        pointBackgroundColor: '#69C9D0',
        fill: true,
        yAxisID: 'y',
      },
      {
        label: 'Revenue',
        data: data.map((d) => d.revenue_cents / 100),
        borderColor: '#EE1D52',
        backgroundColor: 'rgba(238, 29, 82, 0.08)',
        tension: 0.4,
        pointRadius: 3,
        pointBackgroundColor: '#EE1D52',
        fill: false,
        yAxisID: 'y',
      },
    ],
  }), [data, labels]);

  const totals = useMemo(() => data.reduce(
    (acc, d) => ({
      revenue: acc.revenue + d.revenue_cents,
      net: acc.net + d.net_profit_cents,
      units: acc.units + d.units,
    }),
    { revenue: 0, net: 0, units: 0 },
  ), [data]);

  if (isLoading) return <Loading label="Loading P&L by period…" />;
  if (data.length === 0) return <Empty>No sales in this period.</Empty>;

  const options = { ...getLineChartOptions('$'), plugins: { legend: { display: true, labels: { color: '#888', font: { size: 11 } } } } };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Revenue" value={money(totals.revenue)} />
        <StatCard label="Net profit" value={money(totals.net)} valueClass={netClass(totals.net)} />
        <StatCard label="Units sold" value={totals.units.toLocaleString()} />
      </div>
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-5">
        <h3 className="text-sm font-semibold text-tt-muted mb-4">Daily net profit &amp; revenue</h3>
        <div className="relative h-[340px]">
          <Line data={lineData} options={options} />
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, valueClass = 'text-tt-text' }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="bg-tt-card border border-tt-border rounded-[14px] p-5">
      <div className="text-xs text-tt-muted mb-1">{label}</div>
      <div className={`text-2xl font-bold tabular-nums ${valueClass}`}>{value}</div>
    </div>
  );
}
