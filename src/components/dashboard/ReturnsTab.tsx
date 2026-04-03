'use client';

import { useState } from 'react';
import { fmt, fmtInt } from '@/lib/calculations';
import type { ReturnsResponse, ReturnItem } from '@/hooks/useReturns';
import { useQueryClient } from '@tanstack/react-query';

interface ReturnsTabProps {
  data: ReturnsResponse | undefined;
  isLoading: boolean;
}

function isPendingStatus(status: string): boolean {
  const s = status.toUpperCase();
  return s.includes('IN_CANCEL') || s.includes('REQUESTED') || s.includes('IN_PROGRESS') || s.includes('PENDING') || s.includes('AWAITING') || s.includes('IN_TRANSIT');
}

function isAwaitingSellerAction(item: ReturnItem): boolean {
  const role = item.role.toUpperCase();
  if (role === 'SELLER' || role.includes('SELLER')) return true;
  // Fallback: if status suggests seller needs to act
  const s = item.status.toUpperCase();
  return s.includes('AWAITING_ISSUE_REFUND') || s.includes('WAITING_FOR_SELLER') || s.includes('SELLER_RECEIVE');
}

function formatReturnType(type: string): string {
  if (!type) return '';
  return type.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

const REJECT_REASONS = [
  'Product has been shipped',
  'Buyer and seller have reached an agreement',
  'Buyer has already received the goods',
  'Other',
];

export default function ReturnsTab({ data, isLoading }: ReturnsTabProps) {
  const [filter, setFilter] = useState<'all' | 'pending'>('all');
  const [modalItem, setModalItem] = useState<ReturnItem | null>(null);
  const [modalAction, setModalAction] = useState<'approve' | 'reject' | null>(null);
  const [rejectReason, setRejectReason] = useState(REJECT_REASONS[0]);
  const [sellerComments, setSellerComments] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState(false);
  const queryClient = useQueryClient();

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

  function openModal(item: ReturnItem) {
    setModalItem(item);
    setModalAction(null);
    setRejectReason(REJECT_REASONS[0]);
    setSellerComments('');
    setSubmitError(null);
    setSubmitSuccess(false);
  }

  function closeModal() {
    setModalItem(null);
    setModalAction(null);
    setSubmitError(null);
    setSubmitSuccess(false);
  }

  async function handleSubmit() {
    if (!modalItem || !modalAction) return;
    setSubmitting(true);
    setSubmitError(null);

    try {
      const res = await fetch('/api/tiktok/returns/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          returnId: modalItem.return_id,
          action: modalAction,
          returnType: modalItem.return_type?.toUpperCase(),
          ...(modalAction === 'reject' ? { rejectReason, sellerComments: sellerComments || undefined } : {}),
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: 'Request failed' }));
        throw new Error(errData.error || `Request failed (${res.status})`);
      }

      setSubmitSuccess(true);
      // Refetch returns data after a brief delay to show success state
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['returns'] });
        closeModal();
      }, 1500);
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

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
                <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Type / Reason</th>
                <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Date</th>
                <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Status</th>
                <th className="text-right px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Units</th>
                <th className="text-right px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Refund</th>
                <th className="text-center px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Action</th>
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
                      <span className="text-[13px] text-tt-text line-clamp-2">{item.product_name}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex flex-col gap-0.5">
                      {item.return_type && (
                        <span className="text-[11px] text-tt-text font-medium">{formatReturnType(item.return_type)}</span>
                      )}
                      {item.reason && (
                        <span className="text-[11px] text-tt-muted">{item.reason}</span>
                      )}
                      {item.buyer_remarks && (
                        <span className="text-[10px] text-tt-muted/70 italic line-clamp-2">&ldquo;{item.buyer_remarks}&rdquo;</span>
                      )}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-xs text-tt-muted">{item.order_date}</td>
                  <td className="px-5 py-3">
                    <div className="flex flex-col gap-1">
                      <StatusBadge status={item.status} />
                      {isPendingStatus(item.status) && isAwaitingSellerAction(item) && (
                        <span className="text-[9px] font-semibold text-tt-red uppercase tracking-wide">Action needed</span>
                      )}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-[13px] text-tt-text text-right tabular-nums">{item.units}</td>
                  <td className="px-5 py-3 text-[13px] text-tt-text text-right tabular-nums">{fmt(item.gmv)}</td>
                  <td className="px-5 py-3 text-center">
                    {isPendingStatus(item.status) && item.return_id ? (
                      <button
                        onClick={() => openModal(item)}
                        className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-tt-cyan/15 text-tt-cyan hover:bg-tt-cyan/25 transition-colors"
                      >
                        Respond
                      </button>
                    ) : (
                      <span className="text-[11px] text-tt-muted">--</span>
                    )}
                  </td>
                </tr>
              ))}
              {filteredItems.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-5 py-12 text-center text-tt-muted text-sm">
                    {filter === 'pending' ? 'No pending returns or cancellations' : 'No returns or cancellations found for this period'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Respond Modal */}
      {modalItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={closeModal} />

          {/* Modal content */}
          <div className="relative bg-tt-card border border-tt-border rounded-2xl p-6 w-full max-w-md mx-4 shadow-2xl">
            {submitSuccess ? (
              <div className="text-center py-8">
                <div className="w-12 h-12 rounded-full bg-tt-green/15 flex items-center justify-center mx-auto mb-4">
                  <svg className="w-6 h-6 text-tt-green" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <p className="text-tt-text font-semibold">Response submitted successfully</p>
                <p className="text-tt-muted text-sm mt-1">Refreshing data...</p>
              </div>
            ) : (
              <>
                {/* Header */}
                <div className="flex items-start justify-between mb-5">
                  <div>
                    <h3 className="text-base font-semibold text-tt-text">Respond to Request</h3>
                    <p className="text-xs text-tt-muted mt-1">
                      {formatReturnType(modalItem.return_type) || 'Return'} #{modalItem.return_id.slice(-8)}
                    </p>
                  </div>
                  <button onClick={closeModal} className="text-tt-muted hover:text-tt-text transition-colors p-1">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>

                {/* Product info */}
                <div className="flex items-center gap-3 p-3 bg-white/5 rounded-xl mb-5">
                  {modalItem.product_image ? (
                    <img src={modalItem.product_image} alt="" className="w-11 h-11 rounded-lg object-cover flex-shrink-0" />
                  ) : (
                    <div className="w-11 h-11 rounded-lg bg-tt-border flex-shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] text-tt-text line-clamp-2">{modalItem.product_name}</p>
                    <p className="text-xs text-tt-muted mt-0.5">
                      {modalItem.units} unit{modalItem.units !== 1 ? 's' : ''} &middot; Refund: {fmt(modalItem.gmv)}
                    </p>
                  </div>
                </div>

                {modalItem.reason && (
                  <div className="mb-5 p-3 bg-white/5 rounded-xl">
                    <p className="text-[11px] text-tt-muted uppercase tracking-wide mb-1">Reason</p>
                    <p className="text-xs text-tt-text">{modalItem.reason}</p>
                    {modalItem.buyer_remarks && (
                      <p className="text-[11px] text-tt-muted/70 italic mt-1">&ldquo;{modalItem.buyer_remarks}&rdquo;</p>
                    )}
                  </div>
                )}

                {/* Action selection */}
                {!modalAction && (
                  <div className="flex gap-3">
                    <button
                      onClick={() => setModalAction('approve')}
                      className="flex-1 py-3 rounded-xl text-sm font-semibold bg-tt-green/15 text-tt-green hover:bg-tt-green/25 transition-colors"
                    >
                      Issue Refund
                    </button>
                    <button
                      onClick={() => setModalAction('reject')}
                      className="flex-1 py-3 rounded-xl text-sm font-semibold bg-tt-red/15 text-tt-red hover:bg-tt-red/25 transition-colors"
                    >
                      Reject
                    </button>
                  </div>
                )}

                {/* Approve confirmation */}
                {modalAction === 'approve' && (
                  <div>
                    <div className="p-3 bg-tt-green/10 rounded-xl mb-4">
                      <p className="text-sm text-tt-green font-medium">Approve this refund of {fmt(modalItem.gmv)}?</p>
                      <p className="text-xs text-tt-muted mt-1">This action cannot be undone.</p>
                    </div>
                    {submitError && (
                      <div className="p-3 bg-tt-red/10 rounded-xl mb-4">
                        <p className="text-xs text-tt-red">{submitError}</p>
                      </div>
                    )}
                    <div className="flex gap-3">
                      <button
                        onClick={() => setModalAction(null)}
                        className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-tt-muted hover:text-tt-text bg-white/5 hover:bg-white/10 transition-colors"
                        disabled={submitting}
                      >
                        Back
                      </button>
                      <button
                        onClick={handleSubmit}
                        disabled={submitting}
                        className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-tt-green text-black hover:bg-tt-green/90 transition-colors disabled:opacity-50"
                      >
                        {submitting ? (
                          <span className="flex items-center justify-center gap-2">
                            <span className="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin" />
                            Submitting...
                          </span>
                        ) : (
                          'Confirm Refund'
                        )}
                      </button>
                    </div>
                  </div>
                )}

                {/* Reject form */}
                {modalAction === 'reject' && (
                  <div>
                    <div className="mb-4">
                      <label className="text-[11px] text-tt-muted uppercase tracking-wide block mb-2">Rejection Reason</label>
                      <select
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        className="w-full bg-white/5 border border-tt-border rounded-xl px-4 py-2.5 text-sm text-tt-text focus:outline-none focus:ring-1 focus:ring-tt-cyan/50 appearance-none"
                      >
                        {REJECT_REASONS.map(r => (
                          <option key={r} value={r} className="bg-tt-card text-tt-text">{r}</option>
                        ))}
                      </select>
                    </div>
                    <div className="mb-4">
                      <label className="text-[11px] text-tt-muted uppercase tracking-wide block mb-2">Comments (optional)</label>
                      <textarea
                        value={sellerComments}
                        onChange={(e) => setSellerComments(e.target.value)}
                        placeholder="Add any additional context..."
                        rows={3}
                        className="w-full bg-white/5 border border-tt-border rounded-xl px-4 py-2.5 text-sm text-tt-text placeholder:text-tt-muted/50 focus:outline-none focus:ring-1 focus:ring-tt-cyan/50 resize-none"
                      />
                    </div>
                    {submitError && (
                      <div className="p-3 bg-tt-red/10 rounded-xl mb-4">
                        <p className="text-xs text-tt-red">{submitError}</p>
                      </div>
                    )}
                    <div className="flex gap-3">
                      <button
                        onClick={() => setModalAction(null)}
                        className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-tt-muted hover:text-tt-text bg-white/5 hover:bg-white/10 transition-colors"
                        disabled={submitting}
                      >
                        Back
                      </button>
                      <button
                        onClick={handleSubmit}
                        disabled={submitting}
                        className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-tt-red text-white hover:bg-tt-red/90 transition-colors disabled:opacity-50"
                      >
                        {submitting ? (
                          <span className="flex items-center justify-center gap-2">
                            <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                            Submitting...
                          </span>
                        ) : (
                          'Reject Request'
                        )}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
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
