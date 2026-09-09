// Payment-status flip test — reproduces the 2026-09-07 "@Jae.Cole" report.
//
// auction_result/get is CUMULATIVE: an order first seen UNPAID re-arrives PAID seconds
// later. By then the operator has normally already scanned the NEXT item. Before the fix
// the flip was treated as a fresh bind, so it:
//   (a) sent the NEXT item's staged SKUs to the background,
//   (b) cleared staging — stealing the next auction's scan,
//   (c) overwrote the display mapping, showing the next item under the old order,
//   (d) rendered the same order_id as a SECOND row.
// The DB survived only because the RPC's transition path ignores the SKUs it is handed.
//
// Run: node test/content-payment-flip.test.mjs   (from extension/)
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const scriptText = readFileSync(join(here, '..', 'tiktok-content.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const ok = (name, cond, extra) => { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name + (extra ? '  — ' + extra : '')); } };

function makeChrome(store, cfg) {
  const read = (keys) => { const o = {}; (Array.isArray(keys) ? keys : keys == null ? Object.keys(store) : [keys]).forEach((k) => { if (k in store) o[k] = store[k]; }); return o; };
  return {
    runtime: {
      lastError: null, id: 'test-ext', getManifest: () => ({ version: '0.6.7' }),
      onMessage: { addListener: (fn) => { cfg.onMsg = fn; } },
      sendMessage(msg, cb) {
        let reply = {};
        if (msg && msg.type === 'GET_AUTH_STATUS') reply = cfg.authReply;
        else if (msg && msg.type === 'RESOLVE_SKU') { cfg.resolveCalls.push(msg.skuNumber); reply = cfg.resolveReply || { sku: null, status: 'not_found' }; }
        else if (msg && msg.type === 'FETCH_HOSTS') reply = { hosts: [] };
        else if (msg && msg.type === 'AUTO_BIND') { cfg.binds.push(msg); reply = { ok: true, bound: true }; }
        if (typeof cb === 'function') { cb(reply); return undefined; }
        return Promise.resolve(reply);
      },
    },
    storage: { local: {
      get(keys, cb) { const v = read(keys); if (typeof cb === 'function') { cb(v); return undefined; } return Promise.resolve(v); },
      set(obj, cb) { Object.assign(store, obj); if (typeof cb === 'function') cb(); return Promise.resolve(); },
      remove(keys, cb) { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete store[k]); if (typeof cb === 'function') cb(); return Promise.resolve(); },
    } },
  };
}

function boot(store, cfg) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://shop.tiktok.com/live', pretendToBeVisual: true, runScripts: 'dangerously' });
  const { window } = dom;
  window.chrome = makeChrome(store, cfg);
  window.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  window.document.body.remove();
  window.eval(scriptText);
  window.document.documentElement.appendChild(window.document.createElement('body'));
  return window;
}
const shadowOf = (w) => w.document.getElementById('lensed-overlay-root')?.shadowRoot;
const detectRoom = (w, roomId) => w.dispatchEvent(new w.MessageEvent('message', { data: { source: 'lensed-tiktok-room', roomId }, source: w }));
const injectSale = (w, sale) => w.dispatchEvent(new w.MessageEvent('message', { data: { source: 'lensed-tiktok-sale', sale }, source: w }));

function stage(w, cfg, sku) {
  cfg.resolveReply = { sku };
  const input = shadowOf(w)?.querySelector('.lensed-sku-input');
  if (!input) return false;
  input.value = String(sku.sku_number);
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  return true;
}
const stagedPills = (w) => Array.from(shadowOf(w)?.querySelectorAll('.lensed-staged-item') || []).map((p) => p.textContent);
const saleRows = (w) => Array.from(shadowOf(w)?.querySelectorAll('.lensed-sale') || []);
// Identify a row by its VISIBLE order text, not by data-order — the attribute is part of
// the fix, so keying on it would make this test crash instead of fail on unfixed code.
const rowFor = (w, orderId) => saleRows(w).filter((r) => (r.querySelector('.lensed-sale-order')?.textContent || '').includes(orderId));
const rowText = (r) => (r ? Array.from(r.querySelectorAll('.lensed-sale-item')).map((e) => e.textContent).join(' | ') : '(no row)');
const rowStatus = (r) => (!r ? '(no row)' : r.querySelector('.lensed-sale-unpaid') ? 'Unpaid' : (r.querySelector('.lensed-sale-status') ? 'Paid' : '?'));

const STRAWBERRY = { id: 'sku-271', sku_number: 271, title: 'Jumbo Strawberry Squeeze', qty_on_hand: 20, unit_cost_cents: 225, category: 'squish' };
const PINK       = { id: 'sku-286', sku_number: 286, title: 'Pink Squisher',            qty_on_hand: 20, unit_cost_cents: 200, category: 'squish' };
const ORDER = '577560576188190908';

async function run() {
  const store = {};
  const cfg = { resolveCalls: [], binds: [], authReply: { authenticated: true, userId: 'user-A', sessionId: 'sess-1', roomId: 'R1' } };
  const w = boot(store, cfg);
  await sleep(50);
  detectRoom(w, 'R1');
  await sleep(50);

  // 1. Scan #271, it sells to @Jae.Cole — but the payment is PENDING.
  stage(w, cfg, STRAWBERRY);
  await sleep(500);
  injectSale(w, { orderId: ORDER, buyerUsername: 'Jae.Cole', sellingPrice: '$6.00', isPaymentSuccessful: false, orderedAtMs: Date.now() });
  await sleep(80);

  ok('1) unpaid sale still binds #271', cfg.binds.length === 1 && cfg.binds[0].stagedSkus.map((s) => s.sku_number).join() === '271',
    JSON.stringify(cfg.binds.map((b) => b.stagedSkus.map((s) => s.sku_number))));
  ok('2) unpaid row shows #271', rowFor(w, ORDER).length === 1 && /271/.test(rowText(rowFor(w, ORDER)[0])), rowText(rowFor(w, ORDER)[0]));
  ok('3) unpaid row is marked Unpaid', rowStatus(rowFor(w, ORDER)[0]) === 'Unpaid', rowStatus(rowFor(w, ORDER)[0]));
  ok('4) staging cleared by the first bind', stagedPills(w).length === 0, JSON.stringify(stagedPills(w)));

  // 2. Operator scans the NEXT item, #286, while the payment is still pending.
  stage(w, cfg, PINK);
  await sleep(500);
  ok('5) #286 staged for the next auction', stagedPills(w).some((t) => /286/.test(t)), JSON.stringify(stagedPills(w)));

  // 3. Payment clears. TikTok re-sends the SAME order_id, now paid.
  injectSale(w, { orderId: ORDER, buyerUsername: 'Jae.Cole', sellingPrice: '$6.00', isPaymentSuccessful: true, orderedAtMs: Date.now() });
  await sleep(80);

  // ── The regression guards ───────────────────────────────────────────────────
  ok('6) #286 is STILL staged — the flip did not steal the next scan',
    stagedPills(w).some((t) => /286/.test(t)), JSON.stringify(stagedPills(w)));

  const flip = cfg.binds[cfg.binds.length - 1] || {};
  ok('7) flip dispatched a transition, not a bind (isFlip set)', cfg.binds.length === 2 && flip.isFlip === true, JSON.stringify({ n: cfg.binds.length, isFlip: flip.isFlip }));
  ok('8) flip carried NO staged SKUs (#286 never sent under the old order)',
    Array.isArray(flip.stagedSkus) && flip.stagedSkus.length === 0, JSON.stringify(flip.stagedSkus));

  const rows = rowFor(w, ORDER);
  ok('9) the order occupies ONE row, not two', rows.length === 1, 'rows=' + rows.length);
  ok('10) that row now reads Paid', rows.length === 1 && rowStatus(rows[0]) === 'Paid', rows[0] && rowStatus(rows[0]));
  ok('11) that row STILL shows #271, not #286', rows.length === 1 && /271/.test(rowText(rows[0])) && !/286/.test(rowText(rows[0])), rows[0] && rowText(rows[0]));

  // 4. The next real sale binds #286 — the scan survived the flip.
  injectSale(w, { orderId: '577560576792039741', buyerUsername: 'LkC14', sellingPrice: '$3.00', isPaymentSuccessful: true, orderedAtMs: Date.now() });
  await sleep(80);
  const last = cfg.binds[cfg.binds.length - 1] || { sale: {}, stagedSkus: [] };
  ok('12) next order binds #286 with no re-scan needed',
    last.sale.orderId === '577560576792039741' && last.stagedSkus.map((s) => s.sku_number).join() === '286',
    JSON.stringify({ order: last.sale.orderId, skus: last.stagedSkus.map((s) => s.sku_number) }));
  ok('13) counter counted 2 orders, not 3 (flip is not a new order)',
    store.lensed_live_counter && store.lensed_live_counter.salesCount === 2, JSON.stringify(store.lensed_live_counter && store.lensed_live_counter.salesCount));

  console.log('\n' + (failed === 0 ? 'ALL PASS' : 'FAIL') + ': ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
}
run().catch((e) => { console.error(e); process.exit(1); });
