'use client';

import { useState, useMemo } from 'react';
import dynamic from 'next/dynamic';
import DemoBanner from '@/components/demo/DemoBanner';
import Header from '@/components/layout/Header';
import FiltersBar from '@/components/filters/FiltersBar';
import SummaryCards from '@/components/dashboard/SummaryCards';
import ForecastCard from '@/components/dashboard/ForecastCard';
import EntriesTable from '@/components/entries/EntriesTable';
import ProductCostTable from '@/components/products/ProductCostTable';
import DemoTikTokConnect from '@/components/demo/DemoTikTokConnect';
import { useDemoProducts } from '@/hooks/useDemoProducts';
import { useDemoEntries } from '@/hooks/useDemoEntries';
import { useFilters } from '@/hooks/useFilters';
import { computeDashboardMetrics, computeChartData } from '@/lib/calculations';

const Charts = dynamic(() => import('@/components/dashboard/Charts'), { ssr: false });

type ViewTab = 'dashboard' | 'table';

export default function DemoDashboard() {
  const [activeView, setActiveView] = useState<ViewTab>('dashboard');
  const [activeQuickFilter, setActiveQuickFilter] = useState<number | 'all'>('all');

  const { filters, setQuickFilter, setDateFrom, setDateTo } = useFilters();
  const { products } = useDemoProducts();
  const { entries, addEntry, updateEntry, deleteEntry } = useDemoEntries(filters);

  const metrics = useMemo(() => computeDashboardMetrics(entries), [entries]);
  const chartData = useMemo(() => computeChartData(entries), [entries]);

  function handleQuickFilter(days: number | 'all') {
    setActiveQuickFilter(days);
    setQuickFilter(days);
  }

  function handleAddEntry(productId: string) {
    addEntry.mutate({
      product_id: productId,
      date: new Date().toISOString().split('T')[0],
      gmv: 0,
      videos_posted: 0,
      views: 0,
      shipping: 0,
      affiliate: 0,
      ads: 0,
    });
    if (activeView !== 'table') setActiveView('table');
  }

  function handleUpdateEntry(id: string, field: string, value: unknown) {
    updateEntry.mutate({ id, [field]: value });
  }

  function handleDeleteEntry(id: string) {
    deleteEntry.mutate(id);
  }

  const tabs: Array<{ label: string; value: ViewTab }> = [
    { label: 'Dashboard', value: 'dashboard' },
    { label: 'Data Entry', value: 'table' },
  ];

  return (
    <div className="min-h-screen bg-tt-bg">
      <DemoBanner />
      <Header />

      <div className="p-6 max-w-[1600px] mx-auto">
        <DemoTikTokConnect />
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

        {/* Data Entry View */}
        {activeView === 'table' && (
          <div className="space-y-6">
            <ProductCostTable
              products={products}
              productProfits={metrics.productProfits}
              chartData={chartData}
            />
            <EntriesTable
              entries={entries}
              products={products}
              onAddEntry={handleAddEntry}
              onUpdateEntry={handleUpdateEntry}
              onDeleteEntry={handleDeleteEntry}
            />
          </div>
        )}
      </div>
    </div>
  );
}
