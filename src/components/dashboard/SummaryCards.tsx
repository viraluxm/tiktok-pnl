'use client';

import type { ReactNode } from 'react';
import type { DashboardMetrics } from '@/types';
import { fmt, fmtInt, fmtPct } from '@/lib/calculations';

interface SummaryCardsProps {
  metrics: DashboardMetrics | null;
  prevMetrics?: DashboardMetrics | null;
  loading?: boolean;
  error?: boolean;
}

function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return current > 0 ? 100 : null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function ChangeIndicator({ change }: { change: number | null }) {
  if (change == null) return null;
  const isPositive = change >= 0;
  return (
    <span className={`text-[10px] font-semibold ${isPositive ? 'text-tt-green' : 'text-tt-red'}`}>
      {isPositive ? '↑' : '↓'} {Math.abs(change).toFixed(1)}%
    </span>
  );
}

// Three-state tile value. error → an EXPLICIT failure, never a masked $0 (a wrong number the
// user trusts is worse than a visible error). loading → skeleton. otherwise the real value,
// which may legitimately be zero.
function TileValue({ loading, error, colorClass, children }: {
  loading: boolean; error: boolean; colorClass: string; children: ReactNode;
}) {
  if (error) {
    return (
      <div className="text-lg md:text-xl font-bold text-tt-red break-words min-w-0" title="Dashboard totals failed to load — this is an error, not $0.">
        Failed to load
      </div>
    );
  }
  if (loading) {
    return <div className="h-8 md:h-9 w-24 rounded-md bg-tt-border/40 animate-pulse" aria-label="Loading" />;
  }
  return <div className={`text-2xl md:text-[30px] font-bold break-words min-w-0 tabular-nums ${colorClass}`}>{children}</div>;
}

export default function SummaryCards({ metrics, prevMetrics, loading = false, error = false }: SummaryCardsProps) {
  // Three states, in priority order: error (fetch failed) → loading (in flight / no data yet) →
  // ready (real data, possibly a genuine zero). `metrics == null` with no error means "no data yet".
  const ready = !error && !loading && metrics != null;
  const showLoading = !error && (loading || metrics == null);

  const profitColor = metrics && metrics.totalNetProfit >= 0 ? 'text-tt-green' : metrics ? 'text-tt-red' : 'text-tt-text';
  const marginColor = metrics
    ? (metrics.avgMargin >= 25 ? 'text-tt-green' : metrics.avgMargin >= 10 ? 'text-tt-yellow' : 'text-tt-red')
    : '';

  // Value nodes computed only when metrics is present (guards null access); TileValue ignores
  // them under loading/error anyway.
  const gmvVal = metrics ? fmt(metrics.totalGMV) : null;
  const profitVal = metrics ? fmt(metrics.totalNetProfit) : null;
  const unitsVal = metrics ? fmtInt(metrics.totalUnits) : null;
  // returnsCount/returnsAmount are OPTIONAL in the type (not fetch-masking — the error/loading
  // states above handle an absent fetch); coalesce only for that type-optionality.
  const returnsVal = metrics ? fmtInt(metrics.returnsCount ?? 0) : null;

  const gmvChange = ready && prevMetrics ? pctChange(metrics!.totalGMV, prevMetrics.totalGMV) : null;
  const profitChange = ready && prevMetrics ? pctChange(metrics!.totalNetProfit, prevMetrics.totalNetProfit) : null;
  const unitsChange = ready && prevMetrics ? pctChange(metrics!.totalUnits, prevMetrics.totalUnits) : null;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-5 mb-8">
      {/* 1. Total GMV */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-4 md:p-6 backdrop-blur-xl transition-all hover:border-tt-border-hover hover:-translate-y-0.5 animate-fade-in">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-tt-muted uppercase tracking-wide">Total GMV</span>
          <ChangeIndicator change={gmvChange} />
        </div>
        <TileValue loading={showLoading} error={error} colorClass="text-tt-cyan">{gmvVal}</TileValue>
        {ready && metrics!.totalUnitsSold > 0 && (
          <div className="text-xs text-tt-muted mt-1">{fmtInt(metrics!.totalUnitsSold)} orders</div>
        )}
      </div>

      {/* 2. Net Profit · All Shop Orders */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-4 md:p-6 backdrop-blur-xl transition-all hover:border-tt-border-hover hover:-translate-y-0.5 animate-fade-in-1">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-tt-muted uppercase tracking-wide">Net Profit · All Shop Orders</span>
          <ChangeIndicator change={profitChange} />
        </div>
        <TileValue loading={showLoading} error={error} colorClass={profitColor}>{profitVal}</TileValue>
        {ready && (
          <div className="text-xs mt-1">
            <span className={marginColor}>{fmtPct(metrics!.avgMargin)} margin</span>
          </div>
        )}
        <div className="text-[11px] text-tt-muted mt-1 leading-snug">
          All TikTok Shop orders — incl. fees, shipping, affiliate &amp; ad spend
        </div>
      </div>

      {/* 3. Units Sold */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-4 md:p-6 backdrop-blur-xl transition-all hover:border-tt-border-hover hover:-translate-y-0.5 animate-fade-in-2">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-tt-muted uppercase tracking-wide">Units Sold</span>
          <ChangeIndicator change={unitsChange} />
        </div>
        <TileValue loading={showLoading} error={error} colorClass="text-tt-text">{unitsVal}</TileValue>
        {ready && metrics!.totalUnitsSold > 0 && (
          <div className="text-xs text-tt-muted mt-1">{fmtInt(metrics!.totalUnitsSold)} orders</div>
        )}
      </div>

      {/* 4. Returns / Refunds */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-4 md:p-6 backdrop-blur-xl transition-all hover:border-tt-border-hover hover:-translate-y-0.5 animate-fade-in-3">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-tt-muted uppercase tracking-wide">Returns / Refunds</span>
        </div>
        <TileValue loading={showLoading} error={error} colorClass="text-tt-red">{returnsVal}</TileValue>
        {ready && (metrics!.returnsAmount ?? 0) > 0 && (
          <div className="text-xs text-tt-muted mt-1">{fmt(metrics!.returnsAmount ?? 0)} value</div>
        )}
      </div>
    </div>
  );
}
