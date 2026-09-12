'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  formatBreak,
  formatClock12,
  formatDayLabel,
  payPeriodWeeks,
  payStatementFilename,
  type DayGroup,
  type ExcludedRow,
  type PayStatement,
  type PeriodWeek,
  type StatementRow,
} from '@/lib/pay/statement';
import type { BonusItem } from '@/lib/pay/statement';
import { formatPeriodRange } from '@/lib/pay/statementPdf';
import { fmt } from '@/lib/calculations';
import { fmtHours, titleCase } from './shared';
import OverlayLayer from './OverlayLayer';
import PersonAvatar from './weekly/PersonAvatar';
import {
  AddBonusButton,
  BonusDeleteConfirm,
  BonusFormModal,
  BonusSection,
  type BonusDraft,
  type BonusHandlers,
} from './BonusPanel';

// ONE PERSON'S PAY PERIOD, LAID OUT THE WAY THE PRINTED STATEMENT READS IT: Week 1 then Week 2,
// every calendar day present, so a manager can scan the whole fortnight top to bottom and see the
// shape of it — including the days nobody worked, which are information, not omissions.
//
// It RENDERS a PayStatement and computes nothing. Hours, rates, amounts, day totals and week
// subtotals all come from payPeriodWeeks(), the same grouping the PDF reads, so the screen and the
// document cannot drift apart. There is no arithmetic in this file.
//
// IT DOES NOT JUDGE THE RECORDS. No anomaly badge, no warning colour, no "needs review". Two
// records on one day simply sit together under that day, which is what makes a duplicate obvious
// without anything having to say so.
//
// BONUS PAY IS SHOWN AS WHAT IT IS: a separate section of its own line items, under the worked
// time and before the total, never mixed into a day, a week or an hours column. `bonusItems` and
// `totals.bonusTotal` / `totals.totalOwed` are read off the same statement everything else here is
// read off, so the panel still contains no arithmetic — the bonus feature did not add any, and an
// HOURLY bonus did not either: its rate x hours was done in the model, and this file prints the
// result and the working side by side.

// Desktop column template, shared by the header and every row so the whole period lines up as one
// table. Mobile drops to labelled cells inside a per-day card.
const COLS =
  'sm:grid-cols-[8.5rem_5.5rem_9.5rem_4rem_4.5rem_4.5rem_5.5rem_auto] sm:items-center';
const ROW = `grid grid-cols-2 gap-x-3 gap-y-1 ${COLS} sm:gap-y-0`;

function Cell({
  label,
  children,
  right,
  muted,
}: {
  label: string;
  children: React.ReactNode;
  right?: boolean;
  muted?: boolean;
}) {
  return (
    <div className={right ? 'sm:text-right' : ''}>
      <div className="text-[9px] uppercase tracking-wide text-tt-muted sm:hidden">{label}</div>
      <div className={`text-[12.5px] tabular-nums ${muted ? 'text-tt-muted' : 'text-tt-text'}`}>{children}</div>
    </div>
  );
}

/** '2:00 AM' plus, when the shift ran past midnight, the day it actually ended on — stated, not
 *  tucked into faint parentheses, because that date is how you tell 9 hours from 33. */
function EndTime({ row }: { row: StatementRow }) {
  return (
    <span>
      {formatClock12(row.endLabel)}
      {row.endDateISO && (
        <span className="block text-[10.5px] font-medium text-tt-cyan/80 sm:inline sm:before:content-['·_']">
          {formatDayLabel(row.endDateISO)}
        </span>
      )}
    </span>
  );
}

function RecordRow({
  row,
  dateCell,
  onEdit,
  onDelete,
  deleteBlockedReason,
}: {
  row: StatementRow;
  /** The day label, rendered only on a day's FIRST record so repeats read as one day. */
  dateCell: React.ReactNode;
  onEdit?: () => void;
  onDelete?: () => void;
  deleteBlockedReason?: string;
}) {
  return (
    <div className={`${ROW} px-3 py-2`}>
      <div className="col-span-2 sm:col-span-1">
        {dateCell}
        <div className="text-[10px] text-tt-muted">{row.sourceLabel}</div>
      </div>
      <Cell label="Clock in">{formatClock12(row.startLabel)}</Cell>
      <Cell label="Clock out"><EndTime row={row} /></Cell>
      <Cell label="Break" right muted={row.breakMinutes === 0}>{formatBreak(row.breakMinutes)}</Cell>
      <Cell label="Hours" right>{row.paidHours.toFixed(2)}</Cell>
      <Cell label="Rate" right muted>{fmt(row.rate)}</Cell>
      <Cell label="Pay" right>
        <span className="font-semibold text-tt-green">{fmt(row.amount)}</span>
      </Cell>
      <div className="col-span-2 flex gap-1.5 sm:col-span-1 sm:justify-self-end">
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            className="min-h-[30px] flex-1 rounded-lg border border-tt-border px-2.5 text-[11px] font-semibold text-tt-cyan transition-colors hover:bg-tt-cyan/10 sm:flex-none"
          >
            Edit
          </button>
        )}
        {onDelete ? (
          <button
            type="button"
            onClick={onDelete}
            className="min-h-[30px] flex-1 rounded-lg border border-tt-border px-2.5 text-[11px] font-semibold text-tt-red transition-colors hover:bg-tt-red/10 sm:flex-none"
          >
            Delete
          </button>
        ) : (
          deleteBlockedReason && (
            <span
              title={deleteBlockedReason}
              className="min-h-[30px] flex-1 cursor-help rounded-lg border border-dashed border-tt-border px-2.5 text-center text-[11px] font-semibold leading-[30px] text-tt-muted/50 sm:flex-none"
            >
              Delete
            </span>
          )
        )}
      </div>
    </div>
  );
}

/** A day nobody worked. Quiet, but present — the gap is the point. */
function OffRow({ day }: { day: DayGroup }) {
  return (
    <div className={`${ROW} px-3 py-2 opacity-60`}>
      <div className="col-span-2 sm:col-span-1">
        <div className="text-[12.5px] font-semibold text-tt-muted">{formatDayLabel(day.dateISO)}</div>
      </div>
      <div className="col-span-2 text-[12.5px] text-tt-muted sm:col-span-2">Off</div>
      <Cell label="Break" right muted>—</Cell>
      <Cell label="Hours" right muted>0.00</Cell>
      <Cell label="Rate" right muted>—</Cell>
      <Cell label="Pay" right muted>{fmt(0)}</Cell>
      <div className="hidden sm:block" />
    </div>
  );
}

function Week({
  week,
  canEdit,
  onEditRow,
  canDelete,
  onDeleteRow,
  deleteBlockedReason,
}: {
  week: PeriodWeek;
  canEdit: (id: string) => boolean;
  onEditRow?: (id: string) => void;
  canDelete: (row: StatementRow) => boolean;
  onDeleteRow?: (row: StatementRow) => void;
  deleteBlockedReason: (row: StatementRow) => string | undefined;
}) {
  return (
    <section className="mb-5">
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <h4 className="text-[11px] font-bold uppercase tracking-wider text-tt-text">
          Week {week.index}
          <span className="ml-2 font-normal normal-case tracking-normal text-tt-muted">
            {formatPeriodRange(week.start, week.end)}
          </span>
        </h4>
      </div>

      <div className={`${ROW} hidden px-3 pb-1 text-[9px] font-bold uppercase tracking-wider text-tt-muted sm:grid`}>
        <div>Day / Date</div>
        <div>Clock In</div>
        <div>Clock Out</div>
        <div className="text-right">Break</div>
        <div className="text-right">Hours</div>
        <div className="text-right">Rate</div>
        <div className="text-right">Pay</div>
        <div />
      </div>

      <div className="space-y-1">
        {week.days.map((day) =>
          day.rows.length === 0 ? (
            <div key={day.dateISO} className="rounded-lg border border-tt-border/50">
              <OffRow day={day} />
            </div>
          ) : (
            // One block per day. Several records share the block, so a doubled-up day reads as one
            // day with two lines rather than two unrelated cards.
            <div key={day.dateISO} className="divide-y divide-tt-border/40 rounded-lg border border-tt-border">
              {day.rows.map((row, i) => (
                <RecordRow
                  key={row.shiftId}
                  row={row}
                  dateCell={
                    i === 0 ? (
                      <div className="text-[12.5px] font-semibold text-tt-text">
                        {formatDayLabel(day.dateISO)}
                        {day.rows.length > 1 && (
                          <span className="ml-1.5 text-[10px] font-normal text-tt-muted">
                            {day.rows.length} records
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="hidden text-[12.5px] sm:block" aria-hidden />
                    )
                  }
                  onEdit={onEditRow && canEdit(row.shiftId) ? () => onEditRow(row.shiftId) : undefined}
                  onDelete={onDeleteRow && canDelete(row) ? () => onDeleteRow(row) : undefined}
                  deleteBlockedReason={deleteBlockedReason(row)}
                />
              ))}
            </div>
          ),
        )}
      </div>

      {/* Straight off week.hours / week.amount — never re-added here. */}
      <div className="mt-1.5 flex items-center justify-between rounded-lg bg-white/[0.03] px-3 py-2">
        <span className="text-[11.5px] font-bold uppercase tracking-wider text-tt-muted">
          Week {week.index} Total
        </span>
        <span className="flex items-baseline gap-5">
          <span className="text-[12.5px] font-bold tabular-nums text-tt-text">{week.hours.toFixed(2)} hr</span>
          <span className="text-[13px] font-bold tabular-nums text-tt-green">{fmt(week.amount)}</span>
        </span>
      </div>
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'money' }) {
  return (
    <div>
      <div className="text-[9.5px] font-bold uppercase tracking-wider text-tt-muted">{label}</div>
      <div
        className={`mt-0.5 font-bold tabular-nums ${
          tone === 'money' ? 'text-[22px] text-tt-green' : 'text-[15px] text-tt-text'
        }`}
      >
        {value}
      </div>
    </div>
  );
}

export default function PayDetailModal({
  statement,
  onClose,
  onEditRow,
  canEdit,
  onDeleteRow,
  canDelete,
  deleteBlockedReason,
  bonus,
}: {
  statement: PayStatement;
  onClose: () => void;
  /** Opens the app's existing shift editor for this record. */
  onEditRow?: (shiftId: string) => void;
  canEdit: (shiftId: string) => boolean;
  /** Runs the canonical delete for this record, after the manager confirms. */
  onDeleteRow?: (shiftId: string) => Promise<void>;
  canDelete: (row: StatementRow) => boolean;
  /** Why Delete is unavailable on a record, shown on the disabled control. */
  deleteBlockedReason: (row: StatementRow) => string | undefined;
  /**
   * Bonus writes, all three of which go through the caller's canonical database path and are
   * followed by a refetch. Omitted → bonuses still DISPLAY, they just cannot be changed here.
   */
  bonus?: BonusHandlers;
}) {
  const [busy, setBusy] = useState<null | 'download' | 'print'>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<StatementRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Bonus UI state. `bonusForm` is 'add' or the item being edited; one piece of state for both,
  // because they are the same two fields over the same write path.
  const [bonusForm, setBonusForm] = useState<'add' | BonusItem | null>(null);
  const [bonusDelete, setBonusDelete] = useState<BonusItem | null>(null);
  const [bonusBusy, setBonusBusy] = useState(false);
  const [bonusError, setBonusError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  // Object URLs are revoked on unmount rather than straight after the click: Safari can still be
  // reading the blob when a synchronous revoke lands, which shows as an empty print window.
  const urls = useRef<string[]>([]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(
    () => () => {
      for (const u of urls.current) URL.revokeObjectURL(u);
    },
    [],
  );

  async function buildBlobUrl(): Promise<string> {
    const { renderPayStatementPdf } = await import('@/lib/pay/statementPdf');
    const bytes = await renderPayStatementPdf(statement);
    const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    urls.current.push(url);
    return url;
  }

  async function handleDownload() {
    setBusy('download');
    setDocError(null);
    try {
      const url = await buildBlobUrl();
      const a = document.createElement('a');
      a.href = url;
      a.download = payStatementFilename(statement);
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      setDocError('Could not build the PDF. Try again.');
    } finally {
      setBusy(null);
    }
  }

  async function handlePrint() {
    setBusy('print');
    setDocError(null);
    try {
      const url = await buildBlobUrl();
      const w = window.open(url, '_blank');
      if (!w) setDocError('Your browser blocked the print window. Allow pop-ups, or download instead.');
    } catch {
      setDocError('Could not build the PDF. Try again.');
    } finally {
      setBusy(null);
    }
  }

  async function runDelete() {
    if (!confirmDelete || !onDeleteRow) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDeleteRow(confirmDelete.shiftId);
      setConfirmDelete(null);
    } catch {
      setDeleteError('Could not delete that record. Try again.');
    } finally {
      setDeleting(false);
    }
  }

  // SAVE, THEN LET THE DATA COME BACK. Neither of these touches a total locally: the caller's
  // mutation refetches and the whole statement is rebuilt from what the database holds, so a write
  // that failed can never leave a number on screen that nobody owes.
  async function submitBonus(input: BonusDraft) {
    if (!bonus || bonusForm === null) return;
    setBonusBusy(true);
    setBonusError(null);
    try {
      if (bonusForm === 'add') await bonus.onAdd(input);
      else await bonus.onEdit(bonusForm.id, input);
      setBonusForm(null);
    } catch (e) {
      setBonusError(e instanceof Error ? e.message : 'Could not save that bonus. Try again.');
    } finally {
      setBonusBusy(false);
    }
  }

  async function runBonusDelete() {
    if (!bonus || !bonusDelete) return;
    setBonusBusy(true);
    setBonusError(null);
    try {
      await bonus.onDelete(bonusDelete.id);
      setBonusDelete(null);
    } catch (e) {
      setBonusError(e instanceof Error ? e.message : 'Could not delete that bonus. Try again.');
    } finally {
      setBonusBusy(false);
    }
  }

  const weeks = useMemo(() => payPeriodWeeks(statement), [statement]);
  const hasBonus = statement.bonusItems.length > 0;
  // Every calendar day of the period, in order — taken from the SAME week grouping rendered above,
  // so the day list a manager picks from is exactly the day list they are looking at.
  const periodDays = useMemo(() => weeks.flatMap((w) => w.days.map((d) => d.dateISO)), [weeks]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm sm:p-8"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Pay details for ${statement.employee.name}`}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-5xl rounded-[16px] border border-tt-border bg-tt-card p-5 shadow-2xl backdrop-blur-xl"
      >
        {/* ── Header ─────────────────────────────────────────────────────────── */}
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <PersonAvatar name={statement.employee.name} state="confirmed" size="lg" />
            <div>
              <h3 className="text-base font-semibold text-tt-text">{statement.employee.name}</h3>
              <p className="text-xs text-tt-muted">{titleCase(statement.employee.role || '—')}</p>
              <p className="text-xs text-tt-muted">
                {formatPeriodRange(statement.period.start, statement.period.end)}
              </p>
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="h-8 w-8 shrink-0 rounded-lg border border-tt-border text-tt-muted transition-colors hover:bg-tt-card-hover hover:text-tt-text"
          >
            ✕
          </button>
        </div>

        {/* ── One compact summary row ────────────────────────────────────────── */}
        <div className="mb-5 flex flex-wrap items-end justify-between gap-x-8 gap-y-3 border-y border-tt-border py-3">
          <div className="flex flex-wrap gap-x-8 gap-y-3">
            {/* THE HEADLINE IS WHAT IS OWED — worked pay plus bonuses. With no bonuses
                totals.totalOwed IS totals.gross, so this reads exactly as it always has. */}
            <Stat label="Total owed" value={fmt(statement.totals.totalOwed)} tone="money" />
            {/* The two components appear only when there is something to split. A permanent
                "Bonus pay $0.00" on every statement is clutter on the 95% that have none. */}
            {hasBonus && <Stat label="Hourly pay" value={fmt(statement.totals.gross)} />}
            {hasBonus && <Stat label="Bonus pay" value={fmt(statement.totals.bonusTotal)} />}
            <Stat label="Payable hours" value={fmtHours(statement.totals.paidHours)} />
            <Stat label="Rate" value={`${fmt(statement.rate)}/hr`} />
            <Stat label="Worked days" value={String(statement.totals.workedDays)} />
          </div>
          <div className="flex items-center gap-2">
            {bonus && (
              <AddBonusButton
                onClick={() => { setBonusError(null); setBonusForm('add'); }}
              />
            )}
            <button
              type="button"
              onClick={handlePrint}
              disabled={busy !== null}
              className="min-h-[34px] rounded-xl border border-tt-border px-3.5 text-xs font-semibold text-tt-text transition-colors hover:bg-tt-card-hover disabled:opacity-50"
            >
              {busy === 'print' ? 'Preparing…' : 'Print'}
            </button>
            <button
              type="button"
              onClick={handleDownload}
              disabled={busy !== null}
              className="min-h-[34px] rounded-xl bg-tt-cyan px-3.5 text-xs font-semibold text-black transition-colors hover:bg-tt-cyan/90 disabled:opacity-50"
            >
              {busy === 'download' ? 'Building…' : 'Download PDF'}
            </button>
          </div>
        </div>
        {docError && <p className="-mt-3 mb-4 text-xs text-tt-red">{docError}</p>}

        {/* ── Week 1, then Week 2 ────────────────────────────────────────────── */}
        {weeks.map((week) => (
          <Week
            key={week.index}
            week={week}
            canEdit={canEdit}
            onEditRow={onEditRow}
            canDelete={canDelete}
            onDeleteRow={onDeleteRow ? (row) => { setDeleteError(null); setConfirmDelete(row); } : undefined}
            deleteBlockedReason={deleteBlockedReason}
          />
        ))}

        {/* BONUSES & INCENTIVES — after the worked time, before the total, and absent entirely
            when there are none. Its line items and its subtotal both come off the statement. */}
        <BonusSection
          items={statement.bonusItems}
          bonusTotal={statement.totals.bonusTotal}
          onEditItem={bonus ? (item) => { setBonusError(null); setBonusForm(item); } : undefined}
          onDeleteItem={bonus ? (item) => { setBonusError(null); setBonusDelete(item); } : undefined}
        />

        {/* Period total, read off statement.totals — never re-added from the weeks or the bonuses
            above. When there are bonuses the two components are broken out on their own lines so
            the final figure shows its working; when there are none this is the row it always was. */}
        <div className="rounded-xl border border-tt-border bg-white/[0.03] px-4 py-3">
          {hasBonus && (
            <>
              <div className="flex items-center justify-between pb-2">
                <span className="text-[12.5px] text-tt-muted">Hourly pay</span>
                <span className="flex items-baseline gap-5">
                  <span className="text-[12.5px] tabular-nums text-tt-muted">
                    {statement.totals.paidHours.toFixed(2)} hr
                  </span>
                  <span className="text-[13px] font-semibold tabular-nums text-tt-text">
                    {fmt(statement.totals.gross)}
                  </span>
                </span>
              </div>
              <div className="flex items-center justify-between border-b border-tt-border pb-2">
                <span className="text-[12.5px] text-tt-muted">Bonus pay</span>
                <span className="text-[13px] font-semibold tabular-nums text-tt-text">
                  {fmt(statement.totals.bonusTotal)}
                </span>
              </div>
            </>
          )}
          <div className={`flex items-center justify-between ${hasBonus ? 'pt-2' : ''}`}>
            <span className="text-[13px] font-bold text-tt-text">Total owed</span>
            <span className="flex items-baseline gap-5">
              {!hasBonus && (
                <span className="text-[13px] font-bold tabular-nums text-tt-text">
                  {statement.totals.paidHours.toFixed(2)} hr
                </span>
              )}
              <span className="text-[15px] font-bold tabular-nums text-tt-green">
                {fmt(statement.totals.totalOwed)}
              </span>
            </span>
          </div>
        </div>

        <p className="mt-4 text-[10.5px] leading-relaxed text-tt-muted">
          Hours and pay for this period only — not lifetime, and not a running balance. Amounts are
          gross; no deductions are applied.
        </p>

        {/* ── Not paid, folded away, last ────────────────────────────────────── */}
        {statement.excluded.length > 0 && <NotPaid rows={statement.excluded} />}
      </div>

      {confirmDelete && (
        <DeleteConfirm
          employeeName={statement.employee.name}
          row={confirmDelete}
          busy={deleting}
          error={deleteError}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={runDelete}
        />
      )}

      {/* Both bonus dialogs go through OverlayLayer (inside BonusPanel) for the same reason the
          worked-time one does: this panel is portalled to <body> at z-50, so anything it opens has
          to leave the subtree and sit above it or it mounts correctly and is painted underneath. */}
      {bonus && bonusForm !== null && (
        <BonusFormModal
          // Remounts between add and edit, so the form always opens on the right values rather
          // than keeping the last ones in state.
          key={bonusForm === 'add' ? 'add' : bonusForm.id}
          employeeName={statement.employee.name}
          periodLabel={formatPeriodRange(statement.period.start, statement.period.end)}
          // The period's own days, and each day's payable hours — so the form can require a day,
          // offer only days this cheque pays, and show what the rate will be multiplied by. The
          // form never multiplies anything: buildPayStatement does, on the way back.
          periodDays={periodDays}
          paidHoursByDate={statement.totals.paidHoursByDate}
          editing={bonusForm === 'add' ? null : bonusForm}
          busy={bonusBusy}
          error={bonusError}
          onCancel={() => { setBonusForm(null); setBonusError(null); }}
          onSubmit={submitBonus}
        />
      )}
      {bonus && bonusDelete && (
        <BonusDeleteConfirm
          employeeName={statement.employee.name}
          item={bonusDelete}
          busy={bonusBusy}
          error={bonusError}
          onCancel={() => { setBonusDelete(null); setBonusError(null); }}
          onConfirm={runBonusDelete}
        />
      )}
    </div>,
    document.body,
  );
}

// Deleting worked time takes money off someone's cheque, so the dialog restates exactly which
// record is going and what it is worth before anyone can confirm it.
function DeleteConfirm({
  employeeName,
  row,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  employeeName: string;
  row: StatementRow;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <OverlayLayer>
      <div className="fixed inset-0 flex items-end justify-center sm:items-center" onClick={onCancel}>
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
        <div
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label="Delete worked time"
          className="relative w-full rounded-t-2xl border border-tt-border bg-tt-card p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] shadow-2xl sm:mx-4 sm:max-w-md sm:rounded-2xl"
        >
          <h3 className="text-base font-semibold text-tt-text">Delete worked time?</h3>

          <dl className="mt-4 space-y-1.5 rounded-xl border border-tt-border bg-white/[0.02] px-3.5 py-3">
            {[
              ['Employee', employeeName],
              ['Date', formatDayLabel(row.dateISO)],
              ['Start', formatClock12(row.startLabel)],
              [
                'End',
                row.endDateISO
                  ? `${formatClock12(row.endLabel)} · ${formatDayLabel(row.endDateISO)}`
                  : formatClock12(row.endLabel),
              ],
              ['Paid hours', `${row.paidHours.toFixed(2)} hr`],
            ].map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-4">
                <dt className="text-[11px] uppercase tracking-wide text-tt-muted">{k}</dt>
                <dd className="text-[12.5px] tabular-nums text-tt-text">{v}</dd>
              </div>
            ))}
          </dl>

          <p className="mt-3 text-[12px] leading-relaxed text-tt-muted">
            This removes this worked-time record from payroll for this pay period.
          </p>
          {error && <p className="mt-2 text-xs text-tt-red">{error}</p>}

          <div className="flex gap-3 pt-5">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="min-h-[44px] flex-1 rounded-xl bg-white/5 py-2.5 text-sm font-semibold text-tt-muted transition-colors hover:bg-white/10 hover:text-tt-text disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={busy}
              className="min-h-[44px] flex-1 rounded-xl bg-tt-red/15 py-2.5 text-sm font-semibold text-tt-red transition-colors hover:bg-tt-red/25 disabled:opacity-50"
            >
              {busy ? 'Deleting…' : 'Delete Worked Time'}
            </button>
          </div>
        </div>
      </div>
    </OverlayLayer>
  );
}

// Records inside the period that carry no money. Folded shut and last on the page, because they
// are the answer to "why is this lighter than I expected" and nothing more.
function NotPaid({ rows }: { rows: ExcludedRow[] }) {
  return (
    <details className="group mt-4 border-t border-tt-border pt-3">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[11.5px] text-tt-muted transition-colors hover:text-tt-text">
        <span>{rows.length === 1 ? '1 record' : `${rows.length} records`} not included in pay</span>
        <span className="shrink-0 font-semibold text-tt-cyan">
          <span className="group-open:hidden">View</span>
          <span className="hidden group-open:inline">Hide</span>
        </span>
      </summary>
      <div className="mt-2.5 space-y-1.5">
        {rows.map((r) => (
          <div
            key={r.shiftId}
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-dashed border-tt-border px-3 py-2 text-tt-muted"
          >
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] font-semibold text-tt-text/70">{formatDayLabel(r.dateISO)}</span>
              <span className="text-[11.5px] tabular-nums">
                {formatClock12(r.startLabel)} – {r.endLabel ? formatClock12(r.endLabel) : '—'}
              </span>
              <span className="rounded-md bg-white/5 px-1.5 py-0.5 text-[9.5px] font-semibold">{r.label}</span>
            </span>
            <span className="text-[11px]">{r.detail}</span>
          </div>
        ))}
      </div>
    </details>
  );
}
