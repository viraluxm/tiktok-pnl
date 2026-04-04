'use client';

import { useState, useMemo } from 'react';
import { fmt, fmtInt } from '@/lib/calculations';
import type { FinanceData, PaymentRecord, UnsettledSummary } from '@/hooks/useFinance';

/* ── PayoutCalendar sub-component ────────────────────────────── */

function PayoutCalendar({
  payments,
  unsettled,
  statements,
}: {
  payments: PaymentRecord[];
  unsettled: UnsettledSummary;
  statements: FinanceData['statements'];
}) {
  const today = new Date();
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [tooltip, setTooltip] = useState<{ label: string; x: number; y: number } | null>(null);

  const pastPayouts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const p of payments) {
      if (p.status === 'PAID' && p.paidTime) {
        map[p.paidTime] = (map[p.paidTime] || 0) + p.amount;
      }
    }
    for (const s of statements) {
      if (s.date && s.settlement > 0 && !map[s.date]) {
        map[s.date] = s.settlement;
      }
    }
    return map;
  }, [payments, statements]);

  const projectedPayouts = useMemo(() => {
    const map: Record<string, number> = {};
    if (unsettled.estSettlement <= 0) return map;
    const dailyAmount = unsettled.estSettlement / 7;
    for (let i = 1; i <= 7; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      map[key] = dailyAmount;
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unsettled.estSettlement]);

  const firstOfMonth = new Date(viewYear, viewMonth, 1);
  const startDow = firstOfMonth.getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const monthLabel = firstOfMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  const prevMonth = () => {
    if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11); }
    else setViewMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0); }
    else setViewMonth(m => m + 1);
  };

  const cells: number[] = [];
  for (let i = 0; i < startDow; i++) cells.push(0);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length < 42) cells.push(0);

  const handleMouseEnter = (e: React.MouseEvent, amount: number, kind: string) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setTooltip({ label: `${kind}: ${fmt(amount)}`, x: rect.left + rect.width / 2, y: rect.top - 6 });
  };

  return (
    <div className="bg-tt-card border border-tt-border rounded-[14px] backdrop-blur-xl overflow-hidden mb-8">
      {/* Header with pending total */}
      <div className="px-6 py-5 border-b border-tt-border">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-semibold text-tt-text">Payout Calendar</h2>
          <div className="flex items-center gap-3">
            <button onClick={prevMonth} className="text-tt-muted hover:text-tt-text transition-colors text-sm px-1">&larr;</button>
            <span className="text-sm text-tt-text font-medium min-w-[140px] text-center">{monthLabel}</span>
            <button onClick={nextMonth} className="text-tt-muted hover:text-tt-text transition-colors text-sm px-1">&rarr;</button>
          </div>
        </div>
        {unsettled.totalCount > 0 && (
          <div className="flex items-center gap-2 mt-2">
            <div className="w-1.5 h-1.5 rounded-full bg-tt-cyan animate-pulse" />
            <span className="text-sm text-tt-cyan font-semibold">{fmt(unsettled.estSettlement)}</span>
            <span className="text-xs text-tt-muted">pending across {fmtInt(unsettled.totalCount)} orders</span>
          </div>
        )}
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 px-4 pt-3 pb-1">
        {dayNames.map(d => (
          <div key={d} className="text-center text-[10px] text-tt-muted uppercase tracking-wide font-medium">{d}</div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7 px-4 pb-3 gap-y-0.5">
        {cells.map((day, idx) => {
          if (day === 0) return <div key={`empty-${idx}`} className="py-3" />;

          const dayKey = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const pastAmount = pastPayouts[dayKey];
          const projAmount = projectedPayouts[dayKey];
          const isToday = dayKey === todayKey;

          return (
            <div
              key={dayKey}
              className={`relative flex flex-col items-center justify-center py-3 rounded-lg text-xs transition-colors ${
                isToday ? 'bg-tt-cyan/10 ring-1 ring-tt-cyan/40' : ''
              } hover:bg-tt-card-hover`}
              onMouseEnter={(e) => {
                if (pastAmount) handleMouseEnter(e, pastAmount, 'Paid');
                else if (projAmount) handleMouseEnter(e, projAmount, 'Projected');
              }}
              onMouseLeave={() => setTooltip(null)}
            >
              <span className={`tabular-nums ${isToday ? 'text-tt-cyan font-bold' : 'text-tt-muted'}`}>{day}</span>
              {pastAmount ? (
                <span className="text-[9px] text-tt-green font-semibold tabular-nums mt-0.5">{fmt(pastAmount)}</span>
              ) : projAmount ? (
                <span className="text-[9px] text-tt-cyan/60 tabular-nums mt-0.5">~{fmt(projAmount)}</span>
              ) : (
                <span className="h-[14px]" />
              )}
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="px-6 pb-4 flex items-center gap-5">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-tt-green" />
          <span className="text-[10px] text-tt-muted">Paid</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-tt-cyan" />
          <span className="text-[10px] text-tt-muted">Projected</span>
        </div>
      </div>

      {tooltip && (
        <div
          className="fixed z-50 px-2.5 py-1.5 rounded-md bg-[#1a1a2e] border border-tt-border text-[11px] text-tt-text shadow-lg whitespace-nowrap pointer-events-none"
          style={{ left: tooltip.x, top: tooltip.y, transform: 'translate(-50%, -100%)' }}
        >
          {tooltip.label}
        </div>
      )}
    </div>
  );
}

/* ── Main CashflowTab ────────────────────────────────────────── */

interface CashflowTabProps {
  data: FinanceData | undefined;
  isLoading: boolean;
}

export default function CashflowTab({ data, isLoading }: CashflowTabProps) {
  const [payoutsOpen, setPayoutsOpen] = useState(false);
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
  const paidPayments = payments.filter(p => p.status === 'PAID');
  const totalPaid = paidPayments.reduce((sum, p) => sum + p.amount, 0);

  const statementsByDate: Record<string, typeof statements[number]> = {};
  for (const s of statements) {
    if (s.date) statementsByDate[s.date] = s;
  }

  return (
    <div>
      {/* 1. Summary cards */}
      <div className="grid grid-cols-4 gap-5 mb-8">
        <div className="bg-tt-card border border-tt-border rounded-[14px] p-6 backdrop-blur-xl">
          <span className="text-xs text-tt-muted uppercase tracking-wide">Net Sales</span>
          <div className="text-[30px] font-bold text-tt-green mt-2">{fmt(totalRevenue)}</div>
        </div>
        <div className="bg-tt-card border border-tt-border rounded-[14px] p-6 backdrop-blur-xl">
          <span className="text-xs text-tt-muted uppercase tracking-wide">Fees</span>
          <div className="text-[30px] font-bold text-tt-red mt-2">-{fmt(totalFees)}</div>
        </div>
        <div className="bg-tt-card border border-tt-border rounded-[14px] p-6 backdrop-blur-xl">
          <span className="text-xs text-tt-muted uppercase tracking-wide">Shipping</span>
          <div className="text-[30px] font-bold text-tt-text mt-2">-{fmt(totalShipping)}</div>
        </div>
        <div className="bg-tt-card border border-tt-border rounded-[14px] p-6 backdrop-blur-xl">
          <span className="text-xs text-tt-muted uppercase tracking-wide">Total Settled</span>
          <div className="text-[30px] font-bold text-tt-green mt-2">{fmt(totalSettlement)}</div>
        </div>
      </div>

      {/* 2. Calendar (includes pending total) */}
      <PayoutCalendar payments={payments} unsettled={unsettled} statements={statements} />

      {/* 3. Payouts — collapsed by default */}
      {payments.length > 0 && (
        <div className="bg-tt-card border border-tt-border rounded-[14px] backdrop-blur-xl overflow-hidden">
          <button
            onClick={() => setPayoutsOpen(!payoutsOpen)}
            className="w-full px-6 py-5 flex items-center justify-between hover:bg-tt-card-hover transition-colors"
          >
            <div className="flex items-center gap-3">
              <h2 className="text-base font-semibold text-tt-text">Payouts</h2>
              <span className="text-xs text-tt-muted">({payments.length})</span>
            </div>
            <div className="flex items-center gap-3">
              {totalPaid > 0 && (
                <span className="text-xs text-tt-green font-semibold">{fmt(totalPaid)} total</span>
              )}
              <svg className={`w-4 h-4 text-tt-muted transition-transform ${payoutsOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          </button>

          {payoutsOpen && (
            <div className="border-t border-tt-border">
              {payments.map((p, i) => {
                const isExpanded = expandedPayout === p.id;
                const stmt = statementsByDate[p.paidTime] || statementsByDate[p.createTime];

                return (
                  <div key={`${p.id}-${i}`} className="border-b border-[rgba(255,255,255,0.04)] last:border-b-0">
                    <button
                      onClick={() => setExpandedPayout(isExpanded ? null : p.id)}
                      className="w-full px-5 py-3 flex items-center justify-between hover:bg-tt-card-hover transition-colors"
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
                                <span className="text-tt-text">Platform Fees</span>
                                <span className="text-tt-red tabular-nums">-{fmt(stmt.platformFee)}</span>
                              </div>
                              <div className="flex justify-between text-sm">
                                <span className="text-tt-text">Shipping</span>
                                <span className="text-tt-red tabular-nums">-{fmt(stmt.shippingCost)}</span>
                              </div>
                              <div className="border-t border-tt-border my-1" />
                              <div className="flex justify-between text-sm font-bold">
                                <span className="text-tt-text">Net Settlement</span>
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
          )}
        </div>
      )}
    </div>
  );
}
