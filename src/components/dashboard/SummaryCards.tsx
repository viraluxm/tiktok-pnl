'use client';

import type { DashboardMetrics } from '@/types';
import { fmt, fmtInt, fmtPct } from '@/lib/calculations';

interface SummaryCardsProps {
  metrics: DashboardMetrics;
  prevMetrics?: DashboardMetrics | null;
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

export default function SummaryCards({ metrics, prevMetrics }: SummaryCardsProps) {
  const profitColor = metrics.totalNetProfit >= 0 ? 'text-tt-green' : 'text-tt-red';

  const gmvChange = prevMetrics ? pctChange(metrics.totalGMV, prevMetrics.totalGMV) : null;
  const profitChange = prevMetrics ? pctChange(metrics.totalNetProfit, prevMetrics.totalNetProfit) : null;
  const unitsChange = prevMetrics ? pctChange(metrics.totalUnits, prevMetrics.totalUnits) : null;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-5 mb-8">
      {/* 1. Total GMV */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-4 md:p-6 backdrop-blur-xl transition-all hover:border-tt-border-hover hover:-translate-y-0.5 animate-fade-in">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-tt-muted uppercase tracking-wide">Total GMV</span>
          <ChangeIndicator change={gmvChange} />
        </div>
        <div className="text-2xl md:text-[30px] font-bold text-tt-cyan break-words min-w-0 tabular-nums">{fmt(metrics.totalGMV)}</div>
        {metrics.totalUnitsSold > 0 && (
          <div className="text-xs text-tt-muted mt-1">
            {fmtInt(metrics.totalUnitsSold)} orders
          </div>
        )}
      </div>

      {/* 2. Net Profit · All Shop Orders */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-4 md:p-6 backdrop-blur-xl transition-all hover:border-tt-border-hover hover:-translate-y-0.5 animate-fade-in-1">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-tt-muted uppercase tracking-wide">Net · All Shop Orders</span>
          <ChangeIndicator change={profitChange} />
        </div>
        <div className={`text-2xl md:text-[30px] font-bold break-words min-w-0 tabular-nums ${profitColor}`}>{fmt(metrics.totalNetProfit)}</div>
        <div className="text-xs mt-1">
          <span className={`${metrics.avgMargin >= 25 ? 'text-tt-green' : metrics.avgMargin >= 10 ? 'text-tt-yellow' : 'text-tt-red'}`}>
            {fmtPct(metrics.avgMargin)} margin
          </span>
        </div>
        <div className="text-[11px] text-tt-muted mt-1 leading-snug">
          All TikTok Shop orders, net of platform fee, COGS, ad spend &amp; host labor. Excludes refunds and fulfillment labor.
        </div>
      </div>

      {/* 3. Units Sold */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-4 md:p-6 backdrop-blur-xl transition-all hover:border-tt-border-hover hover:-translate-y-0.5 animate-fade-in-2">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-tt-muted uppercase tracking-wide">Units Sold</span>
          <ChangeIndicator change={unitsChange} />
        </div>
        <div className="text-2xl md:text-[30px] font-bold text-tt-text break-words min-w-0 tabular-nums">{fmtInt(metrics.totalUnits)}</div>
        {metrics.totalUnitsSold > 0 && (
          <div className="text-xs text-tt-muted mt-1">
            {fmtInt(metrics.totalUnitsSold)} orders
          </div>
        )}
      </div>

      {/* 4. Returns / Refunds */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-4 md:p-6 backdrop-blur-xl transition-all hover:border-tt-border-hover hover:-translate-y-0.5 animate-fade-in-3">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-tt-muted uppercase tracking-wide">Returns / Refunds</span>
        </div>
        <div className="text-2xl md:text-[30px] font-bold text-tt-red break-words min-w-0 tabular-nums">{fmtInt(metrics.returnsCount || 0)}</div>
        {(metrics.returnsAmount || 0) > 0 && (
          <div className="text-xs text-tt-muted mt-1">
            {fmt(metrics.returnsAmount || 0)} value
          </div>
        )}
      </div>
    </div>
  );
}
