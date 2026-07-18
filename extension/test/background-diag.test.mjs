// Background diagnostics-sink test for feat/extension-live-diagnostics.
// Loads the REAL background.js in jsdom with a functional (async) chrome.storage.local
// and proves the fixes for the empty-export bug:
//   - DIAG_ENABLE + DIAG_EVENT are persisted to chrome.storage.local immediately
//   - events arriving on a freshly-woken SW (before the async restore) are NOT dropped
//   - a simulated SW restart RESTORES the prior ring (merge, no clobber) + records sw.start
//   - DIAG_EXPORT returns storage∪memory (never empty due to lifecycle)
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bgText = readFileSync(join(here, '..', 'background.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  → ' + x : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Boot a fresh "service worker" over a shared persistent store. Returns the captured
// onMessage listener + the store, so we can simulate eviction/restart by re-booting
// against the same store.
function boot(store) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://shop.tiktok.com/', runScripts: 'dangerously' });
  const { window } = dom;
  let onMessage = null;
  // Supports BOTH callback and promise forms (background uses await for auth reads).
  const readKeys = (keys) => {
    const out = {};
    const list = Array.isArray(keys) ? keys : (keys == null ? Object.keys(store) : [keys]);
    list.forEach((k) => { if (k in store) out[k] = store[k]; });
    return out;
  };
  const asyncGet = (keys, cb) => {
    if (typeof cb === 'function') { setTimeout(() => cb(readKeys(keys)), 5); return; }
    return new Promise((res) => setTimeout(() => res(readKeys(keys)), 5));
  };
  const asyncSet = (obj, cb) => {
    const apply = () => { Object.assign(store, JSON.parse(JSON.stringify(obj))); };
    if (typeof cb === 'function') { setTimeout(() => { apply(); cb(); }, 1); return; }
    return new Promise((res) => setTimeout(() => { apply(); res(); }, 1));
  };
  window.chrome = {
    runtime: {
      lastError: null, id: 'test', getManifest: () => ({ version: '0.2.22' }),
      onMessage: { addListener: (fn) => { onMessage = fn; } },
      onMessageExternal: { addListener: () => {} },
      sendMessage: () => {},
    },
    storage: { local: { get: asyncGet, set: asyncSet, remove: (k, cb) => cb && cb() } },
    tabs: { query: (q, cb) => cb && cb([]), sendMessage: () => Promise.resolve(), onRemoved: { addListener() {} } },
  };
  window.fetch = () => Promise.reject(new Error('no network in test'));
  window.eval(bgText);
  return { window, getOnMessage: () => onMessage };
}
const send = (fn, msg) => new Promise((res) => { const r = fn(msg, {}, (resp) => res(resp)); if (r !== true) res(undefined); });

async function run() {
  const store = {};

  // ── SW life #1: enable + record startup-style events ──
  let sw = boot(store);
  await sleep(15); // let the startup restore get() resolve (empty store → no-op)
  const l1 = sw.getOnMessage();
  ok('onMessage listener registered', typeof l1 === 'function');

  await send(l1, { type: 'DIAG_ENABLE' });
  await send(l1, { type: 'DIAG_EVENT', event: { ts: 1001, v: '0.2.22', comp: 'content', type: 'content.load', msg: 'loaded' } });
  await send(l1, { type: 'DIAG_EVENT', event: { ts: 1002, v: '0.2.22', comp: 'inject', type: 'inject.load', msg: 'loaded' } });
  await sleep(15); // let persist writes flush

  const persisted = store['lensed_diag_log'] || [];
  const types1 = persisted.map((e) => e.type);
  ok('enabled flag persisted', store['lensed_diag_enabled'] === true);
  ok('events persisted to chrome.storage.local immediately', persisted.length >= 3, 'len=' + persisted.length);
  ok('persisted includes diag.enable (background-origin)', types1.includes('diag.enable'));
  ok('persisted includes bg.awake (background awake proof)', types1.includes('bg.awake'));
  ok('persisted includes content.load', types1.includes('content.load'));
  ok('persisted includes inject.load', types1.includes('inject.load'));

  // Export in this life returns everything.
  const exp1 = await send(l1, { type: 'DIAG_EXPORT' });
  ok('DIAG_EXPORT count > 0', exp1 && exp1.count > 0, 'count=' + (exp1 && exp1.count));

  // ── Simulate SW eviction + restart: new worker over the SAME store ──
  const sw2 = boot(store);
  const l2 = sw2.getOnMessage();
  // RACE: an event arrives BEFORE the async restore get() resolves. It must NOT be
  // dropped (old bug) and must NOT be clobbered by the restore.
  await send(l2, { type: 'DIAG_EVENT', event: { ts: 2001, v: '0.2.22', comp: 'content', type: 'scan.status', msg: 'scan staged' } });
  await sleep(20); // now the restore get() has resolved + merged

  const exp2 = await send(l2, { type: 'DIAG_EXPORT' });
  const types2 = (exp2.events || []).map((e) => e.type);
  ok('restart: prior events survived (content.load present)', types2.includes('content.load'), types2.join(','));
  ok('restart: sw.start recorded', types2.includes('sw.start'));
  ok('restart: pre-restore event NOT dropped (scan.status present)', types2.includes('scan.status'));
  ok('restart: export count >= life#1 + new events', exp2.count >= exp1.count + 1, 'c1=' + exp1.count + ' c2=' + exp2.count);

  // DIAG_COUNT reflects the ring.
  const cnt = await send(l2, { type: 'DIAG_COUNT' });
  ok('DIAG_COUNT returns enabled + count', cnt && cnt.enabled === true && cnt.count === exp2.count, JSON.stringify(cnt));

  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + `: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
run().catch((e) => { console.error(e); process.exit(2); });
