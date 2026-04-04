'use client';

import { useState } from 'react';
import { fmt, fmtInt } from '@/lib/calculations';
import type { FinanceData } from '@/hooks/useFinance';

interface CashflowTabProps {
  data: FinanceData | undefined;
  isLoading: boolean;
}

export default function CashflowTab({ data, isLoading }: CashflowTabProps) {
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [expandedPayout, setExpandedPayout] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-tt-muted">
        <div className="w-5 h-5 border-2 border-tt-muted border-t-transparent rounded-full animate-spin mr-3" />
        Loading financial data...
      </div>
    );
  }

  if (!data) {
    return <div className="text-tt-muted text-center py-16">No financial data available</div>;
  }

  const { statements, payments, unsettled } = data;

  const totalRevenue = statements.reduce((sum, s) => sum + s.revenue, 0);
  const totalFees = statements.reduce((sum, s) => sum + s.platformFee, 0);
  const totalShipping = statements.reduce((sum, s) => sum + s.shippingCost, 0);
  const totalSettlement = statements.reduce((sum, s) => sum + s.settlement, 0);
  const totalPaid = payments.filter(p => p.status === 'PAID').reduce((sum, p) => sum + p.amount, 0);

  const statementsByDate: Record<string, typeof statements[number]> = {};
  for (const s of statements) {
    if (s.date) statementsByDate[s.date] = s;
  }

  // Show last 5 payouts by default
  const visiblePayments = payments.slice(0, 5);
  const remainingPayments = payments.slice(5);
  const [showAllPayouts, setShowAllPayouts] = useState(false);
  const displayedPayments = showAllPayouts ? payments : visiblePayments;

  return (
    <div>
      {/* 1. Hero: Take-Home with expandable waterfall */}
      <div className="bg-tt-card border border-tt-border rounded-[14px] backdrop-blur-xl overflow-hidden mb-8">
        <button
          onClick={() => setBreakdownOpen(!breakdownOpen)}
          className="w-full px-6 py-6 flex items-center justify-between hover:bg-tt-card-hover transition-colors"
        >
          <div>
            <span className="text-xs text-tt-muted uppercase tracking-wide">Take-Home</span>
            <div className="text-[42px] font-bold text-tt-green mt-1 tabular-nums">{fmt(totalSettlement)}</div>
          </div>
          <div className="flex items-center gap-2 text-tt-muted">
            <span className="text-xs">View breakdown</span>
            <svg className={`w-4 h-4 transition-transform ${breakdownOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </button>

        {breakdownOpen && (
          <div className="px-6 pb-6 border-t border-tt-border pt-4">
            <div className="space-y-3 max-w-md">
              <div className="flex items-center justify-between">
                <span className="text-sm text-tt-text">Net Sales</span>
                <span className="text-sm text-tt-text tabular-nums font-medium">{fmt(totalRevenue)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-tt-muted">Fees</span>
                <span className="text-sm text-tt-red tabular-nums">{fmt(totalFees)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-tt-muted">Shipping</span>
                <span className="text-sm text-tt-red tabular-nums">{fmt(totalShipping)}</span>
              </div>
              <div className="border-t border-tt-border pt-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold text-tt-text">Take-Home</span>
                  <span className="text-sm font-bold text-tt-green tabular-nums">{fmt(totalSettlement)}</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 2. Cashflow Pipeline: On Hold → Settled → Paid Out */}
      {unsettled.totalCount > 0 && (
        <div className="bg-tt-card border border-tt-cyan/20 rounded-[14px] backdrop-blur-xl px-6 py-4 mb-6 flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-tt-cyan animate-pulse" />
          <span className="text-sm text-tt-cyan font-semibold">{fmt(unsettled.estSettlement)}</span>
          <span className="text-xs text-tt-muted">pending across {fmtInt(unsettled.totalCount)} orders</span>
        </div>
      )}

      <div className="grid grid-cols-3 gap-5 mb-8">
        <div className="bg-tt-card border border-tt-border rounded-[14px] p-6 backdrop-blur-xl">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-2 h-2 rounded-full bg-tt-yellow" />
            <span className="text-xs text-tt-muted uppercase tracking-wide">On Hold</span>
          </div>
          <div className="text-[28px] font-bold text-tt-yellow tabular-nums">{fmt(unsettled.estSettlement)}</div>
          <div className="text-xs text-tt-muted mt-1">{fmtInt(unsettled.totalCount)} unsettled orders</div>
        </div>
        <div className="bg-tt-card border border-tt-border rounded-[14px] p-6 backdrop-blur-xl">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-2 h-2 rounded-full bg-tt-cyan" />
            <span className="text-xs text-tt-muted uppercase tracking-wide">Settled</span>
          </div>
          <div className="text-[28px] font-bold text-tt-cyan tabular-nums">{fmt(totalSettlement)}</div>
          <div className="text-xs text-tt-muted mt-1">for selected period</div>
        </div>
        <div className="bg-tt-card border border-tt-border rounded-[14px] p-6 backdrop-blur-xl">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-2 h-2 rounded-full bg-tt-green" />
            <span className="text-xs text-tt-muted uppercase tracking-wide">Paid Out</span>
          </div>
          <div className="text-[28px] font-bold text-tt-green tabular-nums">{fmt(totalPaid)}</div>
          <div className="text-xs text-tt-muted mt-1">{payments.filter(p => p.status === 'PAID').length} payouts</div>
        </div>
      </div>

      {/* 3. Recent Payouts — last 5 expanded by default */}
      {payments.length > 0 && (
        <div className="bg-tt-card border border-tt-border rounded-[14px] backdrop-blur-xl overflow-hidden">
          <div className="px-6 py-5 border-b border-tt-border">
            <h2 className="text-base font-semibold text-tt-text">Recent Payouts</h2>
          </div>

          <div>
            {displayedPayments.map((p, i) => {
              const isExpanded = expandedPayout === p.id;
              const stmt = statementsByDate[p.paidTime] || statementsByDate[p.createTime];

              return (
                <div key={`${p.id}-${i}`} className="border-b border-[rgba(255,255,255,0.04)] last:border-b-0">
                  <button
                    onClick={() => setExpandedPayout(isExpanded ? null : p.id)}
                    className="w-full px-5 py-3.5 flex items-center justify-between hover:bg-tt-card-hover transition-colors"
                  >
                    <div className="flex items-center gap-4">
                      <span className={`text-[10px] font-semibold px-2 py-1 rounded-md ${
                        p.status === 'PAID' ? 'bg-tt-green/15 text-tt-green' :
                        p.status === 'PROCESSING' ? 'bg-tt-yellow/15 text-tt-yellow' :
                        'bg-tt-muted/15 text-tt-muted'
                      }`}>
                        {p.status}
                      </span>
                      <span className="text-xs text-tt-muted">{p.paidTime || p.createTime}</span>
                      <span className="text-xs text-tt-muted">{p.bankAccount}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-[13px] text-tt-green font-semibold tabular-nums">{fmt(p.amount)}</span>
                      <svg className={`w-3.5 h-3.5 text-tt-muted transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="px-8 pb-4 pt-1">
                      <div className="bg-white/5 rounded-xl p-4 space-y-2">
                        <div className="text-[10px] text-tt-muted uppercase tracking-wide mb-3">Breakdown</div>
                        {stmt ? (
                          <>
                            <div className="flex justify-between text-sm">
                              <span className="text-tt-text">Revenue</span>
                              <span className="text-tt-text tabular-nums">{fmt(stmt.revenue)}</span>
                            </div>
                            <div className="flex justify-between text-sm">
                              <span className="text-tt-muted">Platform Fees</span>
                              <span className="text-tt-red tabular-nums">{fmt(stmt.platformFee)}</span>
                            </div>
                            <div className="flex justify-between text-sm">
                              <span className="text-tt-muted">Shipping</span>
                              <span className="text-tt-red tabular-nums">{fmt(stmt.shippingCost)}</span>
                            </div>
                            <div className="border-t border-tt-border my-1" />
                            <div className="flex justify-between text-sm font-bold">
                              <span className="text-tt-text">Take-Home</span>
                              <span className="text-tt-green tabular-nums">{fmt(stmt.settlement)}</span>
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="flex justify-between text-sm">
                              <span className="text-tt-text">Payout ID</span>
                              <span className="text-tt-muted font-mono text-xs">{p.id}</span>
                            </div>
                            <div className="flex justify-between text-sm">
                              <span className="text-tt-text">Created</span>
                              <span className="text-tt-muted">{p.createTime}</span>
                            </div>
                            <div className="flex justify-between text-sm">
                              <span className="text-tt-text">Paid</span>
                              <span className="text-tt-muted">{p.paidTime || '—'}</span>
                            </div>
                            <div className="border-t border-tt-border my-1" />
                            <div className="flex justify-between text-sm font-bold">
                              <span className="text-tt-text">Amount</span>
                              <span className="text-tt-green tabular-nums">{fmt(p.amount)}</span>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {remainingPayments.length > 0 && (
            <button
              onClick={() => setShowAllPayouts(!showAllPayouts)}
              className="w-full px-6 py-3 text-xs text-tt-muted hover:text-tt-cyan transition-colors border-t border-tt-border"
            >
              {showAllPayouts ? 'Show less' : `Show ${remainingPayments.length} more payouts`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
