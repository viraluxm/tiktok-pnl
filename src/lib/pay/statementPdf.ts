import {
  formatBreak,
  formatClock12,
  formatDayLabel,
  formatMoney,
  type PayStatement,
  type StatementRow,
} from './statement';

// THE PAY STATEMENT DOCUMENT. It RENDERS a PayStatement and computes no payroll of its own —
// every hour, rate and dollar on the page is read straight off the object the screen is showing.
// There is deliberately no `shifts` type in this file's imports: it cannot see a raw row, so it
// cannot re-derive one. Give it a different statement and you get a different document; give it
// the same statement and you get the same bytes.
//
// WHY pdf-lib AND NOT A PRINTED WEB PAGE. pdf-lib is already a production dependency of this repo
// (shipping labels), so this adds nothing to install. It writes 612x792 into the MediaBox, which
// IS 8.5x11 — with window.print() the page size, margins and scale live in the operator's print
// dialog and the browser adds its own header chrome. And it draws in Helvetica's standard-14
// metrics, which are part of the PDF format itself, so a statement re-printed next year lays out
// identically instead of reflowing to whatever font that machine resolves. A pay record should not
// depend on the reader's browser.
//
// Print uses this same document rather than an HTML twin, so "Print" and "Download PDF" are
// byte-identical by construction instead of two renderers kept in sync by hand.
//
// DETERMINISTIC. The only time in the document is statement.generatedAtISO, which the caller
// supplies; the PDF's own Creation/Modification dates are set from it too, so building the same
// statement twice produces the same file.

// ── Page geometry (points; 72pt = 1in) ───────────────────────────────────────────────────────
const PAGE_W = 612; // 8.5in
const PAGE_H = 792; // 11in
const MARGIN = 54; // 0.75in
const CONTENT_W = PAGE_W - MARGIN * 2; // 504

// ── Paper palette ────────────────────────────────────────────────────────────────────────────
//
// The app's tt-* tokens are a DARK theme (tt-text #e8e8e8 on #0f0f0f) and are unreadable on white,
// so paper gets its own explicit palette rather than an improvised reuse. It is deliberately
// ink-on-white and survives a grayscale printer, which is how most payroll paperwork is actually
// produced: colour is used for emphasis, never as the only carrier of meaning. Brand cyan appears
// once, as the rule under the masthead.
const INK = rgbHex(0x11, 0x11, 0x11); // body text
const MUTED = rgbHex(0x6b, 0x6b, 0x6b); // labels, secondary
const HAIRLINE = rgbHex(0xd8, 0xd8, 0xd8); // table rules
const ZEBRA = rgbHex(0xf5, 0xf6, 0xf7); // alternating row band
const BRAND = rgbHex(0x2f, 0x8f, 0x99); // tt-cyan #69C9D0 darkened for legibility on white
const FLAG = rgbHex(0xa8, 0x4b, 0x0a); // review marker — amber-brown, readable in grayscale

function rgbHex(r: number, g: number, b: number) {
  return { r: r / 255, g: g / 255, b: b / 255 };
}

// ── Table columns ────────────────────────────────────────────────────────────────────────────
interface Col {
  key: string;
  header: string;
  w: number;
  align: 'left' | 'right';
}
const COLS: Col[] = [
  { key: 'date', header: 'Date', w: 118, align: 'left' },
  { key: 'start', header: 'Start', w: 70, align: 'left' },
  { key: 'end', header: 'End', w: 70, align: 'left' },
  { key: 'break', header: 'Break', w: 46, align: 'right' },
  { key: 'hours', header: 'Paid Hours', w: 60, align: 'right' },
  { key: 'rate', header: 'Rate', w: 56, align: 'right' },
  { key: 'amount', header: 'Amount', w: 84, align: 'right' },
];

// Tall enough for the value line AND the source line beneath it without the two touching:
// 9pt values on a baseline at top-13, a 6.6pt source label at top-22, rule at top-26.
const ROW_H = 26;
const FOOTER_H = 46; // reserved strip at the page foot — a row is never drawn into it

/**
 * Render the Lensed mark as vector primitives.
 *
 * Neither shipped logo asset works on paper: public/logo.png is a white mark on an OPAQUE BLACK
 * square (it prints as a black block) and src/app/icon.png is white on transparency (invisible on
 * white). Drawing it costs zero bytes, scales cleanly, and — unlike reading a file from the repo's
 * untracked logos/ folder — cannot ENOENT once deployed. Proportions are measured from
 * public/logo.png (500x496): two equal circles on a diagonal, with the axis extended past the
 * upper one.
 */
function drawMark(page: PdfPage, x: number, yTop: number, size: number, color: unknown) {
  const px = (u: number) => x + u * size;
  const py = (v: number) => yTop - v * size; // PDF y grows upward; v is measured downward
  const r = 0.204 * size;
  // The axis first, so the filled circles sit on top of it.
  page.drawLine({
    start: { x: px(0.30), y: py(0.67) },
    end: { x: px(0.96), y: py(0.11) },
    thickness: Math.max(0.9, size * 0.045),
    color,
  });
  page.drawCircle({ x: px(0.240), y: py(0.744), size: r, color });
  page.drawCircle({ x: px(0.650), y: py(0.383), size: r, color });
}

// Minimal structural types for the bits of pdf-lib this file touches. Kept local so the module
// can be transpiled and unit-tested without resolving the package.
interface PdfFont {
  widthOfTextAtSize(text: string, size: number): number;
}
interface PdfPage {
  drawText(text: string, o: Record<string, unknown>): void;
  drawLine(o: Record<string, unknown>): void;
  drawRectangle(o: Record<string, unknown>): void;
  drawCircle(o: Record<string, unknown>): void;
}

/** Truncate to fit `maxW`, with an ellipsis, so a long name can never run into the next column. */
export function fitText(text: string, font: PdfFont, size: number, maxW: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxW) return text;
  let out = text;
  while (out.length > 1 && font.widthOfTextAtSize(out + '…', size) > maxW) out = out.slice(0, -1);
  return out + '…';
}

/** Greedy word wrap into lines that each fit `maxW`. Long single words are hard-split. */
export function wrapText(text: string, font: PdfFont, size: number, maxW: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= maxW) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    if (font.widthOfTextAtSize(w, size) <= maxW) {
      line = w;
    } else {
      let chunk = '';
      for (const ch of w) {
        if (font.widthOfTextAtSize(chunk + ch, size) > maxW) {
          lines.push(chunk);
          chunk = ch;
        } else chunk += ch;
      }
      line = chunk;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** 'Aug 24 – Sep 6, 2026'. */
export function formatPeriodRange(startISO: string, endISO: string): string {
  const a = formatDayLabel(startISO).replace(/^\w+ /, '');
  const b = formatDayLabel(endISO).replace(/^\w+ /, '');
  const yearA = startISO.slice(0, 4);
  const yearB = endISO.slice(0, 4);
  return yearA === yearB ? `${a} – ${b}, ${yearB}` : `${a}, ${yearA} – ${b}, ${yearB}`;
}

/** 'Aug 24' from '2026-08-24' — for the '(Aug 26)' suffix on an end that lands on another day. */
function shortDay(dateISO: string): string {
  return formatDayLabel(dateISO).replace(/^\w+ /, '');
}

/** The cell strings for one row. Pure — the PDF and any future renderer read the same text. */
export function rowCells(row: StatementRow): Record<string, string> {
  return {
    date: formatDayLabel(row.dateISO),
    start: formatClock12(row.startLabel),
    end: row.endDateISO
      ? `${formatClock12(row.endLabel)} (${shortDay(row.endDateISO)})`
      : formatClock12(row.endLabel),
    break: formatBreak(row.breakMinutes),
    hours: row.paidHours.toFixed(2),
    rate: formatMoney(row.rate),
    amount: formatMoney(row.amount),
  };
}

/**
 * Build the pay statement PDF for an ALREADY-NORMALIZED statement.
 *
 * pdf-lib is imported dynamically: it is ~350KB and has no business in the dashboard bundle until
 * someone actually asks for a document. This is the same treatment the shipping-label panel gives
 * it.
 */
export async function renderPayStatementPdf(statement: PayStatement): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const C = (c: { r: number; g: number; b: number }) => rgb(c.r, c.g, c.b);

  // Deterministic metadata — never `new Date()`. Same statement in, same bytes out.
  const generated = new Date(statement.generatedAtISO);
  doc.setTitle(`Employee Pay Statement — ${statement.employee.name}`);
  doc.setAuthor('Lensed');
  doc.setProducer('Lensed');
  doc.setCreator('Lensed');
  doc.setSubject(`Pay period ${statement.period.start} to ${statement.period.end}`);
  doc.setCreationDate(generated);
  doc.setModificationDate(generated);

  const flagged = statement.rows.filter((r) => r.warnings.some((w) => w.tone === 'review'));
  const flaggedIds = new Set(flagged.map((r) => r.shiftId));

  const pages: PdfPage[] = [];
  const newPage = () => {
    const p = doc.addPage([PAGE_W, PAGE_H]);
    pages.push(p as unknown as PdfPage);
    return p as unknown as PdfPage;
  };

  // ── Masthead ───────────────────────────────────────────────────────────────────────────────
  function drawMasthead(page: PdfPage, full: boolean): number {
    let y = PAGE_H - MARGIN;
    drawMark(page, MARGIN, y, 26, C(INK));
    page.drawText('LENSED', {
      x: MARGIN + 34,
      y: y - 19,
      size: 16,
      font: bold,
      color: C(INK),
    });
    const title = 'Employee Pay Statement';
    page.drawText(title, {
      x: PAGE_W - MARGIN - regular.widthOfTextAtSize(title, 10),
      y: y - 14,
      size: 10,
      font: regular,
      color: C(MUTED),
    });
    y -= 30;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE_W - MARGIN, y },
      thickness: 1.4,
      color: C(BRAND),
    });
    if (!full) return y - 22;

    // Employee identity
    y -= 26;
    page.drawText(fitText(statement.employee.name, bold, 20, CONTENT_W - 190), {
      x: MARGIN,
      y: y - 15,
      size: 20,
      font: bold,
      color: C(INK),
    });
    const role = statement.employee.role
      ? statement.employee.role.replace(/\b\w/g, (c) => c.toUpperCase())
      : '—';
    page.drawText(role, { x: MARGIN, y: y - 30, size: 10, font: regular, color: C(MUTED) });

    // Period + generated, right-aligned
    const right = (text: string, dy: number, size: number, font: PdfFont, color: typeof INK) => {
      page.drawText(text, {
        x: PAGE_W - MARGIN - font.widthOfTextAtSize(text, size),
        y: y - dy,
        size,
        font,
        color: C(color),
      });
    };
    right('PAY PERIOD', 4, 7.5, bold, MUTED);
    right(formatPeriodRange(statement.period.start, statement.period.end), 17, 11, bold, INK);
    right(`Payday ${shortDay(statement.period.payday)}, ${statement.period.payday.slice(0, 4)}`, 30, 9, regular, MUTED);
    right(`Generated ${statement.generatedAtISO.slice(0, 10)}`, 42, 8, regular, MUTED);

    // ── Summary band ─────────────────────────────────────────────────────────────────────────
    y -= 52;
    const bandH = 58;
    page.drawRectangle({
      x: MARGIN,
      y: y - bandH,
      width: CONTENT_W,
      height: bandH,
      color: C(ZEBRA),
      borderColor: C(HAIRLINE),
      borderWidth: 0.7,
    });
    const cell = (label: string, value: string, cx: number, big: boolean) => {
      page.drawText(label, { x: cx, y: y - 20, size: 7.5, font: bold, color: C(MUTED) });
      page.drawText(value, {
        x: cx,
        y: y - 43,
        size: big ? 19 : 14,
        font: bold,
        color: C(INK),
      });
    };
    cell('TOTAL PAYABLE HOURS', statement.totals.paidHours.toFixed(2), MARGIN + 16, false);
    cell('HOURLY RATE', formatMoney(statement.rate), MARGIN + 172, false);
    cell('WORKED DAYS', String(statement.totals.workedDays), MARGIN + 292, false);
    const owed = formatMoney(statement.totals.gross);
    page.drawText('TOTAL OWED', {
      x: PAGE_W - MARGIN - 16 - bold.widthOfTextAtSize('TOTAL OWED', 7.5),
      y: y - 20,
      size: 7.5,
      font: bold,
      color: C(MUTED),
    });
    page.drawText(owed, {
      x: PAGE_W - MARGIN - 16 - bold.widthOfTextAtSize(owed, 19),
      y: y - 43,
      size: 19,
      font: bold,
      color: C(INK),
    });
    return y - bandH - 24;
  }

  // ── Table head ─────────────────────────────────────────────────────────────────────────────
  function drawTableHead(page: PdfPage, y: number): number {
    let x = MARGIN;
    for (const col of COLS) {
      const w = bold.widthOfTextAtSize(col.header, 7.5);
      page.drawText(col.header, {
        x: col.align === 'right' ? x + col.w - w : x,
        y,
        size: 7.5,
        font: bold,
        color: C(MUTED),
      });
      x += col.w;
    }
    page.drawLine({
      start: { x: MARGIN, y: y - 7 },
      end: { x: PAGE_W - MARGIN, y: y - 7 },
      thickness: 0.9,
      color: C(INK),
    });
    return y - 7;
  }

  // ── Body ───────────────────────────────────────────────────────────────────────────────────
  let page = newPage();
  let y = drawMasthead(page, true);

  if (statement.rows.length === 0) {
    page.drawText('No payable worked time in this pay period.', {
      x: MARGIN,
      y: y - 16,
      size: 10,
      font: regular,
      color: C(MUTED),
    });
  } else {
    page.drawText('WORKED TIME', { x: MARGIN, y: y - 2, size: 8, font: bold, color: C(INK) });
    y -= 20;
    y = drawTableHead(page, y);

    let zebra = false;
    for (const row of statement.rows) {
      if (y - ROW_H < MARGIN + FOOTER_H) {
        page = newPage();
        y = drawMasthead(page, false);
        y = drawTableHead(page, y);
      }
      const top = y;
      y -= ROW_H;
      if (zebra) {
        page.drawRectangle({
          x: MARGIN,
          y,
          width: CONTENT_W,
          height: ROW_H,
          color: C(ZEBRA),
        });
      }
      zebra = !zebra;

      const cells = rowCells(row);
      const isFlagged = flaggedIds.has(row.shiftId);
      let x = MARGIN;
      for (const col of COLS) {
        const text = cells[col.key] ?? '';
        const size = 9;
        const w = regular.widthOfTextAtSize(text, size);
        page.drawText(text, {
          x: col.align === 'right' ? x + col.w - w - 2 : x,
          y: top - 13,
          size,
          font: col.key === 'amount' ? bold : regular,
          color: C(INK),
        });
        x += col.w;
      }
      // Source label sits under the date so the table keeps seven columns and still says where
      // each row came from. A review flag rides beside it, in words as well as colour.
      const sub = isFlagged ? `${row.sourceLabel} · Needs Review` : row.sourceLabel;
      page.drawText(sub, {
        x: MARGIN,
        y: top - 22,
        size: 6.6,
        font: regular,
        color: C(isFlagged ? FLAG : MUTED),
      });
      page.drawLine({
        start: { x: MARGIN, y },
        end: { x: PAGE_W - MARGIN, y },
        thickness: 0.4,
        color: C(HAIRLINE),
      });
    }

    // ── Totals ───────────────────────────────────────────────────────────────────────────────
    y -= 4;
    const totalsRow = (label: string, hours: string, amount: string, heavy: boolean) => {
      const size = heavy ? 11 : 9;
      const font = heavy ? bold : regular;
      page.drawText(label, { x: MARGIN, y: y - 13, size, font, color: C(INK) });
      const hx = MARGIN + COLS.slice(0, 4).reduce((n, c) => n + c.w, 0);
      const hw = COLS[4].w;
      page.drawText(hours, {
        x: hx + hw - font.widthOfTextAtSize(hours, size) - 2,
        y: y - 13,
        size,
        font,
        color: C(INK),
      });
      page.drawText(amount, {
        x: PAGE_W - MARGIN - font.widthOfTextAtSize(amount, size) - 2,
        y: y - 13,
        size,
        font,
        color: C(INK),
      });
      y -= heavy ? 20 : 15;
    };

    // Rate breakdown. One line today, because one rate is all the product stores; if that ever
    // changes, the lines come from the statement, not from arithmetic done here.
    if (statement.rateLines.length > 1) {
      for (const line of statement.rateLines) {
        totalsRow(`At ${formatMoney(line.rate)}/hr`, line.hours.toFixed(2), formatMoney(line.amount), false);
      }
    }
    page.drawLine({
      start: { x: MARGIN, y: y - 1 },
      end: { x: PAGE_W - MARGIN, y: y - 1 },
      thickness: 0.9,
      color: C(INK),
    });
    y -= 3;
    totalsRow('Total owed', statement.totals.paidHours.toFixed(2), formatMoney(statement.totals.gross), true);
    page.drawText(`All hours paid at ${formatMoney(statement.rate)}/hr.`, {
      x: MARGIN,
      y: y - 2,
      size: 8,
      font: regular,
      color: C(MUTED),
    });
    y -= 18;
  }

  // ── Needs review, then everything in the period that is not in the money ─────────────────
  //
  // The same two blocks the screen shows, built from the same fields, so a manager comparing the
  // panel with the printout is reading one report in two places. NEEDS REVIEW holds exactly the
  // items statement.totals.reviewCount counts: review-tone row warnings plus every excluded row
  // that is not simply a scheduled day.
  const notes: { title: string; body: string }[] = [];
  for (const row of flagged) {
    for (const w of row.warnings) {
      if (w.tone !== 'review') continue;
      notes.push({ title: `${formatDayLabel(row.dateISO)} · ${w.label}`, body: w.detail });
    }
  }
  for (const ex of statement.excluded) {
    if (ex.reason === 'schedule_plan') continue; // the plan is not an anomaly
    notes.push({ title: `${formatDayLabel(ex.dateISO)} · ${ex.label} · not paid`, body: ex.detail });
  }

  // Start a section, breaking the page only if its heading plus its FIRST entry will not fit.
  // Demanding room for the whole block would push a section with many entries onto a fresh page
  // and leave most of this one blank; the per-entry loop below paginates the remainder.
  function startSection(title: string, color: typeof INK, firstBlockH: number): void {
    if (y - (32 + firstBlockH) < MARGIN + FOOTER_H) {
      page = newPage();
      y = drawMasthead(page, false);
    }
    y -= 12;
    page.drawText(title, { x: MARGIN, y, size: 8, font: bold, color: C(color) });
    y -= 6;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE_W - MARGIN, y },
      thickness: 0.6,
      color: C(HAIRLINE),
    });
    y -= 14;
  }

  const noteBlockH = (body: string) => 11 + wrapText(body, regular, 8, CONTENT_W - 12).length * 9.6 + 6;

  if (notes.length > 0) {
    startSection('NEEDS REVIEW', FLAG, noteBlockH(notes[0].body));
    for (const note of notes) {
      const bodyLines = wrapText(note.body, regular, 8, CONTENT_W - 12);
      if (y - noteBlockH(note.body) < MARGIN + FOOTER_H) {
        page = newPage();
        y = drawMasthead(page, false) - 12;
      }
      page.drawText(note.title, { x: MARGIN, y, size: 8.5, font: bold, color: C(INK) });
      y -= 10.5;
      for (const line of bodyLines) {
        page.drawText(line, { x: MARGIN + 12, y, size: 8, font: regular, color: C(MUTED) });
        y -= 9.6;
      }
      y -= 6;
    }
  }

  if (statement.excluded.length > 0) {
    startSection('IN THIS PERIOD BUT NOT PAID', MUTED, 12);
    for (const ex of statement.excluded) {
      if (y - 12 < MARGIN + FOOTER_H) {
        page = newPage();
        y = drawMasthead(page, false) - 12;
      }
      const when = `${formatDayLabel(ex.dateISO)}  ${formatClock12(ex.startLabel)} – ${
        ex.endLabel ? formatClock12(ex.endLabel) : '—'
      }`;
      page.drawText(when, { x: MARGIN, y, size: 8, font: regular, color: C(INK) });
      page.drawText(ex.label, { x: MARGIN + 200, y, size: 8, font: bold, color: C(MUTED) });
      y -= 12;
    }
  }

  // ── Footer on every page ───────────────────────────────────────────────────────────────────
  const total = pages.length;
  pages.forEach((p, i) => {
    p.drawLine({
      start: { x: MARGIN, y: MARGIN + 22 },
      end: { x: PAGE_W - MARGIN, y: MARGIN + 22 },
      thickness: 0.5,
      color: C(HAIRLINE),
    });
    const left =
      `${statement.employee.name} · ${formatPeriodRange(statement.period.start, statement.period.end)}`;
    p.drawText(fitText(left, regular, 7.5, CONTENT_W - 150), {
      x: MARGIN,
      y: MARGIN + 11,
      size: 7.5,
      font: regular,
      color: C(MUTED),
    });
    const note = 'Hours and pay for this period only. Gross amounts — no deductions are applied.';
    p.drawText(note, {
      x: MARGIN,
      y: MARGIN + 1,
      size: 6.5,
      font: regular,
      color: C(MUTED),
    });
    const pn = `Page ${i + 1} of ${total}`;
    p.drawText(pn, {
      x: PAGE_W - MARGIN - regular.widthOfTextAtSize(pn, 7.5),
      y: MARGIN + 11,
      size: 7.5,
      font: regular,
      color: C(MUTED),
    });
  });

  return doc.save();
}
