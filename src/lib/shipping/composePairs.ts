// Compose OUR batch print: a strict pair of 4x6 pages per box/package — the TikTok shipping
// label, then our pick slip (order-id Code128 + internal SKU lines). Pure pdf-lib (Vercel Node
// runtime); no network. The route fetches the label bytes + builds SlipModel; this file draws.
//
// The label PDF is native A6 (298x420pt); US 4x6 is 288x432 — so the label is SCALED to fit,
// aspect-preserved, centered. A6_FIT is that factor (printed in the job output, never guessed).

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { code128ToSvg } from '@/lib/barcode/code128';

// US 4x6 thermal page, in points (72/in).
export const PAGE = { w: 288, h: 432 } as const;

// Pair order for a package: label then slip. SINGLE named constant so it can be flipped after a
// real print run without touching any layout code.
export const PAIR_ORDER: readonly ('label' | 'slip')[] = ['label', 'slip'];

const BLACK = rgb(0, 0, 0);
const RED = rgb(0.69, 0, 0);
const MARGIN = 14;

// pdf-lib standard fonts are WinAnsi — they throw on emoji / general-punctuation (⚠, em-dash,
// smart quotes) which appear in product titles and our own labels. Transliterate to a safe set
// before ANY measure/draw so a stray glyph never aborts a whole batch.
function asc(s: string): string {
  return s
    .replace(/[‘’‛]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—―]/g, '-').replace(/×/g, 'x')
    .replace(/•/g, '-').replace(/…/g, '...').replace(/[⚠️]/g, '!')
    .replace(/[^\x20-\xFF]/g, '?'); // any remaining non-Latin1 glyph → ?
}

// Scale a source page into 4x6, aspect-preserved and centered. Exposed so the job can report it.
export function labelFit(srcW: number, srcH: number) {
  const scale = Math.min(PAGE.w / srcW, PAGE.h / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return { scale, w, h, x: (PAGE.w - w) / 2, y: (PAGE.h - h) / 2 };
}
// The A6 label fit factor — 298x420 → 4x6. scale ≈ 0.9664 (label ends up 288 x 405.9, centered).
export const A6_FIT = labelFit(298, 420);

// The slip carries NO per-item lines — the handheld is the item authority. It shows the box's
// scan key + tracking + an AUTHORITATIVE item COUNT (Σqty from the FULL resolved box) + box-level
// warnings. When the box has no reliable physical key (package_id reconciliation failed / no
// tracking), the count cannot be trusted → print UNVERIFIABLE instead of a confident number.
export interface SlipModel {
  orderId: string;            // Code128 value (any box-mate resolves the box on scan)
  tracking: string | null;    // human-readable, for eyeball slip↔label match (no scan needed)
  boxIndex: number;           // 1-based
  boxTotal: number;
  orderCount: number;         // orders in the FULL resolved box
  packageLabel: string | null; // "Package 1 of 2" for multi-package boxes; null when single
  itemCount: number | null;   // authoritative Σqty across the full box; null when unverifiable
  unverifiable: boolean;      // no reliable key / reconciliation disagreement → confirm on device
  setAside: boolean;          // ≥1 unbound-auction order in the box
  unresolvedCount: number;    // # unbound-auction orders
  catalogCount: number;       // # catalog orders (informational)
}
export interface ErrorSheetModel {
  orderId: string;
  tracking: string | null;
  boxIndex: number;
  boxTotal: number;
  reason: string;             // human-readable failure reason
  terminal: boolean;          // post-pickup / no-reprint (surface distinctly from transient)
}

export interface Fonts { reg: PDFFont; bold: PDFFont; mono: PDFFont; monoBold: PDFFont; }
export async function embedFonts(doc: PDFDocument): Promise<Fonts> {
  return {
    reg: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    mono: await doc.embedFont(StandardFonts.Courier),
    monoBold: await doc.embedFont(StandardFonts.CourierBold),
  };
}

// Parse the black bars out of code128ToSvg (module units) so we can draw them as pdf-lib rects.
function code128Bars(value: string): { bars: { x: number; w: number }[]; width: number } {
  const svg = code128ToSvg(value, { moduleWidth: 1, barHeight: 1, quietModules: 10, caption: '' });
  const vb = svg.match(/viewBox="0 0 ([\d.]+) /);
  const width = vb ? parseFloat(vb[1]) : 0;
  const g = svg.match(/<g fill="#000">([\s\S]*?)<\/g>/);
  const bars: { x: number; w: number }[] = [];
  if (g) for (const m of g[1].matchAll(/<rect x="([\d.]+)" y="0" width="([\d.]+)"/g)) {
    bars.push({ x: parseFloat(m[1]), w: parseFloat(m[2]) });
  }
  return { bars, width };
}
function drawBarcode(page: PDFPage, value: string, centerX: number, y: number, targetW: number, height: number) {
  const { bars, width } = code128Bars(value);
  if (!width) return;
  const s = targetW / width;
  const x0 = centerX - targetW / 2;
  for (const b of bars) page.drawRectangle({ x: x0 + b.x * s, y, width: b.w * s, height, color: BLACK });
}
const center = (page: PDFPage, text: string, font: PDFFont, size: number, y: number, color = BLACK) => {
  const t = asc(text);
  const w = font.widthOfTextAtSize(t, size);
  page.drawText(t, { x: (PAGE.w - w) / 2, y, size, font, color });
};

// Word-wrap (with hard-break for over-long tokens) to a max width.
function wrap(font: PDFFont, text: string, size: number, maxW: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const word of asc(text).split(/\s+/)) {
    const test = cur ? `${cur} ${word}` : word;
    if (font.widthOfTextAtSize(test, size) <= maxW) { cur = test; continue; }
    if (cur) { out.push(cur); cur = ''; }
    if (font.widthOfTextAtSize(word, size) > maxW) {
      let s = word;
      while (s && font.widthOfTextAtSize(s, size) > maxW) {
        let i = s.length;
        while (i > 1 && font.widthOfTextAtSize(s.slice(0, i), size) > maxW) i--;
        out.push(s.slice(0, i)); s = s.slice(i);
      }
      cur = s;
    } else cur = word;
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

// Draw the slip as a SINGLE 4x6 page: scan key + tracking + authoritative COUNT (or UNVERIFIABLE)
// + box-level warnings. No per-item lines — the handheld is the item authority, so there is
// nothing to under-list. Returns 1 (kept for the caller's page-count bookkeeping).
export function addSlipPage(doc: PDFDocument, f: Fonts, s: SlipModel): number {
  const page = doc.addPage([PAGE.w, PAGE.h]);
  drawBarcode(page, s.orderId, PAGE.w / 2, 432 - MARGIN - 50, 250, 50);
  center(page, `#${s.orderId}`, f.monoBold, 14, 360);
  center(page, s.tracking ? `TRACKING ${s.tracking}` : 'TRACKING —', f.mono, 8.5, 346);
  const meta = `Box ${s.boxIndex} of ${s.boxTotal}${s.packageLabel ? ` · ${s.packageLabel}` : ''} · ${s.orderCount} order${s.orderCount === 1 ? '' : 's'}`;
  center(page, meta, f.reg, 9, 333);

  // The count block (or UNVERIFIABLE) — the middle of the slip, the thing the picker reconciles.
  if (s.unverifiable || s.itemCount == null) {
    page.drawRectangle({ x: MARGIN, y: 250, width: PAGE.w - 2 * MARGIN, height: 46, color: RED });
    for (const [i, ln] of ['! BOX COMPOSITION', 'UNVERIFIABLE', 'confirm on device'].entries()) {
      const size = i === 2 ? 11 : 15;
      const w = f.bold.widthOfTextAtSize(ln, size);
      page.drawText(ln, { x: (PAGE.w - w) / 2, y: 278 - i * 15, size, font: f.bold, color: rgb(1, 1, 1) });
    }
  } else {
    center(page, String(s.itemCount), f.bold, 64, 250, BLACK);
    center(page, `item${s.itemCount === 1 ? '' : 's'} — verify count on device`, f.reg, 10, 232);
  }

  // Box-level warnings (from the FULL resolved box, never the scanned order alone).
  let y = 205;
  if (s.setAside) {
    page.drawRectangle({ x: MARGIN, y: y - 3, width: PAGE.w - 2 * MARGIN, height: 16, color: RED });
    const t = asc(`⚠ SET ASIDE — ${s.unresolvedCount} unresolved auction order${s.unresolvedCount === 1 ? '' : 's'}`);
    const w = f.bold.widthOfTextAtSize(t, 9.5);
    page.drawText(t, { x: (PAGE.w - w) / 2, y: y + 1, size: 9.5, font: f.bold, color: rgb(1, 1, 1) });
    y -= 22;
  }
  if (s.catalogCount > 0) { center(page, `includes ${s.catalogCount} catalog item${s.catalogCount === 1 ? '' : 's'}`, f.reg, 9, y); }
  return 1;
}

// Embed a fetched label PDF's first page, scaled+centered to 4x6. Returns the fit used.
export async function addLabelPage(doc: PDFDocument, labelPdfBytes: Uint8Array) {
  const [emb] = await doc.embedPdf(labelPdfBytes, [0]);
  const fit = labelFit(emb.width, emb.height);
  const page = doc.addPage([PAGE.w, PAGE.h]);
  page.drawPage(emb, { x: fit.x, y: fit.y, width: fit.w, height: fit.h });
  return { srcW: emb.width, srcH: emb.height, ...fit };
}

// An explicit error sheet takes the failed package's slot so paper count == box count.
export function addErrorSheet(doc: PDFDocument, f: Fonts, e: ErrorSheetModel) {
  const page = doc.addPage([PAGE.w, PAGE.h]);
  center(page, '⚠', f.bold, 60, 344, RED);
  center(page, 'LABEL UNAVAILABLE', f.bold, 16, 320, RED);
  if (e.terminal) {
    center(page, 'ALREADY PICKED UP — NO REPRINT', f.bold, 10.5, 302, RED);
    center(page, 'Ship on current process. Do not reprint here.', f.reg, 9, 290);
  } else {
    center(page, 'Retry this batch same-day, pre-pickup.', f.reg, 9, 302);
  }
  for (const [i, ln] of wrap(f.reg, e.reason, 9, PAGE.w - 2 * MARGIN).entries()) {
    center(page, ln, f.reg, 9, 274 - i * 12);
  }
  drawBarcode(page, e.orderId, PAGE.w / 2, 150, 250, 46);
  center(page, `#${e.orderId}`, f.monoBold, 12, 136);
  center(page, e.tracking ? `TRACKING ${e.tracking}` : 'TRACKING —', f.mono, 8.5, 124);
  center(page, `Box ${e.boxIndex} of ${e.boxTotal}`, f.reg, 8.5, 112);
}
