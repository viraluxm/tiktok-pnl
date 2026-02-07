'use client';

import { useState, useRef, useCallback } from 'react';
import type { Entry, Product } from '@/types';
import { calcEntry, fmt, fmtInt, fmtPct, getMarginLevel } from '@/lib/calculations';

interface EntriesTableProps {
  entries: Entry[];
  products: Product[];
  onAddEntry: (productId: string) => void;
  onUpdateEntry: (id: string, field: string, value: unknown) => void;
  onDeleteEntry: (id: string) => void;
}

const marginColors = {
  green: 'bg-[rgba(0,200,83,0.15)] text-tt-green',
  yellow: 'bg-[rgba(255,214,0,0.15)] text-tt-yellow',
  red: 'bg-[rgba(255,23,68,0.15)] text-tt-red',
};

export default function EntriesTable({ entries, products, onAddEntry, onUpdateEntry, onDeleteEntry }: EntriesTableProps) {
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const handleChange = useCallback((id: string, field: string, value: string) => {
    const key = `${id}-${field}`;
    if (debounceTimers.current[key]) clearTimeout(debounceTimers.current[key]);
    debounceTimers.current[key] = setTimeout(() => {
      const numFields = ['gmv', 'videos_posted', 'views', 'shipping', 'affiliate', 'ads'];
      const parsed = numFields.includes(field) ? parseFloat(value) || 0 : value;
      onUpdateEntry(id, field, parsed);
    }, 400);
  }, [onUpdateEntry]);

  // Calculate totals
  let totGmv = 0, totVideos = 0, totViews = 0, totShipping = 0, totAffiliate = 0, totAds = 0, totCogs = 0, totNet = 0;
  entries.forEach((e) => {
    const c = calcEntry(e);
    totGmv += Number(e.gmv) || 0;
    totVideos += Number(e.videos_posted) || 0;
    totViews += Number(e.views) || 0;
    totShipping += Number(e.shipping) || 0;
    totAffiliate += Number(e.affiliate) || 0;
    totAds += Number(e.ads) || 0;
    totCogs += c.cogs;
    totNet += c.totalNetProfit;
  });
  const avgGRV = totVideos > 0 ? totGmv / totVideos : 0;
  const avgNPPV = totVideos > 0 ? totNet / totVideos : 0;
  const avgMargin = totGmv > 0 ? (totNet / totGmv) * 100 : 0;
  const totMarginLevel = getMarginLevel(avgMargin);

  return (
    <div className="bg-tt-card border border-tt-border rounded-[14px] backdrop-blur-xl overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-tt-border">
        <h2 className="text-base font-semibold">Daily P&L Entries</h2>
        <button
          onClick={() => products[0] && onAddEntry(products[0].id)}
          disabled={products.length === 0}
          className="px-4 py-2 rounded-lg bg-gradient-to-r from-tt-cyan to-[#4db8c0] text-black text-[13px] font-semibold hover:opacity-90 transition-opacity disabled:opacity-40"
        >
          + Add Entry
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse min-w-[1200px]">
          <thead>
            <tr>
              {['Date', 'Product', 'Shop GMV', 'Videos Posted', 'Views', 'Gross Rev/Video', 'COGS (6%)', 'Shipping', 'Affiliate', 'Ads', 'Net Profit/Video', 'Total Net Profit', 'Margin', ''].map((h) => (
                <th key={h} className="px-3.5 py-3 text-left text-[11px] uppercase tracking-wide text-tt-muted font-semibold border-b border-tt-border whitespace-nowrap sticky top-0 bg-[rgba(25,25,25,0.95)]">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.map((e, idx) => {
              const c = calcEntry(e);
              const ml = getMarginLevel(c.margin);
              return (
                <tr
                  key={e.id}
                  className={`border-b border-tt-border transition-colors hover:bg-[rgba(255,255,255,0.03)] ${idx % 2 === 0 ? '' : 'bg-[rgba(255,255,255,0.015)]'}`}
                >
                  <td className="px-3.5 py-2.5">
                    <input type="date" defaultValue={e.date} onChange={(ev) => handleChange(e.id, 'date', ev.target.value)} className="bg-tt-input-bg border border-transparent text-tt-text px-2 py-1.5 rounded-md text-[13px] w-[140px] focus:outline-none focus:border-tt-cyan focus:bg-[rgba(105,201,208,0.08)] transition-all" />
                  </td>
                  <td className="px-3.5 py-2.5">
                    <select defaultValue={e.product_id} onChange={(ev) => handleChange(e.id, 'product_id', ev.target.value)} className="bg-tt-input-bg border border-transparent text-tt-text px-2 py-1.5 rounded-md text-[13px] focus:outline-none focus:border-tt-cyan transition-all">
                      {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </td>
                  <td className="px-3.5 py-2.5"><input type="number" step="0.01" defaultValue={e.gmv || ''} placeholder="0.00" onChange={(ev) => handleChange(e.id, 'gmv', ev.target.value)} className="bg-tt-input-bg border border-transparent text-tt-text px-2 py-1.5 rounded-md text-[13px] w-[100px] focus:outline-none focus:border-tt-cyan focus:bg-[rgba(105,201,208,0.08)] transition-all" /></td>
                  <td className="px-3.5 py-2.5"><input type="number" step="1" defaultValue={e.videos_posted || ''} placeholder="0" onChange={(ev) => handleChange(e.id, 'videos_posted', ev.target.value)} className="bg-tt-input-bg border border-transparent text-tt-text px-2 py-1.5 rounded-md text-[13px] w-[100px] focus:outline-none focus:border-tt-cyan focus:bg-[rgba(105,201,208,0.08)] transition-all" /></td>
                  <td className="px-3.5 py-2.5"><input type="number" step="1" defaultValue={e.views || ''} placeholder="0" onChange={(ev) => handleChange(e.id, 'views', ev.target.value)} className="bg-tt-input-bg border border-transparent text-tt-text px-2 py-1.5 rounded-md text-[13px] w-[100px] focus:outline-none focus:border-tt-cyan focus:bg-[rgba(105,201,208,0.08)] transition-all" /></td>
                  <td className="px-3.5 py-2.5 font-semibold text-[13px] tabular-nums">{fmt(c.grossRevPerVideo)}</td>
                  <td className="px-3.5 py-2.5 font-semibold text-[13px] tabular-nums">{fmt(c.cogs)}</td>
                  <td className="px-3.5 py-2.5"><input type="number" step="0.01" defaultValue={e.shipping || ''} placeholder="0.00" onChange={(ev) => handleChange(e.id, 'shipping', ev.target.value)} className="bg-tt-input-bg border border-transparent text-tt-text px-2 py-1.5 rounded-md text-[13px] w-[100px] focus:outline-none focus:border-tt-cyan focus:bg-[rgba(105,201,208,0.08)] transition-all" /></td>
                  <td className="px-3.5 py-2.5"><input type="number" step="0.01" defaultValue={e.affiliate || ''} placeholder="0.00" onChange={(ev) => handleChange(e.id, 'affiliate', ev.target.value)} className="bg-tt-input-bg border border-transparent text-tt-text px-2 py-1.5 rounded-md text-[13px] w-[100px] focus:outline-none focus:border-tt-cyan focus:bg-[rgba(105,201,208,0.08)] transition-all" /></td>
                  <td className="px-3.5 py-2.5"><input type="number" step="0.01" defaultValue={e.ads || ''} placeholder="0.00" onChange={(ev) => handleChange(e.id, 'ads', ev.target.value)} className="bg-tt-input-bg border border-transparent text-tt-text px-2 py-1.5 rounded-md text-[13px] w-[100px] focus:outline-none focus:border-tt-cyan focus:bg-[rgba(105,201,208,0.08)] transition-all" /></td>
                  <td className="px-3.5 py-2.5 font-semibold text-[13px] tabular-nums">{fmt(c.netProfitPerVideo)}</td>
                  <td className={`px-3.5 py-2.5 font-semibold text-[13px] tabular-nums ${c.totalNetProfit >= 0 ? 'text-tt-green' : 'text-tt-red'}`}>{fmt(c.totalNetProfit)}</td>
                  <td className="px-3.5 py-2.5">
                    <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold ${marginColors[ml]}`}>
                      {fmtPct(c.margin)}
                    </span>
                  </td>
                  <td className="px-3.5 py-2.5">
                    <button onClick={() => onDeleteEntry(e.id)} className="text-tt-muted hover:text-tt-red hover:bg-[rgba(255,23,68,0.1)] p-1 rounded transition-all text-base">&times;</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          {entries.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-tt-cyan bg-[rgba(105,201,208,0.05)]">
                <td colSpan={2} className="px-3.5 py-2.5 font-bold text-tt-cyan text-[13px]">TOTALS</td>
                <td className="px-3.5 py-2.5 font-bold text-[13px] tabular-nums">{fmt(totGmv)}</td>
                <td className="px-3.5 py-2.5 font-bold text-[13px] tabular-nums">{fmtInt(totVideos)}</td>
                <td className="px-3.5 py-2.5 font-bold text-[13px] tabular-nums">{fmtInt(totViews)}</td>
                <td className="px-3.5 py-2.5 font-bold text-[13px] tabular-nums">{fmt(avgGRV)}</td>
                <td className="px-3.5 py-2.5 font-bold text-[13px] tabular-nums">{fmt(totCogs)}</td>
                <td className="px-3.5 py-2.5 font-bold text-[13px] tabular-nums">{fmt(totShipping)}</td>
                <td className="px-3.5 py-2.5 font-bold text-[13px] tabular-nums">{fmt(totAffiliate)}</td>
                <td className="px-3.5 py-2.5 font-bold text-[13px] tabular-nums">{fmt(totAds)}</td>
                <td className="px-3.5 py-2.5 font-bold text-[13px] tabular-nums">{fmt(avgNPPV)}</td>
                <td className={`px-3.5 py-2.5 font-bold text-[13px] tabular-nums ${totNet >= 0 ? 'text-tt-green' : 'text-tt-red'}`}>{fmt(totNet)}</td>
                <td className="px-3.5 py-2.5">
                  <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold ${marginColors[totMarginLevel]}`}>
                    {fmtPct(avgMargin)}
                  </span>
                </td>
                <td></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
