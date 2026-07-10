// Local integration test for barcode-staging reliability (fix/extension-barcode-staging-reliability).
// Loads the REAL tiktok-content.js in jsdom with a mocked chrome + a fake clock,
// then drives synthetic keyboard bursts to verify the global wedge-scanner.
//
// Run:  node test/scanner.test.mjs   (from extension/)
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const scriptText = readFileSync(join(here, '..', 'tiktok-content.js'), 'utf8');

// ── Fake clock: nowMs() reads performance.now(), so a mutable clock makes burst
//    timing deterministic regardless of real wall-clock. ──
let clock = 10000;
const now = () => clock;

// ── Mock chrome. RESOLVE_SKU replies synchronously with whatever the current
//    test configured, so setScanStatus/setResolveLine run before we assert. ──
let resolveResponse = { sku: { sku_number: 14, title: 'iPad' } };
let resolveCalls = [];
function makeChrome() {
  const store = {};
  return {
    runtime: {
      lastError: null,
      id: 'test-ext',
      getManifest: () => ({ version: '0.2.20' }),
      onMessage: { addListener() {} },
      sendMessage(msg, cb) {
        if (msg && msg.type === 'RESOLVE_SKU') {
          resolveCalls.push(msg.skuNumber);
          if (typeof cb === 'function') cb(resolveResponse);
        } else if (typeof cb === 'function') { cb({}); }
      },
    },
    storage: {
      local: {
        get(keys, cb) { if (typeof cb === 'function') cb({}); },
        set(obj, cb) { Object.assign(store, obj); if (typeof cb === 'function') cb(); },
        remove(keys, cb) { if (typeof cb === 'function') cb(); },
      },
    },
  };
}

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://shop.tiktok.com/live', pretendToBeVisual: true, runScripts: 'dangerously',
});
const { window } = dom;
window.chrome = makeChrome();
window.performance.now = now;              // fake clock for nowMs()
window.requestAnimationFrame = (fn) => setTimeout(() => fn(now()), 0);
window.cancelAnimationFrame = (id) => clearTimeout(id);
// Replicate the real content-script load timing: the extension runs at
// document_start when there is no <body> yet, so init() defers to DOMContentLoaded.
// jsdom already has a <body>, which would make init() run synchronously before the
// rest of the IIFE finished evaluating. Remove the body first, then re-add it so
// init()'s deferred retry builds the overlay once the whole script is defined.
window.document.body.remove();
window.eval(scriptText);
window.document.documentElement.appendChild(window.document.createElement('body'));

const shadow = () => window.document.getElementById('lensed-overlay-root')?.shadowRoot;
const lastScanText = () => shadow()?.querySelector('.lensed-lastscan')?.textContent || '';
const resolvedText = () => shadow()?.querySelector('.lensed-resolved')?.textContent || '';

// Dispatch a keydown for `key`, advancing the fake clock by `gap` ms first.
// `targetSel` optionally focuses/targets an element (e.g. a chat input).
function press(key, gap, targetEl) {
  clock += gap;
  const el = targetEl || window.document.body;
  const ev = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
}
// Type a burst: chars fast (10ms apart), optionally Enter. Returns per-char events.
function burst(chars, { enter = false, gap = 10, target } = {}) {
  clock += 1000; // large gap first so the burst starts a fresh sequence
  const evs = [];
  chars.split('').forEach((c, i) => evs.push(press(c, i === 0 ? 0 : gap, target)));
  if (enter) evs.push(press('Enter', gap, target));
  return evs;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle() {
  await sleep(220);
  // A prior commit calls focusScanInput(), leaving the overlay SKU input focused —
  // which would make the next body-targeted burst take the in-input path. Blur it so
  // each global-scan test starts with focus on <body> (the real "clicked nothing" case).
  try { shadow()?.querySelector('.lensed-sku-input')?.blur(); } catch {}
  try { window.document.activeElement?.blur?.(); } catch {}
  resolveCalls = [];
  window.chrome.runtime.lastError = null;
}

// ── Test runner ──
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

async function run() {
  // Wait for init()/createOverlay to build the shadow DOM.
  await sleep(50);
  ok('overlay + last-scan line mounted', !!shadow() && lastScanText().includes('Last scan'));

  // 1. Burst WITH Enter stages the SKU.
  await settle();
  resolveResponse = { sku: { sku_number: 14, title: 'iPad' } };
  burst('SKU14-C60D', { enter: true });
  await sleep(20);
  ok('1) burst+Enter → RESOLVE_SKU sent', resolveCalls.includes('SKU14-C60D'), 'calls=' + JSON.stringify(resolveCalls));
  ok('1) burst+Enter → staged status', /staged/.test(lastScanText()), lastScanText());

  // 2. Burst WITHOUT Enter stages after the idle timeout.
  await settle();
  resolveResponse = { sku: { sku_number: 22, title: 'Gt3 Drone' } };
  burst('SKU22-1A76', { enter: false });
  ok('2) pre-timeout: not yet committed', resolveCalls.length === 0, 'calls=' + JSON.stringify(resolveCalls));
  await sleep(200); // > SCAN_IDLE_COMMIT_MS
  ok('2) burst no-Enter → committed after idle', resolveCalls.includes('SKU22-1A76'), 'calls=' + JSON.stringify(resolveCalls));

  // 3. Scan while focus is inside a TikTok chat input still stages, and burst
  //    chars are swallowed (defaultPrevented) so they don't leak into chat.
  await settle();
  resolveResponse = { sku: { sku_number: 30, title: 'Powerbank' } };
  const chat = window.document.createElement('input');
  chat.type = 'text'; window.document.body.appendChild(chat); chat.focus();
  ok('3) chat input is the active element', window.document.activeElement === chat);
  const evs = burst('SKU30-9B65', { enter: true, target: chat });
  await sleep(20);
  ok('3) scan in chat → RESOLVE_SKU sent', resolveCalls.includes('SKU30-9B65'), 'calls=' + JSON.stringify(resolveCalls));
  const burstPrevented = evs.slice(1, -1).every((e) => e.defaultPrevented); // chars after the 1st
  ok('3) burst chars swallowed (not leaked to chat)', burstPrevented);
  chat.remove();

  // 4. Slow human typing in a chat box is NOT intercepted (no commit, not prevented).
  await settle();
  const chat2 = window.document.createElement('input');
  chat2.type = 'text'; window.document.body.appendChild(chat2); chat2.focus();
  clock += 1000;
  const human = [];
  'hello'.split('').forEach((c, i) => human.push(press(c, i === 0 ? 0 : 180, chat2))); // 180ms apart = human
  await sleep(200);
  ok('4) human typing → no scan commit', resolveCalls.length === 0, 'calls=' + JSON.stringify(resolveCalls));
  ok('4) human typing → keys not swallowed', human.every((e) => !e.defaultPrevented));
  chat2.remove();

  // 5. Unknown SKU → "not found" (visible reason).
  await settle();
  resolveResponse = { sku: null, status: 'not_found' };
  burst('SKU999-XXXX', { enter: true });
  await sleep(20);
  ok('5) unknown SKU → RESOLVE_SKU sent', resolveCalls.includes('SKU999-XXXX'));
  ok('5) unknown SKU → "SKU not found" shown', /not found/i.test(resolvedText()), 'resolved="' + resolvedText() + '"');
  ok('5) unknown SKU → scan status "no SKU matched"', /no SKU matched/i.test(lastScanText()), lastScanText());

  // 6. Auth failure → clear "not connected" reason, not a misleading "not found".
  await settle();
  resolveResponse = { sku: null, status: 'not_authenticated' };
  burst('SKU14-C60D', { enter: true });
  await sleep(20);
  ok('6) auth fail → not shown as "SKU not found"', !/not found/i.test(resolvedText()), 'resolved="' + resolvedText() + '"');
  ok('6) auth fail → "not connected" reason shown', /not connected/i.test(resolvedText()), 'resolved="' + resolvedText() + '"');
  ok('6) auth fail → scan status "failed"', /failed/.test(lastScanText()), lastScanText());

  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + `: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
run().catch((e) => { console.error(e); process.exit(2); });
