'use client';

import { useMemo, useState } from 'react';
import { fmt } from '@/lib/calculations';
import {
  computePay,
  generateRecurringShifts,
  payPeriodFor,
  paydayAtOffset,
  fmtPayDate,
  fmtMonthDay,
} from '@/lib/employees';
import { useShifts } from '@/hooks/useShifts';
import { useShiftRules } from '@/hooks/useShiftRules';
import type { Employee } from '@/types';
import { fmtHours, titleCase } from './shared';
import MobileDataCard from '@/components/ui/MobileDataCard';

// Pay sub-tab role filter (ported from PR #69). 'all' = everyone (default); others match
// employees.role. Purely display — narrows which payroll rows show; no new calc/query.
type PayRole = 'all' | 'fulfillment' | 'host';
const PAY_ROLE_OPTIONS: { value: PayRole; label: string }[] = [
  { value: 'all', label: 'View all' },
  { value: 'fulfillment', label: 'Fulfillment' },
  { value: 'host', label: 'Host' },
];

// Pay owed for the current biweekly pay period — unchanged behaviour, extracted from the
// original EmployeesTab. Scoped to its OWN pay period (not the dashboard FiltersBar), with
// prev/next navigation. Reuses computePay's exact hours×rate math (open + skipped excluded).
export default function PayView({ employees }: { employees: Employee[] }) {
  const [periodOffset, setPeriodOffset] = useState(0);
  const [payRole, setPayRole] = useState<PayRole>('all');
  const payday = useMemo(() => paydayAtOffset(periodOffset), [periodOffset]);
  const period = useMemo(() => payPeriodFor(payday), [payday]);

  const { shifts: periodShifts } = useShifts(period.start, period.end);
  const { rules, exceptions } = useShiftRules();

  const periodMaterialized = useMemo(
    () => new Set(periodShifts.filter((s) => s.source_rule_id).map((s) => `${s.source_rule_id}|${s.date}`)),
    [periodShifts],
  );
  const periodGenerated = useMemo(
    () => generateRecurringShifts(rules, exceptions, period.start, period.end, periodMaterialized),
    [rules, exceptions, period.start, period.end, periodMaterialized],
  );
  const pay = useMemo(
    () => computePay(employees, [...periodShifts, ...periodGenerated.filter((g) => !g.skipped)]),
    [employees, periodShifts, periodGenerated],
  );
  // Role filter applied on the already-computed pay rows (no recompute — just narrows which
  // rows show). The period selector still drives the numbers.
  const filteredPay = useMemo(
    () => (payRole === 'all' ? pay : pay.filter((p) => p.employee.role?.toLowerCase() === payRole)),
    [pay, payRole],
  );
  const totals = useMemo(
    () => filteredPay.reduce((acc, p) => ({ hours: acc.hours + p.hours, pay: acc.pay + p.pay }), { hours: 0, pay: 0 }),
    [filteredPay],
  );

  return (
    <div className="bg-tt-card border border-tt-border rounded-[14px] backdrop-blur-xl overflow-hidden">
      <div className="px-6 py-5 border-b border-tt-border">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-tt-text">Pay owed — this pay period</h2>
            <p className="text-xs text-tt-muted mt-1 max-w-md">
              Hours &amp; pay for the current biweekly period only — not lifetime, and not a running
              balance. Independent of the dashboard date filter.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setPeriodOffset((o) => o - 1)}
              aria-label="Previous pay period"
              className="w-8 h-8 rounded-lg border border-tt-border text-tt-muted hover:bg-tt-card-hover hover:text-tt-text transition-colors cursor-pointer"
            >←</button>
            <div className="text-right min-w-[9.5rem]">
              <div className="text-[13px] font-semibold text-tt-text tabular-nums">
                {fmtMonthDay(period.start)} – {fmtMonthDay(period.end)}
              </div>
              <div className="text-[11px] text-tt-muted">Payday: {fmtPayDate(payday)}</div>
            </div>
            <button
              onClick={() => setPeriodOffset((o) => o + 1)}
              aria-label="Next pay period"
              className="w-8 h-8 rounded-lg border border-tt-border text-tt-muted hover:bg-tt-card-hover hover:text-tt-text transition-colors cursor-pointer"
            >→</button>
          </div>
        </div>
        {periodOffset !== 0 && (
          <button
            onClick={() => setPeriodOffset(0)}
            className="mt-2 text-[11px] text-tt-cyan hover:underline cursor-pointer"
          >
            ← Back to current period
          </button>
        )}
        {/* Role filter: narrows the payroll rows + totals below by employee role.
            Respects the pay period selected above. */}
        <div className="mt-4 flex items-center gap-2">
          <span className="text-[11px] text-tt-muted uppercase tracking-wide">View</span>
          <div className="flex gap-1 bg-white/5 rounded-lg p-0.5">
            {PAY_ROLE_OPTIONS.map(({ value, label }) => (
              <button
                key={value}
                onClick={() => setPayRole(value)}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                  payRole === value ? 'bg-white/10 text-tt-text' : 'text-tt-muted hover:text-tt-text'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-tt-border">
              <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Employee</th>
              <th className="text-left px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Role</th>
              <th className="text-right px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Hourly Rate</th>
              <th className="text-right px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Hours (period)</th>
              <th className="text-right px-5 py-3 text-[11px] text-tt-muted uppercase tracking-wide font-medium">Pay Owed (period)</th>
            </tr>
          </thead>
          <tbody>
            {filteredPay.map(({ employee, hours, pay: owed }) => (
              <tr key={employee.id} className="border-b border-[rgba(255,255,255,0.04)] hover:bg-tt-card-hover transition-colors">
                <td className="px-5 py-3 text-[13px] text-tt-text">{employee.name}</td>
                <td className="px-5 py-3 text-xs text-tt-muted">{titleCase(employee.role)}</td>
                <td className="px-5 py-3 text-[13px] text-tt-text text-right tabular-nums">{fmt(employee.hourly_rate)}</td>
                <td className="px-5 py-3 text-[13px] text-tt-text text-right tabular-nums">{fmtHours(hours)}</td>
                <td className="px-5 py-3 text-[13px] font-semibold text-tt-green text-right tabular-nums">{fmt(owed)}</td>
              </tr>
            ))}
            {filteredPay.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-12 text-center text-tt-muted text-sm">
                  {pay.length === 0
                    ? 'No employees yet'
                    : payRole === 'all'
                      ? 'No pay in this period'
                      : `No ${titleCase(payRole)} staff in this period`}
                </td>
              </tr>
            )}
          </tbody>
          {filteredPay.length > 0 && (
            <tfoot>
              <tr className="border-t border-tt-border">
                <td className="px-5 py-3 text-[13px] font-semibold text-tt-text" colSpan={3}>Total{payRole !== 'all' ? ` · ${titleCase(payRole)}` : ''} for {fmtMonthDay(period.start)} – {fmtMonthDay(period.end)}</td>
                <td className="px-5 py-3 text-[13px] font-semibold text-tt-text text-right tabular-nums">{fmtHours(totals.hours)}</td>
                <td className="px-5 py-3 text-[13px] font-semibold text-tt-green text-right tabular-nums">{fmt(totals.pay)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* Mobile card list — same rows + values as the desktop table above */}
      <div className="md:hidden p-4 flex flex-col gap-3">
        {filteredPay.map(({ employee, hours, pay: owed }) => (
          <MobileDataCard
            key={employee.id}
            title={employee.name}
            subtitle={titleCase(employee.role)}
            stats={[
              { label: 'Hourly Rate', value: fmt(employee.hourly_rate) },
              { label: 'Hours (period)', value: fmtHours(hours) },
              {
                label: 'Pay Owed (period)',
                value: <span className="text-tt-green font-semibold">{fmt(owed)}</span>,
                wide: true,
              },
            ]}
          />
        ))}
        {filteredPay.length === 0 && (
          <div className="px-1 py-12 text-center text-tt-muted text-sm">
            {pay.length === 0
              ? 'No employees yet'
              : payRole === 'all'
                ? 'No pay in this period'
                : `No ${titleCase(payRole)} staff in this period`}
          </div>
        )}
        {filteredPay.length > 0 && (
          <div className="rounded-2xl border border-tt-border bg-white/[0.03] p-4">
            <div className="text-[11px] uppercase tracking-wide text-tt-muted">
              Total{payRole !== 'all' ? ` · ${titleCase(payRole)}` : ''} for {fmtMonthDay(period.start)} – {fmtMonthDay(period.end)}
            </div>
            <div className="mt-2 flex items-center justify-between gap-4">
              <div>
                <div className="text-[11px] text-tt-muted">Hours</div>
                <div className="text-sm font-semibold text-tt-text tabular-nums">{fmtHours(totals.hours)}</div>
              </div>
              <div className="text-right">
                <div className="text-[11px] text-tt-muted">Pay owed</div>
                <div className="text-sm font-semibold text-tt-green tabular-nums">{fmt(totals.pay)}</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
