'use client';

import { useCallback, useMemo, useState } from 'react';
import { fmt } from '@/lib/calculations';
import {
  computePay,
  generateRecurringShifts,
  shiftHours,
  payPeriodFor,
  paydayAtOffset,
  fmtPayDate,
  fmtMonthDay,
} from '@/lib/employees';
import { buildPayStatement, type PayStatement } from '@/lib/pay/statement';
import { canDeleteRecord, deleteBlockedReasonFor } from '@/lib/pay/deleteEligibility';
import { indexWeekCards, type WeekShiftCard } from '@/lib/weeklySchedule';
import { useShifts } from '@/hooks/useShifts';
import { useShiftRules } from '@/hooks/useShiftRules';
import type { Employee } from '@/types';
import { fmtHours, titleCase } from './shared';
import PayGrid, { type PayTile } from './PayGrid';
import PayDetailModal from './PayDetailModal';
import OverlayLayer from './OverlayLayer';
import ShiftEditorModal, { type EditorIntent } from './weekly/ShiftEditorModal';
import { makeEditorHandlers } from './weekly/editorHandlers';

// Pay sub-tab role filter (ported from PR #69). 'all' = everyone (default); others match
// employees.role. Purely display — narrows which payroll rows show; no new calc/query.
type PayRole = 'all' | 'fulfillment' | 'host';
const PAY_ROLE_OPTIONS: { value: PayRole; label: string }[] = [
  { value: 'all', label: 'View all' },
  { value: 'fulfillment', label: 'Fulfillment' },
  { value: 'host', label: 'Host' },
];

/** Which person's detail is open, and the timestamp the statement/PDF is stamped with. Captured
 *  at OPEN time rather than during render, so nothing here reads a clock while rendering. */
interface DetailTarget {
  employee: Employee;
  generatedAtISO: string;
}

// Pay owed for the current biweekly pay period — unchanged behaviour, extracted from the
// original EmployeesTab. Scoped to its OWN pay period (not the dashboard FiltersBar), with
// prev/next navigation. Reuses computePay's exact hours×rate math (open + skipped excluded).
export default function PayView({ employees }: { employees: Employee[] }) {
  const [periodOffset, setPeriodOffset] = useState(0);
  const [payRole, setPayRole] = useState<PayRole>('all');
  const payday = useMemo(() => paydayAtOffset(periodOffset), [periodOffset]);
  const period = useMemo(() => payPeriodFor(payday), [payday]);

  // The period's rows, and the mutations the record editor saves through. Scoped to exactly the
  // pay period — the same query, and therefore the same computePay input, this tab has always used.
  const {
    shifts: periodShifts,
    addShift,
    updateShift,
    deleteShift,
  } = useShifts(period.start, period.end);
  const { rules, exceptions, upsertException } = useShiftRules();

  const periodMaterialized = useMemo(
    () => new Set(periodShifts.filter((s) => s.source_rule_id).map((s) => `${s.source_rule_id}|${s.date}`)),
    [periodShifts],
  );
  const periodGenerated = useMemo(
    () => generateRecurringShifts(rules, exceptions, period.start, period.end, periodMaterialized),
    [rules, exceptions, period.start, period.end, periodMaterialized],
  );
  // PUNCHES ARE TRUTH (Deploy C): pay is computed from real shifts ONLY (punch-derived +
  // manual corrections). Recurring PROJECTIONS are NOT a pay input — they're the plan, shown
  // separately below as "Scheduled". (Materialized recurring rows that happen to sit in
  // periodShifts are also excluded from pay by isPayableShift's source_rule_id guard.)
  const pay = useMemo(() => computePay(employees, periodShifts), [employees, periodShifts]);

  // Planned (scheduled) hours per employee from the recurring projection — DISPLAY ONLY, never
  // summed into pay. Lets the table show "Scheduled Xh · Paid Yh" so a gap (e.g. a forgotten
  // clock-out) is visible instead of silently paying the plan.
  const plannedHoursByEmployee = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of periodGenerated) {
      if (g.skipped) continue;
      m.set(g.employee_id, (m.get(g.employee_id) ?? 0) + shiftHours(g.start_time, g.end_time));
    }
    return m;
  }, [periodGenerated]);

  // ── Detail + editing ───────────────────────────────────────────────────────────────────────
  const [detail, setDetail] = useState<DetailTarget | null>(null);
  const [editorIntent, setEditorIntent] = useState<EditorIntent | null>(null);

  // THE STATEMENT IS BUILT ONCE, HERE, and handed to both the detail panel and (through it) the
  // PDF. Neither renders arithmetic of its own.
  const statement: PayStatement | null = useMemo(
    () =>
      detail
        ? buildPayStatement({
            employee: detail.employee,
            period: { start: period.start, end: period.end, payday },
            shifts: periodShifts,
            generatedAtISO: detail.generatedAtISO,
          })
        : null,
    [detail, period.start, period.end, payday, periodShifts],
  );

  // The editor's own card model, built by the SAME indexer the calendars use — never by hand, so
  // a Pay Details edit opens at the identical prefill (shiftEditPrefill) the calendar would.
  const cardById = useMemo(() => {
    const dates = new Set(periodShifts.map((s) => s.date));
    const m = new Map<string, WeekShiftCard>();
    for (const arr of indexWeekCards(periodShifts, [], dates).values()) {
      for (const c of arr) m.set(c.id, c);
    }
    return m;
  }, [periodShifts]);

  const nameById = useCallback(
    (id: string) => employees.find((e) => e.id === id)?.name ?? 'Unknown',
    [employees],
  );

  // The app's ONE shift-editor wiring. Saving goes through useShifts.updateShift →
  // buildShiftEditPatch, which is what decides whether a correction lands on the punch instants
  // or the wall clock — i.e. the Pay Details edit writes the exact interval payroll reads.
  const editorHandlers = useMemo(
    () => makeEditorHandlers({ employees, nameById, addShift, updateShift, deleteShift, upsertException }),
    [employees, nameById, addShift, updateShift, deleteShift, upsertException],
  );

  const canEdit = useCallback((shiftId: string) => cardById.has(shiftId), [cardById]);

  // Delete eligibility is one shared rule (lib/pay/deleteEligibility) with the schema evidence
  // behind it — manual rows only, because a deleted time-clock row is recreated by the reconciler.
  // The canonical delete, then a refetch: the statement is rebuilt from what the database says,
  // never from an optimistic guess about what the totals should now be.
  const handleDeleteRow = useCallback(
    async (shiftId: string) => {
      await deleteShift.mutateAsync(shiftId);
    },
    [deleteShift],
  );
  const openEditor = useCallback(
    (shiftId: string) => {
      const card = cardById.get(shiftId);
      if (card) setEditorIntent({ mode: 'card', card });
    },
    [cardById],
  );

  // Role filter applied on the already-computed pay rows (no recompute — just narrows which
  // rows show). The period selector still drives the numbers.
  const filteredPay = useMemo(
    () => (payRole === 'all' ? pay : pay.filter((p) => p.employee.role?.toLowerCase() === payRole)),
    [pay, payRole],
  );
  const tiles = useMemo<PayTile[]>(
    () => filteredPay.map((p) => ({
      employee: p.employee,
      hours: p.hours,
      pay: p.pay,
      scheduled: plannedHoursByEmployee.get(p.employee.id) ?? 0,
    })),
    [filteredPay, plannedHoursByEmployee],
  );
  const totals = useMemo(
    () =>
      filteredPay.reduce(
        (acc, p) => ({
          hours: acc.hours + p.hours,
          scheduled: acc.scheduled + (plannedHoursByEmployee.get(p.employee.id) ?? 0),
          pay: acc.pay + p.pay,
        }),
        { hours: 0, scheduled: 0, pay: 0 },
      ),
    [filteredPay, plannedHoursByEmployee],
  );

  return (
    <>
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
      {/* Totals lead. They are the number the pay run is actually built around, so they belong
          above the people rather than buried under 41 tiles. */}
      {tiles.length > 0 && (
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-tt-border px-6 py-4">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-tt-muted">
              Total{payRole !== 'all' ? ` · ${titleCase(payRole)}` : ''} for {fmtMonthDay(period.start)} – {fmtMonthDay(period.end)}
            </div>
            <div className="mt-1 text-3xl font-bold tabular-nums text-tt-green">{fmt(totals.pay)}</div>
          </div>
          <div className="flex gap-6 text-right">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-tt-muted">Paid hours</div>
              <div className="mt-1 text-lg font-semibold tabular-nums text-tt-text">{fmtHours(totals.hours)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-tt-muted">Scheduled</div>
              <div className="mt-1 text-lg font-semibold tabular-nums text-tt-muted">{fmtHours(totals.scheduled)}</div>
            </div>
          </div>
        </div>
      )}

      <PayGrid
        rows={tiles}
        fmt={fmt}
        fmtHours={fmtHours}
        onOpen={(t) => setDetail({ employee: t.employee, generatedAtISO: new Date().toISOString() })}
        emptyMessage={
          pay.length === 0
            ? 'No employees yet'
            : payRole === 'all'
              ? 'No pay in this period'
              : `No ${titleCase(payRole)} staff in this period`
        }
      />
    </div>

    {statement && (
      <PayDetailModal
        statement={statement}
        onClose={() => setDetail(null)}
        onEditRow={openEditor}
        canEdit={canEdit}
        onDeleteRow={handleDeleteRow}
        canDelete={canDeleteRecord}
        deleteBlockedReason={deleteBlockedReasonFor}
      />
    )}
    {/* THE EDITOR MUST BE A BODY-LEVEL LAYER ABOVE THE PANEL THAT OPENED IT.
        Rendered inline here it mounted and prefilled correctly but was painted underneath Pay
        Details — same z-50, and the panel is portalled to the end of <body> while this sits deep
        inside body's first child, so DOM order decided it. Clicking Edit looked like a dead
        button. OverlayLayer portals it out of the dashboard's filtered ancestors and puts it at
        z-60. Every other caller of ShiftEditorModal is untouched. */}
    {editorIntent && (
      <OverlayLayer>
        <ShiftEditorModal
          intent={editorIntent}
          handlers={editorHandlers}
          initialScreen="edit"
          onClose={() => setEditorIntent(null)}
        />
      </OverlayLayer>
    )}
    </>
  );
}
