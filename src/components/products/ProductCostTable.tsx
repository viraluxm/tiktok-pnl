'use client';

import { useState, useCallback, useRef, Fragment } from 'react';
import type { ProductStats, ProductSku } from '@/hooks/useProductStats';

const fmt = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtInt = (n: number) => n.toLocaleString('en-US');

interface ProductCostTableProps {
  productStats: ProductStats[];
  costsMap?: Record<string, number>;
  onCostChange?: (productId: string, skuId: string | null, cost: number) => void;
}

export default function ProductCostTable({ productStats, costsMap, onCostChange }: ProductCostTableProps) {
  const [expandedProduct, setExpandedProduct] = useState<string | null>(null);
  const [localCosts, setLocalCosts] = useState<Record<string, string>>({});
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const getCostValue = useCallback((key: string): string => {
    if (localCosts[key] !== undefined) return localCosts[key];
    if (costsMap && costsMap[key] !== undefined && costsMap[key] > 0) return String(costsMap[key]);
    return '';
  }, [localCosts, costsMap]);

  const handleCostInput = useCallback((key: string, value: string, productId: string, skuId: string | null) => {
    setLocalCosts(prev => ({ ...prev, [key]: value }));
    if (onCostChange) {
      if (debounceTimers.current[key]) clearTimeout(debounceTimers.current[key]);
      debounceTimers.current[key] = setTimeout(() => {
        onCostChange(productId, skuId, parseFloat(value) || 0);
      }, 800);
    }
  }, [onCostChange]);

  const calcProfit = (gmv: number, shipping: number, costKey: string, orders: number) => {
    const costPerUnit = costsMap?.[costKey] || parseFloat(localCosts[costKey] || '0') || 0;
    const platformFee = gmv * 0.06;
    return gmv - shipping - platformFee - (costPerUnit * orders);
  };

  return (
    <div>
      {/* Product Table */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] backdrop-blur-xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-tt-border">
          <h2 className="text-base font-semibold">Products & Cost per SKU</h2>
          <span className="text-xs text-tt-muted">{productStats.length} products</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {['Product Name', 'SKU / Variation', 'Orders', 'Total GMV', 'Net Profit', 'Cost per Unit', 'Status'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-[11px] uppercase tracking-wide text-tt-muted font-semibold border-b border-tt-border whitespace-nowrap bg-[rgba(25,25,25,0.95)]">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {productStats.map((product, idx) => {
                const hasVariants = product.skus.length > 1;
                const isExpanded = expandedProduct === product.tiktok_product_id;
                const costKey = product.tiktok_product_id;
                const profit = calcProfit(product.total_gmv, product.total_shipping, costKey, product.total_orders);

                return (
                  <Fragment key={product.tiktok_product_id}>
                    {/* Hero product row */}
                    <tr className={`border-b border-tt-border transition-colors hover:bg-[rgba(255,255,255,0.03)] ${idx % 2 === 0 ? '' : 'bg-[rgba(255,255,255,0.015)]'}`}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {product.image_url ? (
                            <img src={product.image_url} alt="" className="w-8 h-8 rounded-lg object-cover border border-tt-border" />
                          ) : (
                            <div className="w-8 h-8 rounded-lg bg-[rgba(105,201,208,0.1)] border border-[rgba(105,201,208,0.2)] flex items-center justify-center text-tt-cyan text-xs font-bold">
                              {product.name.charAt(0).toUpperCase()}
                            </div>
                          )}
                          <span className="text-[13px] font-medium text-tt-text">{product.name}</span>
                          {hasVariants && (
                            <button
                              onClick={() => setExpandedProduct(isExpanded ? null : product.tiktok_product_id)}
                              className={`ml-1 flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-medium cursor-pointer transition-all ${
                                isExpanded
                                  ? 'border-tt-cyan bg-[rgba(105,201,208,0.1)] text-tt-cyan'
                                  : 'border-tt-border text-tt-muted hover:border-tt-cyan hover:text-tt-cyan'
                              }`}
                            >
                              <span>{product.skus.length} variants</span>
                              <span className={`transition-transform inline-block text-[10px] ${isExpanded ? 'rotate-180' : ''}`}>▼</span>
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-[13px] text-tt-muted">
                        {hasVariants ? `${product.skus.length} variations` : product.skus[0]?.sku_name || '—'}
                      </td>
                      <td className="px-4 py-3 text-[13px] font-semibold text-tt-text tabular-nums">
                        {fmtInt(product.total_orders)}
                      </td>
                      <td className="px-4 py-3 text-[13px] font-semibold text-tt-cyan tabular-nums">
                        {fmt(product.total_gmv)}
                      </td>
                      <td className={`px-4 py-3 text-[13px] font-semibold tabular-nums ${profit >= 0 ? 'text-tt-green' : 'text-tt-red'}`}>
                        {fmt(profit)}
                      </td>
                      <td className="px-4 py-3">
                        {hasVariants ? (
                          <span className="text-[11px] text-tt-muted italic">per variant</span>
                        ) : (
                          <div className="flex items-center gap-1">
                            <span className="text-tt-muted text-[13px]">$</span>
                            <input
                              type="number"
                              step="0.01"
                              value={getCostValue(costKey)}
                              placeholder="0.00"
                              onChange={e => handleCostInput(costKey, e.target.value, costKey, null)}
                              className="bg-tt-input-bg border border-transparent text-tt-text px-2 py-1.5 rounded-md text-[13px] w-[90px] focus:outline-none focus:border-tt-cyan focus:bg-[rgba(105,201,208,0.08)] transition-all"
                            />
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[rgba(0,200,83,0.12)] text-[#00c853]">
                          Active
                        </span>
                      </td>
                    </tr>

                    {/* Expanded SKU/variation rows */}
                    {isExpanded && product.skus.map((sku, si) => {
                      const skuCostKey = `${product.tiktok_product_id}-${sku.sku_id}`;
                      const skuProfit = calcProfit(sku.gmv, 0, skuCostKey, sku.orders);

                      return (
                        <tr key={`${product.tiktok_product_id}-${sku.sku_id}-${si}`} className="border-b border-tt-border bg-[rgba(105,201,208,0.02)]">
                          <td className="px-4 py-2.5 pl-14">
                            <span className="text-[12px] text-tt-muted">└ {sku.sku_name}</span>
                          </td>
                          <td className="px-4 py-2.5 text-[12px] text-tt-muted font-mono">
                            {sku.sku_id.slice(-8) || '—'}
                          </td>
                          <td className="px-4 py-2.5 text-[12px] text-tt-text tabular-nums">
                            {fmtInt(sku.orders)}
                          </td>
                          <td className="px-4 py-2.5 text-[12px] text-tt-cyan tabular-nums">
                            {fmt(sku.gmv)}
                          </td>
                          <td className={`px-4 py-2.5 text-[12px] tabular-nums ${skuProfit >= 0 ? 'text-tt-green' : 'text-tt-red'}`}>
                            {fmt(skuProfit)}
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-1">
                              <span className="text-tt-muted text-[12px]">$</span>
                              <input
                                type="number"
                                step="0.01"
                                value={getCostValue(skuCostKey)}
                                placeholder="0.00"
                                onChange={e => handleCostInput(skuCostKey, e.target.value, product.tiktok_product_id, sku.sku_id)}
                                className="bg-tt-input-bg border border-transparent text-tt-text px-2 py-1 rounded-md text-[12px] w-[80px] focus:outline-none focus:border-tt-cyan focus:bg-[rgba(105,201,208,0.08)] transition-all"
                              />
                            </div>
                          </td>
                          <td className="px-4 py-2.5" />
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })}
              {productStats.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-sm text-tt-muted">
                    No product data yet. Sync your TikTok shop to see products.
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
