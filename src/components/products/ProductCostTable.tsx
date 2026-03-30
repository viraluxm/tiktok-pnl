'use client';

import { useState, useCallback, useRef, Fragment } from 'react';
import type { ProductStats } from '@/hooks/useProductStats';

const fmt = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtInt = (n: number) => n.toLocaleString('en-US');

interface ProductCostTableProps {
  productStats: ProductStats[];
  costsMap?: Record<string, number>;
  onCostChange?: (productId: string, skuId: string | null, cost: number) => void;
}

function CostInput({ costKey, currentValue, onSave }: { costKey: string; currentValue: number; onSave: (value: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [inputValue, setInputValue] = useState(String(currentValue || ''));
  const [showConfirm, setShowConfirm] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  if (!editing) {
    return (
      <button
        onClick={() => { setEditing(true); setInputValue(String(currentValue || '')); setTimeout(() => inputRef.current?.focus(), 50); }}
        className="flex items-center gap-1 px-2 py-1.5 rounded-md text-[13px] hover:bg-[rgba(105,201,208,0.08)] transition-all cursor-pointer min-w-[90px]"
      >
        <span className="text-tt-muted">$</span>
        <span className={currentValue > 0 ? 'text-tt-text font-medium' : 'text-tt-muted'}>
          {currentValue > 0 ? currentValue.toFixed(2) : '0.00'}
        </span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-tt-muted ml-auto">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
      </button>
    );
  }

  const handleSave = () => {
    const newValue = parseFloat(inputValue) || 0;
    if (newValue !== currentValue) {
      setShowConfirm(true);
    } else {
      setEditing(false);
    }
  };

  const confirmSave = () => {
    const newValue = parseFloat(inputValue) || 0;
    onSave(newValue);
    setShowConfirm(false);
    setEditing(false);
  };

  return (
    <div className="relative">
      <div className="flex items-center gap-1">
        <span className="text-tt-muted text-[13px]">$</span>
        <input
          ref={inputRef}
          type="number"
          step="0.01"
          value={inputValue}
          onChange={e => setInputValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') setEditing(false); }}
          onBlur={handleSave}
          className="bg-tt-input-bg border border-tt-cyan text-tt-text px-2 py-1.5 rounded-md text-[13px] w-[80px] focus:outline-none"
        />
        <button onClick={handleSave} className="text-tt-cyan text-[11px] font-semibold px-1">Save</button>
        <button onClick={() => setEditing(false)} className="text-tt-muted text-[11px] px-1">Cancel</button>
      </div>

      {/* Confirmation modal */}
      {showConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={e => e.stopPropagation()}>
          <div className="bg-tt-card border border-tt-border rounded-2xl p-6 max-w-sm w-full mx-4 shadow-2xl">
            <h3 className="text-sm font-semibold text-tt-text mb-2">Update Cost per Unit?</h3>
            <p className="text-xs text-tt-muted mb-1">
              Changing from <strong>${(currentValue || 0).toFixed(2)}</strong> to <strong>${(parseFloat(inputValue) || 0).toFixed(2)}</strong>
            </p>
            <p className="text-xs text-tt-muted mb-4">
              This will recalculate net profit for all orders with this product.
            </p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => { setShowConfirm(false); setEditing(false); }} className="px-4 py-2 rounded-lg border border-tt-border text-tt-muted text-[12px] font-medium hover:border-tt-text hover:text-tt-text transition-all">
                Cancel
              </button>
              <button onClick={confirmSave} className="px-4 py-2 rounded-lg bg-tt-cyan text-black text-[12px] font-semibold hover:opacity-90 transition-opacity">
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ProductCostTable({ productStats, costsMap, onCostChange }: ProductCostTableProps) {
  const [expandedProduct, setExpandedProduct] = useState<string | null>(null);

  const getCost = (key: string) => costsMap?.[key] || 0;

  const calcProfit = (gmv: number, shipping: number, costKey: string, orders: number) => {
    const cogs = getCost(costKey) * orders;
    const platformFee = gmv * 0.06;
    // Net Profit = GMV - Shipping - Platform Fee - COGS
    // (Tax already excluded from GMV in the sync)
    return gmv - shipping - platformFee - cogs;
  };

  const handleCostSave = (productId: string, skuId: string | null, value: number) => {
    if (onCostChange) onCostChange(productId, skuId, value);
  };

  return (
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
                        <span className="text-[11px] text-tt-muted italic">per variant ↓</span>
                      ) : (
                        <CostInput
                          costKey={costKey}
                          currentValue={getCost(costKey)}
                          onSave={v => handleCostSave(costKey, null, v)}
                        />
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[rgba(0,200,83,0.12)] text-[#00c853]">
                        Active
                      </span>
                    </td>
                  </tr>

                  {/* Expanded variation rows */}
                  {isExpanded && product.skus.map((sku, si) => {
                    const skuCostKey = `${product.tiktok_product_id}-${sku.sku_id}`;
                    const skuProfit = calcProfit(sku.gmv, 0, skuCostKey, sku.orders);

                    return (
                      <tr key={`${sku.sku_id}-${si}`} className="border-b border-tt-border bg-[rgba(105,201,208,0.02)]">
                        <td className="px-4 py-2.5 pl-14">
                          <span className="text-[12px] text-tt-muted">└ {sku.sku_name}</span>
                        </td>
                        <td className="px-4 py-2.5 text-[12px] text-tt-muted font-mono">
                          {sku.sku_id ? sku.sku_id.slice(-8) : '—'}
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
                          <CostInput
                            costKey={skuCostKey}
                            currentValue={getCost(skuCostKey)}
                            onSave={v => handleCostSave(product.tiktok_product_id, sku.sku_id, v)}
                          />
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
  );
}
