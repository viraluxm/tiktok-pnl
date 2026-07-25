// Print OUR OWN order-id pick tickets (one per physical box / combine-group), so pickers
// scan a barcode WE control instead of TikTok's unreliable paper. Mirrors the print-window +
// @page pattern of printSkuLabels() in src/components/inventory/InventorySection.tsx.
//
// The barcode encodes ONE order_id from the box — scanning it loads the whole box via the
// existing /api/shipping/pick-list order-id resolution (unchanged). Item lines use the
// INTERNAL sku snapshot (#number + title); orders with no bound SKU show as UNRESOLVED so the
// picker sees them on paper before walking to the rack.
//
// NO SILENT TRUNCATION. A 4×6 ticket can hold only so many item lines; a box can carry up to
// ~16 orders' worth. Instead of clipping (overflow:hidden — a picker would hold paper that
// LOOKS complete and pack short), we PAGINATE: extra pages for the same box, each with the SAME
// order-id barcode + a "Box N — page X of Y" header + a "M items total" line, so a picker
// holding page 1 of 2 can tell paper is missing. The split is decided by LIVE MEASUREMENT in
// the print window (append each line, compare the items region's scrollHeight to its
// clientHeight) — NOT a guessed line count — so a wrapped long title correctly costs two lines.
// The geometry that measurement rides on: a 4×6in ticket minus 0.36in vertical padding minus the
// header (~0.7in barcode + order-id + page + total lines ≈ 1.4in) leaves ~3.8in ≈ 285pt of item
// area, i.e. ~17 single-height 11pt/1.3 lines — but nothing is hardcoded to 17; the DOM decides.

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

// Per-box print model handed to the in-window paginator. `lines` = resolved SKU lines + one
// UNRESOLVED line per unbound order. `totalItems` = physical pieces to gather (Σqty + unresolved)
// — printed on EVERY page as the completeness cross-check.
interface BoxModel {
  barcodeSvg: string;
  oid: string;
  orderCount: number;
  totalItems: number;
  lines: { html: string; cls: string }[];
}

function buildBox(g: PickTicketGroup): BoxModel {
  const lines: { html: string; cls: string }[] = g.items.map((it) => ({
    cls: 'item',
    html:
      `<span class="num">#${it.sku_number ?? '?'}</span> ` +
      `${escapeHtml(it.title || 'Untitled')}${it.qty > 1 ? ` <b>×${it.qty}</b>` : ''}`,
  }));
  // One UNRESOLVED line per unbound order in the box (spec: picker must see it on paper).
  for (let i = 0; i < g.unresolved_count; i++) {
    lines.push({ cls: 'item unresolved', html: '⚠ UNRESOLVED — no SKU bound' });
  }
  const totalItems = g.items.reduce((n, it) => n + (Number(it.qty) || 1), 0) + g.unresolved_count;
  return {
    barcodeSvg: orderBarcodeSvg(g.barcode_order_id),
    oid: escapeHtml(g.barcode_order_id),
    orderCount: g.order_count,
    totalItems,
    lines,
  };
}

const TICKET_CSS =
  `@page{size:4in 6in;margin:0}` +
  `html,body{margin:0;padding:0;background:#fff;color:#000;font-family:system-ui,sans-serif}` +
  // Fixed 4×6 page; items region is a flex child that shrinks (min-height:0) so overflowing
  // content is measurable (scrollHeight > clientHeight) instead of resizing the page.
  `.ticket{width:4in;height:6in;box-sizing:border-box;padding:0.18in 0.2in;` +
  `page-break-after:always;break-after:page;display:flex;flex-direction:column;overflow:hidden}` +
  `.ticket:last-child{page-break-after:auto;break-after:auto}` +
  // Fatal-fallback only: auto height lets content flow to extra printer pages, never hidden.
  `.ticket.auto{height:auto;min-height:6in;overflow:visible}` +
  `.hd{flex:0 0 auto}` +
  `.bc{display:flex;align-items:center;justify-content:center}` +
  `.bc svg{height:0.7in;width:auto;max-width:100%}` +
  `.oid{font-family:monospace;font-weight:700;font-size:15pt;text-align:center;line-height:1;margin-top:2px}` +
  `.cnt{text-align:center;font-size:10pt;color:#333;margin-top:2px}` +
  `.pg{text-align:center;font-size:9pt;color:#333;font-weight:600;margin-top:2px}` +
  `.tot{text-align:center;font-size:10pt;font-weight:700;margin-top:1px}` +
  `.items{flex:1 1 0;min-height:0;overflow:hidden;margin-top:8px;font-size:11pt;line-height:1.3}` +
  `.item{padding:1px 0}.num{font-family:monospace;font-weight:700}` +
  `.unresolved{color:#b00000;font-weight:700}` +
  `.incomplete{color:#b00000;font-weight:800}` +
  `.fallback-warn{color:#b00000;font-weight:800;font-size:11pt;padding:6px}`;

// Runs INSIDE the print window (plain ES5). Reads the box models from a JSON island, lays each
// box out page-by-page measuring real rendered height, numbers pages once Y is known, then prints.
// On any failure it falls back to auto-height blocks — content flows onto extra pages, is NEVER
// hidden — with a visible warning, so a partial-looking-complete list is impossible.
const PAGINATOR = `(function(){
  function build(box, bi){
    var pages=[];
    function header(){
      var h=document.createElement('div'); h.className='hd';
      h.innerHTML='<div class="bc">'+box.barcodeSvg+'</div>'+
        '<div class="oid">#'+box.oid+'</div>'+
        (box.orderCount>1?'<div class="cnt">'+box.orderCount+' orders in this box</div>':'')+
        '<div class="pg">Box '+(bi+1)+' \\u2014 page 1 of 1</div>'+
        '<div class="tot">'+box.totalItems+' items total</div>';
      return h;
    }
    function newPage(){
      var t=document.createElement('div'); t.className='ticket';
      t.appendChild(header());
      var items=document.createElement('div'); items.className='items';
      t.appendChild(items);
      document.getElementById('root').appendChild(t);
      var p={t:t,items:items}; pages.push(p); return p;
    }
    var pg=newPage();
    for(var i=0;i<box.lines.length;i++){
      var ln=box.lines[i];
      var node=document.createElement('div');
      node.className=ln.cls; node.innerHTML=ln.html;
      pg.items.appendChild(node);
      if(pg.items.scrollHeight>pg.items.clientHeight+1){
        if(pg.items.children.length===1){
          // A single line taller than a whole page — cannot paginate it away. Keep it visible
          // (never hidden) and flag the ticket so nobody packs a possibly-clipped list.
          var w=document.createElement('div'); w.className='item incomplete';
          w.textContent='\\u26a0 ITEM TOO LONG \\u2014 TICKET MAY BE INCOMPLETE, VERIFY BEFORE PACKING';
          pg.items.appendChild(w);
        } else {
          pg.items.removeChild(node);
          pg=newPage();
          pg.items.appendChild(node);
        }
      }
    }
    var Y=pages.length;
    for(var j=0;j<pages.length;j++){
      pages[j].t.querySelector('.pg').textContent='Box '+(bi+1)+' \\u2014 page '+(j+1)+' of '+Y;
    }
  }
  var boxes;
  try {
    boxes=JSON.parse(document.getElementById('pt-data').textContent);
    for(var i=0;i<boxes.length;i++) build(boxes[i], i);
    window.focus(); window.print();
  } catch(e){
    try {
      boxes=boxes||JSON.parse(document.getElementById('pt-data').textContent);
      var html='<div class="fallback-warn">\\u26a0 Pagination failed \\u2014 tickets may span extra pages. Verify item counts before packing.</div>';
      for(var k=0;k<boxes.length;k++){
        var b=boxes[k], li='';
        for(var m=0;m<b.lines.length;m++) li+='<div class="'+b.lines[m].cls+'">'+b.lines[m].html+'</div>';
        html+='<div class="ticket auto"><div class="bc">'+b.barcodeSvg+'</div>'+
          '<div class="oid">#'+b.oid+'</div>'+
          (b.orderCount>1?'<div class="cnt">'+b.orderCount+' orders in this box</div>':'')+
          '<div class="pg">Box '+(k+1)+'</div>'+
          '<div class="tot">'+b.totalItems+' items total</div>'+
          '<div class="items">'+li+'</div></div>';
      }
      document.getElementById('root').innerHTML=html;
    } catch(e2){}
    window.focus(); window.print();
  }
})();`;

// Open a print window and lay out one-or-more 4×6 pages per box (see PAGINATOR).
export function printOrderTickets(groups: PickTicketGroup[]) {
  if (!groups.length) return;
  const win = window.open('', '_blank', 'width=560,height=720');
  if (!win) return;

  const model = groups.map(buildBox);
  // Safe embed in a <script type="application/json"> island: neutralize '<' (covers the inline
  // barcode SVG and any '</script>'); JSON.parse restores it. Titles are already HTML-escaped.
  const dataJson = JSON.stringify(model).replace(/</g, '\\u003c');

  win.document.write(
    `<!doctype html><html><head><title>Pick tickets</title><style>${TICKET_CSS}</style></head>` +
      `<body><div id="root"></div>` +
      `<script id="pt-data" type="application/json">${dataJson}</script>` +
      `<script>${PAGINATOR}</script></body></html>`,
  );
  win.document.close();
}
