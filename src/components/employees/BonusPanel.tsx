'use client';

import { useEffect, useRef, useState } from 'react';
import { fmt } from '@/lib/calculations';
import type { BonusItem } from '@/lib/pay/statement';
import {
  BONUS_DESCRIPTION_MAX,
  centsToInput,
  normalizeBonusDescription,
  parseBonusAmount,
} from '@/lib/pay/bonusInput';
import OverlayLayer from './OverlayLayer';

// BONUS / INCENTIVE PAY — the list, the form and the delete confirmation.
//
// IT RENDERS `statement.bonusItems` AND ADDS NOTHING UP. The bonus total printed at the foot of
// the list is `statement.totals.bonusTotal`, computed once in buildPayStatement and shared with
// the Pay tile and the PDF. Summing the lines here would be a second calculation, which is the one
// thing the pay statement architecture exists to prevent — so this file contains no `+` over money.
//
// THE ONLY ARITHMETIC ANYWHERE NEAR IT is parseBonusAmount(), which turns typed text into integer
// cents without a float (lib/pay/bonusInput.ts), and that runs on the way IN, before the database.
//
// WRITES ARE OPTIONAL. Without `handlers` this is a read-only list — which is what a future
// employee-facing or historical view would want, and it means the display cannot accidentally
// depend on having write access.

export interface BonusHandlers {
  onAdd: (input: { amountCents: number; description: string | null }) => Promise<void>;
  onEdit: (id: string, input: { amountCents: number; description: string | null }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

/** The "+ Add Bonus" affordance that sits next to the Pay Details summary. */
export function AddBonusButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-h-[34px] rounded-xl border border-dashed border-tt-cyan/50 px-3.5 text-xs font-semibold text-tt-cyan transition-colors hover:bg-tt-cyan/10"
    >
      + Add Bonus
    </button>
  );
}

/**
 * BONUSES & INCENTIVES. Rendered only when there is at least one — an empty framed section with a
 * heading and a $0.00 would take up more of the page than the information in it.
 */
export function BonusSection({
  items,
  bonusTotal,
  onEditItem,
  onDeleteItem,
}: {
  items: BonusItem[];
  /** statement.totals.bonusTotal. Passed in, never re-added from `items`. */
  bonusTotal: number;
  onEditItem?: (item: BonusItem) => void;
  onDeleteItem?: (item: BonusItem) => void;
}) {
  if (items.length === 0) return null;

  return (
    <section className="mb-5">
      <h4 className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-tt-text">
        Bonuses &amp; Incentives
        <span className="ml-2 font-normal normal-case tracking-normal text-tt-muted">
          Not worked time — added to the total
        </span>
      </h4>

      <div className="divide-y divide-tt-border/40 rounded-lg border border-tt-border">
        {items.map((item) => (
          <div
            key={item.id}
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2"
          >
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-tt-text" title={item.label}>
              {item.label}
            </span>
            <span className="text-[12.5px] font-semibold tabular-nums text-tt-green">
              {fmt(item.amount)}
            </span>
            {(onEditItem || onDeleteItem) && (
              <span className="flex w-full gap-1.5 sm:w-auto">
                {onEditItem && (
                  <button
                    type="button"
                    onClick={() => onEditItem(item)}
                    className="min-h-[30px] flex-1 rounded-lg border border-tt-border px-2.5 text-[11px] font-semibold text-tt-cyan transition-colors hover:bg-tt-cyan/10 sm:flex-none"
                  >
                    Edit
                  </button>
                )}
                {onDeleteItem && (
                  <button
                    type="button"
                    onClick={() => onDeleteItem(item)}
                    className="min-h-[30px] flex-1 rounded-lg border border-tt-border px-2.5 text-[11px] font-semibold text-tt-red transition-colors hover:bg-tt-red/10 sm:flex-none"
                  >
                    Delete
                  </button>
                )}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* statement.totals.bonusTotal — read, not recomputed. */}
      <div className="mt-1.5 flex items-center justify-between rounded-lg bg-white/[0.03] px-3 py-2">
        <span className="text-[11.5px] font-bold uppercase tracking-wider text-tt-muted">Bonus Total</span>
        <span className="text-[13px] font-bold tabular-nums text-tt-green">{fmt(bonusTotal)}</span>
      </div>
    </section>
  );
}

/**
 * ADD or EDIT, one small form. Amount and reason, and deliberately nothing else — the person and
 * the pay period are whichever Pay Details is open on, which is what makes this two fields instead
 * of a picker a manager could get wrong.
 */
export function BonusFormModal({
  employeeName,
  periodLabel,
  /** The bonus being edited, or null to add a new one. */
  editing,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  employeeName: string;
  periodLabel: string;
  editing: BonusItem | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (input: { amountCents: number; description: string | null }) => void;
}) {
  const [amount, setAmount] = useState(editing ? centsToInput(editing.amountCents) : '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [localError, setLocalError] = useState<string | null>(null);
  const amountRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    amountRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, busy]);

  function submit() {
    // Validated here so the manager gets a sentence; validated AGAIN by CHECK constraints in the
    // database, which is the one that actually decides.
    const parsed = parseBonusAmount(amount);
    if (!parsed.ok) {
      setLocalError(parsed.error);
      return;
    }
    setLocalError(null);
    onSubmit({ amountCents: parsed.cents, description: normalizeBonusDescription(description) });
  }

  const shown = localError ?? error;

  return (
    <OverlayLayer>
      <div className="fixed inset-0 flex items-end justify-center sm:items-center" onClick={busy ? undefined : onCancel}>
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
        <form
          onClick={(e) => e.stopPropagation()}
          onSubmit={(e) => { e.preventDefault(); submit(); }}
          role="dialog"
          aria-modal="true"
          aria-label={editing ? 'Edit bonus' : 'Add bonus'}
          className="relative w-full rounded-t-2xl border border-tt-border bg-tt-card p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] shadow-2xl sm:mx-4 sm:max-w-md sm:rounded-2xl"
        >
          <h3 className="text-base font-semibold text-tt-text">{editing ? 'Edit bonus' : 'Add bonus'}</h3>
          {/* Stated, not assumed: this money lands on THIS person's THIS period and nowhere else. */}
          <p className="mt-1 text-[12px] text-tt-muted">
            {employeeName} · {periodLabel}
          </p>

          <label className="mt-4 block">
            <span className="text-[11px] font-bold uppercase tracking-wider text-tt-muted">Bonus amount</span>
            <span className="mt-1 flex items-center gap-2 rounded-xl border border-tt-border bg-white/[0.02] px-3">
              <span className="text-[15px] text-tt-muted">$</span>
              <input
                ref={amountRef}
                value={amount}
                onChange={(e) => { setAmount(e.target.value); setLocalError(null); }}
                inputMode="decimal"
                placeholder="0.00"
                aria-label="Bonus amount in dollars"
                className="min-h-[44px] w-full bg-transparent text-[15px] tabular-nums text-tt-text outline-none placeholder:text-tt-muted/50"
              />
            </span>
          </label>

          <label className="mt-3 block">
            <span className="text-[11px] font-bold uppercase tracking-wider text-tt-muted">
              Description <span className="font-normal normal-case tracking-normal">(optional)</span>
            </span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={BONUS_DESCRIPTION_MAX}
              placeholder="Performance bonus"
              aria-label="Bonus description"
              className="mt-1 min-h-[44px] w-full rounded-xl border border-tt-border bg-white/[0.02] px-3 text-[14px] text-tt-text outline-none placeholder:text-tt-muted/50"
            />
          </label>

          <p className="mt-2 text-[11px] leading-relaxed text-tt-muted">
            A bonus is paid on top of worked time. It adds no hours and changes no shift, rate or
            clock-in.
          </p>

          {shown && <p className="mt-2 text-xs text-tt-red">{shown}</p>}

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
              type="submit"
              disabled={busy}
              className="min-h-[44px] flex-1 rounded-xl bg-tt-cyan py-2.5 text-sm font-semibold text-black transition-colors hover:bg-tt-cyan/90 disabled:opacity-50"
            >
              {busy ? 'Saving…' : editing ? 'Save Bonus' : 'Add Bonus'}
            </button>
          </div>
        </form>
      </div>
    </OverlayLayer>
  );
}

/** Deleting a bonus takes money off someone's cheque, so the dialog restates exactly which one. */
export function BonusDeleteConfirm({
  employeeName,
  item,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  employeeName: string;
  item: BonusItem;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <OverlayLayer>
      <div className="fixed inset-0 flex items-end justify-center sm:items-center" onClick={busy ? undefined : onCancel}>
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
        <div
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label="Delete bonus"
          className="relative w-full rounded-t-2xl border border-tt-border bg-tt-card p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] shadow-2xl sm:mx-4 sm:max-w-md sm:rounded-2xl"
        >
          <h3 className="text-base font-semibold text-tt-text">Delete bonus?</h3>

          <dl className="mt-4 space-y-1.5 rounded-xl border border-tt-border bg-white/[0.02] px-3.5 py-3">
            {[
              ['Employee', employeeName],
              ['Bonus', item.label],
              ['Amount', fmt(item.amount)],
            ].map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-4">
                <dt className="text-[11px] uppercase tracking-wide text-tt-muted">{k}</dt>
                <dd className="text-[12.5px] tabular-nums text-tt-text">{v}</dd>
              </div>
            ))}
          </dl>

          <p className="mt-3 text-[12px] leading-relaxed text-tt-muted">
            This removes the bonus from this employee&apos;s pay period. Worked time is not changed.
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
              {busy ? 'Deleting…' : 'Delete Bonus'}
            </button>
          </div>
        </div>
      </div>
    </OverlayLayer>
  );
}
