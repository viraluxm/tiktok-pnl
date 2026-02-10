'use client';

import { useState, useMemo, useCallback } from 'react';
import dynamic from 'next/dynamic';
import Header from '@/components/layout/Header';
import FiltersBar from '@/components/filters/FiltersBar';
import SummaryCards from '@/components/dashboard/SummaryCards';
import ForecastCard from '@/components/dashboard/ForecastCard';
import ProductCostTable from '@/components/products/ProductCostTable';
import TikTokConnect from '@/components/tiktok/TikTokConnect';
import { useProducts } from '@/hooks/useProducts';
import { useEntries } from '@/hooks/useEntries';
import { useProductCosts } from '@/hooks/useProductCosts';
import { useFilters } from '@/hooks/useFilters';
import { computeDashboardMetrics, computeChartData } from '@/lib/calculations';
import type { Entry } from '@/types';

const Charts = dynamic(() => import('@/components/dashboard/Charts'), { ssr: false });

type ViewTab = 'dashboard' | 'products';

function getPreviousPeriodEntries(
  allEntries: Entry[],
  activeQuickFilter: number | 'all',
  dateFrom: string | null,
  dateTo: string | null,
): Entry[] {
  if (activeQuickFilter === 'all' || (!dateFrom && !dateTo)) return [];

  const now = new Date();
  let prevFrom: string;
  let prevTo: string;

  if (activeQuickFilter === 0) {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    prevFrom = prevTo = yesterday.toISOString().split('T')[0];
  } else if (activeQuickFilter === 1) {
    const dayBefore = new Date(now);
    dayBefore.setDate(dayBefore.getDate() - 2);
    prevFrom = prevTo = dayBefore.toISOString().split('T')[0];
  } else if (dateFrom && dateTo) {
    const from = new Date(dateFrom);
    const to = new Date(dateTo);
    const daysSpan = Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
    const prevEnd = new Date(from);
    prevEnd.setDate(prevEnd.getDate() - 1);
    const prevStart = new Date(prevEnd);
    prevStart.setDate(prevStart.getDate() - daysSpan + 1);
    prevFrom = prevStart.toISOString().split('T')[0];
    prevTo = prevEnd.toISOString().split('T')[0];
  } else {
    return [];
  }

  return allEntries.filter((e) => e.date >= prevFrom && e.date <= prevTo);
}

export default function RealDashboard() {
  const [activeView, setActiveView] = useState<ViewTab>('dashboard');
  const [activeQuickFilter, setActiveQuickFilter] = useState<number | 'all'>(30);

  const { filters, setQuickFilter, setDateFrom, setDateTo } = useFilters();
  const { products } = useProducts();
  const { costsMap, upsertCost } = useProductCosts();

  // All entries (no filter) for previous period comparison & forecast
  const { entries: allEntries } = useEntries({ dateFrom: null, dateTo: null, productId: 'all' });
  const { entries } = useEntries(filters);

  // Pass costs into all calculations so cost per unit affects net profit
  const metrics = useMemo(() => computeDashboardMetrics(entries, costsMap), [entries, costsMap]);
  const chartData = useMemo(() => computeChartData(entries, costsMap), [entries, costsMap]);

  // Previous period
  const prevEntries = useMemo(
    () => getPreviousPeriodEntries(allEntries, activeQuickFilter, filters.dateFrom, filters.dateTo),
    [allEntries, activeQuickFilter, filters.dateFrom, filters.dateTo],
  );
  const prevMetrics = useMemo(
    () => (prevEntries.length > 0 ? computeDashboardMetrics(prevEntries, costsMap) : null),
    [prevEntries, costsMap],
  );

  const handleCostChange = useCallback((productId: string, variantId: string | null, cost: number) => {
    upsertCost.mutate({ productId, variantId, costPerUnit: cost });
  }, [upsertCost]);

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
            <SummaryCards metrics={metrics} prevMetrics={prevMetrics} />
            <ForecastCard entries={allEntries} costsMap={costsMap} />
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
            savedCosts={costsMap}
            onCostChange={handleCostChange}
          />
        )}
      </div>
    </div>
  );
}
