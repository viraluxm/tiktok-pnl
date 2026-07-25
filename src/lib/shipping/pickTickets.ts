// Print OUR OWN order-id pick tickets (one per physical box / combine-group), so pickers
// scan a barcode WE control instead of TikTok's unreliable paper. Mirrors the print-window +
// @page pattern of printSkuLabels() in src/components/inventory/InventorySection.tsx.
//
// The barcode encodes ONE order_id from the box — scanning it loads the whole box via the
// existing /api/shipping/pick-list order-id resolution (unchanged). Item lines use the
// INTERNAL sku snapshot (#number + title); orders with no bound SKU show as UNRESOLVED so the
// picker sees them on paper before walking to the rack.

import { code128ToSvg } from '@/lib/barcode/code128';

export interface PickTicketItem {
  sku_number: number | null;
  title: string;
  qty: number;
}
export interface PickTicketGroup {
  barcode_order_id: string; // the order_id encoded in the barcode (any box-mate resolves the box)
  order_ids: string[];
  order_count: number;
  items: PickTicketItem[]; // aggregated bound SKUs across every order in the box
  unresolved_count: number; // orders in the box with no bound SKU
}

const escapeHtml = (s: string) =>
  s.replace(/[<>&]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'));

// Barcode of the order_id. Falls back to plain text if a char is unencodable (order_ids are
// numeric, so this never trips in practice — same defensive guard as skuBarcodeSvg).
function orderBarcodeSvg(orderId: string): string {
  try {
    return code128ToSvg(orderId, { caption: '', barHeight: 70, moduleWidth: 2 });
  } catch {
    return `<div style="font-family:monospace;font-size:11pt">${escapeHtml(orderId)}</div>`;
  }
}

// Open a print window with one 4×6 ticket per box. Same shape as printSkuLabels: an @page rule
// sizes the output and each ticket is one page.
export function printOrderTickets(groups: PickTicketGroup[]) {
  if (!groups.length) return;
  const win = window.open('', '_blank', 'width=560,height=720');
  if (!win) return;

  const tickets = groups
    .map((g) => {
      const itemLines = g.items
        .map(
          (it) =>
            `<div class="item"><span class="num">#${it.sku_number ?? '?'}</span> ` +
            `${escapeHtml(it.title || 'Untitled')}${it.qty > 1 ? ` <b>×${it.qty}</b>` : ''}</div>`,
        )
        .join('');
      // One UNRESOLVED line per unbound order in the box (spec: picker must see it on paper).
      const unresolvedLines = Array.from({ length: g.unresolved_count })
        .map(() => `<div class="item unresolved">⚠ UNRESOLVED — no SKU bound</div>`)
        .join('');
      return (
        `<div class="ticket">` +
        `<div class="bc">${orderBarcodeSvg(g.barcode_order_id)}</div>` +
        `<div class="oid">#${escapeHtml(g.barcode_order_id)}</div>` +
        (g.order_count > 1 ? `<div class="cnt">${g.order_count} orders in this box</div>` : '') +
        `<div class="items">${itemLines}${unresolvedLines}</div>` +
        `</div>`
      );
    })
    .join('');

  win.document.write(
    `<!doctype html><html><head><title>Pick tickets</title><style>` +
      `@page{size:4in 6in;margin:0}` +
      `html,body{margin:0;padding:0;background:#fff;color:#000;font-family:system-ui,sans-serif}` +
      `.ticket{width:4in;height:6in;box-sizing:border-box;padding:0.18in 0.2in;` +
      `page-break-after:always;break-after:page;overflow:hidden;display:flex;flex-direction:column}` +
      `.ticket:last-child{page-break-after:auto;break-after:auto}` +
      `.bc{display:flex;align-items:center;justify-content:center}` +
      `.bc svg{height:0.7in;width:auto;max-width:100%}` +
      `.oid{font-family:monospace;font-weight:700;font-size:15pt;text-align:center;line-height:1;margin-top:2px}` +
      `.cnt{text-align:center;font-size:10pt;color:#333;margin-top:2px}` +
      `.items{margin-top:8px;font-size:11pt;line-height:1.3;overflow:hidden}` +
      `.item{padding:1px 0}.num{font-family:monospace;font-weight:700}` +
      `.unresolved{color:#b00000;font-weight:700}` +
      `</style></head><body>${tickets}` +
      `<script>window.onload=function(){window.focus();window.print();}<\/script></body></html>`,
  );
  win.document.close();
}
