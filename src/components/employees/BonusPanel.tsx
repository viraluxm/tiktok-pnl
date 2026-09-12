'use client';

import { useEffect, useRef, useState } from 'react';
import { fmt } from '@/lib/calculations';
import { formatBonusBasis, formatPayableDuration, type BonusItem } from '@/lib/pay/statement';
import {
  BONUS_DESCRIPTION_MAX,
  centsToInput,
  normalizeBonusDescription,
  parseBonusAmount,
} from '@/lib/pay/bonusInput';
import type { PayAdjustmentCalculationType } from '@/types';
import OverlayLayer from './OverlayLayer';

// BONUS / INCENTIVE PAY — the list, the form and the delete confirmation.
//
// IT RENDERS `statement.bonusItems` AND ADDS NOTHING UP — INCLUDING THE HOURLY ONES. A line's
// dollar figure is `item.amount`, worked out in buildPayStatement from the statement's own payable
// hours, and the '$2.00/hr x 72.50 hr' beside it is formatBonusBasis() from the same model. There
// is no rate x hours anywhere in this file: a manager reads the working, the model does the
// multiplying, and the PDF prints the identical two strings.
//
// The bonus total at the foot of the list is `statement.totals.bonusTotal`, computed once and
// shared with the Pay tile and the PDF. Summing the lines here would be a second calculation, which
// is the one thing the pay statement architecture exists to prevent — so this file contains no `+`
// and no `*` over money.
//
// THE ONLY ARITHMETIC ANYWHERE NEAR IT is parseBonusAmount(), which turns typed text into integer
// cents without a float (lib/pay/bonusInput.ts), and that runs on the way IN, before the database.
//
// WRITES ARE OPTIONAL. Without `handlers` this is a read-only list — which is what a future
// employee-facing or historical view would want, and it means the display cannot accidentally
// depend on having write access.

/** What the form hands back: exactly one of the two figures, plus the reason. */
export interface BonusDraft {
  calculationType: PayAdjustmentCalculationType;
  /** FLAT only. */
  amountCents: number | null;
  /** HOURLY only. */
  rateCentsPerHour: number | null;
  description: string | null;
}

export interface BonusHandlers {
  onAdd: (input: BonusDraft) => Promise<void>;
  /** The calculation type is carried through unchanged — an edit never converts one into the other. */
  onEdit: (id: string, input: BonusDraft) => Promise<void>;
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
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] text-tt-text" title={item.label}>
                {item.label}
              </span>
              {/* THE WORKING, SO NOBODY HAS TO DO IT: '$2.00/hr x 72.50 hr' beside the figure it
                  produced. Straight off the model — this line does no multiplying. */}
              <span className="block text-[10.5px] tabular-nums text-tt-muted">
                {formatBonusBasis(item)}
              </span>
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
 * ADD or EDIT, one small form. Amount (or rate) and reason, and deliberately nothing else — the
 * person and the pay period are whichever Pay Details is open on, which is what makes this two
 * fields instead of a picker a manager could get wrong.
 *
 * THE CALCULATION TYPE IS CHOSEN ONCE, WHEN THE BONUS IS ADDED, AND IS NOT EDITABLE AFTERWARDS.
 * Both writes are equally safe at the database — the row sets both money columns explicitly either
 * way — so this is a product decision, not a technical limit, and it is the safer of the two:
 * "$2.00" as a flat bonus and "$2.00" as an hourly rate differ by a factor of the period's hours
 * (seventy-odd), and a radio button that silently multiplies a line by seventy is not something to
 * leave one mis-click away in an edit form. Changing a bonus's type is delete-and-re-add, which
 * also leaves an honest created_at behind rather than restating history.
 */
const TYPES: { value: PayAdjustmentCalculationType; label: string; hint: string }[] = [
  { value: 'flat', label: 'Flat amount', hint: 'A fixed sum for this pay period.' },
  { value: 'hourly', label: 'Hourly bonus', hint: 'Paid per payable hour worked in this pay period.' },
];

export function BonusFormModal({
  employeeName,
  periodLabel,
  /** The payable hours an hourly bonus would be multiplied by — shown, never used to compute. */
  paidHours,
  /** The bonus being edited, or null to add a new one. */
  editing,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  employeeName: string;
  periodLabel: string;
  paidHours: number;
  editing: BonusItem | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (input: BonusDraft) => void;
}) {
  const [type, setType] = useState<PayAdjustmentCalculationType>(editing?.calculationType ?? 'flat');
  const [value, setValue] = useState(() => {
    if (!editing) return '';
    return centsToInput((editing.calculationType === 'hourly' ? editing.rateCentsPerHour : editing.amountCents) ?? 0);
  });
  const [description, setDescription] = useState(editing?.description ?? '');
  const [localError, setLocalError] = useState<string | null>(null);
  const valueRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    valueRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, busy]);

  const hourly = type === 'hourly';

  function submit() {
    // Validated here so the manager gets a sentence; validated AGAIN by CHECK constraints in the
    // database, which is the one that actually decides.
    const parsed = parseBonusAmount(value, hourly ? 'rate' : 'amount');
    if (!parsed.ok) {
      setLocalError(parsed.error);
      return;
    }
    setLocalError(null);
    onSubmit({
      calculationType: type,
      amountCents: hourly ? null : parsed.cents,
      rateCentsPerHour: hourly ? parsed.cents : null,
      description: normalizeBonusDescription(description),
    });
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

          {/* On an EDIT the type is shown as a fact rather than a choice — see the note above. */}
          {editing ? (
            <p className="mt-4 rounded-xl border border-tt-border bg-white/[0.02] px-3.5 py-2.5 text-[12px] text-tt-muted">
              <span className="font-semibold text-tt-text">{hourly ? 'Hourly bonus' : 'Flat amount'}</span>
              {' — '}
              {hourly
                ? 'to change it to a flat amount, delete this bonus and add it again.'
                : 'to change it to an hourly bonus, delete this bonus and add it again.'}
            </p>
          ) : (
            <fieldset className="mt-4">
              <legend className="text-[11px] font-bold uppercase tracking-wider text-tt-muted">Bonus type</legend>
              <div className="mt-1.5 flex gap-2">
                {TYPES.map((t) => (
                  <label
                    key={t.value}
                    className={`flex-1 cursor-pointer rounded-xl border px-3 py-2.5 transition-colors ${
                      type === t.value
                        ? 'border-tt-cyan/60 bg-tt-cyan/10'
                        : 'border-tt-border bg-white/[0.02] hover:bg-tt-card-hover'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="bonus-type"
                        value={t.value}
                        checked={type === t.value}
                        onChange={() => { setType(t.value); setLocalError(null); }}
                        className="accent-tt-cyan"
                      />
                      <span className="text-[12.5px] font-semibold text-tt-text">{t.label}</span>
                    </span>
                    <span className="mt-1 block text-[10.5px] leading-snug text-tt-muted">{t.hint}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          <label className="mt-3 block">
            <span className="text-[11px] font-bold uppercase tracking-wider text-tt-muted">
              {hourly ? 'Bonus per hour' : 'Bonus amount'}
            </span>
            <span className="mt-1 flex items-center gap-2 rounded-xl border border-tt-border bg-white/[0.02] px-3">
              <span className="text-[15px] text-tt-muted">$</span>
              <input
                ref={valueRef}
                value={value}
                onChange={(e) => { setValue(e.target.value); setLocalError(null); }}
                inputMode="decimal"
                placeholder="0.00"
                aria-label={hourly ? 'Bonus rate in dollars per payable hour' : 'Bonus amount in dollars'}
                className="min-h-[44px] w-full bg-transparent text-[15px] tabular-nums text-tt-text outline-none placeholder:text-tt-muted/50"
              />
              {hourly && <span className="shrink-0 text-[13px] text-tt-muted">/ hr</span>}
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
              placeholder={hourly ? 'Productivity incentive' : 'Performance bonus'}
              aria-label="Bonus description"
              className="mt-1 min-h-[44px] w-full rounded-xl border border-tt-border bg-white/[0.02] px-3 text-[14px] text-tt-text outline-none placeholder:text-tt-muted/50"
            />
          </label>

          <p className="mt-2 text-[11px] leading-relaxed text-tt-muted">
            {hourly ? (
              <>
                {/* The SAME duration basis the saved line will show, so the figure a manager sees
                    while choosing a rate is the figure they see afterwards. Stated as a duration
                    rather than 72.50 hr for the reason formatBonusBasis explains: this number is
                    about to be multiplied by the rate above it, and it has to come out right. */}
                Paid on every payable hour in this pay period — {formatPayableDuration(paidHours)} so
                far. It is separate from the base hourly rate and changes nothing about it; if worked
                hours are corrected later, this bonus follows them on its own.
              </>
            ) : (
              <>A bonus is paid on top of worked time. It adds no hours and changes no shift, rate or clock-in.</>
            )}
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
              // An hourly line's worth is DERIVED, so the dialog says what it is derived from and
              // calls the figure what it is — a current value, not a fixed amount.
              [item.calculationType === 'hourly' ? 'Rate' : 'Type', formatBonusBasis(item)],
              [item.calculationType === 'hourly' ? 'Current value' : 'Amount', fmt(item.amount)],
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
