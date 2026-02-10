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
    <span className={`text-[11px] font-semibold ${isPositive ? 'text-tt-green' : 'text-tt-red'}`}>
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
  const viewsChange = prevMetrics ? pctChange(metrics.totalViews, prevMetrics.totalViews) : null;
  const adsChange = prevMetrics ? pctChange(metrics.totalAds, prevMetrics.totalAds) : null;
  const affiliateChange = prevMetrics ? pctChange(metrics.totalAffiliate, prevMetrics.totalAffiliate) : null;
  const profitPerVideoChange = prevMetrics ? pctChange(metrics.profitPerVideo, prevMetrics.profitPerVideo) : null;

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4 mb-6">
      {/* 1. Total GMV */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-5 backdrop-blur-xl transition-all hover:border-tt-border-hover hover:-translate-y-0.5 animate-fade-in">
        <div className="text-xs text-tt-muted uppercase tracking-wide mb-2">Total GMV</div>
        <div className="text-[26px] font-bold text-tt-cyan">{fmt(metrics.totalGMV)}</div>
        <div className="text-xs text-tt-muted mt-1 flex items-center gap-1.5">
          <ChangeIndicator change={gmvChange} />
          {gmvChange == null && <span>vs previous period</span>}
        </div>
      </div>

      {/* 2. Total Net Profit — with margin below */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-5 backdrop-blur-xl transition-all hover:border-tt-border-hover hover:-translate-y-0.5 animate-fade-in-1">
        <div className="text-xs text-tt-muted uppercase tracking-wide mb-2">Total Net Profit</div>
        <div className={`text-[26px] font-bold ${profitColor}`}>{fmt(metrics.totalNetProfit)}</div>
        <div className="text-xs mt-1 flex items-center gap-1.5">
          <span className={`${metrics.avgMargin >= 25 ? 'text-tt-green' : metrics.avgMargin >= 10 ? 'text-tt-yellow' : 'text-tt-red'}`}>
            {fmtPct(metrics.avgMargin)} margin
          </span>
          <ChangeIndicator change={profitChange} />
        </div>
      </div>

      {/* 3. Videos Posted */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-5 backdrop-blur-xl transition-all hover:border-tt-border-hover hover:-translate-y-0.5 animate-fade-in-2">
        <div className="text-xs text-tt-muted uppercase tracking-wide mb-2">Videos Posted</div>
        <div className="text-[26px] font-bold text-tt-cyan">{fmtInt(metrics.totalVideos)}</div>
        <div className="text-xs text-tt-muted mt-1 flex items-center gap-1.5">
          <span>{metrics.entryCount} days tracked</span>
          <ChangeIndicator change={videosChange} />
        </div>
      </div>

      {/* 4. Total Views */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-5 backdrop-blur-xl transition-all hover:border-tt-border-hover hover:-translate-y-0.5 animate-fade-in-3">
        <div className="text-xs text-tt-muted uppercase tracking-wide mb-2">Total Views</div>
        <div className="text-[26px] font-bold text-tt-magenta">{fmtInt(metrics.totalViews)}</div>
        <div className="text-xs text-tt-muted mt-1 flex items-center gap-1.5">
          <span>avg {fmtInt(Math.round(metrics.avgViewsPerVideo))}/video</span>
          <ChangeIndicator change={viewsChange} />
        </div>
      </div>

      {/* 5. Total Ad Spend */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-5 backdrop-blur-xl transition-all hover:border-tt-border-hover hover:-translate-y-0.5 animate-fade-in-4">
        <div className="text-xs text-tt-muted uppercase tracking-wide mb-2">Total Ad Spend</div>
        <div className="text-[26px] font-bold text-tt-text">{fmt(metrics.totalAds)}</div>
        <div className="text-xs text-tt-muted mt-1 flex items-center gap-1.5">
          <span>ROAS: {roasDisplay}</span>
          <ChangeIndicator change={adsChange} />
        </div>
      </div>

      {/* 6. Affiliate Commission Paid */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-5 backdrop-blur-xl transition-all hover:border-tt-border-hover hover:-translate-y-0.5 animate-fade-in-5">
        <div className="text-xs text-tt-muted uppercase tracking-wide mb-2">Affiliate Commission</div>
        <div className="text-[26px] font-bold text-tt-yellow">{fmt(metrics.totalAffiliate)}</div>
        <div className="text-xs text-tt-muted mt-1 flex items-center gap-1.5">
          <span>{metrics.totalGMV > 0 ? ((metrics.totalAffiliate / metrics.totalGMV) * 100).toFixed(1) : '0.0'}% of GMV</span>
          <ChangeIndicator change={affiliateChange} />
        </div>
      </div>

      {/* 7. Profit Per Video — with revenue/video below */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-5 backdrop-blur-xl transition-all hover:border-tt-border-hover hover:-translate-y-0.5 animate-fade-in-6">
        <div className="text-xs text-tt-muted uppercase tracking-wide mb-2">Profit Per Video</div>
        <div className={`text-[26px] font-bold ${metrics.profitPerVideo >= 0 ? 'text-tt-green' : 'text-tt-red'}`}>
          {fmt(metrics.profitPerVideo)}
        </div>
        <div className="text-xs mt-1 flex items-center gap-1.5">
          <span className="text-tt-muted">{fmt(metrics.revenuePerVideo)} rev/video</span>
          <ChangeIndicator change={profitPerVideoChange} />
        </div>
      </div>
    </div>
  );
}
