'use client';

import { useState } from 'react';
import { fmt, fmtInt } from '@/lib/calculations';
import type { ReturnsResponse, ReturnItem } from '@/hooks/useReturns';

interface ReturnsTabProps {
  data: ReturnsResponse | undefined;
  isLoading: boolean;
}

function isPendingStatus(status: string): boolean {
  const s = status.toUpperCase();
  return s.includes('IN_CANCEL') || s.includes('REQUESTED') || s.includes('IN_PROGRESS') || s.includes('PENDING') || s.includes('AWAITING') || s.includes('IN_TRANSIT');
}

export default function ReturnsTab({ data, isLoading }: ReturnsTabProps) {
  const [filter, setFilter] = useState<'all' | 'pending'>('all');

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-tt-muted">
        <div className="w-5 h-5 border-2 border-tt-muted border-t-transparent rounded-full animate-spin mr-3" />
        Loading returns...
      </div>
    );
  }

  if (!data) {
    return <div className="text-tt-muted text-center py-16">No return data available</div>;
  }

  const { summary, items } = data;
  const filteredItems = filter === 'pending' ? items.filter(i => isPendingStatus(i.status)) : items;

  return (
    <div>
      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-5 mb-8">
        <div className="bg-tt-card border border-tt-border rounded-[14px] p-6 backdrop-blur-xl">
          <span className="text-xs text-tt-muted uppercase tracking-wide">Total Returns</span>
          <div className="text-[30px] font-bold text-tt-red mt-2">{fmtInt(summary.totalReturns)}</div>
          <div className="text-xs text-tt-muted mt-1">{fmt(summary.totalAmount)} value</div>
        </div>
        <div className="bg-tt-card border border-tt-border rounded-[14px] p-6 backdrop-blur-xl">
          <span className="text-xs text-tt-muted uppercase tracking-wide">Pending</span>
          <div className="text-[30px] font-bold text-tt-yellow mt-2">{fmtInt(summary.pendingReturns)}</div>
          <div className="text-xs text-tt-muted mt-1">{fmt(summary.pendingAmount)} value</div>
        </div>
        <div className="bg-tt-card border border-tt-border rounded-[14px] p-6 backdrop-blur-xl">
          <span className="text-xs text-tt-muted uppercase tracking-wide">Completed</span>
          <div className="text-[30px] font-bold text-tt-green mt-2">{fmtInt(summary.completedReturns)}</div>
          <div className="text-xs text-tt-muted mt-1">{fmt(summary.completedAmount)} value</div>
        </div>
      </div>

      {/* Returns table */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] backdrop-blur-xl overflow-hidden">
        <div className="px-6 py-5 border-b border-tt-border flex items-center justify-between">
          <h2 className="text-base font-semibold text-tt-text">Return & Cancellation History</h2>
          <div className="flex gap-2">
            <button
              onClick={() => setFilter('all')}
              className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                filter === 'all'
                  ? 'bg-white/10 text-tt-text'
                  : 'text-tt-muted hover:text-tt-text hover:bg-white/5'
              }`}
            >
              View All
            </button>
            <button
              onClick={() => setFilter('pending')}
              className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                filter === 'pending'
                  ? 'bg-tt-yellow/15 text-tt-yellow'
                  : 'text-tt-muted hover:text-tt-text hover:bg-white/5'
              }`}
            >
              Pending ({fmtInt(summary.pendingReturns)})
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-tt-border">
                <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Order ID</th>
                <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Product</th>
                <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Date</th>
                <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Status</th>
                <th className="text-right px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Units</th>
                <th className="text-right px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">GMV</th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.map((item, i) => (
                <tr key={`${item.order_id}-${i}`} className="border-b border-[rgba(255,255,255,0.04)] hover:bg-tt-card-hover transition-colors">
                  <td className="px-5 py-3 text-xs text-tt-muted font-mono">{item.order_id.slice(-12)}</td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      {item.product_image ? (
                        <img src={item.product_image} alt="" className="w-9 h-9 rounded-lg object-cover flex-shrink-0" />
                      ) : (
                        <div className="w-9 h-9 rounded-lg bg-tt-border flex-shrink-0" />
                      )}
                      <span className="text-[13px] text-tt-text">{item.product_name}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-xs text-tt-muted">{item.order_date}</td>
                  <td className="px-5 py-3"><StatusBadge status={item.status} /></td>
                  <td className="px-5 py-3 text-[13px] text-tt-text text-right tabular-nums">{item.units}</td>
                  <td className="px-5 py-3 text-[13px] text-tt-text text-right tabular-nums">{fmt(item.gmv)}</td>
                </tr>
              ))}
              {filteredItems.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-5 py-12 text-center text-tt-muted text-sm">
                    {filter === 'pending' ? 'No pending returns or cancellations' : 'No returns or cancellations found for this period'}
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

function StatusBadge({ status }: { status: string }) {
  const s = status.toUpperCase();
  const pending = isPendingStatus(s);
  const isCancelled = s === 'CANCELLED' || s.includes('CANCEL');

  let colorClass = 'bg-tt-red/15 text-tt-red';
  if (pending) colorClass = 'bg-tt-yellow/15 text-tt-yellow';
  else if (!isCancelled) colorClass = 'bg-tt-muted/15 text-tt-muted';

  // Clean up display
  const display = status.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

  return (
    <span className={`text-[10px] font-semibold px-2 py-1 rounded-md ${colorClass}`}>
      {display}
    </span>
  );
}
