// Host-segment CLOSE paths (Phase 2c). Loads the REAL background.js in jsdom and proves each of
// the four end/reset paths actually FIRES close_session_host_segment with the right p_source.
//
// Why observe rather than assert: closes are best-effort and non-fatal by design, so a close
// that never fires is SILENT. The failure mode that matters is a segment left open, and an open
// segment is indistinguishable from "still selling" — it would credit a host until the read
// path's ceiling. So each path is driven and the resulting RPC call is inspected.
//
// Run: node extension/test/background-host-close.test.mjs
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
const jwt = (sub) => 'h.' + b64url({ sub, exp: 4102444800 }) + '.s';
const httpResp = (status, bodyText, jsonVal) => ({
  ok: status >= 200 && status < 300, status,
  text: () => Promise.resolve(bodyText || ''),
  json: () => Promise.resolve(jsonVal !== undefined ? jsonVal : []),
});

const SESSION_FOR = { room1: 'sess-room1', room2: 'sess-room2' };
const HOST_A = 'emp-host-A';
const STAGED = [{ id: 'sku-1', qty: 1 }];
const sale = (id, room) => ({ orderId: id, buyerUsername: 'x', sellingPrice: '$5', isPaymentSuccessful: true, roomId: room, orderStatus: 1 });

// `closeReturns` lets a test make the RPC return null (nothing open) vs a segment id.
function boot(opts = {}) {
  const store = { lensed_access_token: jwt('user-A'), lensed_refresh_token: 'r', lensed_user_id: 'user-A' };
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://shop.tiktok.com/', runScripts: 'dangerously' });
  const { window } = dom;
  let onMessage = null, onMessageExternal = null, onRemoved = null;
  const read = (keys) => { const o = {}; (Array.isArray(keys) ? keys : keys == null ? Object.keys(store) : [keys]).forEach((k) => { if (k in store) o[k] = store[k]; }); return o; };
  window.chrome = {
    runtime: {
      lastError: null, id: 't', getManifest: () => ({ version: '0.2.23' }),
      onMessage: { addListener: (fn) => { onMessage = fn; } },
      onMessageExternal: { addListener: (fn) => { onMessageExternal = fn; } },
      sendMessage: () => {},
    },
    storage: { local: {
      get: (k, cb) => cb ? setTimeout(() => cb(read(k)), 2) : new Promise((r) => setTimeout(() => r(read(k)), 2)),
      set: (o, cb) => cb ? setTimeout(() => { Object.assign(store, o); cb(); }, 1) : new Promise((r) => setTimeout(() => { Object.assign(store, o); r(); }, 1)),
      remove: (k, cb) => cb && cb(),
    } },
    tabs: {
      query: (q, cb) => cb && cb([]),
      sendMessage: (id, m) => { tabMessages.push(m); return Promise.resolve(); },
      onRemoved: { addListener: (fn) => { onRemoved = fn; } },
    },
    alarms: { create: () => {}, clear: () => {}, onAlarm: { addListener: () => {} } },
  };

  const tabMessages = [];  // everything broadcast to tabs — lets us assert on failures
  const closeCalls = [];   // { session, source, at }
  const openCalls = [];
  window.fetch = (url, opts2) => {
    const u = String(url);
    let body = {};
    try { body = opts2 && opts2.body ? JSON.parse(opts2.body) : {}; } catch (_) {}
    if (u.includes('/rpc/close_session_host_segment')) {
      closeCalls.push({ session: body.p_session_id, source: body.p_source, at: body.p_at });
      // Default: pretend a segment was open and got closed. `closeReturns:null` simulates
      // the idempotent no-op (nothing was open).
      return Promise.resolve(httpResp(200, '', opts.closeReturns === undefined ? 'seg-closed' : opts.closeReturns));
    }
    if (u.includes('/rpc/open_session_host_segment')) {
      openCalls.push({ session: body.p_session_id, host: body.p_host_id, source: body.p_source });
      return Promise.resolve(httpResp(200, '', 'seg-open'));
    }
    if (u.includes('/rest/v1/live_sessions')) {
      const m = u.match(/tiktok_live_id=eq\.([^&]+)/);
      const room = m ? decodeURIComponent(m[1]) : null;
      if (room && SESSION_FOR[room]) {
        return Promise.resolve(httpResp(200, '', [{ id: SESSION_FOR[room], status: 'live', tiktok_live_id: room, started_at: new Date().toISOString() }]));
      }
      return Promise.resolve(httpResp(200, '', []));
    }
    if (u.includes('/rest/v1/employees')) return Promise.resolve(httpResp(200, '', [{ id: HOST_A, name: 'A', role: 'host', status: 'active' }]));
    return Promise.resolve(httpResp(200, '', []));
  };
  window.eval(bgText);
  return {
    internal: () => onMessage, external: () => onMessageExternal, removed: () => onRemoved,
    closeCalls, openCalls, tabMessages,
  };
}
// The real content script always sends from a tab, and background.js records that tab id as
// liveTabId — which onRemoved keys off. Passing {} as sender (as the other suites do) leaves
// liveTabId null and the tab-close path unreachable.
const TAB_ID = 77;
const send = (fn, msg, sender) => new Promise((res) => { const r = fn(msg, sender || { tab: { id: TAB_ID } }, (resp) => res(resp)); if (r !== true) res(undefined); });

// Bring a worker to "room1 live, host A selected, session resolved".
async function live(sw) {
  const l = sw.internal();
  await send(l, { type: 'TIKTOK_ROOM', roomId: 'room1' });
  await sleep(10);
  await send(l, { type: 'SET_SESSION_HOST', hostId: HOST_A, roomId: 'room1' });
  await send(l, { type: 'AUTO_BIND', sale: sale('o1', 'room1'), stagedSkus: STAGED });
  await sleep(30);
  return l;
}
const closesWith = (sw, source) => sw.closeCalls.filter((c) => c.source === source);

async function run() {
  // ── A. ROOM CHANGE ────────────────────────────────────────────────────────────────
  {
    const sw = boot(); await sleep(25); const l = await live(sw);
    ok('A) setup: an open segment exists for room1', sw.openCalls.length > 0, JSON.stringify(sw.openCalls));
    await send(l, { type: 'TIKTOK_ROOM', roomId: 'room2' });   // new live
    await sleep(40);
    const c = closesWith(sw, 'room_change_close');
    ok('A) room change FIRED a close with room_change_close', c.length === 1, JSON.stringify(sw.closeCalls));
    ok('A) …against room1\'s session, not the new room\'s',
       c.length === 1 && c[0].session === SESSION_FOR.room1, JSON.stringify(c));
  }
  // ── B. USER CHANGE ────────────────────────────────────────────────────────────────
  {
    const sw = boot(); await sleep(25); await live(sw);
    await send(sw.external(), { type: 'LENSED_AUTH', accessToken: jwt('user-B') });
    await sleep(40);
    const c = closesWith(sw, 'user_change_close');
    ok('B) user change FIRED a close with user_change_close', c.length === 1, JSON.stringify(sw.closeCalls));
    ok('B) …against the outgoing user\'s session',
       c.length === 1 && c[0].session === SESSION_FOR.room1, JSON.stringify(c));
  }
  // ── C. TAB CLOSE ──────────────────────────────────────────────────────────────────
  {
    const sw = boot(); await sleep(25); const l = await live(sw);
    // the sale path records liveTabId from the message sender; drive onRemoved for that tab
    // liveTabId is recorded from the sender of TIKTOK_HEARTBEAT / TIKTOK_ACCOUNT / TIKTOK_SALE
    // (not AUTO_BIND), and onRemoved keys off it. A real live tab heartbeats every ~45s, so
    // sending one here reproduces the production precondition rather than faking it.
    await send(l, { type: 'TIKTOK_HEARTBEAT', roomId: 'room1' });
    await sleep(20);
    const rm = sw.removed();
    ok('C) onRemoved listener is registered', typeof rm === 'function');
    if (typeof rm === 'function') { rm(TAB_ID); await sleep(50); }
    const c = closesWith(sw, 'tab_closed');
    ok('C) tab close FIRED a close with tab_closed', c.length >= 1, JSON.stringify(sw.closeCalls));
  }
  // ── D. SESSION END (host ended the live) ──────────────────────────────────────────
  {
    const sw = boot(); await sleep(25); const l = await live(sw);
    await send(l, { type: 'TIKTOK_LIVE_END', roomId: 'room1' });
    await sleep(60);
    const c = closesWith(sw, 'session_end');
    ok('D) live end FIRED a close with session_end', c.length === 1, JSON.stringify(sw.closeCalls));
    ok('D) …against room1\'s session',
       c.length === 1 && c[0].session === SESSION_FOR.room1, JSON.stringify(c));
  }
  // ── E. NO OPEN SEGMENT → IDEMPOTENT NO-OP, NOT AN ERROR ───────────────────────────
  {
    const sw = boot({ closeReturns: null });   // RPC returns null = nothing was open
    await sleep(25);
    const l = sw.internal();
    await send(l, { type: 'TIKTOK_ROOM', roomId: 'room1' });
    await sleep(10);
    // never pick a host; force a session then change room
    await send(l, { type: 'AUTO_BIND', sale: sale('o9', 'room1'), stagedSkus: STAGED });
    await sleep(20);
    await send(l, { type: 'TIKTOK_ROOM', roomId: 'room2' });
    await sleep(40);
    ok('E) close still fired with no host ever picked (fires unconditionally)',
       closesWith(sw, 'room_change_close').length === 1, JSON.stringify(sw.closeCalls));
    const failures = sw.tabMessages.filter((m) => m && m.type === 'LENSED_HOST_SEGMENT_FAILED');
    ok('E) a null return is a no-op, NOT an error (zero failure broadcasts)',
       failures.length === 0 && sw.closeCalls.length > 0,
       `close_calls_examined=${sw.closeCalls.length} failure_broadcasts=${failures.length}`);
  }
  // ── F. every close carries p_at = null so the SERVER clock stamps it ──────────────
  {
    const sw = boot(); await sleep(25); const l = await live(sw);
    await send(l, { type: 'TIKTOK_LIVE_END', roomId: 'room1' });
    await sleep(60);
    ok('F) closes pass p_at = null (server clock, no client skew possible)',
       sw.closeCalls.length > 0 && sw.closeCalls.every((c) => c.at === null || c.at === undefined),
       `${sw.closeCalls.length} close calls examined: ${JSON.stringify(sw.closeCalls)}`);
  }

  console.log('');
  console.log(fail === 0 ? `ALL PASS: ${pass} passed, 0 failed` : `FAILED: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
run();
