// Fit a slip's text onto a 4x6 label without a font library.
//
// NO IMPORTS — slipLayout.test.mjs transpiles this file standalone at runtime. Text measurement
// comes in as a callback, so the wrapping logic is testable without pdf-lib and without real
// font metrics.
//
// WHY AUTO-FIT AT ALL. Slip captions come from SKU titles, which range from "XL Peanut in bag"
// to "Jumbo UV Color Changing Strawberry". A fixed font size either wastes most of the label on
// the short ones or overflows the long ones, and an overflowing slip is worse than a small one:
// the packer reads a truncated SKU name and pulls the wrong stock.

/** A wrapped, sized block of text. */
export interface FitResult {
  size: number;
  lines: string[];
  /** Set when the text did not fit at any size and the last line was clipped with an ellipsis. */
  truncated?: true;
}

/** Measures the width of `text` rendered at `size`. Supplied by the caller's font. */
export type Measure = (text: string, size: number) => number;

/**
 * Split a slip caption into its number and title.
 *
 * Captions look like "#248 PUMPKIN GLITTER". The number is what a packer matches against the
 * SKU written on the pallet, so it is rendered far larger than the title — the title is
 * confirmation, the number is the identifier. "MIXED — READ EACH LABEL" has no number and is
 * returned whole as the title.
 */
export function splitCaption(caption: string): { number: string | null; title: string } {
  const m = /^\s*(#\S+)\s*(.*)$/.exec(caption ?? '');
  if (!m) return { number: null, title: (caption ?? '').trim() };
  return { number: m[1], title: m[2].trim() };
}

/**
 * Hard-break a single word too wide to fit at the smallest size.
 *
 * Only reachable for a title with one very long unbroken token. Breaking mid-word is ugly but
 * readable; letting it run off the edge is not.
 */
function breakWord(word: string, measure: Measure, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of word) {
    if (cur && measure(cur + ch, size) > maxWidth) { out.push(cur); cur = ch; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out.length ? out : [word];
}

/** Greedy word wrap at a fixed size. Returns null if any single word cannot fit. */
function wrapAt(text: string, measure: Measure, size: number, maxWidth: number): string[] | null {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (measure(w, size) > maxWidth) return null;   // no wrap can save an over-wide word
    const candidate = cur ? `${cur} ${w}` : w;
    if (measure(candidate, size) <= maxWidth) { cur = candidate; continue; }
    lines.push(cur);
    cur = w;
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Largest size from `sizes` at which `text` wraps into at most `maxLines`.
 *
 * `sizes` is tried in the order given — pass it descending. If nothing fits, the last size is
 * used with hard-broken words and the result is truncated to maxLines, so the caller always
 * gets something drawable rather than an exception at print time.
 */
export function fitText(
  text: string,
  measure: Measure,
  maxWidth: number,
  maxLines: number,
  sizes: number[],
): FitResult {
  const candidates = sizes.length ? sizes : [12];
  for (const size of candidates) {
    const lines = wrapAt(text, measure, size, maxWidth);
    if (lines && lines.length <= maxLines) return { size, lines };
  }
  // Nothing fitted cleanly. Fall back to the smallest size with mid-word breaks.
  const size = candidates[candidates.length - 1];
  const broken: string[] = [];
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (measure(w, size) > maxWidth) broken.push(...breakWord(w, measure, size, maxWidth));
    else broken.push(w);
  }
  const lines = wrapAt(broken.join(' '), measure, size, maxWidth) ?? broken;
  if (lines.length <= maxLines) return { size, lines };

  // Truncating means the packer sees a partial SKU name, so SAY SO. A silently clipped title
  // reads as complete and is the one failure mode worse than a small slip: they would pull
  // stock matching a name that was never fully shown. The number is drawn separately and is
  // never truncated, so the ellipsis points them at the label rather than leaving them guessing.
  const kept = lines.slice(0, maxLines);
  const last = kept.length - 1;
  let tail = `${kept[last]}…`;
  while (tail.length > 1 && measure(tail, size) > maxWidth) {
    tail = `${tail.slice(0, -2)}…`;
  }
  kept[last] = tail;
  return { size, lines: kept, truncated: true };
}
