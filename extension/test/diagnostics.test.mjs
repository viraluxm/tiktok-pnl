// Diagnostics (flight-recorder) test for feat/extension-live-diagnostics.
// Loads the real tiktok-content.js in jsdom, mocks chrome, and verifies:
//  - OFF by default: no DIAG_* traffic in normal host mode
//  - ON via localStorage.lensed_diagnostics='1': DIAG_ENABLE on load + DIAG_EVENTs
//  - redaction: the raw scanned barcode never appears in any DIAG event
//  - export button issues DIAG_EXPORT and builds a JSON download
//  - capture/staging still works with diagnostics enabled (logging is additive)
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const scriptText = readFileSync(join(here, '..', 'tiktok-content.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  → ' + x : '')); } };

let clock = 10000;
let sent = [];               // every chrome.runtime.sendMessage {message}
let clicks = 0, lastDownload = null;

function build(diagOn) {
  clock = 10000; sent = []; clicks = 0; lastDownload = null;
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://shop.tiktok.com/live', pretendToBeVisual: true, runScripts: 'dangerously' });
  const { window } = dom;
  if (diagOn) window.localStorage.setItem('lensed_diagnostics', '1');
  window.chrome = {
    runtime: {
      lastError: null, id: 'x', getManifest: () => ({ version: '0.2.22' }),
      onMessage: { addListener() {} },
      sendMessage(msg, cb) {
        sent.push(msg);
        if (msg && msg.type === 'RESOLVE_SKU') { cb && cb({ sku: { sku_number: 1, title: 'Ipad Air 2nd Gen', qty_on_hand: 5 } }); return; }
        if (msg && msg.type === 'DIAG_EXPORT') { cb && cb({ v: '0.2.22', count: 2, events: [{ type: 'sw.start' }, { type: 'bind.rpc_error', meta: { code: 'OUT_OF_STOCK' } }] }); return; }
        cb && cb({ ok: true });
      },
    },
    storage: { local: { get(k, cb) { cb && cb({}); }, set(o, cb) { cb && cb(); }, remove(k, cb) { cb && cb(); } } },
  };
  window.performance.now = () => clock;
  window.requestAnimationFrame = (fn) => setTimeout(() => fn(clock), 0);
  // Capture blob downloads triggered by exportDiagnostics().
  window.URL.createObjectURL = () => 'blob:mock';
  window.URL.revokeObjectURL = () => {};
  const origCreate = window.document.createElement.bind(window.document);
  window.document.createElement = function (tag) {
    const elm = origCreate(tag);
    if (String(tag).toLowerCase() === 'a') { elm.click = function () { clicks++; lastDownload = elm.getAttribute('download'); }; }
    return elm;
  };
  window.document.body.remove();
  window.eval(scriptText);
  window.document.documentElement.appendChild(window.document.createElement('body'));
  return window;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sr = (w) => w.document.getElementById('lensed-overlay-root')?.shadowRoot;
const diagMsgs = () => sent.filter((m) => m && (m.type === 'DIAG_EVENT' || m.type === 'DIAG_ENABLE' || m.type === 'DIAG_EXPORT'));
const diagEvents = () => sent.filter((m) => m && m.type === 'DIAG_EVENT').map((m) => m.event);

function scan(w, value) {
  clock += 1000;
  value.split('').forEach((c, i) => { clock += i ? 10 : 0; w.document.body.dispatchEvent(new w.KeyboardEvent('keydown', { key: c, bubbles: true, cancelable: true })); });
  clock += 10; w.document.body.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
}

async function run() {
  // ── OFF by default ──
  let w = build(false);
  await sleep(50);
  scan(w, 'SKU1-DE33');
  await sleep(40);
  ok('OFF: no DIAG traffic in normal host mode', diagMsgs().length === 0, 'saw ' + diagMsgs().length);
  ok('OFF: scan still resolves (capture unaffected)', sent.some((m) => m.type === 'RESOLVE_SKU'));

  // ── ON ──
  w = build(true);
  await sleep(50);
  ok('ON: DIAG_ENABLE sent on load', sent.some((m) => m.type === 'DIAG_ENABLE'));
  ok('ON: content.load event emitted', diagEvents().some((e) => e && e.type === 'content.load'));

  scan(w, 'SKU1-DE33');
  await sleep(40);
  ok('ON: scan.status events emitted', diagEvents().some((e) => e && e.type === 'scan.status'));
  ok('ON: staging still works (pill rendered)', !!sr(w).querySelector('.lensed-staged-item'));

  // Redaction: the full raw barcode must never appear inside any DIAG event.
  const diagJson = JSON.stringify(diagEvents());
  ok('ON: raw barcode NOT present in diagnostics', diagJson.indexOf('SKU1-DE33') === -1, diagJson.slice(0, 120));

  // Feed a sale → bind.sent + order.captured diagnostics. The content listener
  // requires event.source === window, so set it explicitly and dispatch on window.
  const saleEv = new w.MessageEvent('message', { data: { source: 'lensed-tiktok-sale', sale: { orderId: '5774709999', buyerUsername: 'someone', sellingPrice: '$3', isPaymentSuccessful: true } } });
  Object.defineProperty(saleEv, 'source', { value: w });
  w.dispatchEvent(saleEv);
  await sleep(40);
  ok('ON: bind.sent emitted for a sale', diagEvents().some((e) => e && e.type === 'bind.sent'), diagEvents().map((e) => e && e.type).join(','));
  ok('ON: buyer username NOT in diagnostics', JSON.stringify(diagEvents()).indexOf('someone') === -1);

  // Export button present + triggers DIAG_EXPORT + a JSON download.
  const btn = [...sr(w).querySelectorAll('.lensed-toggle')].find((b) => (b.title || '').toLowerCase().includes('export'));
  ok('ON: export button present', !!btn);
  if (btn) { btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await sleep(20); }
  ok('ON: export issued DIAG_EXPORT', sent.some((m) => m.type === 'DIAG_EXPORT'));
  ok('ON: export downloaded a .json file', clicks === 1 && /lensed-diagnostics-.*\.json/.test(lastDownload || ''), 'clicks=' + clicks + ' name=' + lastDownload);

  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + `: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
run().catch((e) => { console.error(e); process.exit(2); });
