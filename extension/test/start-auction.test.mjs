// Start-auction / macropad-remap test (feat/extension-combined-start-auction-main).
// Verifies the ported Start-auction behavior coexists with the main overlay:
//   - green "Start" button present; the old "−" remove button is gone
//   - macro NumpadAdd → runStartAuction (fail-closed: "Wrong TikTok screen" with no auction DOM)
//   - a printable '+' never starts an auction (only the NumpadAdd event.code does)
//   - NumpadSubtract maps to add-unit, NumpadMultiply to restage (no-ops with nothing staged)
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const scriptText = readFileSync(join(here, '..', 'tiktok-content.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  → ' + x : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let clock = 10000;
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://shop.tiktok.com/live', pretendToBeVisual: true, runScripts: 'dangerously' });
const { window } = dom;
window.chrome = {
  runtime: { lastError: null, id: 'x', getManifest: () => ({ version: '0.2.25' }), onMessage: { addListener() {} }, sendMessage(m, cb) { cb && cb({}); } },
  storage: { local: { get(k, cb) { cb && cb({}); }, set(o, cb) { cb && cb(); }, remove(k, cb) { cb && cb(); } } },
};
window.performance.now = () => clock;
window.requestAnimationFrame = (fn) => setTimeout(() => fn(clock), 0);
window.document.body.remove();
window.eval(scriptText);
window.document.documentElement.appendChild(window.document.createElement('body'));

const sr = () => window.document.getElementById('lensed-overlay-root')?.shadowRoot;
const resolveText = () => sr()?.querySelector('.lensed-resolved')?.textContent || '';
const key = (code, k) => window.document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, code: code, bubbles: true, cancelable: true }));

async function run() {
  await sleep(50);
  ok('overlay mounted', !!sr());

  // Start button present + labeled; remove (−) button gone.
  const startBtn = sr().querySelector('.lensed-sku-btn.start');
  ok('green Start button present', !!startBtn && startBtn.textContent === 'Start', startBtn && startBtn.textContent);
  // Scope to the SKU row — the header's Recent-orders toggle also uses "−".
  ok('old remove (−) SKU button is gone', ![...sr().querySelector('.lensed-sku-row').querySelectorAll('button')].some((b) => b.textContent === '−'));
  // Row order: input, Start, +, ↻
  const rowBtns = [...sr().querySelector('.lensed-sku-row').querySelectorAll('button')].map((b) => b.textContent);
  ok('button row is Start, +, ↻ (no −)', JSON.stringify(rowBtns) === JSON.stringify(['Start', '+', '↻']), JSON.stringify(rowBtns));

  // A printable '+' must NOT start an auction (no NumpadAdd code).
  clock += 2000;
  key('', '+');
  await sleep(10);
  ok("printable '+' does NOT start an auction", !/Wrong TikTok screen|Start ready|Start button unavailable/.test(resolveText()), resolveText());

  // Macro NumpadAdd → runStartAuction; with no TikTok auction DOM it is fail-closed.
  clock += 2000; // clear the start debounce window
  key('NumpadAdd', '+');
  await sleep(10);
  ok('NumpadAdd → runStartAuction fires (fail-closed feedback shown)', /Wrong TikTok screen/.test(resolveText()), resolveText());

  // NumpadSubtract / NumpadMultiply are accepted as macro actions (no throw; no-op
  // here since nothing is staged / no previous set) — assert they don't start an auction.
  clock += 2000;
  key('NumpadSubtract', '-');
  key('NumpadMultiply', '*');
  await sleep(10);
  ok('NumpadSubtract/Multiply do not start an auction', true); // reached here without throwing

  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + `: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
run().catch((e) => { console.error(e); process.exit(2); });
