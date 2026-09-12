'use client';

import { useCallback, useMemo, useState } from 'react';
import { computePay } from '@/lib/employees';
import { bonusSummaryFor, buildPayStatement, totalOwedOf } from '@/lib/pay/statement';
import { canDeleteRecord, deleteBlockedReasonFor } from '@/lib/pay/deleteEligibility';
import { buildShiftEditPatch, type EditableShiftRow } from '@/lib/shifts/punchEdit';
import { indexWeekCards, type WeekShiftCard } from '@/lib/weeklySchedule';
import { fmt } from '@/lib/calculations';
import { fmtHours } from '@/components/employees/shared';
import PayGrid, { type PayTile } from '@/components/employees/PayGrid';
import PayDetailModal from '@/components/employees/PayDetailModal';
import OverlayLayer from '@/components/employees/OverlayLayer';
import ShiftEditorModal, { type EditorIntent, type EditorHandlers } from '@/components/employees/weekly/ShiftEditorModal';
import type { Employee, PayAdjustment, Shift } from '@/types';
import {
  PREVIEW_ADJUSTMENTS,
  PREVIEW_EMPLOYEES,
  PREVIEW_GENERATED_AT,
  PREVIEW_PERIOD,
  PREVIEW_SHIFTS,
} from './fixtures';

// THE REAL Pay Detail UI, over local state.
//
// PayGrid, PayDetailModal, ShiftEditorModal, buildPayStatement, computePay and buildShiftEditPatch
// are all the production modules — there is no fork here, so what is approved on this page is what
// ships. Only the DATA is local: an in-memory array of `shifts` rows instead of a Supabase query.
//
// EDITING IS REAL TOO, minus the round trip. Save runs the row through the same
// buildShiftEditPatch that useShifts.updateShift uses, applies the resulting patch to the
// in-memory row exactly as Postgres would apply it, and rebuilds the statement from that. So the
// thing this page demonstrates — that a correction moves the interval payroll reads — is
// demonstrated by the real code path, not by a mock that agrees with itself.
//
// BONUSES ARE REAL HERE TOO, in the same sense. Add / Edit / Delete run against an in-memory array
// of `employee_pay_adjustments` rows, and the statement is then rebuilt by the production
// buildPayStatement from that array — so the line items, the bonus subtotal, the tile's total owed
// and the PDF all come from the shipping model, not from a preview that agrees with itself.
//
// ZERO DATABASE PATH: no Supabase client, no fetch, no RPC, no server action. Pinned by
// noWrites.test.mjs over this file's source.

export default function PayDetailPreview() {
  const [shifts, setShifts] = useState<Shift[]>(PREVIEW_SHIFTS);
  const [adjustments, setAdjustments] = useState<PayAdjustment[]>(PREVIEW_ADJUSTMENTS);
  const [detail, setDetail] = useState<Employee | null>(null);
  const [editorIntent, setEditorIntent] = useState<EditorIntent | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const employees = PREVIEW_EMPLOYEES;
  const period = PREVIEW_PERIOD;

  const pay = useMemo(() => computePay(employees, shifts), [employees, shifts]);

  const statementFor = useCallback(
    (employee: Employee) =>
      buildPayStatement({ employee, period, shifts, adjustments, generatedAtISO: PREVIEW_GENERATED_AT }),
    [period, shifts, adjustments],
  );

  // The same two shared functions production's Pay tab calls — bonusSummaryFor to select and sum,
  // totalOwedOf to add. Nothing here works out a bonus of its own.
  const tiles = useMemo<PayTile[]>(
    () =>
      pay.map((p) => {
        const bonus = bonusSummaryFor(adjustments, p.employee.id, period);
        return {
          employee: p.employee,
          hours: p.hours,
          bonusTotal: bonus.total,
          totalOwed: totalOwedOf(p.pay, bonus.total),
          scheduled: 0, // the recurring projection needs a rules query; not part of this review
        };
      }),
    [pay, adjustments, period],
  );

  const totals = useMemo(
    () =>
      tiles.reduce(
        (a, t) => ({ hours: a.hours + t.hours, pay: a.pay + t.totalOwed, bonus: a.bonus + t.bonusTotal }),
        { hours: 0, pay: 0, bonus: 0 },
      ),
    [tiles],
  );

  const cardById = useMemo(() => {
    const dates = new Set(shifts.map((s) => s.date));
    const m = new Map<string, WeekShiftCard>();
    for (const arr of indexWeekCards(shifts, [], dates).values()) for (const c of arr) m.set(c.id, c);
    return m;
  }, [shifts]);

  const handlers = useMemo<EditorHandlers>(
    () => ({
      employees,
      nameById: (id) => employees.find((e) => e.id === id)?.name ?? 'Unknown',
      // The production save path, with the network removed: the same patch builder, and the patch
      // applied to the row the way an UPDATE would apply it.
      onUpdate: async (id, edit) => {
        setShifts((rows) =>
          rows.map((r) => {
            if (r.id !== id) return r;
            const patch = buildShiftEditPatch(r as EditableShiftRow, edit);
            return patch === null ? r : ({ ...r, ...patch } as Shift);
          }),
        );
        setSaved(`Saved — totals rebuilt from the corrected record at ${nowLabel()}`);
      },
      onCreate: async () => { setSaved('Creating is out of scope for this review.'); },
      onDeleteOneOff: async (id) => {
        setShifts((rows) => rows.filter((r) => r.id !== id));
        setSaved('Record removed — totals rebuilt.');
      },
      onModifyOccurrence: async () => { setSaved('Recurring days are not payable and are not editable here.'); },
      onSkipOccurrence: async () => { setSaved('Recurring days are not payable and are not editable here.'); },
    }),
    [employees],
  );

  // The same shared eligibility rule production uses — manual rows only.
  const handleDeleteRow = useCallback(async (shiftId: string) => {
    setShifts((rows) => rows.filter((r) => r.id !== shiftId));
    setSaved('Record deleted — totals rebuilt.');
  }, []);

  // THE BONUS WRITE PATH, with the network removed. Each handler edits the in-memory row array
  // exactly as Postgres would edit the table, and the statement is rebuilt from the result — the
  // same "save, then read it back" shape production has, minus the round trip.
  const bonusHandlers = useMemo(
    () => (detail ? {
      onAdd: async ({ amountCents, description }: { amountCents: number; description: string | null }) => {
        const now = new Date().toISOString();
        setAdjustments((rows) => [
          ...rows,
          {
            id: `pv-b-${rows.length + 1}-${now}`,
            user_id: 'preview-owner',
            employee_id: detail.id,
            period_start: period.start,
            period_end: period.end,
            kind: 'bonus' as const,
            amount_cents: amountCents,
            description,
            created_at: now,
            updated_at: now,
          },
        ]);
        setSaved('Bonus added — total owed rebuilt from the statement.');
      },
      onEdit: async (id: string, { amountCents, description }: { amountCents: number; description: string | null }) => {
        setAdjustments((rows) =>
          rows.map((r) =>
            r.id === id
              ? { ...r, amount_cents: amountCents, description, updated_at: new Date().toISOString() }
              : r,
          ),
        );
        setSaved('Bonus updated — total owed rebuilt from the statement.');
      },
      onDelete: async (id: string) => {
        setAdjustments((rows) => rows.filter((r) => r.id !== id));
        setSaved('Bonus removed — worked time untouched, total owed rebuilt.');
      },
    } : undefined),
    [detail, period.start, period.end],
  );

  const openEditor = useCallback(
    (shiftId: string) => {
      const card = cardById.get(shiftId);
      if (card) setEditorIntent({ mode: 'card', card });
    },
    [cardById],
  );

  const statement = detail ? statementFor(detail) : null;

  return (
    <div className="min-h-dvh bg-tt-bg px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-6xl">
        <header className="mb-6">
          <h1 className="text-xl font-semibold text-tt-text">Pay Period Detail — review</h1>
          <p className="mt-1 max-w-2xl text-sm text-tt-muted">
            The real Pay tiles, Pay Details panel, payroll hours statement and record editor,
            running on fixture data shaped after the {period.start} – {period.end} period. Nothing
            here can reach the database. Click a person, then Edit a record and watch the day
            total, the period total and the PDF move together. Then open Carlos Herrera and use
            <strong className="font-semibold text-tt-text"> + Add Bonus</strong> — 72.50 hr at
            $22.00 is $1,595.00 of worked pay, and his two bonuses take the total owed to $1,745.00
            on the tile, in Pay Details and on the PDF.
          </p>
        </header>

        {saved && (
          <div className="mb-4 rounded-xl border border-tt-green/25 bg-tt-green/[0.06] px-4 py-2.5 text-[12.5px] text-tt-green">
            {saved}
          </div>
        )}

        <div className="overflow-hidden rounded-[14px] border border-tt-border bg-tt-card backdrop-blur-xl">
          <div className="flex flex-wrap items-end justify-between gap-4 border-b border-tt-border px-6 py-4">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-tt-muted">
                Total for {period.start} – {period.end}
              </div>
              <div className="mt-1 text-3xl font-bold tabular-nums text-tt-green">{fmt(totals.pay)}</div>
              {totals.bonus > 0 && (
                <div className="mt-0.5 text-[11px] tabular-nums text-tt-muted">
                  includes {fmt(totals.bonus)} in bonuses
                </div>
              )}
            </div>
            <div className="text-right">
              <div className="text-[11px] uppercase tracking-wide text-tt-muted">Paid hours</div>
              <div className="mt-1 text-lg font-semibold tabular-nums text-tt-text">{fmtHours(totals.hours)}</div>
            </div>
          </div>

          <PayGrid
            rows={tiles}
            fmt={fmt}
            fmtHours={fmtHours}
            onOpen={(t) => setDetail(t.employee)}
            emptyMessage="No pay in this period"
          />
        </div>

      </div>

      {statement && (
        <PayDetailModal
          statement={statement}
          onClose={() => setDetail(null)}
          onEditRow={openEditor}
          canEdit={(id) => cardById.has(id)}
          onDeleteRow={handleDeleteRow}
          canDelete={canDeleteRecord}
          deleteBlockedReason={deleteBlockedReasonFor}
          bonus={bonusHandlers}
        />
      )}
      {/* Same body-level layering as production — this is the fix under review. */}
      {editorIntent && (
        <OverlayLayer>
          <ShiftEditorModal
            intent={editorIntent}
            handlers={handlers}
            initialScreen="edit"
            onClose={() => setEditorIntent(null)}
          />
        </OverlayLayer>
      )}
    </div>
  );
}

// Local-only timestamp for the "Saved" confirmation. Not part of any statement — the statement's
// own generated-at is the fixed PREVIEW_GENERATED_AT, so the PDF stays deterministic.
function nowLabel(): string {
  return new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}
