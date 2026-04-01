'use client';

import { useState, useRef, Fragment } from 'react';
import type { ProductStats } from '@/hooks/useProductStats';

const fmt = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtInt = (n: number) => n.toLocaleString('en-US');

interface ProductCostTableProps {
  productStats: ProductStats[];
  costsMap?: Record<string, number>;
  onCostChange?: (productId: string, skuId: string | null, cost: number) => void;
  onInventoryChange?: (productId: string, skuId: string, quantity: number) => void;
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
    onSave(parseFloat(inputValue) || 0);
    setEditing(false);
  };

  if (!editing) {
    return (
      <button onClick={startEdit} className="flex items-center gap-1 px-2 py-1.5 rounded-md text-[13px] hover:bg-[rgba(105,201,208,0.08)] transition-all cursor-pointer min-w-[80px]">
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
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
        className="bg-tt-input-bg border border-tt-cyan text-tt-text px-2 py-1.5 rounded-md text-[13px] w-[70px] focus:outline-none"
      />
      <button onClick={save} className="p-1 rounded hover:bg-[rgba(0,200,83,0.15)] transition-colors">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#00c853" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </button>
      <button onClick={() => setEditing(false)} className="p-1 rounded hover:bg-[rgba(255,23,68,0.15)] transition-colors">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ff1744" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

function InventoryInput({ currentValue, onSave }: { currentValue: number; onSave: (value: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = () => {
    setEditing(true);
    setInputValue(currentValue > 0 ? String(currentValue) : '');
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const save = () => {
    onSave(parseInt(inputValue) || 0);
    setEditing(false);
  };

  if (!editing) {
    return (
      <button onClick={startEdit} className="flex items-center gap-1 px-2 py-1.5 rounded-md text-[13px] hover:bg-[rgba(105,201,208,0.08)] transition-all cursor-pointer min-w-[60px]">
        <span className={currentValue > 0 ? 'text-tt-text font-medium' : 'text-tt-muted'}>
          {currentValue > 0 ? fmtInt(currentValue) : '0'}
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
      <input
        ref={inputRef}
        type="number"
        step="1"
        value={inputValue}
        placeholder="0"
        onChange={e => setInputValue(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
        className="bg-tt-input-bg border border-tt-cyan text-tt-text px-2 py-1.5 rounded-md text-[13px] w-[60px] focus:outline-none"
      />
      <button onClick={save} className="p-1 rounded hover:bg-[rgba(0,200,83,0.15)] transition-colors">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#00c853" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </button>
      <button onClick={() => setEditing(false)} className="p-1 rounded hover:bg-[rgba(255,23,68,0.15)] transition-colors">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ff1744" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

export default function ProductCostTable({ productStats, costsMap, onCostChange, onInventoryChange }: ProductCostTableProps) {
  const [expandedProduct, setExpandedProduct] = useState<string | null>(null);

  const getCost = (key: string) => costsMap?.[key] || 0;

  // Calculate profit for a product/SKU
  const calcProfit = (gmv: number, shipping: number, costKey: string, orders: number) => {
    const cogs = getCost(costKey) * orders;
    const platformFee = gmv * 0.06;
    return gmv - shipping - platformFee - cogs;
  };

  // Calculate hero product profit by summing variant profits (uses per-variant costs)
  const calcHeroProfit = (product: ProductStats) => {
    if (product.skus.length <= 1) {
      return calcProfit(product.total_gmv, product.total_shipping, product.tiktok_product_id, product.total_orders);
    }
    // Sum variant-level profits
    let totalProfit = 0;
    for (const sku of product.skus) {
      const skuCostKey = `${product.tiktok_product_id}-${sku.sku_id}`;
      const gmvShare = product.total_gmv > 0 ? sku.gmv / product.total_gmv : 0;
      const skuShipping = product.total_shipping * gmvShare;
      totalProfit += calcProfit(sku.gmv, skuShipping, skuCostKey, sku.orders);
    }
    return totalProfit;
  };

  return (
    <div className="bg-tt-card border border-tt-border rounded-[14px] backdrop-blur-xl overflow-hidden">
      <div className="flex items-center justify-between px-6 py-5 border-b border-tt-border">
        <h2 className="text-base font-semibold">Products & Cost per SKU</h2>
        <span className="text-xs text-tt-muted">{productStats.length} products</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {['Product Name', 'Orders', 'Total GMV', 'Net Profit', 'Cost per Unit', 'Inventory'].map(h => (
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
              const profit = calcHeroProfit(product);

              return (
                <Fragment key={product.tiktok_product_id}>
                  {/* Hero product row */}
                  <tr className={`border-b border-tt-border transition-colors hover:bg-[rgba(255,255,255,0.03)] ${idx % 2 === 0 ? '' : 'bg-[rgba(255,255,255,0.015)]'}`}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {product.image_url ? (
                          <img src={product.image_url} alt="" className="w-10 h-10 rounded-lg object-cover border border-tt-border flex-shrink-0" />
                        ) : (
                          <div className="w-10 h-10 rounded-lg bg-[rgba(105,201,208,0.1)] border border-[rgba(105,201,208,0.2)] flex items-center justify-center text-tt-cyan text-sm font-bold flex-shrink-0">
                            {product.name.charAt(0).toUpperCase()}
                          </div>
                        )}
                        <div>
                          <span className="text-[13px] font-medium text-tt-text">{product.name}</span>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-[10px] text-tt-muted font-mono">ID: {product.tiktok_product_id.slice(-10)}</span>
                            {hasVariants && (
                              <button
                                onClick={() => setExpandedProduct(isExpanded ? null : product.tiktok_product_id)}
                                className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium cursor-pointer transition-all ${
                                  isExpanded ? 'border-tt-cyan bg-[rgba(105,201,208,0.1)] text-tt-cyan' : 'border-tt-border text-tt-muted hover:border-tt-cyan hover:text-tt-cyan'
                                }`}
                              >
                                {product.skus.length} SKUs
                                <span className={`transition-transform inline-block ${isExpanded ? 'rotate-180' : ''}`}>▼</span>
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-[13px] font-semibold text-tt-text tabular-nums">{fmtInt(product.total_orders)}</td>
                    <td className="px-4 py-3 text-[13px] font-semibold text-tt-cyan tabular-nums">{fmt(product.total_gmv)}</td>
                    <td className={`px-4 py-3 text-[13px] font-semibold tabular-nums ${profit >= 0 ? 'text-tt-green' : 'text-tt-red'}`}>{fmt(profit)}</td>
                    <td className="px-4 py-3">
                      {hasVariants ? (() => {
                        const costs = product.skus.map(s => getCost(`${product.tiktok_product_id}-${s.sku_id}`));
                        const min = Math.min(...costs);
                        const max = Math.max(...costs);
                        return (
                          <span className="text-[13px] text-tt-text tabular-nums">
                            {min === max ? fmt(min) : `${fmt(min)} - ${fmt(max)}`}
                          </span>
                        );
                      })() : (
                        <CostInput
                          currentValue={getCost(product.tiktok_product_id)}
                          onSave={v => onCostChange?.(product.tiktok_product_id, null, v)}
                        />
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {hasVariants ? (() => {
                        const totalInv = product.skus.reduce((sum, s) => sum + (s.inventory || 0), 0);
                        return (
                          <button
                            onClick={() => setExpandedProduct(isExpanded ? null : product.tiktok_product_id)}
                            className="flex items-center gap-1.5 text-[13px] text-tt-text tabular-nums hover:text-tt-cyan transition-colors cursor-pointer"
                          >
                            {fmtInt(totalInv)}
                            <span className={`transition-transform inline-block text-tt-muted ${isExpanded ? 'rotate-180' : ''}`}>▼</span>
                          </button>
                        );
                      })() : (
                        <span className="text-[13px] text-tt-text tabular-nums">{fmtInt(product.skus[0]?.inventory || 0)}</span>
                      )}
                    </td>
                  </tr>

                  {/* Expanded SKU rows */}
                  {isExpanded && product.skus.map((sku, si) => {
                    const skuCostKey = `${product.tiktok_product_id}-${sku.sku_id}`;
                    const gmvShare = product.total_gmv > 0 ? sku.gmv / product.total_gmv : 0;
                    const skuShipping = product.total_shipping * gmvShare;
                    const skuProfit = calcProfit(sku.gmv, skuShipping, skuCostKey, sku.orders);

                    return (
                      <tr key={`${sku.sku_id}-${si}`} className="border-b border-[rgba(255,255,255,0.04)] bg-[rgba(105,201,208,0.015)]">
                        <td className="px-4 py-2.5 pl-16">
                          <span className={`text-[12px] ${sku.active === false ? 'text-tt-muted' : 'text-tt-text'}`}>
                            └ {sku.sku_name}
                            {sku.active === false && (
                              <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider bg-[rgba(255,255,255,0.06)] text-tt-muted">
                                Inactive
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-[12px] text-tt-text tabular-nums">{fmtInt(sku.orders)}</td>
                        <td className="px-4 py-2.5 text-[12px] text-tt-cyan tabular-nums">{fmt(sku.gmv)}</td>
                        <td className={`px-4 py-2.5 text-[12px] tabular-nums ${skuProfit >= 0 ? 'text-tt-green' : 'text-tt-red'}`}>{fmt(skuProfit)}</td>
                        <td className="px-4 py-2.5">
                          <CostInput
                            currentValue={getCost(skuCostKey)}
                            onSave={v => onCostChange?.(product.tiktok_product_id, sku.sku_id, v)}
                          />
                        </td>
                        <td className="px-4 py-2.5">
                          <InventoryInput
                            currentValue={sku.inventory || 0}
                            onSave={v => onInventoryChange?.(product.tiktok_product_id, sku.sku_id, v)}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </Fragment>
              );
            })}
            {productStats.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-tt-muted">No product data yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
