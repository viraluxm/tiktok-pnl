// WHAT A MANAGER TYPED → INTEGER CENTS, without ever touching a float.
//
// Two things get typed, and they are parsed by the SAME routine because they are the same kind of
// thing — a dollars-and-cents figure a human wrote down. A FLAT bonus's amount ($100.00 → 10000)
// and an HOURLY bonus's rate ($2.50/hr → 250) differ only in their ceiling and in the sentence
// shown when one is refused.
//
// `Number('19.99') * 100` is 1998.9999999999998. Rounding that happens to work for two decimal
// places, which is exactly why it survives review and then turns up as a penny somewhere else. So
// the amount is parsed as TEXT: the dollars and the cents are separate integer strings, and the
// only arithmetic is `dollars * 100 + cents`. There is no floating-point value anywhere on the
// path from the keyboard to `amount_cents`.
//
// Pure: no React, no client, no clock. The modal renders what these functions return.

/** $1,000,000 — the same cap the SQL CHECK enforces on a FLAT amount (migration 150). */
export const BONUS_MAX_CENTS = 100_000_000;

/**
 * $1,000.00 per hour — the cap the SQL CHECK enforces on an HOURLY rate.
 *
 * Far lower than the flat cap on purpose: a rate is MULTIPLIED. Across a two-week period someone
 * can be paid for roughly 336 hours, so $1,000/hr is already a third of a million dollars of
 * incentive — generous headroom for anything real, and a hard stop on a flat amount typed into the
 * per-hour box, which is the mistake this number exists to bound.
 */
export const BONUS_MAX_RATE_CENTS = 100_000;

/** Matches the SQL `char_length(description) <= 120`. */
export const BONUS_DESCRIPTION_MAX = 120;

export type BonusAmountResult = { ok: true; cents: number } | { ok: false; error: string };

/** Which box was typed into — it changes the ceiling and the wording, nothing else. */
export type BonusField = 'amount' | 'rate';

/**
 * Parse a typed dollar amount. Accepts '150', '150.', '150.5', '150.50', '$1,595.00', ' 12.34 '.
 * Rejects anything else — including a negative, because this feature adds pay and never subtracts
 * it, and including three decimal places, because a third decimal is not a thing a cheque has.
 */
export function parseBonusAmount(input: string, field: BonusField = 'amount'): BonusAmountResult {
  const rate = field === 'rate';
  const cleaned = input.trim().replace(/^\$/, '').replace(/,/g, '').replace(/\/\s*h(ou)?r$/i, '').trim();
  if (cleaned === '') return { ok: false, error: rate ? 'Enter a per-hour bonus rate.' : 'Enter a bonus amount.' };

  const m = /^(\d+)(?:\.(\d{0,2}))?$/.exec(cleaned);
  if (!m) {
    if (/^-/.test(cleaned)) return { ok: false, error: 'A bonus has to be a positive amount.' };
    if (/^\d*\.\d{3,}$/.test(cleaned)) return { ok: false, error: 'Amounts go to cents — two decimal places.' };
    return { ok: false, error: rate ? 'Enter a rate like 2 or 2.50.' : 'Enter an amount like 150 or 150.00.' };
  }

  // '150.5' means fifty cents, not five. Pad on the RIGHT, which is the half that is easy to get
  // backwards and expensive when you do.
  const dollars = Number(m[1]);
  const centsPart = (m[2] ?? '').padEnd(2, '0');
  const cents = dollars * 100 + Number(centsPart || '0');

  const max = rate ? BONUS_MAX_RATE_CENTS : BONUS_MAX_CENTS;
  const tooBig = rate ? 'That is too large to be a per-hour bonus rate.' : 'That amount is too large to be a bonus.';
  if (cents <= 0) {
    return { ok: false, error: rate ? 'A bonus rate has to be more than $0.00/hr.' : 'A bonus has to be more than $0.00.' };
  }
  if (cents > max) return { ok: false, error: tooBig };
  // Beyond 2^53 nothing is exact any more; the caps above are far below it, so this is belt and
  // braces against a future cap change rather than a live concern.
  if (!Number.isSafeInteger(cents)) return { ok: false, error: tooBig };

  return { ok: true, cents };
}

/** Integer cents → the text an edit form opens at: 10050 → '100.50'. Integer division only. */
export function centsToInput(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const rest = Math.abs(cents % 100);
  return `${whole}.${String(rest).padStart(2, '0')}`;
}

/** Trim, collapse runs of whitespace, and treat an empty reason as no reason at all. */
export function normalizeBonusDescription(input: string): string | null {
  const trimmed = input.trim().replace(/\s+/g, ' ');
  return trimmed === '' ? null : trimmed.slice(0, BONUS_DESCRIPTION_MAX);
}
