// UI-layout acceptance test for fix/extension-overlay-host-ui-polish.
// Loads the real tiktok-content.js in jsdom and asserts the overlay STRUCTURE:
// top status bar (connection + host) out of the work area, a prominent current-item
// card holding the staged SKU, and screenshot debug controls hidden unless dev mode.
// Structure-only (jsdom has no layout engine) — pairs with scanner.test.mjs for behavior.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const scriptText = readFileSync(join(here, '..', 'tiktok-content.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); } };

let clock = 10000;
let resolveResponse = { sku: { sku_number: 1, title: 'Ipad Air 2nd Gen' } };
let resolveCalls = [];
function makeChrome() {
  return {
    runtime: {
      lastError: null, id: 'x', getManifest: () => ({ version: '0.2.21' }),
      onMessage: { addListener() {} },
      sendMessage(msg, cb) { if (msg && msg.type === 'RESOLVE_SKU') { resolveCalls.push(msg.skuNumber); cb && cb(resolveResponse); } else cb && cb({}); },
    },
    storage: { local: { get(k, cb) { cb && cb({}); }, set(o, cb) { cb && cb(); }, remove(k, cb) { cb && cb(); } } },
  };
}

// Build a fresh overlay instance with a given localStorage state (for dev-mode test).
async function build(devMode) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://shop.tiktok.com/live', pretendToBeVisual: true, runScripts: 'dangerously' });
  const { window } = dom;
  if (devMode) window.localStorage.setItem('lensed_dev', '1');
  window.chrome = makeChrome();
  window.performance.now = () => clock;
  window.requestAnimationFrame = (fn) => setTimeout(() => fn(clock), 0);
  window.document.body.remove();
  window.eval(scriptText);
  window.document.documentElement.appendChild(window.document.createElement('body'));
  await new Promise((r) => setTimeout(r, 60));
  return window;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  // ── Normal (non-dev) mode ──
  const w = await build(false);
  const sr = () => w.document.getElementById('lensed-overlay-root')?.shadowRoot;
  ok('overlay mounted', !!sr());

  const panel = sr().querySelector('.lensed-panel');
  const order = [...panel.children].map((c) => c.className).filter((c) => typeof c === 'string');
  // header → statusbar → sku-bar → body (version span is absolute-positioned, ignore)
  const idx = (cls) => order.findIndex((c) => c.includes(cls));
  ok('panel order: header before statusbar', idx('lensed-header') >= 0 && idx('lensed-statusbar') > idx('lensed-header'), order.join(' | '));
  ok('panel order: statusbar before sku-bar', idx('lensed-statusbar') < idx('lensed-sku-bar'), order.join(' | '));

  // Status bar holds connection + host (moved out of the work area).
  const statusbar = sr().querySelector('.lensed-statusbar');
  ok('statusbar has connection status', !!statusbar.querySelector('.lensed-session-status'));
  ok('statusbar has host row', !!statusbar.querySelector('.lensed-host-row'));
  // …and they are NO LONGER in the main work column.
  const skuMain = sr().querySelector('.lensed-sku-main');
  ok('session status NOT in work area', !skuMain.querySelector('.lensed-session-status'));
  ok('host row NOT in work area', !skuMain.querySelector('.lensed-host-row'));

  // Current-item card exists, sits above talking points, and wraps the staged list.
  const card = sr().querySelector('.lensed-current-card');
  ok('current-item card exists', !!card);
  ok('card has CURRENT ITEM head', /current item/i.test(card.querySelector('.lensed-current-head')?.textContent || ''));
  ok('card contains the staged list', !!card.querySelector('.lensed-staged'));
  const mainKids = [...skuMain.children].map((c) => c.className);
  ok('current card is above talking points', mainKids.findIndex((c) => c.includes('current-card')) < mainKids.findIndex((c) => c.includes('lensed-notes')), mainKids.join(' | '));
  // Scan input stays at the top of the work area (first child).
  ok('scan row is first in work area', (mainKids[0] || '').includes('lensed-sku-row'));

  // Screenshot debug controls are hidden in normal mode.
  ok('no screenshot dot in normal mode', ![...sr().querySelectorAll('.lensed-toggle')].some((b) => (b.title || '').toLowerCase().includes('screenshot')));
  ok('no screenshot debug row in normal mode DOM', !skuMain.querySelector('button')?.textContent?.match?.(/Test|Clear/) && ![...sr().querySelectorAll('button')].some((b) => b.textContent === 'Test'));

  // Stage a SKU via a scan burst → the big current item renders in the card.
  // Mirror scanner.test's proven burst: fresh sequence (large leading gap), then
  // machine-fast chars, then Enter; each keydown advances the fake clock.
  resolveResponse = { sku: { sku_number: 1, title: 'Ipad Air 2nd Gen', qty_on_hand: 5 } };
  const press = (key, gap) => { clock += gap; w.document.body.dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); };
  clock += 1000;
  'SKU1-DE33'.split('').forEach((c, i) => press(c, i === 0 ? 0 : 10));
  press('Enter', 10);
  await sleep(50);
  const item = sr().querySelector('.lensed-current-card .lensed-staged-item');
  ok('staged SKU renders inside the current-item card', !!item, 'calls=' + resolveCalls.join(',') + ' staged=' + JSON.stringify(sr().querySelector('.lensed-staged')?.innerHTML));
  ok('staged item shows qty + title', /1×/.test(item?.querySelector('.lensed-si-title')?.textContent || '') && /Ipad Air/i.test(item?.textContent || ''), item?.textContent);

  // ── Dev mode: screenshot dot returns ──
  const wd = await build(true);
  const srd = () => wd.document.getElementById('lensed-overlay-root')?.shadowRoot;
  ok('screenshot dot present in dev mode', [...srd().querySelectorAll('.lensed-toggle')].some((b) => (b.title || '').toLowerCase().includes('screenshot')));

  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + `: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
run().catch((e) => { console.error(e); process.exit(2); });
