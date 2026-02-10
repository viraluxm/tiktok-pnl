'use client';

import { useState, useMemo } from 'react';
import dynamic from 'next/dynamic';
import Header from '@/components/layout/Header';
import FiltersBar from '@/components/filters/FiltersBar';
import SummaryCards from '@/components/dashboard/SummaryCards';
import ForecastCard from '@/components/dashboard/ForecastCard';
import ProductCostTable from '@/components/products/ProductCostTable';
import TikTokConnect from '@/components/tiktok/TikTokConnect';
import { useProducts } from '@/hooks/useProducts';
import { useEntries } from '@/hooks/useEntries';
import { useFilters } from '@/hooks/useFilters';
import { computeDashboardMetrics, computeChartData } from '@/lib/calculations';

const Charts = dynamic(() => import('@/components/dashboard/Charts'), { ssr: false });

type ViewTab = 'dashboard' | 'products';

export default function RealDashboard() {
  const [activeView, setActiveView] = useState<ViewTab>('dashboard');
  const [activeQuickFilter, setActiveQuickFilter] = useState<number | 'all'>('all');

  const { filters, setQuickFilter, setDateFrom, setDateTo } = useFilters();
  const { products } = useProducts();
  const { entries } = useEntries(filters);

  const metrics = useMemo(() => computeDashboardMetrics(entries), [entries]);
  const chartData = useMemo(() => computeChartData(entries), [entries]);

  function handleQuickFilter(days: number | 'all') {
    setActiveQuickFilter(days);
    setQuickFilter(days);
  }

  const tabs: Array<{ label: string; value: ViewTab }> = [
    { label: 'Dashboard', value: 'dashboard' },
    { label: 'Products', value: 'products' },
  ];

  return (
    <div className="min-h-screen bg-tt-bg">
      <Header />

      <div className="p-6 max-w-[1600px] mx-auto">
        <TikTokConnect />
        <FiltersBar
          filters={filters}
          onQuickFilter={handleQuickFilter}
          onDateFromChange={setDateFrom}
          onDateToChange={setDateTo}
          activeQuickFilter={activeQuickFilter}
        />

        {/* View Tabs */}
        <div className="flex gap-1 mb-6">
          {tabs.map((tab) => (
            <button
              key={tab.value}
              onClick={() => setActiveView(tab.value)}
              className={`px-5 py-2 rounded-lg border text-[13px] font-medium cursor-pointer transition-all ${
                activeView === tab.value
                  ? 'bg-tt-cyan text-black border-tt-cyan font-semibold'
                  : 'border-tt-border text-tt-muted hover:bg-tt-card-hover'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Dashboard View */}
        {activeView === 'dashboard' && (
          <>
            <SummaryCards metrics={metrics} />
            <ForecastCard entries={entries} />
            <Charts chartData={chartData} />
          </>
        )}

        {/* Products View */}
        {activeView === 'products' && (
          <ProductCostTable
            products={products}
            productProfits={metrics.productProfits}
            chartData={chartData}
            entries={entries}
          />
        )}
      </div>
    </div>
  );
}
