'use client';

import { useState, useRef, useCallback, useMemo, Fragment } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Tooltip,
  Legend,
} from 'chart.js';
import { Bar } from 'react-chartjs-2';
import type { Product, Entry, ChartData } from '@/types';
import { fmt, fmtInt, calcEntry } from '@/lib/calculations';
import { getBarChartOptions } from '@/lib/chart-options';

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

const PRODUCTS_PER_PAGE = 10;

interface ProductCostTableProps {
  products: Product[];
  productProfits: Record<string, { profit: number; gmv: number; unitsSold: number }>;
  chartData: ChartData;
  entries: Entry[];
  /** Persisted costs map: "productId" or "productId-variantId" -> cost_per_unit */
  savedCosts?: Record<string, number>;
  /** Called when a cost is changed — pass null for demo mode (local state only) */
  onCostChange?: (productId: string, variantId: string | null, cost: number) => void;
  isDemo?: boolean;
}

export default function ProductCostTable({
  products,
  productProfits,
  chartData,
  entries,
  savedCosts,
  onCostChange,
  isDemo,
}: ProductCostTableProps) {
  const [localCosts, setLocalCosts] = useState<Record<string, string>>({});
  const [expandedProduct, setExpandedProduct] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const chartScrollRef = useRef<HTMLDivElement>(null);
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const getCostValue = useCallback((key: string): string => {
    if (localCosts[key] !== undefined) return localCosts[key];
    if (savedCosts && savedCosts[key] !== undefined && savedCosts[key] > 0) return String(savedCosts[key]);
    return '';
  }, [localCosts, savedCosts]);

  const handleCostInput = useCallback((key: string, value: string, productId: string, variantId: string | null) => {
    setLocalCosts((prev) => ({ ...prev, [key]: value }));

    // Debounce save to DB for real users
    if (onCostChange && !isDemo) {
      if (debounceTimers.current[key]) clearTimeout(debounceTimers.current[key]);
      debounceTimers.current[key] = setTimeout(() => {
        const numVal = parseFloat(value) || 0;
        onCostChange(productId, variantId, numVal);
      }, 800);
    }
  }, [onCostChange, isDemo]);

  // Compute variant-level stats from entries
  const variantStats = useCallback((productId: string) => {
    const product = products.find((p) => p.id === productId);
    if (!product?.variants?.length) return [];

    const stats: Record<string, { gmv: number; profit: number; unitsSold: number }> = {};
    product.variants.forEach((v) => {
      stats[v.id] = { gmv: 0, profit: 0, unitsSold: 0 };
    });

    const productEntries = entries.filter((e) => e.product_id === productId);
    const variants = product.variants;

    productEntries.forEach((e) => {
      const variantId = e.variant_id || variants[0]?.id;
      if (variantId && stats[variantId]) {
        const c = calcEntry(e);
        stats[variantId].gmv += Number(e.gmv) || 0;
        stats[variantId].profit += c.totalNetProfit;
        stats[variantId].unitsSold += Number(e.units_sold) || 0;
      } else if (variants.length > 0) {
        const c = calcEntry(e);
        const perVariant = 1 / variants.length;
        variants.forEach((v) => {
          stats[v.id].gmv += (Number(e.gmv) || 0) * perVariant;
          stats[v.id].profit += c.totalNetProfit * perVariant;
          stats[v.id].unitsSold += Math.round((Number(e.units_sold) || 0) * perVariant);
        });
      }
    });

    return variants.map((v) => ({
      ...v,
      ...(stats[v.id] || { gmv: 0, profit: 0, unitsSold: 0 }),
    }));
  }, [products, entries]);

  // Pagination
  const totalPages = Math.ceil(products.length / PRODUCTS_PER_PAGE);
  const paginatedProducts = useMemo(() => {
    const start = currentPage * PRODUCTS_PER_PAGE;
    return products.slice(start, start + PRODUCTS_PER_PAGE);
  }, [products, currentPage]);

  const showSlider = chartData.productCompare.labels.length > 5;

  return (
    <div className="space-y-4">
      {/* GMV vs Net Profit by Product Chart */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-5 backdrop-blur-xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-tt-muted">GMV vs Net Profit by Product</h3>
          {showSlider && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => chartScrollRef.current?.scrollBy({ left: -300, behavior: 'smooth' })}
                className="w-7 h-7 rounded-full border border-tt-border flex items-center justify-center text-tt-muted hover:text-tt-text hover:border-tt-cyan transition-all text-sm"
              >
                ‹
              </button>
              <button
                onClick={() => chartScrollRef.current?.scrollBy({ left: 300, behavior: 'smooth' })}
                className="w-7 h-7 rounded-full border border-tt-border flex items-center justify-center text-tt-muted hover:text-tt-text hover:border-tt-cyan transition-all text-sm"
              >
                ›
              </button>
            </div>
          )}
        </div>
        <div ref={chartScrollRef} className={`relative ${showSlider ? 'overflow-x-auto scrollbar-hide' : ''}`}>
          <div style={{ minWidth: showSlider ? `${chartData.productCompare.labels.length * 120}px` : '100%', height: '260px' }}>
            <Bar
              data={{
                labels: chartData.productCompare.labels,
                datasets: [
                  {
                    label: 'GMV',
                    data: chartData.productCompare.gmv,
                    backgroundColor: 'rgba(105, 201, 208, 0.7)',
                    borderRadius: 6,
                  },
                  {
                    label: 'Net Profit',
                    data: chartData.productCompare.profit,
                    backgroundColor: 'rgba(238, 29, 82, 0.7)',
                    borderRadius: 6,
                  },
                ],
              }}
              options={getBarChartOptions()}
            />
          </div>
        </div>
      </div>

      {/* Product Cost Table */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] backdrop-blur-xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-tt-border">
          <h2 className="text-base font-semibold">Products & Cost per SKU</h2>
          <span className="text-xs text-tt-muted">{products.length} products auto-pulled from shop</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {['Product Name', 'SKU / ID', 'Units Sold', 'Total GMV', 'Net Profit', 'Cost per Unit', 'Status'].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-[11px] uppercase tracking-wide text-tt-muted font-semibold border-b border-tt-border whitespace-nowrap bg-[rgba(25,25,25,0.95)]">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paginatedProducts.map((product, idx) => {
                const stats = productProfits[product.name] || { profit: 0, gmv: 0, unitsSold: 0 };
                const hasVariants = product.variants && product.variants.length > 0;
                const isExpanded = expandedProduct === product.id;
                const vStats = isExpanded ? variantStats(product.id) : [];

                return (
                  <Fragment key={product.id}>
                    <tr
                      className={`border-b border-tt-border transition-colors hover:bg-[rgba(255,255,255,0.03)] ${idx % 2 === 0 ? '' : 'bg-[rgba(255,255,255,0.015)]'}`}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-8 h-8 rounded-lg bg-[rgba(105,201,208,0.1)] border border-[rgba(105,201,208,0.2)] flex items-center justify-center text-tt-cyan text-xs font-bold">
                            {product.name.charAt(0).toUpperCase()}
                          </div>
                          <span className="text-[13px] font-medium text-tt-text">{product.name}</span>
                          {hasVariants && (
                            <button
                              onClick={() => setExpandedProduct(isExpanded ? null : product.id)}
                              className={`ml-1 flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-medium cursor-pointer transition-all ${
                                isExpanded
                                  ? 'border-tt-cyan bg-[rgba(105,201,208,0.1)] text-tt-cyan'
                                  : 'border-tt-border text-tt-muted hover:border-tt-cyan hover:text-tt-cyan'
                              }`}
                            >
                              <span>{product.variants!.length} variants</span>
                              <span className={`transition-transform inline-block text-[10px] ${isExpanded ? 'rotate-180' : ''}`}>▼</span>
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-[13px] text-tt-muted font-mono">
                        {product.id.slice(0, 8)}...
                      </td>
                      <td className="px-4 py-3 text-[13px] font-semibold text-tt-text tabular-nums">
                        {fmtInt(stats.unitsSold)}
                      </td>
                      <td className="px-4 py-3 text-[13px] font-semibold text-tt-cyan tabular-nums">
                        {fmt(stats.gmv)}
                      </td>
                      <td className={`px-4 py-3 text-[13px] font-semibold tabular-nums ${stats.profit >= 0 ? 'text-tt-green' : 'text-tt-red'}`}>
                        {fmt(stats.profit)}
                      </td>
                      <td className="px-4 py-3">
                        {hasVariants ? (
                          <span className="text-[11px] text-tt-muted italic">—</span>
                        ) : (
                          <div className="flex items-center gap-1">
                            <span className="text-tt-muted text-[13px]">$</span>
                            <input
                              type="number"
                              step="0.01"
                              value={getCostValue(product.id)}
                              placeholder="0.00"
                              onChange={(e) => handleCostInput(product.id, e.target.value, product.id, null)}
                              className="bg-tt-input-bg border border-transparent text-tt-text px-2 py-1.5 rounded-md text-[13px] w-[90px] focus:outline-none focus:border-tt-cyan focus:bg-[rgba(105,201,208,0.08)] transition-all"
                            />
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-[rgba(0,200,83,0.15)] text-tt-green">
                          <span className="w-1.5 h-1.5 rounded-full bg-tt-green" />
                          Active
                        </span>
                      </td>
                    </tr>
                    {/* Variant rows */}
                    {isExpanded && vStats.map((v, vi) => {
                      const vKey = `${product.id}-${v.id}`;
                      return (
                        <tr
                          key={v.id}
                          className="border-b border-tt-border bg-[rgba(105,201,208,0.03)] transition-colors hover:bg-[rgba(105,201,208,0.06)]"
                        >
                          <td className="px-4 py-2.5 pl-14">
                            <div className="flex items-center gap-2">
                              <div className="w-1.5 h-1.5 rounded-full bg-tt-cyan opacity-50" />
                              <span className="text-[12px] text-tt-text">{v.name}</span>
                              {v.sku && <span className="text-[10px] text-tt-muted font-mono">({v.sku})</span>}
                            </div>
                          </td>
                          <td className="px-4 py-2.5 text-[12px] text-tt-muted font-mono">
                            {v.id.slice(0, 16)}...
                          </td>
                          <td className="px-4 py-2.5 text-[12px] text-tt-muted tabular-nums">
                            {fmtInt(v.unitsSold)}
                          </td>
                          <td className="px-4 py-2.5 text-[12px] text-tt-cyan tabular-nums">
                            {fmt(v.gmv)}
                          </td>
                          <td className={`px-4 py-2.5 text-[12px] tabular-nums ${v.profit >= 0 ? 'text-tt-green' : 'text-tt-red'}`}>
                            {fmt(v.profit)}
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-1">
                              <span className="text-tt-muted text-[12px]">$</span>
                              <input
                                type="number"
                                step="0.01"
                                value={getCostValue(vKey)}
                                placeholder="0.00"
                                onChange={(e) => handleCostInput(vKey, e.target.value, product.id, v.id)}
                                className="bg-tt-input-bg border border-transparent text-tt-text px-2 py-1 rounded-md text-[12px] w-[80px] focus:outline-none focus:border-tt-cyan focus:bg-[rgba(105,201,208,0.08)] transition-all"
                              />
                            </div>
                          </td>
                          <td className="px-4 py-2.5">
                            <span className="text-[10px] text-tt-muted">Variant {vi + 1}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })}
              {products.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-tt-muted text-sm">
                    No products found. Connect your TikTok Shop to auto-pull products.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-tt-border">
            <span className="text-xs text-tt-muted">
              Showing {currentPage * PRODUCTS_PER_PAGE + 1}–{Math.min((currentPage + 1) * PRODUCTS_PER_PAGE, products.length)} of {products.length} products
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
                disabled={currentPage === 0}
                className="px-3 py-1 rounded-md border border-tt-border text-xs text-tt-muted hover:text-tt-text hover:border-tt-cyan transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              >
                ← Prev
              </button>
              {Array.from({ length: totalPages }, (_, i) => (
                <button
                  key={i}
                  onClick={() => setCurrentPage(i)}
                  className={`w-7 h-7 rounded-md border text-xs transition-all ${
                    currentPage === i
                      ? 'bg-tt-cyan text-black border-tt-cyan font-semibold'
                      : 'border-tt-border text-tt-muted hover:text-tt-text hover:border-tt-cyan'
                  }`}
                >
                  {i + 1}
                </button>
              ))}
              <button
                onClick={() => setCurrentPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={currentPage === totalPages - 1}
                className="px-3 py-1 rounded-md border border-tt-border text-xs text-tt-muted hover:text-tt-text hover:border-tt-cyan transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Next →
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
