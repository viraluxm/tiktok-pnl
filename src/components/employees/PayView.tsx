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

// Pay owed for the current biweekly pay period — unchanged behaviour, extracted from the
// original EmployeesTab. Scoped to its OWN pay period (not the dashboard FiltersBar), with
// prev/next navigation. Reuses computePay's exact hours×rate math (open + skipped excluded).
export default function PayView({ employees }: { employees: Employee[] }) {
  const [periodOffset, setPeriodOffset] = useState(0);
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
  const totals = useMemo(
    () => pay.reduce((acc, p) => ({ hours: acc.hours + p.hours, pay: acc.pay + p.pay }), { hours: 0, pay: 0 }),
    [pay],
  );

  return (
    <div className="bg-tt-card border border-tt-border rounded-[14px] backdrop-blur-xl overflow-hidden">
      <div className="px-6 py-5 border-b border-tt-border">
        <div className="flex items-start justify-between gap-4">
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
      </div>
      <div className="overflow-x-auto">
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
            {pay.map(({ employee, hours, pay: owed }) => (
              <tr key={employee.id} className="border-b border-[rgba(255,255,255,0.04)] hover:bg-tt-card-hover transition-colors">
                <td className="px-5 py-3 text-[13px] text-tt-text">{employee.name}</td>
                <td className="px-5 py-3 text-xs text-tt-muted">{titleCase(employee.role)}</td>
                <td className="px-5 py-3 text-[13px] text-tt-text text-right tabular-nums">{fmt(employee.hourly_rate)}</td>
                <td className="px-5 py-3 text-[13px] text-tt-text text-right tabular-nums">{fmtHours(hours)}</td>
                <td className="px-5 py-3 text-[13px] font-semibold text-tt-green text-right tabular-nums">{fmt(owed)}</td>
              </tr>
            ))}
            {pay.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-12 text-center text-tt-muted text-sm">No employees yet</td>
              </tr>
            )}
          </tbody>
          {pay.length > 0 && (
            <tfoot>
              <tr className="border-t border-tt-border">
                <td className="px-5 py-3 text-[13px] font-semibold text-tt-text" colSpan={3}>Total for {fmtMonthDay(period.start)} – {fmtMonthDay(period.end)}</td>
                <td className="px-5 py-3 text-[13px] font-semibold text-tt-text text-right tabular-nums">{fmtHours(totals.hours)}</td>
                <td className="px-5 py-3 text-[13px] font-semibold text-tt-green text-right tabular-nums">{fmt(totals.pay)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
