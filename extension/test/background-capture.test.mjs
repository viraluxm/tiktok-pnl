// Background capture_events + AUTO_BIND semantics test (feat/extension-capture-write-fix).
// Loads the REAL background.js in jsdom with mocked chrome + fetch and proves:
//   A) capture_events upsert now sends on_conflict=user_id,order_id (idempotent)
//   B) AUTO_BIND replies the TRUTH — ok:false when the capture write fails
//   C) a failed capture is retried once (idempotent) and reports ok on success
//   E) the failure carries the real PostgREST code/status, not "unknown"
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Buffer } from 'node:buffer';

const here = dirname(fileURLToPath(import.meta.url));
const bgText = readFileSync(join(here, '..', 'background.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  → ' + x : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Non-expired fake JWT so isAuthenticated() is true without any network refresh.
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const JWT = 'h.' + b64url({ sub: 'user-abc-1234', exp: 4102444800 }) + '.s';

const httpResp = (status, bodyText, jsonVal) => ({
  ok: status >= 200 && status < 300, status,
  text: () => Promise.resolve(bodyText || ''),
  json: () => Promise.resolve(jsonVal !== undefined ? jsonVal : []),
});
const CONFLICT_BODY = '{"code":"23505","message":"duplicate key value violates unique constraint \\"idx_capture_events_user_order\\"","details":"Key (user_id, order_id)=(x, y) already exists.","hint":null}';

function boot() {
  const store = { lensed_access_token: JWT, lensed_refresh_token: 'r', lensed_user_id: 'user-abc-1234' };
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://shop.tiktok.com/', runScripts: 'dangerously' });
  const { window } = dom;
  let onMessage = null;
  const read = (keys) => { const o = {}; (Array.isArray(keys) ? keys : keys == null ? Object.keys(store) : [keys]).forEach((k) => { if (k in store) o[k] = store[k]; }); return o; };
  window.chrome = {
    runtime: {
      lastError: null, id: 't', getManifest: () => ({ version: '0.2.23' }),
      onMessage: { addListener: (fn) => { onMessage = fn; } }, onMessageExternal: { addListener: () => {} }, sendMessage: () => {},
    },
    storage: { local: {
      get: (k, cb) => cb ? setTimeout(() => cb(read(k)), 2) : new Promise((r) => setTimeout(() => r(read(k)), 2)),
      set: (o, cb) => cb ? setTimeout(() => { Object.assign(store, o); cb(); }, 1) : new Promise((r) => setTimeout(() => { Object.assign(store, o); r(); }, 1)),
      remove: (k, cb) => cb && cb(),
    } },
    tabs: { query: (q, cb) => cb && cb([]), sendMessage: () => Promise.resolve(), onRemoved: { addListener() {} } },
  };
  const captureCalls = [];
  let captureQueue = [];
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes('/rest/v1/capture_events')) { captureCalls.push(u); return Promise.resolve(captureQueue.shift() || httpResp(201, '[]', [{}])); }
    return Promise.resolve(httpResp(200, '[]', []));
  };
  window.eval(bgText);
  return { getOnMessage: () => onMessage, captureCalls, setCaptureQueue: (q) => { captureQueue = q; } };
}
const send = (fn, msg) => new Promise((res) => { const r = fn(msg, {}, (resp) => res(resp)); if (r !== true) res(undefined); });
const sale = (id, ok = true) => ({ orderId: id, buyerUsername: 'x', sellingPrice: '$5', isPaymentSuccessful: ok, roomId: 'room1', orderStatus: 1 });

async function run() {
  const sw = boot();
  await sleep(20); // rehydrate settles → authenticated
  const l = sw.getOnMessage();

  // A + capture success: no-staged order, capture upsert returns 201.
  sw.setCaptureQueue([httpResp(201, '[]', [{}])]);
  const r1 = await send(l, { type: 'AUTO_BIND', sale: sale('order-A-1'), stagedSkus: [] });
  ok('A) capture upsert sends on_conflict=user_id,order_id', /on_conflict=user_id(%2C|,)order_id/.test(sw.captureCalls[0] || ''), sw.captureCalls[0]);
  ok('B) no-staged + capture ok → reply ok:true, bound:false', r1 && r1.ok === true && r1.bound === false, JSON.stringify(r1));
  ok('B) reason is no_staged (informational, not error)', r1 && r1.reason === 'no_staged', JSON.stringify(r1));

  // B + E: capture fails persistently (both attempts 409) → reply ok:false with real code.
  const before = sw.captureCalls.length;
  sw.setCaptureQueue([httpResp(409, CONFLICT_BODY), httpResp(409, CONFLICT_BODY)]);
  const r2 = await send(l, { type: 'AUTO_BIND', sale: sale('order-B-2'), stagedSkus: [] });
  ok('B) capture failure → reply ok:false', r2 && r2.ok === false, JSON.stringify(r2));
  ok('B) reason capture_write_failed', r2 && r2.reason === 'capture_write_failed', JSON.stringify(r2));
  ok('E) real PostgREST code surfaced (23505, not "unknown")', r2 && r2.code === '23505', JSON.stringify(r2));
  ok('E) HTTP status surfaced (409)', r2 && r2.status === 409, JSON.stringify(r2));
  ok('C) failed capture retried once (2 upsert attempts)', sw.captureCalls.length - before === 2, 'delta=' + (sw.captureCalls.length - before));

  // C: transient failure — first 409, retry 201 → reply ok:true.
  const before2 = sw.captureCalls.length;
  sw.setCaptureQueue([httpResp(409, CONFLICT_BODY), httpResp(201, '[]', [{}])]);
  const r3 = await send(l, { type: 'AUTO_BIND', sale: sale('order-C-3'), stagedSkus: [] });
  ok('C) transient capture failure recovered on retry → ok:true', r3 && r3.ok === true, JSON.stringify(r3));
  ok('C) exactly 2 attempts for the transient case', sw.captureCalls.length - before2 === 2, 'delta=' + (sw.captureCalls.length - before2));

  // Duplicate order+status is skipped truthfully (not a failure).
  const r4 = await send(l, { type: 'AUTO_BIND', sale: sale('order-A-1'), stagedSkus: [] });
  ok('dedup: same order+status → skipped:true, ok:true', r4 && r4.ok === true && r4.skipped === true, JSON.stringify(r4));

  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + `: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
run().catch((e) => { console.error(e); process.exit(2); });
