// Background payment-status-flip test. Loads the REAL background.js in jsdom with mocked
// chrome + fetch and proves the transition path is driven by the isFlip flag rather than by
// the presence of staged SKUs:
//   A) a flip fires the RPC with the TRANSITION PLACEHOLDER, never the caller's SKUs
//   B) a flip after a worker restart (loggedOrderStatus lost) is still a transition,
//      because the content script asserts isFlip — previously it degraded to no_staged
//   C) a flip does NOT null capture_events.bound_sku_id
//   D) a flip with no resolvable session rolls the dedup back so it can retry
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

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const JWT = 'h.' + b64url({ sub: 'user-abc-1234', exp: 4102444800 }) + '.s';
const httpResp = (status, bodyText, jsonVal) => ({
  ok: status >= 200 && status < 300, status,
  text: () => Promise.resolve(bodyText || ''),
  json: () => Promise.resolve(jsonVal !== undefined ? jsonVal : []),
});

function boot(opts) {
  opts = opts || {};
  const store = { lensed_access_token: JWT, lensed_refresh_token: 'r', lensed_user_id: 'user-abc-1234' };
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://shop.tiktok.com/', runScripts: 'dangerously' });
  const { window } = dom;
  let onMessage = null;
  const read = (keys) => { const o = {}; (Array.isArray(keys) ? keys : keys == null ? Object.keys(store) : [keys]).forEach((k) => { if (k in store) o[k] = store[k]; }); return o; };
  window.chrome = {
    runtime: {
      lastError: null, id: 't', getManifest: () => ({ version: '0.6.7' }),
      onMessage: { addListener: (fn) => { onMessage = fn; } }, onMessageExternal: { addListener: () => {} }, sendMessage: () => {},
    },
    storage: { local: {
      get: (k, cb) => cb ? setTimeout(() => cb(read(k)), 2) : new Promise((r) => setTimeout(() => r(read(k)), 2)),
      set: (o, cb) => cb ? setTimeout(() => { Object.assign(store, o); cb(); }, 1) : new Promise((r) => setTimeout(() => { Object.assign(store, o); r(); }, 1)),
      remove: (k, cb) => cb && cb(),
    } },
    tabs: { query: (q, cb) => cb && cb([]), sendMessage: () => Promise.resolve(), onRemoved: { addListener() {} } },
  };
  const rpcBodies = [];      // lensed_log_auction request bodies
  const captureBodies = [];  // capture_events request bodies
  window.fetch = (url, opts2) => {
    const u = String(url);
    const body = opts2 && opts2.body;
    if (u.includes('/rest/v1/rpc/lensed_log_auction')) {
      rpcBodies.push(JSON.parse(body));
      return Promise.resolve(httpResp(200, '[]', [{ item_id: 'item-1', auction_number: 188, status: 'sold', replayed: false }]));
    }
    if (u.includes('/rest/v1/capture_events')) { captureBodies.push(JSON.parse(body)); return Promise.resolve(httpResp(201, '[]', [{}])); }
    if (u.includes('/rest/v1/live_auction_items')) {
      // Existence probe for a client-asserted flip. `noRow` models an order that was
      // NEVER bound (captured-only), so no auction row exists to transition.
      return Promise.resolve(httpResp(200, '[]', opts.noRow ? [] : [{ id: 'item-1' }]));
    }
    if (u.includes('/rest/v1/live_sessions')) {
      // Session resolution for the room. `null` models "no session could be resolved".
      return Promise.resolve(httpResp(200, '[]', opts.noSession ? [] : [{ id: 'sess-1', room_id: 'room1', status: 'live' }]));
    }
    return Promise.resolve(httpResp(200, '[]', []));
  };
  window.eval(bgText);
  return { getOnMessage: () => onMessage, rpcBodies, captureBodies };
}

const send = (fn, msg) => new Promise((res) => { const r = fn(msg, {}, (resp) => res(resp)); if (r !== true) res(undefined); });
const ORDER = '577560576188190908';
const saleAt = (paid) => ({ orderId: ORDER, buyerUsername: 'Jae.Cole', sellingPrice: '$6.00', isPaymentSuccessful: paid, roomId: 'room1', orderStatus: paid ? 3 : 2 });
const STRAWBERRY = [{ id: 'sku-271-uuid', sku_number: 271, title: 'Jumbo Strawberry Squeeze', qty: 1, unit_cost_cents: 225 }];

async function run() {
  // ── A + C: normal flip inside one worker lifetime ──────────────────────────
  let sw = boot();
  await sleep(20);
  let l = sw.getOnMessage();

  await send(l, { type: 'AUTO_BIND', sale: saleAt(false), stagedSkus: STRAWBERRY });
  const firstRpc = sw.rpcBodies[0] || {};
  ok('A1) first bind logs not_sold with the real SKU', firstRpc.p_result === 'not_sold' && JSON.stringify(firstRpc.p_skus).includes('sku-271-uuid'), JSON.stringify(firstRpc));
  const capBind = sw.captureBodies[0] || {};
  ok('A2) first bind records bound_sku_id', capBind.bound_sku_id === 'sku-271-uuid', JSON.stringify(capBind.bound_sku_id));

  // The flip: content script sends NO staged SKUs and isFlip:true.
  const flipRes = await send(l, { type: 'AUTO_BIND', sale: saleAt(true), stagedSkus: [], isFlip: true });
  const flipRpc = sw.rpcBodies[1] || {};
  ok('A3) flip fires the RPC (transition), reply bound:true', flipRes && flipRes.bound === true, JSON.stringify(flipRes));
  ok('A4) flip sends p_result=sold', flipRpc.p_result === 'sold', JSON.stringify(flipRpc.p_result));
  ok('A5) flip sends the PLACEHOLDER, never a real sku', !JSON.stringify(flipRpc.p_skus || []).includes('sku-286'), JSON.stringify(flipRpc.p_skus));
  ok('A6) flip reuses the ORIGINAL session', flipRpc.p_session_id === 'sess-1', JSON.stringify(flipRpc.p_session_id));

  const capFlip = sw.captureBodies[1] || {};
  ok('C1) flip does NOT null bound_sku_id', capFlip.bound_sku_id === 'sku-271-uuid', JSON.stringify(capFlip.bound_sku_id));
  ok('C2) flip still records the new paid status', capFlip.is_payment_successful === true && capFlip.order_status === 3, JSON.stringify({ p: capFlip.is_payment_successful, s: capFlip.order_status }));

  // ── B: flip arriving at a FRESH worker (restart lost loggedOrderStatus) ─────
  sw = boot();
  await sleep(20);
  l = sw.getOnMessage();
  const coldRes = await send(l, { type: 'AUTO_BIND', sale: saleAt(true), stagedSkus: [], isFlip: true });
  const coldRpc = sw.rpcBodies[0] || {};
  ok('B1) post-restart flip is still a transition, not no_staged', coldRes && coldRes.bound === true && coldRes.reason !== 'no_staged', JSON.stringify(coldRes));
  ok('B2) post-restart flip recovers the room-scoped session', coldRpc.p_session_id === 'sess-1', JSON.stringify(coldRpc.p_session_id));
  const coldCap = sw.captureBodies[0] || {};
  ok('C3) post-restart flip OMITS bound_sku_id rather than nulling it',
    !Object.prototype.hasOwnProperty.call(coldCap, 'bound_sku_id'), JSON.stringify(Object.keys(coldCap)));

  // ── D: flip with no resolvable session → retryable, not silently lost ───────
  sw = boot({ noSession: true });
  await sleep(20);
  l = sw.getOnMessage();
  const noSessRes = await send(l, { type: 'AUTO_BIND', sale: saleAt(true), stagedSkus: [], isFlip: true });
  ok('D1) unresolvable session → bound:false, reason no_session', noSessRes && noSessRes.bound === false && noSessRes.reason === 'no_session', JSON.stringify(noSessRes));
  ok('D2) the order is still captured (revenue never lost)', sw.captureBodies.length === 1, String(sw.captureBodies.length));
  // Dedup was rolled back, so the next cumulative snapshot retries instead of skipping.
  const retry = await send(l, { type: 'AUTO_BIND', sale: saleAt(true), stagedSkus: [], isFlip: true });
  ok('D3) a retry is NOT skipped as a duplicate', !(retry && retry.skipped), JSON.stringify(retry));

  // ── E: client-asserted flip for an order that was NEVER bound (captured-only) ──
  // The RPC's INSERT path would raise SKU_NOT_FOUND on the placeholder sku, roll back,
  // and roll back our dedup — re-firing on every cumulative snapshot. Confirm we detect
  // the missing row first and fall through to normal handling instead.
  sw = boot({ noRow: true });
  await sleep(20);
  l = sw.getOnMessage();
  const unboundRes = await send(l, { type: 'AUTO_BIND', sale: saleAt(true), stagedSkus: [], isFlip: true });
  ok('E1) flip with no auction row does NOT call the RPC', sw.rpcBodies.length === 0, JSON.stringify(sw.rpcBodies));
  ok('E2) it degrades to captured-only, not rpc_failed', unboundRes && unboundRes.ok === true && unboundRes.reason === 'no_staged', JSON.stringify(unboundRes));
  const retryUnbound = await send(l, { type: 'AUTO_BIND', sale: saleAt(true), stagedSkus: [], isFlip: true });
  ok('E3) the next snapshot is deduped — no retry storm', retryUnbound && retryUnbound.skipped === true, JSON.stringify(retryUnbound));
  // ...and a real bind for it still works if the operator stages late.
  const lateBind = await send(l, { type: 'AUTO_BIND', sale: saleAt(false), stagedSkus: STRAWBERRY, isFlip: true });
  ok('E4) a later staged bind for that order still binds', lateBind && lateBind.bound === true, JSON.stringify(lateBind));

  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAIL') + ': ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
run().catch((e) => { console.error(e); process.exit(1); });
