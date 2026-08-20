// Room-keyed host selection (Phase 2a). Loads the REAL background.js in jsdom and proves the
// worker keeps ONE HOST PER ROOM rather than one global scalar.
//
// The bug this pins: with a single `selectedHostId`, two live tabs on one machine meant the
// second host pick overwrote the first, and any later re-apply for the first session attached
// the WRONG host. The DB's per-session unique index cannot catch it — each session still ends
// up with exactly one host, internally consistent and wrongly attributed. Snore has run 3
// concurrent sessions on one store, so this is live exposure, not a hypothetical.
//
// Run: node extension/test/background-host-rooms.test.mjs
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

// Each room maps to its own session id, the way live_sessions would resolve them.
const SESSION_FOR = { room1: 'sess-room1-aaaa', room2: 'sess-room2-bbbb' };
const HOST_A = 'emp-aaaa-host-A';
const HOST_B = 'emp-bbbb-host-B';

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
    alarms: { create: () => {}, clear: () => {}, onAlarm: { addListener: () => {} } },
  };

  // Every set_session_host RPC call, in order — the assertion surface for attribution.
  const hostRpcCalls = [];
    window.fetch = (url, opts) => {
    const u = String(url);
    let body = {};
    try { body = opts && opts.body ? JSON.parse(opts.body) : {}; } catch (_) {}

    if (u.includes('/rpc/set_session_host')) {
      hostRpcCalls.push({ session: body.p_session_id, host: body.p_host_id });
      return Promise.resolve(httpResp(200, '', null));
    }
    // Session lookup: return the session belonging to the requested room.
    if (u.includes('/rest/v1/live_sessions')) {
      const m = u.match(/tiktok_live_id=eq\.([^&]+)/);
      const room = m ? decodeURIComponent(m[1]) : null;
      if (room && SESSION_FOR[room]) {
        return Promise.resolve(httpResp(200, '', [{ id: SESSION_FOR[room], status: 'live', tiktok_live_id: room, started_at: new Date().toISOString() }]));
      }
      return Promise.resolve(httpResp(200, '', []));
    }
    if (u.includes('/rest/v1/employees')) {
      return Promise.resolve(httpResp(200, '', [{ id: HOST_A, name: 'A', role: 'host', status: 'active' }, { id: HOST_B, name: 'B', role: 'host', status: 'active' }]));
    }
    return Promise.resolve(httpResp(200, '', []));
  };
  window.eval(bgText);
  return { getOnMessage: () => onMessage, hostRpcCalls, win: window };
}

// A fresh bind needs staged SKUs — without them handleAutoBind takes the captured-only path
// and never calls getOrCreateSession, so no session resolves and no host is attached.
const STAGED = [{ id: 'sku-1111', qty: 1 }];
const sale = (id, room) => ({ orderId: id, buyerUsername: 'x', sellingPrice: '$5', isPaymentSuccessful: true, roomId: room, orderStatus: 1 });
const send = (fn, msg) => new Promise((res) => { const r = fn(msg, {}, (resp) => res(resp)); if (r !== true) res(undefined); });

async function run() {
  const sw = boot();
  await sleep(25);
  const l = sw.getOnMessage();

  // ── 1. a pick with NO roomId is DEFERRED, not applied and not an error ──────────────
  const noRoom = await send(l, { type: 'SET_SESSION_HOST', hostId: HOST_A, roomId: null });
  ok('1) pick with no roomId is deferred (not applied, not an error)',
     noRoom && noRoom.ok === true && noRoom.deferred === true && noRoom.reason === 'ROOM_UNKNOWN',
     JSON.stringify(noRoom));
  ok('1) …and fired no set_session_host RPC', sw.hostRpcCalls.length === 0,
     JSON.stringify(sw.hostRpcCalls));

  // ── 2. room1 goes live, host A picked, a sale lands there ─────────────────────────
  //     The sale is what resolves the session (getOrCreateSession -> maybeApplyHost), so it is
  //     required to exercise the attach RPC at all.
  await send(l, { type: 'TIKTOK_ROOM', roomId: 'room1' });
  await sleep(10);
  const r1 = await send(l, { type: 'SET_SESSION_HOST', hostId: HOST_A, roomId: 'room1' });
  await send(l, { type: 'AUTO_BIND', sale: sale('order-r1-1', 'room1'), stagedSkus: STAGED });
  await sleep(30);
  ok('2) room1 pick accepted and scoped to room1', r1 && r1.ok === true && r1.roomId === 'room1' && r1.hostId === HOST_A,
     JSON.stringify(r1));
  ok('2) room1 session got host A attached',
     sw.hostRpcCalls.some((c) => c.session === SESSION_FOR.room1 && c.host === HOST_A),
     JSON.stringify(sw.hostRpcCalls));

  // ── 3. second tab: host B picked for room2, a sale lands there ─────────────────────
  const r2 = await send(l, { type: 'SET_SESSION_HOST', hostId: HOST_B, roomId: 'room2' });
  await send(l, { type: 'AUTO_BIND', sale: sale('order-r2-1', 'room2'), stagedSkus: STAGED });
  await sleep(30);
  ok('3) room2 pick accepted and scoped to room2', r2 && r2.ok === true && r2.roomId === 'room2' && r2.hostId === HOST_B,
     JSON.stringify(r2));
  ok('3) room2 session got host B attached',
     sw.hostRpcCalls.some((c) => c.session === SESSION_FOR.room2 && c.host === HOST_B),
     JSON.stringify(sw.hostRpcCalls));

  // ── 4. THE REGRESSION: another sale back in room1 must re-attach host A, not B ─────
  //     With the old global scalar, room2's pick had overwritten selectedHostId, so this
  //     re-apply attached HOST_B to room1's session — silently misattributing the whole show.
  const back = await send(l, { type: 'SET_SESSION_HOST', hostId: HOST_A, roomId: 'room1' });
  await send(l, { type: 'AUTO_BIND', sale: sale('order-r1-2', 'room1'), stagedSkus: STAGED });
  await sleep(30);
  ok('4) room1 still holds host A after room2 was picked (no clobber)',
     back && back.hostId === HOST_A, JSON.stringify(back));
  // The return value alone does NOT discriminate — the old global scalar also happened to hold
  // HOST_A at this point. The discriminating assertion is at the RPC level: room1's session must
  // NEVER have been attached to host B.
  const room1Attaches = sw.hostRpcCalls.filter((c) => c.session === SESSION_FOR.room1);
  ok('4) room1 session was NEVER attached to host B',
     room1Attaches.length > 0 && room1Attaches.every((c) => c.host === HOST_A),
     JSON.stringify(room1Attaches));

  // ── 5. no RPC ever paired one room's session with the other room's host ───────────
  const wrongPairs = sw.hostRpcCalls.filter((c) =>
    (c.session === SESSION_FOR.room1 && c.host !== HOST_A) ||
    (c.session === SESSION_FOR.room2 && c.host !== HOST_B));
  ok('5) no set_session_host call crossed a room boundary',
     wrongPairs.length === 0, `calls=${JSON.stringify(sw.hostRpcCalls)} wrong=${JSON.stringify(wrongPairs)}`);
  // ANTI-VACUITY (supabase/migrations/CONVENTIONS.md): a "no bad pairs" pass is meaningless
  // unless there were pairs to examine. This caught a real vacuous pass on first run.
  ok('5) …and BOTH rooms actually attached (not a vacuous pass)',
     sw.hostRpcCalls.some((c) => c.session === SESSION_FOR.room1) &&
     sw.hostRpcCalls.some((c) => c.session === SESSION_FOR.room2),
     `calls=${sw.hostRpcCalls.length}: ${JSON.stringify(sw.hostRpcCalls)}`);

  // ── 6. clearing one room's host leaves the other room's intact ─────────────────────
  await send(l, { type: 'SET_SESSION_HOST', hostId: null, roomId: 'room2' });
  const after = await send(l, { type: 'SET_SESSION_HOST', hostId: HOST_A, roomId: 'room1' });
  ok('6) clearing room2 does not clear room1', after && after.hostId === HOST_A, JSON.stringify(after));
  // Discriminating form: after clearing room2, a further room1 sale must still attach host A.
  await send(l, { type: 'AUTO_BIND', sale: sale('order-r1-3', 'room1'), stagedSkus: STAGED });
  await sleep(30);
  const room2Attaches = sw.hostRpcCalls.filter((c) => c.session === SESSION_FOR.room2);
  ok('6) …and room2 session was NEVER attached to host A',
     room2Attaches.length > 0 && room2Attaches.every((c) => c.host === HOST_B),
     JSON.stringify(room2Attaches));

  console.log('');
  console.log(fail === 0 ? `ALL PASS: ${pass} passed, 0 failed` : `FAILED: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
run();
