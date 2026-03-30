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

function CostInput({ currentValue, onSave }: { currentValue: number; onSave: (value: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = () => {
    setEditing(true);
    setInputValue(currentValue > 0 ? currentValue.toFixed(2) : '');
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const save = () => {
    const val = parseFloat(inputValue) || 0;
    onSave(val);
    setEditing(false);
  };

  const cancel = () => {
    setEditing(false);
    setInputValue('');
  };

  if (!editing) {
    return (
      <button onClick={startEdit} className="flex items-center gap-1 px-2 py-1.5 rounded-md text-[13px] hover:bg-[rgba(105,201,208,0.08)] transition-all cursor-pointer min-w-[90px]">
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

  return (
    <div className="flex items-center gap-1">
      <span className="text-tt-muted text-[13px]">$</span>
      <input
        ref={inputRef}
        type="number"
        step="0.01"
        value={inputValue}
        placeholder="0.00"
        onChange={e => setInputValue(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); }}
        className="bg-tt-input-bg border border-tt-cyan text-tt-text px-2 py-1.5 rounded-md text-[13px] w-[70px] focus:outline-none"
      />
      {/* Checkmark */}
      <button onClick={save} className="p-1 rounded hover:bg-[rgba(0,200,83,0.15)] transition-colors" title="Save">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#00c853" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </button>
      {/* X */}
      <button onClick={cancel} className="p-1 rounded hover:bg-[rgba(255,23,68,0.15)] transition-colors" title="Cancel">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ff1744" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

export default function ProductCostTable({ productStats, costsMap, onCostChange }: ProductCostTableProps) {
  const [expandedProduct, setExpandedProduct] = useState<string | null>(null);

  const getCost = (key: string) => costsMap?.[key] || 0;

  // Net Profit = GMV - Shipping - Platform Fee (6%) - COGS
  const calcProfit = (gmv: number, shipping: number, costKey: string, orders: number) => {
    const cogs = getCost(costKey) * orders;
    const platformFee = gmv * 0.06;
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
                              isExpanded ? 'border-tt-cyan bg-[rgba(105,201,208,0.1)] text-tt-cyan' : 'border-tt-border text-tt-muted hover:border-tt-cyan hover:text-tt-cyan'
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
                    <td className="px-4 py-3 text-[13px] font-semibold text-tt-text tabular-nums">{fmtInt(product.total_orders)}</td>
                    <td className="px-4 py-3 text-[13px] font-semibold text-tt-cyan tabular-nums">{fmt(product.total_gmv)}</td>
                    <td className={`px-4 py-3 text-[13px] font-semibold tabular-nums ${profit >= 0 ? 'text-tt-green' : 'text-tt-red'}`}>{fmt(profit)}</td>
                    <td className="px-4 py-3">
                      {hasVariants ? (
                        <span className="text-[11px] text-tt-muted italic">per variant ↓</span>
                      ) : (
                        <CostInput currentValue={getCost(costKey)} onSave={v => handleCostSave(costKey, null, v)} />
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[rgba(0,200,83,0.12)] text-[#00c853]">Active</span>
                    </td>
                  </tr>

                  {isExpanded && product.skus.map((sku, si) => {
                    const skuCostKey = `${product.tiktok_product_id}-${sku.sku_id}`;
                    // Distribute shipping proportionally by GMV share
                    const gmvShare = product.total_gmv > 0 ? sku.gmv / product.total_gmv : 0;
                    const skuShipping = product.total_shipping * gmvShare;
                    const skuProfit = calcProfit(sku.gmv, skuShipping, skuCostKey, sku.orders);

                    return (
                      <tr key={`${sku.sku_id}-${si}`} className="border-b border-tt-border bg-[rgba(105,201,208,0.02)]">
                        <td className="px-4 py-2.5 pl-14">
                          <span className="text-[12px] text-tt-muted">└ {sku.sku_name}</span>
                        </td>
                        <td className="px-4 py-2.5 text-[12px] text-tt-muted font-mono">{sku.sku_id ? sku.sku_id.slice(-8) : '—'}</td>
                        <td className="px-4 py-2.5 text-[12px] text-tt-text tabular-nums">{fmtInt(sku.orders)}</td>
                        <td className="px-4 py-2.5 text-[12px] text-tt-cyan tabular-nums">{fmt(sku.gmv)}</td>
                        <td className={`px-4 py-2.5 text-[12px] tabular-nums ${skuProfit >= 0 ? 'text-tt-green' : 'text-tt-red'}`}>{fmt(skuProfit)}</td>
                        <td className="px-4 py-2.5">
                          <CostInput currentValue={getCost(skuCostKey)} onSave={v => handleCostSave(product.tiktok_product_id, sku.sku_id, v)} />
                        </td>
                        <td className="px-4 py-2.5" />
                      </tr>
                    );
                  })}
                </Fragment>
              );
            })}
            {productStats.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-tt-muted">No product data yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
