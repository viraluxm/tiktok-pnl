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

  return (
    <div className="grid grid-cols-4 gap-5 mb-8">
      {/* 1. Total GMV */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-6 backdrop-blur-xl transition-all hover:border-tt-border-hover hover:-translate-y-0.5 animate-fade-in">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-tt-muted uppercase tracking-wide">Total GMV</span>
          <ChangeIndicator change={gmvChange} />
        </div>
        <div className="text-[30px] font-bold text-tt-cyan">{fmt(metrics.totalGMV)}</div>
        {metrics.totalUnitsSold > 0 && (
          <div className="text-xs text-tt-muted mt-1">
            {fmtInt(metrics.totalUnitsSold)} orders
          </div>
        )}
      </div>

      {/* 2. Total Net Profit */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-6 backdrop-blur-xl transition-all hover:border-tt-border-hover hover:-translate-y-0.5 animate-fade-in-1">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-tt-muted uppercase tracking-wide">Total Net Profit</span>
          <ChangeIndicator change={profitChange} />
        </div>
        <div className={`text-[30px] font-bold ${profitColor}`}>{fmt(metrics.totalNetProfit)}</div>
        <div className="text-xs mt-1">
          <span className={`${metrics.avgMargin >= 25 ? 'text-tt-green' : metrics.avgMargin >= 10 ? 'text-tt-yellow' : 'text-tt-red'}`}>
            {fmtPct(metrics.avgMargin)} margin
          </span>
        </div>
      </div>

      {/* 3. Returns / Refunds */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-6 backdrop-blur-xl transition-all hover:border-tt-border-hover hover:-translate-y-0.5 animate-fade-in-3">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-tt-muted uppercase tracking-wide">Returns / Refunds</span>
        </div>
        <div className="text-[30px] font-bold text-tt-red">{fmtInt(metrics.returnsCount || 0)}</div>
        {(metrics.returnsAmount || 0) > 0 && (
          <div className="text-xs text-tt-muted mt-1">
            {fmt(metrics.returnsAmount || 0)} value
          </div>
        )}
      </div>
    </div>
  );
}
