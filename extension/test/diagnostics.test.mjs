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
  // E: per-character spam collapsed — exactly ONE scan.detected per attempt, and no
  // 'detected' logged via scan.status.
  ok('E: one scan.detected per scan (no per-char spam)', diagEvents().filter((e) => e && e.type === 'scan.detected').length === 1,
    'detected=' + diagEvents().filter((e) => e && e.type === 'scan.detected').length);
  ok('E: no scan.status carries state "detected"', !diagEvents().some((e) => e && e.type === 'scan.status' && e.meta && e.meta.state === 'detected'));

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

  // Export button present + triggers DIAG_EXPORT + a JSON download. Lives in the
  // dev-only diagnostics indicator row ("Export" button, title "Download diagnostics JSON").
  const btn = [...sr(w).querySelectorAll('button')].find((b) => b.textContent === 'Export' && /diagnostics json/i.test(b.title || ''));
  ok('ON: export button present (in diagnostics row)', !!btn);
  // The indicator itself must be shown.
  ok('ON: "Diagnostics ON" indicator present', /Diagnostics ON/.test(sr(w).textContent || ''));
  if (btn) { btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await sleep(20); }
  ok('ON: export issued DIAG_EXPORT', sent.some((m) => m.type === 'DIAG_EXPORT'));
  ok('ON: export downloaded a .json file', clicks === 1 && /lensed-diagnostics-.*\.json/.test(lastDownload || ''), 'clicks=' + clicks + ' name=' + lastDownload);

  // ── D: replay/backlog gate ── a fresh build, nothing staged, dispatch a stale vs a
  // fresh no-staged order and assert the historical one is skipped (no bind, no warn).
  const w3 = build(true);
  await sleep(50);
  const dispatchSale = (win, s) => { const ev = new win.MessageEvent('message', { data: { source: 'lensed-tiktok-sale', sale: s } }); Object.defineProperty(ev, 'source', { value: win }); win.dispatchEvent(ev); };
  const sentBefore = sent.length;
  // Stale (10 min old) order, nothing staged → historical/replayed → skipped.
  dispatchSale(w3, { orderId: 'stale-1', sellingPrice: '$3', isPaymentSuccessful: true, orderedAtMs: Date.now() - 10 * 60 * 1000 });
  await sleep(30);
  ok('D: stale no-staged order → NO AUTO_BIND dispatched', !sent.slice(sentBefore).some((m) => m.type === 'AUTO_BIND'));
  ok('D: stale order logs order.replayed_skip', diagEvents().some((e) => e && e.type === 'order.replayed_skip' && e.meta && e.meta.order === 'stale-1'));
  ok('D: stale order NOT counted captured_only', !diagEvents().some((e) => e && e.type === 'order.captured_only' && e.meta && e.meta.order === 'stale-1'));
  // Fresh order, nothing staged → genuine live unbound → warns + binds (dispatched).
  const sentBefore2 = sent.length;
  dispatchSale(w3, { orderId: 'fresh-1', sellingPrice: '$3', isPaymentSuccessful: true, orderedAtMs: Date.now() });
  await sleep(30);
  ok('D: fresh no-staged order → AUTO_BIND dispatched', sent.slice(sentBefore2).some((m) => m.type === 'AUTO_BIND'));
  ok('D: fresh no-staged order → captured_only warning kept', diagEvents().some((e) => e && e.type === 'order.captured_only' && e.meta && e.meta.order === 'fresh-1'));
  // Ambiguous: NO orderedAtMs + nothing staged → must NOT be discarded (may be fresh).
  // Processed (bind dispatched) + logged ambiguous, but NOT counted captured_only and
  // NOT skipped as replayed.
  const sentBefore3 = sent.length;
  dispatchSale(w3, { orderId: 'ambig-1', sellingPrice: '$3', isPaymentSuccessful: true }); // no orderedAtMs
  await sleep(30);
  ok('D: ambiguous (no timestamp) no-staged → still processed (AUTO_BIND dispatched)', sent.slice(sentBefore3).some((m) => m.type === 'AUTO_BIND'));
  ok('D: ambiguous → order.ambiguous_timestamp_no_staged logged', diagEvents().some((e) => e && e.type === 'order.ambiguous_timestamp_no_staged' && e.meta && e.meta.order === 'ambig-1'));
  ok('D: ambiguous → NOT skipped as replayed', !diagEvents().some((e) => e && e.type === 'order.replayed_skip' && e.meta && e.meta.order === 'ambig-1'));
  ok('D: ambiguous → NOT counted captured_only', !diagEvents().some((e) => e && e.type === 'order.captured_only' && e.meta && e.meta.order === 'ambig-1'));

  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + `: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
run().catch((e) => { console.error(e); process.exit(2); });
