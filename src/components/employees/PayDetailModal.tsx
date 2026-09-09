'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  formatBreak,
  formatClock12,
  formatDayLabel,
  payStatementFilename,
  workedDayGroups,
  type ExcludedRow,
  type PayStatement,
  type StatementRow,
} from '@/lib/pay/statement';
import { formatPeriodRange } from '@/lib/pay/statementPdf';
import { fmt } from '@/lib/calculations';
import { fmtHours, titleCase } from './shared';
import PersonAvatar from './weekly/PersonAvatar';

// EVERY WORKED-TIME RECORD BEHIND ONE PERSON'S PAY, grouped by the day it happened on, and the two
// buttons that put the same thing on paper. This component RENDERS a PayStatement; it does not
// compute one. Hours, rates, amounts and totals are read off the object, which is the same object
// the PDF is handed — so "the screen and the PDF agree" is not a thing to keep true, it is a thing
// that cannot be false.
//
// IT DOES NOT JUDGE THE RECORDS. There is no anomaly badge, no warning colour and no "needs review"
// anywhere: the job here is to lay the payroll out clearly enough that a manager can see a bad
// record for themselves. Rows read left to right as day → in → out → break → hours → pay, and each
// record keeps its own Edit, because a duplicate is fixed one record at a time.
//
// PORTALLED TO document.body ON PURPOSE. `position: fixed` resolves against the nearest ancestor
// carrying a filter/backdrop-filter, and PayView's own card is `backdrop-blur-xl overflow-hidden` —
// rendered as its descendant this overlay would be laid out inside the panel and clipped by it.
// Same reasoning, same fix as HoverCard.

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'money' }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-wider text-tt-muted">{label}</div>
      <div
        className={`mt-1 font-bold tabular-nums ${
          tone === 'money' ? 'text-2xl text-tt-green' : 'text-lg text-tt-text'
        }`}
      >
        {value}
      </div>
    </div>
  );
}

// One worked-time record. Desktop lays out as columns under a shared header; on a phone each cell
// labels itself and the record reads as a card — one markup tree, both shapes.
function Cell({ label, children, right }: { label: string; children: React.ReactNode; right?: boolean }) {
  return (
    <div className={right ? 'sm:text-right' : ''}>
      <div className="text-[9px] uppercase tracking-wide text-tt-muted sm:hidden">{label}</div>
      <div className="text-[12.5px] tabular-nums text-tt-text">{children}</div>
    </div>
  );
}

const GRID =
  'grid grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-[1.15fr_0.95fr_1.15fr_0.6fr_0.75fr_0.7fr_0.95fr_auto] sm:items-center sm:gap-y-0';

function RecordRow({
  row,
  onEdit,
}: {
  row: StatementRow;
  onEdit?: () => void;
}) {
  return (
    <div className={`${GRID} rounded-lg border border-tt-border px-3 py-2.5`}>
      <Cell label="Source">
        <span className="text-[11.5px] text-tt-muted">{row.sourceLabel}</span>
      </Cell>
      <Cell label="Start">{formatClock12(row.startLabel)}</Cell>
      <Cell label="End">
        {formatClock12(row.endLabel)}
        {row.endDateISO && (
          <span className="ml-1 text-[10px] text-tt-muted">
            ({formatDayLabel(row.endDateISO).replace(/^\w+ /, '')})
          </span>
        )}
      </Cell>
      <Cell label="Break" right>{formatBreak(row.breakMinutes)}</Cell>
      <Cell label="Paid hours" right>{row.paidHours.toFixed(2)}</Cell>
      <Cell label="Rate" right>{fmt(row.rate)}</Cell>
      <Cell label="Amount" right>
        <span className="font-semibold text-tt-green">{fmt(row.amount)}</span>
      </Cell>
      <div className="col-span-2 sm:col-span-1 sm:justify-self-end">
        {onEdit ? (
          <button
            type="button"
            onClick={onEdit}
            className="min-h-[32px] w-full rounded-lg border border-tt-border px-2.5 text-[11px] font-semibold text-tt-cyan transition-colors hover:bg-tt-cyan/10 sm:w-auto"
          >
            Edit
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default function PayDetailModal({
  statement,
  onClose,
  onEditRow,
  canEdit,
}: {
  statement: PayStatement;
  onClose: () => void;
  /** Opens the app's existing shift editor for this record. Undefined = editing unavailable. */
  onEditRow?: (shiftId: string) => void;
  canEdit: (shiftId: string) => boolean;
}) {
  const [busy, setBusy] = useState<null | 'download' | 'print'>(null);
  const [docError, setDocError] = useState<string | null>(null);
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

  // ONE document, two buttons. Print opens the very PDF that Download saves, so there is no HTML
  // twin to drift out of step with it.
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

  const days = useMemo(() => workedDayGroups(statement), [statement]);

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
        className="w-full max-w-4xl rounded-[16px] border border-tt-border bg-tt-card p-5 shadow-2xl backdrop-blur-xl"
      >
        {/* ── Header ─────────────────────────────────────────────────────────── */}
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <PersonAvatar name={statement.employee.name} state="confirmed" size="lg" />
            <div>
              <h3 className="text-base font-semibold text-tt-text">{statement.employee.name}</h3>
              <p className="text-xs text-tt-muted">
                {titleCase(statement.employee.role || '—')} ·{' '}
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

        {/* ── Summary + document actions ─────────────────────────────────────── */}
        <div className="mb-5 flex flex-wrap items-end justify-between gap-4 rounded-xl border border-tt-border bg-white/[0.02] px-4 py-3.5">
          <div className="flex flex-wrap gap-x-8 gap-y-3">
            <Stat label="Total owed" value={fmt(statement.totals.gross)} tone="money" />
            <Stat label="Payable hours" value={fmtHours(statement.totals.paidHours)} />
            <Stat label="Rate" value={`${fmt(statement.rate)}/hr`} />
            <Stat label="Worked days" value={String(statement.totals.workedDays)} />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handlePrint}
              disabled={busy !== null}
              className="min-h-[36px] rounded-xl border border-tt-border px-3.5 text-xs font-semibold text-tt-text transition-colors hover:bg-tt-card-hover disabled:opacity-50"
            >
              {busy === 'print' ? 'Preparing…' : 'Print'}
            </button>
            <button
              type="button"
              onClick={handleDownload}
              disabled={busy !== null}
              className="min-h-[36px] rounded-xl bg-tt-cyan px-3.5 text-xs font-semibold text-black transition-colors hover:bg-tt-cyan/90 disabled:opacity-50"
            >
              {busy === 'download' ? 'Building…' : 'Download PDF'}
            </button>
          </div>
        </div>
        {docError && <p className="-mt-3 mb-4 text-xs text-tt-red">{docError}</p>}

        {/* ── Worked time, by day ────────────────────────────────────────────── */}
        <div className="mb-2 flex items-baseline justify-between">
          <div className="text-[10px] font-bold uppercase tracking-wider text-tt-muted">Worked time</div>
          <div className="text-[10px] text-tt-muted">
            {statement.totals.rowCount === 1 ? '1 record' : `${statement.totals.rowCount} records`}
            {' · '}
            {statement.totals.workedDays === 1 ? '1 day' : `${statement.totals.workedDays} days`}
          </div>
        </div>

        {days.length === 0 ? (
          <div className="rounded-xl border border-tt-border px-4 py-10 text-center text-sm text-tt-muted">
            No payable worked time in this pay period.
          </div>
        ) : (
          <div className="space-y-3">
            <div
              className={`${GRID} hidden px-3 text-[9px] font-bold uppercase tracking-wider text-tt-muted sm:grid`}
            >
              <div>Source</div>
              <div>Start</div>
              <div>End</div>
              <div className="text-right">Break</div>
              <div className="text-right">Paid Hours</div>
              <div className="text-right">Rate</div>
              <div className="text-right">Amount</div>
              <div />
            </div>

            {/* One block per calendar day. A day with several records keeps them side by side under
                the same heading — never merged, so each stays separately editable. */}
            {days.map((day) => (
              <div key={day.dateISO}>
                <div className="mb-1.5 flex items-baseline justify-between gap-3 border-b border-tt-border pb-1">
                  <span className="text-[12.5px] font-semibold text-tt-text">
                    {formatDayLabel(day.dateISO)}
                    {day.rows.length > 1 && (
                      <span className="ml-2 text-[10px] font-normal text-tt-muted">
                        {day.rows.length} records
                      </span>
                    )}
                  </span>
                  <span className="text-[11px] tabular-nums text-tt-muted">
                    {day.hours.toFixed(2)} hr · {fmt(day.amount)}
                  </span>
                </div>
                <div className="space-y-1.5">
                  {day.rows.map((row) => (
                    <RecordRow
                      key={row.shiftId}
                      row={row}
                      onEdit={onEditRow && canEdit(row.shiftId) ? () => onEditRow(row.shiftId) : undefined}
                    />
                  ))}
                </div>
              </div>
            ))}

            {/* Read off statement.totals — never re-added from the rows above, so this can never
                quietly disagree with the tile that opened the panel. */}
            <div className="flex items-center justify-between rounded-xl border border-tt-border bg-white/[0.03] px-4 py-3">
              <span className="text-[13px] font-bold text-tt-text">Total owed</span>
              <span className="flex items-baseline gap-5">
                <span className="text-[13px] font-bold tabular-nums text-tt-text">
                  {statement.totals.paidHours.toFixed(2)} hr
                </span>
                <span className="text-[15px] font-bold tabular-nums text-tt-green">
                  {fmt(statement.totals.gross)}
                </span>
              </span>
            </div>
          </div>
        )}

        {/* ── Not paid ───────────────────────────────────────────────────────── */}
        {statement.excluded.length > 0 && <NotPaid rows={statement.excluded} />}

        <p className="mt-5 text-[10.5px] leading-relaxed text-tt-muted">
          Hours and pay for this period only — not lifetime, and not a running balance. Amounts are
          gross; no deductions are applied.
        </p>
      </div>
    </div>,
    document.body,
  );
}

// Records inside the period that carry no money. Stated plainly and without alarm, because a light
// total is easier to understand when you can see what is not in it.
function NotPaid({ rows }: { rows: ExcludedRow[] }) {
  return (
    <div className="mt-5">
      <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-tt-muted">
        In this period but not paid
      </div>
      <div className="space-y-1.5">
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
    </div>
  );
}
