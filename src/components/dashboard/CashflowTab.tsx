'use client';

import { fmt, fmtInt } from '@/lib/calculations';
import type { FinanceData } from '@/hooks/useFinance';

interface CashflowTabProps {
  data: FinanceData | undefined;
  isLoading: boolean;
}

export default function CashflowTab({ data, isLoading }: CashflowTabProps) {
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

  // Compute totals from statements
  const totalRevenue = statements.reduce((sum, s) => sum + s.revenue, 0);
  const totalFees = statements.reduce((sum, s) => sum + s.platformFee, 0);
  const totalShipping = statements.reduce((sum, s) => sum + s.shippingCost, 0);
  const totalSettlement = statements.reduce((sum, s) => sum + s.settlement, 0);

  // Recent paid payouts
  const paidPayments = payments.filter(p => p.status === 'PAID');
  const totalPaid = paidPayments.reduce((sum, p) => sum + p.amount, 0);

  return (
    <div>
      {/* Projected Payout - Hero Card */}
      {unsettled.totalCount > 0 && (
        <div className="mb-8">
          <div className="bg-tt-card border border-tt-cyan/30 rounded-[14px] backdrop-blur-xl overflow-hidden">
            <div className="px-6 py-5 border-b border-tt-border flex items-center gap-3">
              <div className="w-2 h-2 rounded-full bg-tt-cyan animate-pulse" />
              <h2 className="text-base font-semibold text-tt-text">Projected Payout</h2>
              <span className="text-xs text-tt-muted ml-auto">{fmtInt(unsettled.totalCount)} unsettled orders</span>
            </div>
            <div className="p-6">
              <div className="grid grid-cols-4 gap-6">
                <div>
                  <span className="text-xs text-tt-muted uppercase tracking-wide">Est. Revenue</span>
                  <div className="text-2xl font-bold text-tt-text mt-1">{fmt(unsettled.estRevenue)}</div>
                </div>
                <div>
                  <span className="text-xs text-tt-muted uppercase tracking-wide">Est. Fees</span>
                  <div className="text-2xl font-bold text-tt-red mt-1">-{fmt(Math.abs(unsettled.estFees))}</div>
                </div>
                <div>
                  <span className="text-xs text-tt-muted uppercase tracking-wide">Est. Adjustments</span>
                  <div className="text-2xl font-bold text-tt-text mt-1">{fmt(unsettled.estAdjustments)}</div>
                </div>
                <div>
                  <span className="text-xs text-tt-muted uppercase tracking-wide">Est. Payout</span>
                  <div className="text-2xl font-bold text-tt-green mt-1">{fmt(unsettled.estSettlement)}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-5 mb-8">
        <div className="bg-tt-card border border-tt-border rounded-[14px] p-6 backdrop-blur-xl">
          <span className="text-xs text-tt-muted uppercase tracking-wide">Net Sales</span>
          <div className="text-[30px] font-bold text-tt-green mt-2">{fmt(totalRevenue)}</div>
          <div className="text-xs text-tt-muted mt-1">from statements</div>
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

      {/* Recent Payouts */}
      {payments.length > 0 && (
        <div className="bg-tt-card border border-tt-border rounded-[14px] backdrop-blur-xl overflow-hidden mb-8">
          <div className="px-6 py-5 border-b border-tt-border flex items-center justify-between">
            <h2 className="text-base font-semibold text-tt-text">Recent Payouts</h2>
            {totalPaid > 0 && (
              <span className="text-xs text-tt-green font-semibold">{fmt(totalPaid)} total paid</span>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-tt-border">
                  <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Payout ID</th>
                  <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Bank Account</th>
                  <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Created</th>
                  <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Paid</th>
                  <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Status</th>
                  <th className="text-right px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p, i) => (
                  <tr key={`${p.id}-${i}`} className="border-b border-[rgba(255,255,255,0.04)] hover:bg-tt-card-hover transition-colors">
                    <td className="px-5 py-3 text-xs text-tt-muted font-mono">{p.id.slice(-10)}</td>
                    <td className="px-5 py-3 text-xs text-tt-muted">{p.bankAccount}</td>
                    <td className="px-5 py-3 text-xs text-tt-muted">{p.createTime}</td>
                    <td className="px-5 py-3 text-xs text-tt-muted">{p.paidTime || '—'}</td>
                    <td className="px-5 py-3">
                      <span className={`text-[10px] font-semibold px-2 py-1 rounded-md ${
                        p.status === 'PAID' ? 'bg-tt-green/15 text-tt-green' :
                        p.status === 'PROCESSING' ? 'bg-tt-yellow/15 text-tt-yellow' :
                        'bg-tt-muted/15 text-tt-muted'
                      }`}>
                        {p.status}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-[13px] text-tt-green text-right tabular-nums font-medium">{fmt(p.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Payout Breakdown */}
      {statements.length > 0 && (
        <div className="bg-tt-card border border-tt-border rounded-[14px] backdrop-blur-xl overflow-hidden mb-8">
          <div className="px-6 py-5 border-b border-tt-border">
            <h2 className="text-base font-semibold text-tt-text">Payout Breakdown</h2>
          </div>
          <div className="px-6 py-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between py-2">
                <span className="text-sm text-tt-text">Gross Sales</span>
                <span className="text-sm text-tt-text tabular-nums">{fmt(totalRevenue)}</span>
              </div>
              <div className="flex items-center justify-between py-2">
                <span className="text-sm text-tt-text">Platform Fees</span>
                <span className="text-sm text-tt-red tabular-nums">-{fmt(totalFees)}</span>
              </div>
              <div className="flex items-center justify-between py-2">
                <span className="text-sm text-tt-text">Shipping Costs</span>
                <span className="text-sm text-tt-red tabular-nums">-{fmt(totalShipping)}</span>
              </div>
              <div className="border-t border-tt-border my-2" />
              <div className="flex items-center justify-between py-2">
                <span className="text-sm font-bold text-tt-text">Net Payout</span>
                <span className="text-sm font-bold text-tt-green tabular-nums">{fmt(totalSettlement)}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Statements table */}
      {statements.length > 0 && (
        <div className="bg-tt-card border border-tt-border rounded-[14px] backdrop-blur-xl overflow-hidden">
          <div className="px-6 py-5 border-b border-tt-border">
            <h2 className="text-base font-semibold text-tt-text">Statements</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-tt-border">
                  <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Date</th>
                  <th className="text-right px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Revenue</th>
                  <th className="text-right px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Fees</th>
                  <th className="text-right px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Shipping</th>
                  <th className="text-right px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Settlement</th>
                </tr>
              </thead>
              <tbody>
                {statements.map((s, i) => (
                  <tr key={`${s.date}-${i}`} className="border-b border-[rgba(255,255,255,0.04)] hover:bg-tt-card-hover transition-colors">
                    <td className="px-5 py-3 text-xs text-tt-muted">{s.date}</td>
                    <td className="px-5 py-3 text-[13px] text-tt-text text-right tabular-nums">{fmt(s.revenue)}</td>
                    <td className="px-5 py-3 text-[13px] text-tt-red text-right tabular-nums">-{fmt(s.platformFee)}</td>
                    <td className="px-5 py-3 text-[13px] text-tt-red text-right tabular-nums">-{fmt(s.shippingCost)}</td>
                    <td className="px-5 py-3 text-[13px] text-tt-green text-right tabular-nums font-medium">{fmt(s.settlement)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
