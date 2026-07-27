// Live session metrics test — proves the revenue / rev-hr / ASP-hit accumulators are correct
// and, critically, SURVIVE A PAGE RELOAD MID-SESSION without double-counting. TikTok re-sends
// the cumulative sales backlog on reload; the accumulator is keyed off the persisted deduped
// order_id set, so a replayed order must NOT re-accumulate.
//
// Run: node test/content-metrics.test.mjs   (from extension/)
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
      lastError: null, id: 'test-ext', getManifest: () => ({ version: '0.6.3' }),
      onMessage: { addListener: (fn) => { cfg.onMsg = fn; } },
      sendMessage(msg, cb) {
        let reply = {};
        if (msg && msg.type === 'GET_AUTH_STATUS') reply = cfg.authReply || { authenticated: true, userId: 'user-A', sessionId: 'sess-1', roomId: 'R1' };
        else if (msg && msg.type === 'RESOLVE_SKU') { cfg.resolveCalls.push(msg.skuNumber); reply = cfg.resolveReply || { sku: null, status: 'not_found' }; }
        else if (msg && msg.type === 'FETCH_HOSTS') reply = { hosts: cfg.hosts || [] };
        else if (msg && msg.type === 'AUTO_BIND') reply = { ok: true };
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
const shadowOf = (window) => window.document.getElementById('lensed-overlay-root')?.shadowRoot;
const detectRoom = (window, roomId) => window.dispatchEvent(new window.MessageEvent('message', { data: { source: 'lensed-tiktok-room', roomId }, source: window }));
function stageViaInput(window, cfg, sku) {
  cfg.resolveReply = { sku };
  const input = shadowOf(window)?.querySelector('.lensed-sku-input');
  if (!input) return false;
  input.value = String(sku.sku_number);
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  return true;
}
const injectSale = (window, sale) => window.dispatchEvent(new window.MessageEvent('message', { data: { source: 'lensed-tiktok-sale', sale }, source: window }));
// Read a metric cell's value by its label (Revenue / Rev/hr / ASP hit).
function metric(window, label) {
  const cells = shadowOf(window)?.querySelectorAll('.lensed-metric') || [];
  for (const c of cells) {
    if (c.querySelector('.lensed-metric-label')?.textContent === label) return c.querySelector('.lensed-metric-value')?.textContent;
  }
  return null;
}

async function run() {
  const store = {};
  const cfg = { resolveCalls: [], userId: 'user-A', authReply: { authenticated: true, userId: 'user-A', sessionId: 'sess-1', roomId: 'R1' } };

  // ── First page load: session adopted, stage a $2.00-cost SKU (4x goal = $8.00) ──
  let w = boot(store, cfg);
  await sleep(50);
  detectRoom(w, 'R1');
  await sleep(50);
  ok('0) overlay + metrics row present', !!metric(w, 'Revenue'), 'rev=' + metric(w, 'Revenue'));

  stageViaInput(w, cfg, { id: 'sku-1', sku_number: 14, title: 'Mouth Tape', qty_on_hand: 50, unit_cost_cents: 200, category: 'squish' });
  await sleep(500); // resolve(+300ms) → stageCurrentSku

  // Sale 1: $10.00 (≥ $8 goal → HIT). Sale 2: $5.00 (< $8 → miss). Both paid, fresh (recent ts).
  injectSale(w, { orderId: 'o1', sellingPrice: '$10.00', isPaymentSuccessful: true, orderedAtMs: Date.now() });
  await sleep(60);
  // Re-stage before the 2nd sale (staging auto-clears after a bind).
  stageViaInput(w, cfg, { id: 'sku-1', sku_number: 14, title: 'Mouth Tape', qty_on_hand: 50, unit_cost_cents: 200, category: 'squish' });
  await sleep(500);
  injectSale(w, { orderId: 'o2', sellingPrice: '$5.00', isPaymentSuccessful: true, orderedAtMs: Date.now() });
  await sleep(80);

  const rev1 = metric(w, 'Revenue'), asp1 = metric(w, 'ASP hit');
  ok('1) cumulative revenue = $15 after two sales', rev1 === '$15', 'rev=' + rev1);
  ok('2) ASP hit = 50% (1 of 2 met the $8 goal)', asp1 === '50%', 'asp=' + asp1);
  ok('3) accumulators persisted to LK_COUNTER', !!(store.lensed_live_counter && store.lensed_live_counter.revenueCents === 1500 && store.lensed_live_counter.aspHits === 1 && store.lensed_live_counter.aspEligible === 2), JSON.stringify(store.lensed_live_counter));

  // ── RELOAD: fresh content instance over the SAME persisted store, SAME session ──
  const cfg2 = { resolveCalls: [], userId: 'user-A', authReply: { authenticated: true, userId: 'user-A', sessionId: 'sess-1', roomId: 'R1' } };
  w = boot(store, cfg2);
  await sleep(50);
  detectRoom(w, 'R1');
  await sleep(80);
  ok('4) revenue restored to $15 after reload', metric(w, 'Revenue') === '$15', 'rev=' + metric(w, 'Revenue'));
  ok('5) ASP hit restored to 50% after reload', metric(w, 'ASP hit') === '50%', 'asp=' + metric(w, 'ASP hit'));

  // Backlog replay: TikTok re-sends o1 and o2 (already-seen). Must NOT re-accumulate.
  injectSale(w, { orderId: 'o1', sellingPrice: '$10.00', isPaymentSuccessful: true, orderedAtMs: Date.now() - 3600000 });
  injectSale(w, { orderId: 'o2', sellingPrice: '$5.00', isPaymentSuccessful: true, orderedAtMs: Date.now() - 3600000 });
  await sleep(80);
  ok('6) revenue STILL $15 after backlog replay (no double-count)', metric(w, 'Revenue') === '$15', 'rev=' + metric(w, 'Revenue'));
  ok('7) ASP hit STILL 50% after backlog replay', metric(w, 'ASP hit') === '50%', 'asp=' + metric(w, 'ASP hit'));
  ok('8) persisted revenueCents still 1500 (not 3000)', store.lensed_live_counter && store.lensed_live_counter.revenueCents === 1500, JSON.stringify(store.lensed_live_counter));

  // A genuinely NEW paid sale after reload accumulates on top.
  stageViaInput(w, cfg2, { id: 'sku-1', sku_number: 14, title: 'Mouth Tape', qty_on_hand: 50, unit_cost_cents: 200, category: 'squish' });
  await sleep(500);
  injectSale(w, { orderId: 'o3', sellingPrice: '$9.00', isPaymentSuccessful: true, orderedAtMs: Date.now() });
  await sleep(80);
  ok('9) new sale after reload adds → revenue $24', metric(w, 'Revenue') === '$24', 'rev=' + metric(w, 'Revenue'));
  ok('10) ASP hit now 67% (2 of 3)', metric(w, 'ASP hit') === '67%', 'asp=' + metric(w, 'ASP hit'));

  console.log('\n' + (failed === 0 ? 'ALL PASS' : 'FAIL') + ': ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
}
run().catch((e) => { console.error(e); process.exit(1); });
