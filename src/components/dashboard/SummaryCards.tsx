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
  const roasDisplay = metrics.roas != null ? metrics.roas.toFixed(1) + 'x' : '\u221Ex';

  // Calculate % changes vs previous period
  const gmvChange = prevMetrics ? pctChange(metrics.totalGMV, prevMetrics.totalGMV) : null;
  const profitChange = prevMetrics ? pctChange(metrics.totalNetProfit, prevMetrics.totalNetProfit) : null;
  const videosChange = prevMetrics ? pctChange(metrics.totalVideos, prevMetrics.totalVideos) : null;
  const adsChange = prevMetrics ? pctChange(metrics.totalAds, prevMetrics.totalAds) : null;
  const affiliateChange = prevMetrics ? pctChange(metrics.totalAffiliate, prevMetrics.totalAffiliate) : null;
  const profitPerVideoChange = prevMetrics ? pctChange(metrics.profitPerVideo, prevMetrics.profitPerVideo) : null;

  return (
    <div className="grid grid-cols-3 gap-4 mb-6">
      {/* 1. Total GMV */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-5 backdrop-blur-xl transition-all hover:border-tt-border-hover hover:-translate-y-0.5 animate-fade-in">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-tt-muted uppercase tracking-wide">Total GMV</span>
          <ChangeIndicator change={gmvChange} />
        </div>
        <div className="text-[26px] font-bold text-tt-cyan">{fmt(metrics.totalGMV)}</div>
      </div>

      {/* 2. Total Net Profit */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-5 backdrop-blur-xl transition-all hover:border-tt-border-hover hover:-translate-y-0.5 animate-fade-in-1">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-tt-muted uppercase tracking-wide">Total Net Profit</span>
          <ChangeIndicator change={profitChange} />
        </div>
        <div className={`text-[26px] font-bold ${profitColor}`}>{fmt(metrics.totalNetProfit)}</div>
        <div className="text-xs mt-1">
          <span className={`${metrics.avgMargin >= 25 ? 'text-tt-green' : metrics.avgMargin >= 10 ? 'text-tt-yellow' : 'text-tt-red'}`}>
            {fmtPct(metrics.avgMargin)} margin
          </span>
        </div>
      </div>

      {/* 3. Units Sold */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-5 backdrop-blur-xl transition-all hover:border-tt-border-hover hover:-translate-y-0.5 animate-fade-in-2">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-tt-muted uppercase tracking-wide">Units Sold</span>
        </div>
        <div className="text-[26px] font-bold text-tt-cyan">{fmtInt(metrics.totalUnitsSold)}</div>
        <div className="text-xs text-tt-muted mt-1">
          {metrics.entryCount} active days
        </div>
      </div>

      {/* 4. Total Ad Spend */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-5 backdrop-blur-xl transition-all hover:border-tt-border-hover hover:-translate-y-0.5 animate-fade-in-3">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-tt-muted uppercase tracking-wide">Total Ad Spend</span>
        </div>
        <div className="text-[26px] font-bold text-tt-text">{fmt(metrics.totalAds)}</div>
        <div className="text-xs text-tt-muted mt-1">
          {metrics.totalAds > 0 ? `ROAS: ${roasDisplay}` : 'TikTok Ads API coming soon'}
        </div>
      </div>

      {/* 5. Affiliate Commission */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-5 backdrop-blur-xl transition-all hover:border-tt-border-hover hover:-translate-y-0.5 animate-fade-in-4">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-tt-muted uppercase tracking-wide">Affiliate Commission</span>
        </div>
        {metrics.totalAffiliate > 0 ? (
          <>
            <div className="text-[26px] font-bold text-tt-yellow">{fmt(metrics.totalAffiliate)}</div>
            <div className="text-xs text-tt-muted mt-1">
              {((metrics.totalAffiliate / metrics.totalGMV) * 100).toFixed(1)}% of GMV
            </div>
          </>
        ) : (
          <>
            <div className="text-[20px] font-bold text-tt-muted">Coming Soon</div>
            <div className="text-xs text-tt-muted mt-1">Requires Affiliate API scope</div>
          </>
        )}
      </div>

      {/* 6. Shipping Cost */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-5 backdrop-blur-xl transition-all hover:border-tt-border-hover hover:-translate-y-0.5 animate-fade-in-5">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-tt-muted uppercase tracking-wide">Total Shipping</span>
        </div>
        <div className="text-[26px] font-bold text-tt-text">{fmt(metrics.totalShipping)}</div>
        <div className="text-xs text-tt-muted mt-1">
          {metrics.totalGMV > 0 ? ((metrics.totalShipping / metrics.totalGMV) * 100).toFixed(1) : '0.0'}% of GMV
        </div>
      </div>
    </div>
  );
}
