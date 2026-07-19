// Passive-follower auth test (fix/ext-auth-passive-follower).
// Loads the REAL background.js in jsdom with mocked chrome + fetch and proves the
// dual-refresh logout root is gone and the degrade/flush path works:
//   A) the extension NEVER calls POST /auth/v1/token — not on a 401, not on rehydrate
//      of an expired token (this independent refresh was the logout root cause)
//   B) expiry gate: an expired access token reads UNAUTHENTICATED → a sale is ENQUEUED
//      (degrade to the Fix-A queue), not written and not lost
//   C) re-auth flush: a fresh token via LENSED_AUTH drains the queued sale
//   D) a 401 write marks the session stale (broadcasts authenticated:false) and the
//      NEXT sale degrades to the queue — still no /token call
//   E) channel ack contract: TIKTOK_ACCOUNT replies { persisted:false } while stale and
//      { persisted:true } once authenticated+session resolve (drives the content-side
//      re-send-until-acked retry that stops channel_handle landing NULL — Bug 3)
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
const jwtExp = (sub, exp) => 'h.' + b64url({ sub, exp }) + '.s';
const FRESH = (sub) => jwtExp(sub, 4102444800);       // year 2100 — valid
const EXPIRED = (sub) => jwtExp(sub, 1000000000);     // year 2001 — expired

const httpResp = (status, bodyText, jsonVal) => ({
  ok: status >= 200 && status < 300, status,
  text: () => Promise.resolve(bodyText || ''),
  json: () => Promise.resolve(jsonVal !== undefined ? jsonVal : []),
});

const K_AT = 'lensed_access_token', K_RT = 'lensed_refresh_token', K_UID = 'lensed_user_id';
const K_SID = 'lensed_session_id', K_ROOM = 'lensed_room_id', K_TS = 'lensed_session_ts';
const K_QUEUE = 'lensed_sale_queue';

// opts.writeStatus: HTTP status for /rest/v1 writes/reads (default 200). Lets us force 401.
function boot(seed, opts) {
  opts = opts || {};
  const store = Object.assign({}, seed);
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://shop.tiktok.com/', runScripts: 'dangerously' });
  const { window } = dom;
  let onMessage = null, onExternal = null;
  const broadcasts = [];
  const fetched = [];
  const read = (keys) => { const o = {}; (Array.isArray(keys) ? keys : keys == null ? Object.keys(store) : [keys]).forEach((k) => { if (k in store) o[k] = store[k]; }); return o; };
  const asPromiseOrCb = (compute, cb) => { const p = new Promise((r) => setTimeout(() => r(compute()), 1)); if (cb) { p.then(cb); return undefined; } return p; };
  window.chrome = {
    runtime: {
      lastError: null, id: 't', getManifest: () => ({ version: '0.3.0' }),
      onMessage: { addListener: (fn) => { onMessage = fn; } },
      onMessageExternal: { addListener: (fn) => { onExternal = fn; } },
      sendMessage: () => {},
    },
    storage: { local: {
      get: (k, cb) => asPromiseOrCb(() => read(k), cb),
      set: (o, cb) => asPromiseOrCb(() => { Object.assign(store, o); }, cb),
      remove: (keys, cb) => asPromiseOrCb(() => { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete store[k]); }, cb),
    } },
    tabs: {
      query: (q, cb) => { const t = [{ id: 1 }]; if (cb) { cb(t); return; } return Promise.resolve(t); },
      sendMessage: (id, msg) => { broadcasts.push(msg); return Promise.resolve(); },
      onRemoved: { addListener() {} },
    },
  };
  window.fetch = (url, o) => {
    const u = String(url);
    fetched.push(u);
    if (u.includes('/auth/v1/token')) {
      // Should NEVER be hit. If it is, return a "success" so a regression would be
      // masked at runtime but the test's tokenCalls assertion still catches it.
      return Promise.resolve(httpResp(200, '', { access_token: FRESH('user-A'), refresh_token: 'x' }));
    }
    const st = opts.writeStatus || 200;
    if (u.includes('/rest/v1/rpc/lensed_log_auction')) return Promise.resolve(httpResp(st, st === 200 ? '[]' : 'unauth', st === 200 ? [{ item_id: 'i1', auction_number: 1, status: 'sold', replayed: false, expected_price_cents: 0, total_cost_cents: 0 }] : []));
    if (u.includes('/rest/v1/')) return Promise.resolve(httpResp(st, st === 200 ? '[]' : 'unauth', st === 200 ? [{ id: 'x' }] : []));
    return Promise.resolve(httpResp(200, '[]', []));
  };
  window.eval(bgText);
  return {
    getExternal: () => onExternal, getInternal: () => onMessage,
    broadcasts, store, fetched,
    tokenCalls: () => fetched.filter((u) => u.includes('/auth/v1/token')).length,
    authStatus: () => broadcasts.filter((m) => m && m.type === 'LENSED_AUTH_STATUS'),
    clearFetched: () => { fetched.length = 0; },
  };
}
const send = (fn, msg) => new Promise((res) => { const r = fn(msg, {}, (resp) => res(resp)); if (r !== true) res(undefined); });
const seed = (at, sub) => ({ [K_AT]: at, [K_RT]: 'r', [K_UID]: sub, [K_SID]: 'sess-' + sub, [K_ROOM]: 'room-' + sub, [K_TS]: Date.now() });
const sale = (orderId) => ({ orderId, isPaymentSuccessful: true, roomId: 'room-user-A', sellingPrice: '$5', buyerUsername: 'b' });

async function run() {
  // ── A) NEVER calls /auth/v1/token, even with an expired stored token + a write ──
  {
    const sw = boot(seed(EXPIRED('user-A'), 'user-A'));
    await sleep(25); // rehydrate: expired token → must NOT refresh
    await send(sw.getInternal(), { type: 'AUTO_BIND', sale: sale('o-A'), stagedSkus: [{ id: 'sku1', qty: 1 }] });
    await sleep(10);
    ok('A) NO /auth/v1/token call on rehydrate+write with expired token', sw.tokenCalls() === 0, 'tokenCalls=' + sw.tokenCalls());
  }

  // ── B) Expiry gate → sale ENQUEUED (degrade), not written ────────────────────
  {
    const sw = boot(seed(EXPIRED('user-A'), 'user-A'));
    await sleep(25);
    sw.clearFetched();
    const res = await send(sw.getInternal(), { type: 'AUTO_BIND', sale: sale('o-B'), stagedSkus: [{ id: 'sku1', qty: 1 }] });
    await sleep(10);
    ok('B) AUTO_BIND replies queued (not written) under expired token', res && res.queued === true, JSON.stringify(res));
    ok('B) sale persisted to the queue', Array.isArray(sw.store[K_QUEUE]) && sw.store[K_QUEUE].length === 1, JSON.stringify(sw.store[K_QUEUE]));
    ok('B) NO write/RPC fetch happened (fully degraded)', sw.fetched.filter((u) => u.includes('/rest/v1/')).length === 0, JSON.stringify(sw.fetched));
    ok('B) still no /token call', sw.tokenCalls() === 0, 'tokenCalls=' + sw.tokenCalls());
  }

  // ── C) Re-auth flush: a fresh token drains the queued sale ───────────────────
  {
    const sw = boot(seed(EXPIRED('user-A'), 'user-A'));
    await sleep(25);
    await send(sw.getInternal(), { type: 'AUTO_BIND', sale: sale('o-C'), stagedSkus: [{ id: 'sku1', qty: 1 }] });
    await sleep(10);
    ok('C) precondition: one sale queued', (sw.store[K_QUEUE] || []).length === 1, JSON.stringify(sw.store[K_QUEUE]));
    // Same user, FRESH token via the web-app relay.
    await send(sw.getExternal(), { type: 'LENSED_AUTH', accessToken: FRESH('user-A'), refreshToken: 'r2' });
    await sleep(40); // flushSaleQueue is fire-and-forget
    ok('C) queue drained after re-auth relay', (sw.store[K_QUEUE] || []).length === 0, JSON.stringify(sw.store[K_QUEUE]));
    ok('C) a real write (rpc/rest) happened during flush', sw.fetched.some((u) => u.includes('/rest/v1/')), 'no rest write seen');
    ok('C) flush used the relay, not a /token refresh', sw.tokenCalls() === 0, 'tokenCalls=' + sw.tokenCalls());
  }

  // ── D) A 401 write marks stale → next sale degrades; still no /token ─────────
  {
    const sw = boot(seed(FRESH('user-A'), 'user-A'), { writeStatus: 401 });
    await sleep(25);
    // Authenticated (fresh token) → heartbeat attempts a PATCH → 401 → markAuthStale.
    await send(sw.getInternal(), { type: 'TIKTOK_HEARTBEAT', roomId: 'room-user-A' });
    await sleep(10);
    const st = sw.authStatus();
    ok('D) 401 broadcast authenticated:false (stale)', st.some((m) => m.authenticated === false), JSON.stringify(st.map((m) => m.authenticated)));
    ok('D) 401 did NOT trigger a /token refresh', sw.tokenCalls() === 0, 'tokenCalls=' + sw.tokenCalls());
    // Next sale now degrades because authRejected made isAuthenticated() false.
    const res = await send(sw.getInternal(), { type: 'AUTO_BIND', sale: sale('o-D'), stagedSkus: [{ id: 'sku1', qty: 1 }] });
    await sleep(10);
    ok('D) subsequent sale degrades to queue after stale', res && res.queued === true, JSON.stringify(res));
  }

  // ── E) Channel ack contract (drives the content-side re-send-until-acked retry) ──
  {
    // Stale (expired) → not persisted.
    const sw1 = boot(seed(EXPIRED('user-A'), 'user-A'));
    await sleep(25);
    const r1 = await send(sw1.getInternal(), { type: 'TIKTOK_ACCOUNT', account: { handle: 'onlybidss', source: 'dom' }, roomId: 'room-user-A' });
    ok('E) TIKTOK_ACCOUNT replies persisted:false while stale', r1 && r1.persisted === false, JSON.stringify(r1));

    // Authenticated + resolvable session → persisted:true (DB PATCH ok).
    const sw2 = boot(seed(FRESH('user-A'), 'user-A'));
    await sleep(25);
    const r2 = await send(sw2.getInternal(), { type: 'TIKTOK_ACCOUNT', account: { handle: 'onlybidss', source: 'dom' }, roomId: 'room-user-A' });
    ok('E) TIKTOK_ACCOUNT replies persisted:true when authed+session', r2 && r2.persisted === true, JSON.stringify(r2));
  }

  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + `: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
run().catch((e) => { console.error(e); process.exit(2); });
