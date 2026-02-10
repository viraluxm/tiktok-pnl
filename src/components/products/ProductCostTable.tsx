'use client';

import { useState, useRef, useCallback } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Tooltip,
  Legend,
} from 'chart.js';
import { Bar } from 'react-chartjs-2';
import type { Product, ChartData } from '@/types';
import { fmt } from '@/lib/calculations';
import { getBarChartOptions } from '@/lib/chart-options';

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

interface ProductCostTableProps {
  products: Product[];
  productProfits: Record<string, { profit: number; gmv: number }>;
  chartData: ChartData;
}

export default function ProductCostTable({ products, productProfits, chartData }: ProductCostTableProps) {
  // Track cost per product (would be persisted in a real implementation)
  const [costs, setCosts] = useState<Record<string, number>>({});
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const handleCostChange = useCallback((productId: string, value: string) => {
    if (debounceTimers.current[productId]) clearTimeout(debounceTimers.current[productId]);
    debounceTimers.current[productId] = setTimeout(() => {
      setCosts((prev) => ({ ...prev, [productId]: parseFloat(value) || 0 }));
    }, 400);
  }, []);

  return (
    <div className="space-y-4">
      {/* GMV vs Net Profit by Product Chart */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] p-5 backdrop-blur-xl">
        <h3 className="text-sm font-semibold text-tt-muted mb-4">GMV vs Net Profit by Product</h3>
        <div className="relative h-[260px]">
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
                {['Product Name', 'SKU / ID', 'Total GMV', 'Net Profit', 'Cost per Unit', 'Status'].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-[11px] uppercase tracking-wide text-tt-muted font-semibold border-b border-tt-border whitespace-nowrap bg-[rgba(25,25,25,0.95)]">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {products.map((product, idx) => {
                const stats = productProfits[product.name] || { profit: 0, gmv: 0 };
                return (
                  <tr
                    key={product.id}
                    className={`border-b border-tt-border transition-colors hover:bg-[rgba(255,255,255,0.03)] ${idx % 2 === 0 ? '' : 'bg-[rgba(255,255,255,0.015)]'}`}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-lg bg-[rgba(105,201,208,0.1)] border border-[rgba(105,201,208,0.2)] flex items-center justify-center text-tt-cyan text-xs font-bold">
                          {product.name.charAt(0).toUpperCase()}
                        </div>
                        <span className="text-[13px] font-medium text-tt-text">{product.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-[13px] text-tt-muted font-mono">
                      {product.id.slice(0, 8)}...
                    </td>
                    <td className="px-4 py-3 text-[13px] font-semibold text-tt-cyan tabular-nums">
                      {fmt(stats.gmv)}
                    </td>
                    <td className={`px-4 py-3 text-[13px] font-semibold tabular-nums ${stats.profit >= 0 ? 'text-tt-green' : 'text-tt-red'}`}>
                      {fmt(stats.profit)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <span className="text-tt-muted text-[13px]">$</span>
                        <input
                          type="number"
                          step="0.01"
                          defaultValue={costs[product.id] || ''}
                          placeholder="0.00"
                          onChange={(e) => handleCostChange(product.id, e.target.value)}
                          className="bg-tt-input-bg border border-transparent text-tt-text px-2 py-1.5 rounded-md text-[13px] w-[90px] focus:outline-none focus:border-tt-cyan focus:bg-[rgba(105,201,208,0.08)] transition-all"
                        />
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-[rgba(0,200,83,0.15)] text-tt-green">
                        <span className="w-1.5 h-1.5 rounded-full bg-tt-green" />
                        Active
                      </span>
                    </td>
                  </tr>
                );
              })}
              {products.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-tt-muted text-sm">
                    No products found. Connect your TikTok Shop to auto-pull products.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
