// Draw a separator slip onto a label-sized page.
//
// WHAT A SLIP IS FOR. It sits in front of a run of identical labels so the packer can hold one
// box of stock and work mechanically — one item per package, slap, next — without reading
// anything. So the slip has exactly one job: be unmistakable at arm's length while flipping
// through a stack of near-identical 4x6 labels.
//
// Three decisions follow from that:
//
//   THE NUMBER IS THE BIGGEST THING ON THE PAGE. "#248" is what a packer matches against the
//   number written on the pallet. The title is confirmation; the number is the identifier.
//
//   A HEAVY OUTLINE, NOT A FILLED BLOCK. The slip must be distinguishable from a label by
//   silhouette alone. An inverted or filled header would do that too, but these print on
//   thermal 4x6 stock, where large black areas are slow and wear the printhead.
//
//   THE COUNT IS SHOWN. "12 LABELS" lets the packer count out stock once instead of
//   discovering the end of the run by surprise.

import { type PDFDocument, type PDFFont, rgb } from 'pdf-lib';
import { fitText, splitCaption, type Measure } from '@/lib/shipping/slipLayout';

/** Fallback page size: 4x6 inches at 72pt/inch, used when no label is available to match. */
export const DEFAULT_SLIP_SIZE = { width: 288, height: 432 };

const MARGIN = 14;
const BORDER = 5;
/** Descending, so fitText picks the largest that works. */
const NUMBER_SIZES = [104, 88, 72, 60, 50, 42, 34, 26];
const TITLE_SIZES = [40, 34, 29, 25, 21, 18, 15, 12, 10];

export interface SlipContent {
  caption: string;
  count: number;
  /**
   * A PILE divider rather than a SKU header. Drawn heavier, with a filled bar, because it is
   * what someone finds while splitting a stack by hand — often at arm's length and without
   * reading it closely. The extra toner is worth it a handful of times per run; it would not
   * be on every SKU slip.
   */
  banner?: boolean;
}

/**
 * Append a slip page.
 *
 * Sized to match the labels it will be bound with, so the printer never rescales mid-document —
 * a rescale would resize the label pages too, and a shrunk barcode may not scan.
 */
export function addSlipPage(
  doc: PDFDocument,
  font: PDFFont,
  size: { width: number; height: number },
  slip: SlipContent,
): void {
  const page = doc.addPage([size.width, size.height]);
  const heavy = slip.banner === true;
  const measure: Measure = (t, s) => font.widthOfTextAtSize(t, s);
  const black = rgb(0, 0, 0);

  // Outline, drawn inside the margin so it survives a printer's unprintable edge.
  page.drawRectangle({
    x: MARGIN, y: MARGIN,
    width: size.width - MARGIN * 2, height: size.height - MARGIN * 2,
    borderColor: black, borderWidth: heavy ? BORDER * 3 : BORDER,
  });
  if (heavy) {
    // A solid bar across the top. Deliberately the only filled area in the whole document, so a
    // banner is identifiable by silhouette when the stack is fanned.
    page.drawRectangle({
      x: MARGIN + BORDER * 3, y: size.height - MARGIN - BORDER * 3 - 26,
      width: size.width - (MARGIN + BORDER * 3) * 2, height: 26, color: black,
    });
  }

  const { number, title } = splitCaption(slip.caption);
  const pad = MARGIN + BORDER + 10;
  const usable = size.width - pad * 2;
  const centred = (text: string, s: number) => (size.width - measure(text, s)) / 2;

  // Lay out from the top down.
  let y = size.height - pad - (heavy ? 30 : 0);

  if (number) {
    const fit = fitText(number, measure, usable, 1, NUMBER_SIZES);
    y -= fit.size;
    page.drawText(fit.lines[0] ?? number, {
      x: centred(fit.lines[0] ?? number, fit.size), y, size: fit.size, font, color: black,
    });
    y -= 14;
  }

  if (title) {
    const fit = fitText(title, measure, usable, 3, TITLE_SIZES);
    for (const line of fit.lines) {
      y -= fit.size * 1.12;
      page.drawText(line, { x: centred(line, fit.size), y, size: fit.size, font, color: black });
    }
    // fitText only truncates when nothing fits at any size. Say so on the page: a clipped title
    // that looks complete is worse than a small one, because it reads as the whole SKU name.
    if (fit.truncated) {
      const note = '(NAME CLIPPED — CHECK LABEL)';
      y -= 20;
      page.drawText(note, { x: centred(note, 10), y, size: 10, font, color: black });
    }
  }

  // The count, anchored to the bottom rather than following the title, so its position is
  // constant across slips and the eye learns where to find it.
  const countText = `${slip.count} ${slip.count === 1 ? 'LABEL' : 'LABELS'}`;
  const countSize = 26;
  page.drawText(countText, {
    x: centred(countText, countSize), y: MARGIN + BORDER + 18, size: countSize, font, color: black,
  });

  // A hairline above the count separates it from the title block without another heavy rule.
  page.drawLine({
    start: { x: pad, y: MARGIN + BORDER + 18 + countSize + 6 },
    end: { x: size.width - pad, y: MARGIN + BORDER + 18 + countSize + 6 },
    thickness: 1.5, color: black,
  });

}
