import { code128ToSvg } from '@/lib/barcode/code128';

// Printable label for one section.
//
// The barcode encodes the OPAQUE slot code and nothing else. The human address (R1A L4 S1)
// is printed as a caption for whoever is placing stock, never encoded — that separation is
// the whole reason a rack can be moved on the floor plan without invalidating a single
// printed label.
//
// Deliberately does NOT show the SKU. A section's contents change every time something sells
// out; its address does not. Putting the SKU on the label would make every reassignment a
// reprinting job, which is exactly what this design exists to avoid.

const LABEL = {
  w: '2in',
  h: '1in',
  pad: '0.06in',
  barcodeH: '0.42in',
  svgBarHeight: 64,
  addressSize: '19pt',
  codeSize: '7pt',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

export interface PrintableSection {
  slot_code: string;
  address: string;
}

function barcodeSvg(code: string): string {
  try {
    return code128ToSvg(code, { caption: '', barHeight: LABEL.svgBarHeight, moduleWidth: 2 });
  } catch {
    // A label with an unreadable barcode is still useful to a human, so fall back to the
    // code as text rather than printing a blank.
    return `<div style="font-family:monospace;font-size:9pt">${escapeHtml(code)}</div>`;
  }
}

/** Open the print dialog for one or more section labels. */
export function printSectionLabels(sections: PrintableSection[]): void {
  if (!sections.length) return;
  const win = window.open('', '_blank', 'width=560,height=520');
  if (!win) return;

  const labels = sections
    .map(
      (s) =>
        `<div class="label">` +
        `<div class="bc">${barcodeSvg(s.slot_code)}</div>` +
        `<div class="addr">${escapeHtml(s.address)}</div>` +
        `<div class="code">${escapeHtml(s.slot_code)}</div>` +
        `</div>`,
    )
    .join('');

  win.document.write(
    `<!doctype html><html><head><title>Section labels</title><style>` +
      `@page{size:${LABEL.w} ${LABEL.h};margin:0}` +
      `html,body{margin:0;padding:0;background:#fff}` +
      `.label{width:${LABEL.w};height:${LABEL.h};box-sizing:border-box;padding:${LABEL.pad};` +
      `display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0.02in;` +
      `overflow:hidden;page-break-after:always;break-after:page}` +
      `.label:last-child{page-break-after:auto;break-after:auto}` +
      `.bc{display:flex;align-items:center;justify-content:center;width:100%}` +
      `.bc svg{height:${LABEL.barcodeH};width:auto;max-width:100%}` +
      `.addr{font-family:system-ui,sans-serif;font-weight:800;font-size:${LABEL.addressSize};line-height:1}` +
      `.code{font-family:monospace;font-size:${LABEL.codeSize};color:#555;line-height:1}` +
      `</style></head><body>${labels}` +
      `<script>window.onload=function(){window.focus();window.print();}<\/script></body></html>`,
  );
  win.document.close();
}
