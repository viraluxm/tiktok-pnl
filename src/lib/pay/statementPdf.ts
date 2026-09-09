import {
  formatBreak,
  formatClock12,
  formatMoney,
  payPeriodWeeks,
  type DayGroup,
  type PayStatement,
  type PeriodWeek,
  type StatementRow,
} from './statement';

// THE EMPLOYEE PAYROLL HOURS STATEMENT. It RENDERS a PayStatement and computes no payroll of its
// own — every hour, rate and dollar on the page is read straight off the object the screen shows.
// There is deliberately no `shifts` type and no `lib/employees` import in this file, so it cannot
// re-derive a number even by accident; the tests assert that structurally. Week and day grouping
// comes from payPeriodWeeks() in the model, which is the same grouping the Pay Details panel reads,
// so a day's hours on paper are that day's hours on screen.
//
// LAYOUT follows the payroll statement this team already issues by hand: a centred title, a
// two-column identity block, then the whole 14-day period as Week 1 and Week 2 tables with EVERY
// calendar day present — a day nobody worked reads "Off / Off / — / 0.00", which is information,
// not an omission — each week subtotalled, and a summary of total hours, rate and gross pay.
//
// WHY pdf-lib AND NOT A PRINTED WEB PAGE. pdf-lib is already a production dependency (shipping
// labels), so this adds nothing to install. It writes 612x792 into the MediaBox, which IS 8.5x11 —
// with window.print() the page size, margins and scale live in the operator's print dialog and the
// browser adds its own header chrome. And it draws in Helvetica's standard-14 metrics, which are
// part of the PDF format, so a statement re-printed next year lays out identically instead of
// reflowing to whatever font that machine resolves.
//
// Print uses this same document rather than an HTML twin, so "Print" and "Download PDF" are
// byte-identical by construction instead of two renderers kept in sync by hand.
//
// DETERMINISTIC. The only time in the document is statement.generatedAtISO, which the caller
// supplies; the PDF's own Creation/Modification dates are set from it too.

// ── Branding ─────────────────────────────────────────────────────────────────────────────────
//
// THE ARTWORK IS THE SUPPLIED LOCKUP, UNCHANGED. `public/viralux-lockup.png` is `Viralux Logo.ai`'s
// own mark-over-wordmark lockup, cropped to its artwork bounding box and nothing else — the
// proportions, the internal spacing and the wordmark are exactly as supplied. It reads clearly at
// the 58pt header height used here; the wordmark spans almost the full width of the lockup, so it
// survives the reduction far better than the 8:1 height ratio suggests.
//
// TWO THINGS THE MASTER CANNOT DO, both verified rather than assumed:
//   * It cannot be embedded as vector. The .ai IS a PDF and pdf-lib's embedPdf() reads it happily,
//     but the artboard carries a full-bleed charcoal rectangle behind the white artwork, so it
//     lands on a white payroll sheet as a dark block (rendered and looked at). It also costs
//     ~1.1MB per document. Cropping the embedded page does not help: the fill is behind the mark,
//     not around it.
//   * It cannot be used at its supplied polarity. White-on-charcoal prints as that same block.
// So the shipped PNG is the master with its luminance taken as ALPHA — the ground's own luminance
// remapped to fully transparent, which is what stops a grey haze washing over the page — and flat
// brand charcoal #373535, sampled from the master, as the ink. Shapes untouched, nothing redrawn.
//
// It is a normal file under public/, not base64 in a source file, and it is FETCHED because the
// document is built in the browser. A failure to load leaves the rest of the statement intact
// rather than denying someone their payroll paperwork over a missing image.
const LOCKUP_URL = '/viralux-lockup.png';
const LOCKUP_ASPECT = 387 / 520; // the supplied lockup's own proportions

export type LogoLoader = () => Promise<Uint8Array | null>;

async function fetchLockup(): Promise<Uint8Array | null> {
  try {
    const res = await fetch(LOCKUP_URL);
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

// ── Page geometry (points; 72pt = 1in) ───────────────────────────────────────────────────────
const PAGE_W = 612; // 8.5in
const PAGE_H = 792; // 11in
const MARGIN = 46;
const CONTENT_W = PAGE_W - MARGIN * 2; // 520

// ── Paper palette ────────────────────────────────────────────────────────────────────────────
// The app's tt-* tokens are a dark theme and are unreadable on white, so paper gets its own
// explicit palette. Ink on white, grayscale-safe: nothing on this page depends on colour to be
// understood, which is how payroll paperwork is actually printed.
const INK = hex(0x11, 0x11, 0x11);
const MUTED = hex(0x5f, 0x5f, 0x5f);
const RULE = hex(0x99, 0x99, 0x99);
const HEAD_BG = hex(0xf0, 0xf0, 0xf0);

function hex(r: number, g: number, b: number) {
  return { r: r / 255, g: g / 255, b: b / 255 };
}

// ── Week table columns ───────────────────────────────────────────────────────────────────────
interface Col {
  key: 'date' | 'day' | 'in' | 'out' | 'break' | 'hours';
  header: string;
  w: number;
  align: 'left' | 'center' | 'right';
}
const COLS: Col[] = [
  { key: 'date', header: 'Date', w: 104, align: 'center' },
  { key: 'day', header: 'Day', w: 96, align: 'center' },
  { key: 'in', header: 'Time In', w: 104, align: 'center' },
  { key: 'out', header: 'Time Out', w: 112, align: 'center' },
  { key: 'break', header: 'Break', w: 52, align: 'center' },
  { key: 'hours', header: 'Hours', w: 52, align: 'center' },
];

// Sized so a normal two-week period — 14 day rows plus a handful of second records — lands on ONE
// Letter page, signatures included. The reference statement this follows is a single page and a
// payroll sheet that spills for no reason is worse paperwork.
const ROW_H = 16;
const HEAD_H = 17;
const FOOTER_RESERVE = 22;

// Minimal structural types for the bits of pdf-lib this file touches. Local so the module can be
// transpiled and unit-tested without resolving the package.
interface PdfFont {
  widthOfTextAtSize(text: string, size: number): number;
}
interface PdfPage {
  drawText(text: string, o: Record<string, unknown>): void;
  drawLine(o: Record<string, unknown>): void;
  drawRectangle(o: Record<string, unknown>): void;
  drawImage(img: unknown, o: Record<string, unknown>): void;
}

/** Truncate to fit `maxW`, with an ellipsis, so a long name can never run into the next column. */
export function fitText(text: string, font: PdfFont, size: number, maxW: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxW) return text;
  let out = text;
  while (out.length > 1 && font.widthOfTextAtSize(out + '…', size) > maxW) out = out.slice(0, -1);
  return out + '…';
}

/** 'August 24' — the long form the printed statement reads in. */
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
export function formatLongDate(dateISO: string): string {
  return `${MONTHS[Number(dateISO.slice(5, 7)) - 1]} ${Number(dateISO.slice(8, 10))}`;
}

/** 'August 24 - September 6' / with years when the period straddles one. */
export function formatPeriodRange(startISO: string, endISO: string): string {
  const a = formatLongDate(startISO);
  const b = formatLongDate(endISO);
  return startISO.slice(0, 4) === endISO.slice(0, 4)
    ? `${a} - ${b}`
    : `${a}, ${startISO.slice(0, 4)} - ${b}, ${endISO.slice(0, 4)}`;
}

/**
 * The lines one calendar day contributes to a week table.
 *
 * A day with no payable record is a single "Off" line — the reference statement's own convention,
 * and the reason every date is listed rather than only the worked ones. A day with SEVERAL records
 * gets several lines under the same date, never merged: a split shift and a hand-entered correction
 * are separate records a manager may need to edit one at a time.
 */
export function dayLines(day: DayGroup): Record<Col['key'], string>[] {
  if (day.rows.length === 0) {
    return [{ date: formatLongDate(day.dateISO), day: day.dayName, in: 'Off', out: 'Off', break: '—', hours: '0.00' }];
  }
  return day.rows.map((row, i) => ({
    // The date and day name are printed once per day; repeat lines carry the times only, so the
    // eye reads "Monday → in → out → break → hours" down a single column of dates.
    date: i === 0 ? formatLongDate(day.dateISO) : '',
    day: i === 0 ? day.dayName : '',
    in: formatClock12(row.startLabel),
    out: endCell(row),
    break: formatBreak(row.breakMinutes),
    hours: row.paidHours.toFixed(2),
  }));
}

/** '2:07 PM', or '5:44 AM (Aug 26)' when the shift ended on a later calendar day. */
function endCell(row: StatementRow): string {
  const t = formatClock12(row.endLabel);
  if (!row.endDateISO) return t;
  const short = `${MONTHS[Number(row.endDateISO.slice(5, 7)) - 1].slice(0, 3)} ${Number(row.endDateISO.slice(8, 10))}`;
  return `${t} (${short})`;
}

/**
 * Build the payroll hours statement PDF for an ALREADY-NORMALIZED statement.
 *
 * pdf-lib is imported dynamically: it is ~350KB and has no business in the dashboard bundle until
 * someone actually asks for a document. Same treatment the shipping-label panel gives it.
 */
export async function renderPayStatementPdf(
  statement: PayStatement,
  /** Overridable so tests can supply the asset from disk; production fetches it from public/. */
  opts: { loadLogo?: LogoLoader } = {},
): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const C = (c: { r: number; g: number; b: number }) => rgb(c.r, c.g, c.b);
  const logoBytes = await (opts.loadLogo ?? fetchLockup)();
  const logo = logoBytes ? await doc.embedPng(logoBytes) : null;

  const generated = new Date(statement.generatedAtISO);
  doc.setTitle(`Employee Payroll Hours Statement — ${statement.employee.name}`);
  doc.setAuthor('Viralux Media');
  doc.setProducer('Viralux Media');
  doc.setCreator('Viralux Media');
  doc.setSubject(`Pay period ${statement.period.start} to ${statement.period.end}`);
  doc.setCreationDate(generated);
  doc.setModificationDate(generated);

  const pages: PdfPage[] = [];
  let page = addPage();
  let y = PAGE_H - MARGIN;

  function addPage(): PdfPage {
    const p = doc.addPage([PAGE_W, PAGE_H]) as unknown as PdfPage;
    pages.push(p);
    return p;
  }

  // Reserve vertical room; start a new page when this block will not fit.
  function need(h: number): void {
    if (y - h >= MARGIN + FOOTER_RESERVE) return;
    page = addPage();
    y = PAGE_H - MARGIN;
  }

  const text = (
    s: string,
    x: number,
    baseline: number,
    size: number,
    font: PdfFont,
    color: typeof INK,
  ) => page.drawText(s, { x, y: baseline, size, font, color: C(color) });

  const centred = (s: string, cx: number, baseline: number, size: number, font: PdfFont, color: typeof INK) =>
    text(s, cx - font.widthOfTextAtSize(s, size) / 2, baseline, size, font, color);

  // ── Masthead: the supplied lockup top-left, title centred on the page beside it ─────────────
  // The lockup is portrait and narrow (43pt wide at 58pt tall), and the centred title spans roughly
  // x 137-475, so the two share one band without touching — which is both the layout of the
  // statement this follows and cheaper in height than stacking them.
  const LOGO_H = 58;
  if (logo) {
    page.drawImage(logo, {
      x: MARGIN,
      y: y - LOGO_H,
      width: LOGO_H * LOCKUP_ASPECT,
      height: LOGO_H,
    });
  }
  centred('EMPLOYEE PAYROLL HOURS STATEMENT', PAGE_W / 2, y - 36, 17, bold, INK);
  y -= LOGO_H + 8;
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_W - MARGIN, y },
    thickness: 1.6,
    color: C(INK),
  });

  // ── Identity block: two columns of label/value, as the reference statement has it ───────────
  y -= 17;
  const LABEL_X = MARGIN;
  const VALUE_X = MARGIN + 118;
  const R_LABEL_X = MARGIN + 300;
  const R_VALUE_X = MARGIN + 400;
  const LINE = 16;

  const pair = (label: string, value: string, lx: number, vx: number, baseline: number, maxW: number) => {
    text(label, lx, baseline, 9.5, bold, INK);
    text(fitText(value, regular, 9.5, maxW), vx, baseline, 9.5, regular, INK);
  };

  pair('Employee Name:', statement.employee.name, LABEL_X, VALUE_X, y, 170);
  pair('Pay Period:', formatPeriodRange(statement.period.start, statement.period.end), R_LABEL_X, R_VALUE_X, y, 166);
  y -= LINE;
  pair('Department:', titleCase(statement.employee.role) || '—', LABEL_X, VALUE_X, y, 170);
  // Deliberately NOT here: payment method, cash paid, taxes, deductions, net pay. The reference
  // statement carries some of those, but this product stores none of them, and a payroll document
  // must not state a number the system cannot stand behind.
  pair('Payday:', formatLongDate(statement.period.payday), R_LABEL_X, R_VALUE_X, y, 166);
  y -= LINE;
  pair('Pay Schedule:', 'Biweekly', LABEL_X, VALUE_X, y, 170);
  pair('Generated:', statement.generatedAtISO.slice(0, 10), R_LABEL_X, R_VALUE_X, y, 166);

  y -= 11;
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_W - MARGIN, y },
    thickness: 1.6,
    color: C(INK),
  });
  y -= 18;

  // ── Week tables ────────────────────────────────────────────────────────────────────────────
  const weeks: PeriodWeek[] = payPeriodWeeks(statement);

  function drawTableHead(): void {
    page.drawRectangle({
      x: MARGIN,
      y: y - HEAD_H,
      width: CONTENT_W,
      height: HEAD_H,
      color: C(HEAD_BG),
      borderColor: C(RULE),
      borderWidth: 0.7,
    });
    let x = MARGIN;
    for (const col of COLS) {
      centred(col.header, x + col.w / 2, y - HEAD_H + 5.5, 8.5, bold, INK);
      if (x > MARGIN) {
        page.drawLine({ start: { x, y }, end: { x, y: y - HEAD_H }, thickness: 0.7, color: C(RULE) });
      }
      x += col.w;
    }
    y -= HEAD_H;
  }

  function drawCells(cells: Record<Col['key'], string>): void {
    page.drawRectangle({
      x: MARGIN,
      y: y - ROW_H,
      width: CONTENT_W,
      height: ROW_H,
      borderColor: C(RULE),
      borderWidth: 0.5,
    });
    let x = MARGIN;
    for (const col of COLS) {
      const value = cells[col.key];
      if (value) centred(fitText(value, regular, 8.5, col.w - 6), x + col.w / 2, y - ROW_H + 5.5, 8.5, regular, INK);
      if (x > MARGIN) {
        page.drawLine({ start: { x, y }, end: { x, y: y - ROW_H }, thickness: 0.5, color: C(RULE) });
      }
      x += col.w;
    }
    y -= ROW_H;
  }

  for (const week of weeks) {
    const lines = week.days.flatMap(dayLines);
    // Keep a week's heading with at least its header row and first two lines; a heading stranded
    // at the foot of a page is the one break that always looks like a mistake.
    need(14 + HEAD_H + ROW_H * Math.min(lines.length, 2) + 8);
    text(
      `Week ${week.index}: ${formatPeriodRange(week.start, week.end)}`,
      MARGIN,
      y - 12,
      12.5,
      bold,
      INK,
    );
    y -= 18;
    drawTableHead();
    for (const cells of lines) {
      need(ROW_H + ROW_H); // the subtotal must not be orphaned either
      drawCells(cells);
    }

    // Week subtotal: label spanning the first four columns, value in the Hours column.
    const hoursColX = MARGIN + COLS.slice(0, 5).reduce((n, c) => n + c.w, 0);
    page.drawRectangle({
      x: MARGIN,
      y: y - ROW_H,
      width: CONTENT_W,
      height: ROW_H,
      borderColor: C(RULE),
      borderWidth: 0.7,
    });
    const label = `Week ${week.index} Total Hours:`;
    text(label, hoursColX - 8 - bold.widthOfTextAtSize(label, 9), y - ROW_H + 5.5, 9, bold, INK);
    page.drawLine({
      start: { x: hoursColX, y },
      end: { x: hoursColX, y: y - ROW_H },
      thickness: 0.7,
      color: C(RULE),
    });
    centred(week.hours.toFixed(2), hoursColX + COLS[5].w / 2, y - ROW_H + 5.5, 9, bold, INK);
    y -= ROW_H + 16;
  }

  // ── Summary ────────────────────────────────────────────────────────────────────────────────
  const SUM_ROWS: [string, string][] = [
    ['Total Hours This Pay Period:', statement.totals.paidHours.toFixed(2)],
    ['Hourly Rate:', formatMoney(statement.rate)],
    ['Gross Pay:', formatMoney(statement.totals.gross)],
  ];
  need(ROW_H * (SUM_ROWS.length + 1) + 6);
  const SPLIT = MARGIN + 288;
  for (const [label, value] of SUM_ROWS) {
    page.drawRectangle({
      x: MARGIN,
      y: y - ROW_H,
      width: CONTENT_W,
      height: ROW_H,
      borderColor: C(RULE),
      borderWidth: 0.7,
    });
    page.drawLine({ start: { x: SPLIT, y }, end: { x: SPLIT, y: y - ROW_H }, thickness: 0.7, color: C(RULE) });
    text(label, MARGIN + 8, y - ROW_H + 5.5, 9.5, bold, INK);
    text(value, SPLIT + 8, y - ROW_H + 5.5, 9.5, bold, INK);
    y -= ROW_H;
  }
  // Notes row — a writable space on a printed sheet, kept because it costs one line.
  page.drawRectangle({
    x: MARGIN,
    y: y - ROW_H,
    width: CONTENT_W,
    height: ROW_H,
    borderColor: C(RULE),
    borderWidth: 0.7,
  });
  page.drawLine({ start: { x: SPLIT, y }, end: { x: SPLIT, y: y - ROW_H }, thickness: 0.7, color: C(RULE) });
  text('Notes:', MARGIN + 8, y - ROW_H + 5.5, 9.5, bold, INK);
  y -= ROW_H + 20;

  // ── Signatures ─────────────────────────────────────────────────────────────────────────────
  need(40);
  const sigLine = (label: string, x: number, lineW: number, baseline: number) => {
    text(label, x, baseline, 9, regular, INK);
    const lx = x + regular.widthOfTextAtSize(label, 9) + 8;
    page.drawLine({
      start: { x: lx, y: baseline - 2 },
      end: { x: lx + lineW, y: baseline - 2 },
      thickness: 0.7,
      color: C(RULE),
    });
  };
  sigLine('Employee Signature:', MARGIN, 168, y);
  sigLine('Date:', MARGIN + 330, 132, y);
  y -= 22;
  sigLine('Employer/Manager Signature:', MARGIN, 168, y);

  // ── Footer on every page ───────────────────────────────────────────────────────────────────
  const total = pages.length;
  pages.forEach((p, i) => {
    const left = `${statement.employee.name} · ${formatPeriodRange(statement.period.start, statement.period.end)}`;
    p.drawText(fitText(left, regular, 7.5, CONTENT_W - 150), {
      x: MARGIN,
      y: MARGIN - 12,
      size: 7.5,
      font: regular,
      color: C(MUTED),
    });
    const pn = `Page ${i + 1} of ${total}`;
    p.drawText(pn, {
      x: PAGE_W - MARGIN - regular.widthOfTextAtSize(pn, 7.5),
      y: MARGIN - 12,
      size: 7.5,
      font: regular,
      color: C(MUTED),
    });
  });

  return doc.save();
}

function titleCase(s: string): string {
  return s ? s.replace(/\b\w/g, (c) => c.toUpperCase()) : '';
}
