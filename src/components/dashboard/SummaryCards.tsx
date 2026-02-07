'use client';

import type { DashboardMetrics } from '@/types';
import { fmt, fmtInt, fmtPct } from '@/lib/calculations';

interface SummaryCardsProps {
  metrics: DashboardMetrics;
}

export default function SummaryCards({ metrics }: SummaryCardsProps) {
  const profitColor = metrics.totalNetProfit >= 0 ? 'text-tt-green' : 'text-tt-red';
  const profitSub = metrics.totalNetProfit >= 0 ? 'profitable' : 'net loss';

  let marginColor = 'text-tt-red';
  let marginSub = metrics.avgMargin < 0 ? 'negative' : 'low';
  if (metrics.avgMargin >= 25) { marginColor = 'text-tt-green'; marginSub = 'healthy'; }
  else if (metrics.avgMargin >= 10) { marginColor = 'text-tt-yellow'; marginSub = 'moderate'; }

  const roasDisplay = metrics.roas != null ? metrics.roas.toFixed(1) + 'x' : '\u221Ex';

  const cards = [
    {
      label: 'Total GMV', value: fmt(metrics.totalGMV), color: 'text-tt-cyan',
      sub: `${metrics.entryCount} entries`, delay: 'animate-fade-in',
    },
    {
      label: 'Total Net Profit', value: fmt(metrics.totalNetProfit), color: profitColor,
      sub: profitSub, delay: 'animate-fade-in-1',
    },
    {
      label: 'Avg Profit Margin', value: fmtPct(metrics.avgMargin), color: marginColor,
      sub: marginSub, delay: 'animate-fade-in-2',
    },
    {
      label: 'Videos Posted', value: fmtInt(metrics.totalVideos), color: 'text-tt-cyan',
      sub: `${metrics.entryCount} days tracked`, delay: 'animate-fade-in-3',
    },
    {
      label: 'Total Views', value: fmtInt(metrics.totalViews), color: 'text-tt-magenta',
      sub: `avg ${fmtInt(Math.round(metrics.avgViewsPerVideo))}/video`, delay: 'animate-fade-in-4',
    },
    {
      label: 'Total Ad Spend', value: fmt(metrics.totalAds), color: 'text-tt-text',
      sub: `ROAS: ${roasDisplay}`, delay: 'animate-fade-in-5',
    },
    {
      label: 'Top Product', value: metrics.topProduct?.name || '--', color: 'text-tt-cyan',
      sub: metrics.topProduct ? `${fmt(metrics.topProduct.profit)} net profit` : 'by net profit',
      delay: 'animate-fade-in-6', smallValue: true,
    },
  ];

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4 mb-6">
      {cards.map((card) => (
        <div
          key={card.label}
          className={`bg-tt-card border border-tt-border rounded-[14px] p-5 backdrop-blur-xl transition-all hover:border-tt-border-hover hover:-translate-y-0.5 ${card.delay}`}
        >
          <div className="text-xs text-tt-muted uppercase tracking-wide mb-2">{card.label}</div>
          <div className={`${card.smallValue ? 'text-lg' : 'text-[26px]'} font-bold ${card.color}`}>
            {card.value}
          </div>
          <div className="text-xs text-tt-muted mt-1">{card.sub}</div>
        </div>
      ))}
    </div>
  );
}
