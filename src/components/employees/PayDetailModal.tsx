'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  formatBreak,
  formatClock12,
  formatDayLabel,
  payStatementFilename,
  type ExcludedRow,
  type PayStatement,
  type StatementRow,
} from '@/lib/pay/statement';
import { formatPeriodRange } from '@/lib/pay/statementPdf';
import { fmt } from '@/lib/calculations';
import { fmtHours, titleCase } from './shared';
import PersonAvatar from './weekly/PersonAvatar';

// EVERY WORKED-TIME ROW BEHIND ONE PERSON'S PAY, and the two buttons that put the same thing on
// paper. This component RENDERS a PayStatement; it does not compute one. Hours, rates, amounts,
// totals and warnings are all read off the object, which is the same object the PDF is handed —
// so "the screen and the PDF agree" is not a thing to keep true, it is a thing that cannot be
// false.
//
// PORTALLED TO document.body ON PURPOSE. `position: fixed` resolves against the nearest ancestor
// carrying a filter/backdrop-filter, and PayView's own card is `backdrop-blur-xl overflow-hidden`
// — rendered as its descendant this overlay would be laid out inside the panel and clipped by it.
// Same reasoning, same fix as HoverCard.

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'money' | 'plain' }) {
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

const CHIP = 'rounded-md px-1.5 py-0.5 text-[9.5px] font-semibold whitespace-nowrap';

function WarningChips({ row }: { row: StatementRow }) {
  // The 'manual_entry' note is dropped here and only here: this row already prints its source
  // label immediately to the left, so a chip repeating "Manual Entry" is the same word twice. The
  // note stays in the statement model — it is a real property of the row, and the model is what
  // the PDF and any future surface read.
  const chips = row.warnings.filter((w) => w.kind !== 'manual_entry');
  if (chips.length === 0) return null;
  return (
    <span className="ml-1.5 inline-flex flex-wrap gap-1 align-middle">
      {chips.map((w) => (
        <span
          key={w.kind}
          title={w.detail}
          className={`${CHIP} ${
            w.tone === 'review'
              ? 'bg-tt-yellow/15 text-tt-yellow'
              : 'bg-white/5 text-tt-muted'
          }`}
        >
          {w.label}
        </span>
      ))}
    </span>
  );
}

// One worked-time row. Desktop lays out as columns under a shared header; on a phone each cell
// labels itself and the row reads as a card — one markup tree, both shapes, matching how
// FulfillmentPerformance already does its tables.
function Cell({ label, children, right }: { label: string; children: React.ReactNode; right?: boolean }) {
  return (
    <div className={right ? 'sm:text-right' : ''}>
      <div className="text-[9px] uppercase tracking-wide text-tt-muted sm:hidden">{label}</div>
      <div className="text-[12.5px] text-tt-text tabular-nums">{children}</div>
    </div>
  );
}

const GRID = 'grid grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-[1.6fr_1fr_1fr_0.6fr_0.8fr_0.7fr_1fr_auto] sm:items-center sm:gap-y-0';

export default function PayDetailModal({
  statement,
  onClose,
  onEditRow,
  canEdit,
}: {
  statement: PayStatement;
  onClose: () => void;
  /** Opens the app's existing shift editor for this row. Undefined = editing unavailable. */
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

  const reviewRows = useMemo(
    () => statement.rows.filter((r) => r.warnings.some((w) => w.tone === 'review')),
    [statement.rows],
  );

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

        {/* ── Needs review ───────────────────────────────────────────────────── */}
        {statement.totals.reviewCount > 0 && (
          <div className="mb-5 rounded-xl border border-tt-yellow/25 bg-tt-yellow/[0.06] px-4 py-3">
            <div className="text-[10px] font-bold uppercase tracking-wider text-tt-yellow">
              {statement.totals.reviewCount === 1 ? '1 thing to review' : `${statement.totals.reviewCount} things to review`}
            </div>
            <ul className="mt-2 space-y-1.5">
              {reviewRows.flatMap((r) =>
                r.warnings
                  .filter((w) => w.tone === 'review')
                  .map((w) => (
                    <li key={`${r.shiftId}-${w.kind}`} className="text-[12px] leading-snug text-tt-text">
                      <span className="font-semibold">{formatDayLabel(r.dateISO)} · {w.label}</span>{' '}
                      <span className="text-tt-muted">{w.detail}</span>
                    </li>
                  )),
              )}
              {statement.excluded
                .filter((e) => e.reason !== 'schedule_plan')
                .map((e) => (
                  <li key={e.shiftId} className="text-[12px] leading-snug text-tt-text">
                    <span className="font-semibold">
                      {formatDayLabel(e.dateISO)} · {e.label} · not paid
                    </span>{' '}
                    <span className="text-tt-muted">{e.detail}</span>
                  </li>
                ))}
            </ul>
          </div>
        )}

        {/* ── Worked time ────────────────────────────────────────────────────── */}
        <div className="mb-2 flex items-baseline justify-between">
          <div className="text-[10px] font-bold uppercase tracking-wider text-tt-muted">Worked time</div>
          <div className="text-[10px] text-tt-muted">
            {statement.totals.rowCount === 1 ? '1 record' : `${statement.totals.rowCount} records`}
          </div>
        </div>

        {statement.rows.length === 0 ? (
          <div className="rounded-xl border border-tt-border px-4 py-10 text-center text-sm text-tt-muted">
            No payable worked time in this pay period.
          </div>
        ) : (
          <div className="space-y-1.5">
            <div className={`${GRID} hidden px-3 pb-1 text-[9px] font-bold uppercase tracking-wider text-tt-muted sm:grid`}>
              <div>Date</div>
              <div>Start</div>
              <div>End</div>
              <div className="text-right">Break</div>
              <div className="text-right">Paid Hours</div>
              <div className="text-right">Rate</div>
              <div className="text-right">Amount</div>
              <div />
            </div>

            {statement.rows.map((row) => (
              <div
                key={row.shiftId}
                className={`${GRID} rounded-xl border px-3 py-2.5 ${
                  row.warnings.some((w) => w.tone === 'review')
                    ? 'border-tt-yellow/25 bg-tt-yellow/[0.03]'
                    : 'border-tt-border'
                }`}
              >
                <div className="col-span-2 sm:col-span-1">
                  <div className="text-[12.5px] font-semibold text-tt-text">{formatDayLabel(row.dateISO)}</div>
                  <div className="mt-0.5 text-[9.5px] text-tt-muted">
                    {row.sourceLabel}
                    <WarningChips row={row} />
                  </div>
                </div>
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
                  {onEditRow && canEdit(row.shiftId) ? (
                    <button
                      type="button"
                      onClick={() => onEditRow(row.shiftId)}
                      className="min-h-[32px] w-full rounded-lg border border-tt-border px-2.5 text-[11px] font-semibold text-tt-cyan transition-colors hover:bg-tt-cyan/10 sm:w-auto"
                    >
                      Edit
                    </button>
                  ) : null}
                </div>
              </div>
            ))}

            {/* Total. Read off statement.totals — never re-added from the rows above, so this can
                never quietly disagree with the tile that opened this panel. */}
            <div className={`${GRID} rounded-xl border border-tt-border bg-white/[0.03] px-3 py-3`}>
              <div className="col-span-2 text-[12.5px] font-bold text-tt-text sm:col-span-4">
                Total owed
              </div>
              <div className="text-right text-[13px] font-bold tabular-nums text-tt-text">
                {statement.totals.paidHours.toFixed(2)}
              </div>
              <div />
              <div className="text-right text-[14px] font-bold tabular-nums text-tt-green">
                {fmt(statement.totals.gross)}
              </div>
              <div />
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

// Records that sit inside the period but are NOT part of the money. Shown so a manager can see
// why a number looks light, and visually separated so nothing here can be mistaken for pay.
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
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl border border-dashed border-tt-border px-3 py-2.5 opacity-70"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12.5px] font-semibold text-tt-text">{formatDayLabel(r.dateISO)}</span>
              <span className="text-[12px] tabular-nums text-tt-muted">
                {formatClock12(r.startLabel)} – {r.endLabel ? formatClock12(r.endLabel) : '—'}
              </span>
              <span className={`${CHIP} bg-white/5 text-tt-muted`}>{r.label}</span>
            </div>
            <span className="text-[11px] text-tt-muted">{r.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
