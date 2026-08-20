// Room-keyed host selection (2a) + the segment writer (2b). Loads the REAL background.js in jsdom and proves the
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
    tabs: { query: (q, cb) => cb && cb([{ id: 1 }]), sendMessage: (id, m) => { tabMessages.push(m); return Promise.resolve(); }, onRemoved: { addListener() {} } },
    alarms: { create: () => {}, clear: () => {}, onAlarm: { addListener: () => {} } },
  };

  // Every host RPC call, in order — the assertion surface for attribution. `fn` records WHICH
  // rpc was hit so the test can prove set_session_host is no longer used at all.
  const tabMessages = [];   // broadcasts to tabs, so the OK/FAILED messages are assertable
  const hostRpcCalls = [];
    window.fetch = (url, opts) => {
    const u = String(url);
    let body = {};
    try { body = opts && opts.body ? JSON.parse(opts.body) : {}; } catch (_) {}

    if (u.includes('/rpc/open_session_host_segment')) {
      hostRpcCalls.push({ fn: 'open_session_host_segment', session: body.p_session_id, host: body.p_host_id, at: body.p_at, source: body.p_source });
      return Promise.resolve(httpResp(200, '', 'seg-' + hostRpcCalls.length));
    }
    if (u.includes('/rpc/set_session_host')) {
      hostRpcCalls.push({ fn: 'set_session_host', session: body.p_session_id, host: body.p_host_id });
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
  return { getOnMessage: () => onMessage, hostRpcCalls, tabMessages, win: window };
}

// A fresh bind needs staged SKUs — without them handleAutoBind takes the captured-only path
// and never calls getOrCreateSession, so no session resolves and no host is attached.
const STAGED = [{ id: 'sku-1111', qty: 1 }];
const sale = (id, room) => ({ orderId: id, buyerUsername: 'x', sellingPrice: '$5', isPaymentSuccessful: true, roomId: room, orderStatus: 1 });
const hostRpcCalls_none = (sw, fn) => !sw.hostRpcCalls.some((c) => c.fn === fn);
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

  // ── 6b. THE REPLY SHAPE ITSELF — room known, no session yet ────────────────────────
  //     This is the shape the overlay renders from, so it has to be asserted HERE, against the
  //     real worker, not hand-constructed in the overlay test. A constructed reply is exactly
  //     how the overlay came to render "waiting for room" for a room that was known: the
  //     overlay test built {deferred:true, reason:'ROOM_UNKNOWN'} and production returned
  //     {pending:true, reason:'NO_SESSION_YET'}.
  {
    const sw2 = boot();
    await sleep(25);
    const l2 = sw2.getOnMessage();
    await send(l2, { type: 'TIKTOK_ROOM', roomId: 'room1' });
    await sleep(10);
    // NO sale driven, so getOrCreateSession never runs and no session exists.
    const r = await send(l2, { type: 'SET_SESSION_HOST', hostId: HOST_A, roomId: 'room1' });
    ok('6b) room known + no session → ok:true (not an error)', r && r.ok === true, JSON.stringify(r));
    ok('6b) …roomId echoed back (the room WAS known)', r && r.roomId === 'room1', JSON.stringify(r));
    ok('6b) …pending:true', r && r.pending === true, JSON.stringify(r));
    ok('6b) …reason is NO_SESSION_YET, NOT ROOM_UNKNOWN',
       r && r.reason === 'NO_SESSION_YET', JSON.stringify(r && r.reason));
    ok('6b) …deferred is NOT set (that flag is room-unknown only)',
       !(r && r.deferred), JSON.stringify(r && r.deferred));
    ok('6b) …sessionId is null', r && r.sessionId === null, JSON.stringify(r && r.sessionId));
    ok('6b) …and no host RPC fired (nothing to attach to)',
       sw2.hostRpcCalls.length === 0, JSON.stringify(sw2.hostRpcCalls));
  }

  // ── 6c. a success broadcast is emitted when a segment DOES open ────────────────────
  {
    const sw3 = boot();
    await sleep(25);
    const l3 = sw3.getOnMessage();
    await send(l3, { type: 'TIKTOK_ROOM', roomId: 'room1' });
    await sleep(10);
    await send(l3, { type: 'SET_SESSION_HOST', hostId: HOST_A, roomId: 'room1' });
    await send(l3, { type: 'AUTO_BIND', sale: sale('order-ok-1', 'room1'), stagedSkus: STAGED });
    await sleep(40);
    const oks = sw3.tabMessages.filter((m) => m && m.type === 'LENSED_HOST_SEGMENT_OK');
    ok('6c) opening a segment broadcasts LENSED_HOST_SEGMENT_OK',
       oks.length >= 1, JSON.stringify(sw3.tabMessages.map((m) => m && m.type)));
    ok('6c) …carrying the room and host so the overlay can filter it',
       oks.length >= 1 && oks[0].roomId === 'room1' && oks[0].hostId === HOST_A, JSON.stringify(oks[0]));
    ok('6c) …and the RPC really ran (not a vacuous pass)',
       sw3.hostRpcCalls.length >= 1, String(sw3.hostRpcCalls.length));
  }

  // ── 7. (2b) the writer replaced set_session_host entirely ─────────────────────────
  ok('7) set_session_host is NEVER called any more',
     hostRpcCalls_none(sw, 'set_session_host') && sw.hostRpcCalls.length > 0,
     JSON.stringify(sw.hostRpcCalls.map((c) => c.fn)));
  ok('7) every host attach went through open_session_host_segment',
     sw.hostRpcCalls.every((c) => c.fn === 'open_session_host_segment'),
     JSON.stringify(sw.hostRpcCalls.map((c) => c.fn)));

  // ── 8. (2b) p_source distinguishes the three trigger kinds ────────────────────────
  const sources = [...new Set(sw.hostRpcCalls.map((c) => c.source))].sort();
  ok('8) p_source is always a valid vocabulary value',
     sw.hostRpcCalls.length > 0 && sw.hostRpcCalls.every((c) =>
       ['extension_switch', 'session_create', 'session_reuse'].includes(c.source)),
     JSON.stringify(sources));
  ok('8) a session-resolution source is used, not only extension_switch',
     sources.some((x) => x === 'session_create' || x === 'session_reuse'),
     JSON.stringify(sources));

  // ── 9. (2b) p_at carries the operator's pick instant, not null ────────────────────
  const withAt = sw.hostRpcCalls.filter((c) => c.at);
  ok('9) p_at carries an ISO instant so a switch lands when it was MADE',
     withAt.length > 0 && withAt.every((c) => !Number.isNaN(Date.parse(c.at))),
     `${withAt.length}/${sw.hostRpcCalls.length} calls carried p_at: ${JSON.stringify(withAt.map((c) => c.at))}`);

  console.log('');
  console.log(fail === 0 ? `ALL PASS: ${pass} passed, 0 failed` : `FAILED: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
run();
