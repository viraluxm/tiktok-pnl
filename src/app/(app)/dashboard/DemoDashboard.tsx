'use client';

import { useState, useMemo } from 'react';
import dynamic from 'next/dynamic';
import DemoBanner from '@/components/demo/DemoBanner';
import Header from '@/components/layout/Header';
import FiltersBar from '@/components/filters/FiltersBar';
import SummaryCards from '@/components/dashboard/SummaryCards';
import EntriesTable from '@/components/entries/EntriesTable';
import ImportModal from '@/components/entries/ImportModal';
import ProductManager from '@/components/products/ProductManager';
import DemoTikTokConnect from '@/components/demo/DemoTikTokConnect';
import { useDemoProducts } from '@/hooks/useDemoProducts';
import { useDemoEntries } from '@/hooks/useDemoEntries';
import { useFilters } from '@/hooks/useFilters';
import { computeDashboardMetrics, computeChartData } from '@/lib/calculations';
import { exportCSV, parseCSVData } from '@/lib/csv';

const Charts = dynamic(() => import('@/components/dashboard/Charts'), { ssr: false });

type ViewTab = 'dashboard' | 'table' | 'products';

export default function DemoDashboard() {
  const [activeView, setActiveView] = useState<ViewTab>('dashboard');
  const [activeQuickFilter, setActiveQuickFilter] = useState<number | 'all'>('all');
  const [importModalOpen, setImportModalOpen] = useState(false);

  const { filters, setQuickFilter, setDateFrom, setDateTo, setProductId } = useFilters();
  const { products, addProduct, removeProduct } = useDemoProducts();
  const { entries, addEntry, updateEntry, deleteEntry, bulkInsert } = useDemoEntries(filters);

  const metrics = useMemo(() => computeDashboardMetrics(entries), [entries]);
  const chartData = useMemo(() => computeChartData(entries), [entries]);

  function handleQuickFilter(days: number | 'all') {
    setActiveQuickFilter(days);
    setQuickFilter(days);
  }

  function handleExportCSV() {
    exportCSV(entries);
  }

  function handleClearAll() {
    if (!confirm('Are you sure you want to clear all demo entries? This cannot be undone.')) return;
    entries.forEach((e) => deleteEntry.mutate(e.id));
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

  async function handleImport(text: string) {
    const parsed = parseCSVData(text);
    if (parsed.length === 0) return;

    // In demo mode, create products in memory
    const existingNames = new Set(products.map((p) => p.name.toLowerCase()));
    const newProductNames = [...new Set(parsed.map((r) => r.productName))].filter(
      (name) => !existingNames.has(name.toLowerCase())
    );

    for (const name of newProductNames) {
      addProduct.mutate(name);
    }

    // Build product map from current + new products
    const allProducts = [...products];
    for (const name of newProductNames) {
      allProducts.push({
        id: `demo-product-import-${Date.now()}-${name}`,
        user_id: 'demo',
        name,
        created_at: new Date().toISOString(),
      });
    }

    const productMap = new Map(allProducts.map((p) => [p.name.toLowerCase(), p.id]));

    const entriesToInsert = parsed
      .map((r) => ({
        product_id: productMap.get(r.productName.toLowerCase()) || '',
        date: r.date,
        gmv: r.gmv,
        videos_posted: r.videosPosted,
        views: r.views,
        shipping: r.shipping,
        affiliate: r.affiliate,
        ads: r.ads,
      }))
      .filter((e) => e.product_id);

    if (entriesToInsert.length > 0) {
      bulkInsert.mutate(entriesToInsert);
    }
  }

  const tabs: Array<{ label: string; value: ViewTab }> = [
    { label: 'Dashboard', value: 'dashboard' },
    { label: 'Data Entry', value: 'table' },
    { label: 'Products', value: 'products' },
  ];

  return (
    <div className="min-h-screen bg-tt-bg">
      <DemoBanner />
      <Header />

      <div className="p-6 max-w-[1600px] mx-auto">
        <DemoTikTokConnect />
        <FiltersBar
          filters={filters}
          products={products}
          onQuickFilter={handleQuickFilter}
          onDateFromChange={setDateFrom}
          onDateToChange={setDateTo}
          onProductChange={setProductId}
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
            <Charts chartData={chartData} />
          </>
        )}

        {/* Data Entry View */}
        {activeView === 'table' && (
          <EntriesTable
            entries={entries}
            products={products}
            onAddEntry={handleAddEntry}
            onUpdateEntry={handleUpdateEntry}
            onDeleteEntry={handleDeleteEntry}
          />
        )}

        {/* Products View */}
        {activeView === 'products' && (
          <ProductManager
            products={products}
            onAddProduct={(name) => addProduct.mutate(name)}
            onRemoveProduct={(id) => {
              if (products.length <= 1) return;
              if (!confirm('Delete this product and all its entries?')) return;
              removeProduct.mutate(id);
            }}
          />
        )}
      </div>

      <ImportModal
        isOpen={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onImport={handleImport}
      />
    </div>
  );
}
