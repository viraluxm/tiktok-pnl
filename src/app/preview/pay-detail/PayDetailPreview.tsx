'use client';

import { useCallback, useMemo, useState } from 'react';
import { computePay } from '@/lib/employees';
import { buildPayStatement } from '@/lib/pay/statement';
import { buildShiftEditPatch, type EditableShiftRow } from '@/lib/shifts/punchEdit';
import { indexWeekCards, type WeekShiftCard } from '@/lib/weeklySchedule';
import { fmt } from '@/lib/calculations';
import { fmtHours, titleCase } from '@/components/employees/shared';
import PayGrid, { type PayTile } from '@/components/employees/PayGrid';
import PayDetailModal from '@/components/employees/PayDetailModal';
import ShiftEditorModal, { type EditorIntent, type EditorHandlers } from '@/components/employees/weekly/ShiftEditorModal';
import type { Employee, Shift } from '@/types';
import { PREVIEW_EMPLOYEES, PREVIEW_GENERATED_AT, PREVIEW_PERIOD, PREVIEW_SHIFTS } from './fixtures';

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
// ZERO DATABASE PATH: no Supabase client, no fetch, no RPC, no server action. Pinned by
// noWrites.test.mjs over this file's source.

export default function PayDetailPreview() {
  const [shifts, setShifts] = useState<Shift[]>(PREVIEW_SHIFTS);
  const [detail, setDetail] = useState<Employee | null>(null);
  const [editorIntent, setEditorIntent] = useState<EditorIntent | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const employees = PREVIEW_EMPLOYEES;
  const period = PREVIEW_PERIOD;

  const pay = useMemo(() => computePay(employees, shifts), [employees, shifts]);

  const statementFor = useCallback(
    (employee: Employee) =>
      buildPayStatement({ employee, period, shifts, generatedAtISO: PREVIEW_GENERATED_AT }),
    [period, shifts],
  );

  const tiles = useMemo<PayTile[]>(
    () =>
      pay.map((p) => ({
        employee: p.employee,
        hours: p.hours,
        pay: p.pay,
        scheduled: 0, // the recurring projection needs a rules query; not part of this review
        reviewCount: statementFor(p.employee).totals.reviewCount,
      })),
    [pay, statementFor],
  );

  const totals = useMemo(
    () => pay.reduce((a, p) => ({ hours: a.hours + p.hours, pay: a.pay + p.pay }), { hours: 0, pay: 0 }),
    [pay],
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
            The real Pay tiles, Pay Details panel, statement PDF and shift editor, running on
            fixture data shaped after the {period.start} – {period.end} period. Nothing here can
            reach the database. Click a person, then Edit a row and watch the totals and the PDF
            move together.
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

        <div className="mt-6 rounded-xl border border-tt-border px-4 py-3 text-[12px] leading-relaxed text-tt-muted">
          <div className="mb-1 font-semibold text-tt-text">What to look at</div>
          <ul className="list-disc space-y-0.5 pl-5">
            <li><span className="text-tt-text">{titleCase('Juan Reyes')}</span> — overlapping worked time, an unusually long span, an unconfirmed punch and a scheduled-only day.</li>
            <li><span className="text-tt-text">Adriana Salas</span> — an overnight shift whose end lands on the next day, plus one overlap.</li>
            <li><span className="text-tt-text">Chris Okafor</span> — an open clock-in that is deliberately not paid.</li>
            <li><span className="text-tt-text">Haley Nguyen</span> — the ordinary, clean case.</li>
            <li><span className="text-tt-text">Marcus Bell</span> — nothing but an unconfirmed punch, so zero owed.</li>
            <li><span className="text-tt-text">Devon Clarke</span> — real hours at a $0 rate.</li>
          </ul>
        </div>
      </div>

      {statement && (
        <PayDetailModal
          statement={statement}
          onClose={() => setDetail(null)}
          onEditRow={openEditor}
          canEdit={(id) => cardById.has(id)}
        />
      )}
      {editorIntent && (
        <ShiftEditorModal
          intent={editorIntent}
          handlers={handlers}
          initialScreen="edit"
          onClose={() => setEditorIntent(null)}
        />
      )}
    </div>
  );
}

// Local-only timestamp for the "Saved" confirmation. Not part of any statement — the statement's
// own generated-at is the fixed PREVIEW_GENERATED_AT, so the PDF stays deterministic.
function nowLabel(): string {
  return new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}
