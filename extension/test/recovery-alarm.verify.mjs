// Verification harness for the recovery-alarm + always-on logging + ghost-fix changes.
// Loads the REAL background.js in jsdom with mocked chrome (incl. chrome.alarms) + fetch.
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
const httpResp = (status, jsonVal) => ({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(JSON.stringify(jsonVal ?? [])), json: () => Promise.resolve(jsonVal ?? []) });

function boot(opts) {
  opts = opts || {};
  const expIn = opts.expInSec != null ? opts.expInSec : 4102444800 - Math.floor(Date.now() / 1000);
  const JWT = 'h.' + b64url({ sub: 'user-abc-1234', exp: Math.floor(Date.now() / 1000) + expIn }) + '.s';
  const store = { lensed_access_token: JWT, lensed_refresh_token: 'r', lensed_user_id: 'user-abc-1234' };
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://shop.tiktok.com/', runScripts: 'dangerously' });
  const { window } = dom;
  let onMessage = null, alarmHandler = null;
  const read = (keys) => { const o = {}; (Array.isArray(keys) ? keys : keys == null ? Object.keys(store) : [keys]).forEach((k) => { if (k in store) o[k] = store[k]; }); return o; };
  window.chrome = {
    runtime: { lastError: null, id: 't', getManifest: () => ({ version: '0.4.0' }), onMessage: { addListener: (fn) => { onMessage = fn; } }, onMessageExternal: { addListener: () => {} }, sendMessage: () => {} },
    storage: { local: {
      get: (k, cb) => cb ? setTimeout(() => cb(read(k)), 2) : new Promise((r) => setTimeout(() => r(read(k)), 2)),
      set: (o, cb) => cb ? setTimeout(() => { Object.assign(store, o); cb(); }, 1) : new Promise((r) => setTimeout(() => { Object.assign(store, o); r(); }, 1)),
      remove: (k, cb) => cb && cb(),
    } },
    tabs: { query: (q, cb) => cb && cb([]), sendMessage: () => Promise.resolve(), onRemoved: { addListener() {} } },
    alarms: { create: () => {}, onAlarm: { addListener: (fn) => { alarmHandler = fn; } } },
  };
  const calls = []; // {method,url}
  const q = { live_sessions_get: opts.liveSessionsGet || [], token: opts.tokenResp };
  window.fetch = (url, o) => {
    const u = String(url); const m = (o && o.method) || 'GET'; calls.push({ method: m, url: u });
    if (u.includes('/auth/v1/token')) return Promise.resolve(q.token || httpResp(200, { access_token: 'NEW.' + b64url({ sub: 'user-abc-1234', exp: Math.floor(Date.now() / 1000) + 3600 }) + '.s', refresh_token: 'r2' }));
    if (u.includes('/rest/v1/live_sessions') && m === 'GET') return Promise.resolve(httpResp(200, q.live_sessions_get));
    if (u.includes('/rest/v1/live_sessions') && m === 'PATCH') return Promise.resolve(httpResp(200, [{}]));
    if (u.includes('/rest/v1/live_sessions') && m === 'POST') return Promise.resolve(httpResp(201, [{ id: 'GHOST-NEW' }]));
    if (u.includes('/rest/v1/capture_events')) return Promise.resolve(httpResp(201, [{}]));
    if (u.includes('/rest/v1/rpc/lensed_log_auction')) return Promise.resolve(httpResp(200, [{ item_id: 'it1', status: 'sold', replayed: false }]));
    return Promise.resolve(httpResp(200, []));
  };
  // Test bridge: appended into the SAME eval program so it closes over background.js's
  // module-scoped vars/functions (they don't attach to window in jsdom). Harness-only.
  const bridge = ';globalThis.__T={'
    + 'ring:function(){return diagRing;},'
    + 'queue:function(){return saleQueue;},'
    + 'diagEnabled:function(){return diagEnabled;},'
    + 'setPinned:function(s,r){currentSessionId=s;sessionRoomId=r;currentRoomId=r;},'
    + 'setQueue:function(q){saleQueue=q;saleQueueLoaded=true;},'
    + 'setPing:function(ts){lastContentPingTs=ts;lastHeartbeatWriteTs=0;lastHeartbeatLoggedSid=null;},'
    + 'replay:function(i){return replayQueuedSale(i);},'
    + 'runTick:function(){return runRecoveryTick();}'
    + '};';
  window.eval(bgText + bridge);
  return { window, T: window.__T, getOnMessage: () => onMessage, getAlarm: () => alarmHandler, calls };
}
const send = (fn, msg) => new Promise((res) => { const r = fn(msg, {}, (resp) => res(resp)); if (r !== true) res(undefined); });
const countPost = (calls, frag) => calls.filter((c) => c.method === 'POST' && c.url.includes(frag)).length;
const countPatch = (calls, frag) => calls.filter((c) => c.method === 'PATCH' && c.url.includes(frag)).length;
const hasRefresh = (calls) => calls.some((c) => c.url.includes('/auth/v1/token'));

async function run() {
  // ── (d) critical logs record WITHOUT DIAG_ENABLE ────────────────────
  console.log('(d) always-on critical logging (no DIAG_ENABLE sent):');
  { const sw = boot(); await sleep(40);
    const ring = sw.T.ring() || [];
    const types = new Set(ring.map((e) => e.type));
    ok('ring is non-empty without DIAG_ENABLE', ring.length > 0, 'len=' + ring.length);
    ok('sw.start recorded', types.has('sw.start'));
    ok('auth.acquired recorded (rehydrate)', types.has('auth.acquired'));
    ok('all recorded events carry crit:1', ring.every((e) => e.crit === 1), 'non-crit present');
    ok('diagEnabled still false (verbose stays gated)', sw.T.diagEnabled() === false);
  }

  // ── (a) alarm refreshes + flushes WITHOUT a content ping ────────────
  console.log('(a) recovery alarm: refresh + flush with NO content ping:');
  { const sw = boot({ expInSec: 120 }); await sleep(40); // near-expiry (120s < 180 buf; >60 so rehydrate keeps it)
    sw.T.setPinned('sess-live', 'room-live');
    sw.T.setQueue([{ sale: { orderId: 'ord-queued', roomId: 'room-live', isPaymentSuccessful: true, sellingPrice: '$5' }, stagedSkus: [], result: 'sold' }]);
    sw.T.setPing(0); // NEVER pinged by content
    const before = sw.calls.length;
    await sw.getAlarm()({ name: 'lensed_recovery' }); // drive via the real chrome.alarms handler
    await sleep(30);
    const after = sw.calls.slice(before);
    ok('proactive token refresh fired (no 401 needed)', hasRefresh(after), 'no refresh call');
    ok('queue flushed (capture_events POSTed)', countPost(after, 'capture_events') >= 1);
    ok('sale queue drained', (sw.T.queue() || []).length === 0, 'left=' + (sw.T.queue() || []).length);
    const ring = sw.T.ring() || [];
    ok('recovery.refresh + recovery.flush logged', ring.some((e) => e.type === 'recovery.refresh') && ring.some((e) => e.type === 'recovery.flush'));
  }

  // ── (b) bounded heartbeat backstop stops after N min of ping silence ─
  console.log('(b) bounded heartbeat backstop:');
  { const sw = boot(); await sleep(40);
    sw.T.setPinned('sess-live', 'room-live');
    // within backstop window (stalled but < 5min) → SHOULD heartbeat
    sw.T.setPing(Date.now() - (2 * 60 * 1000));
    let before = sw.calls.length;
    await sw.getAlarm()({ name: 'lensed_recovery' }); await sleep(30);
    ok('within window → alarm writes heartbeat PATCH', countPatch(sw.calls.slice(before), 'live_sessions') >= 1);
    // past backstop (> 5min of silence) → must NOT heartbeat (no zombie)
    sw.T.setPing(Date.now() - (6 * 60 * 1000));
    before = sw.calls.length;
    await sw.getAlarm()({ name: 'lensed_recovery' }); await sleep(30);
    ok('past backstop → NO heartbeat PATCH (no zombie)', countPatch(sw.calls.slice(before), 'live_sessions') === 0);
    ok('release logged (content.ping_stall past backstop)', (sw.T.ring() || []).some((e) => e.type === 'content.ping_stall' && /past backstop/.test(e.msg || '')));
  }

  // ── (c) stale-queue flush: attach to existing / captured-only, NO new live row ─
  console.log('(c) ghost-fix: flush never creates a live session row:');
  { // c1: room HAS an existing session → attach, no POST
    const sw = boot({ liveSessionsGet: [{ id: 'sess-existing', status: 'live' }] }); await sleep(40);
    sw.T.setPinned(null, null); // force DB resolve path (no in-memory same-room session)
    const before = sw.calls.length;
    await sw.T.replay({ sale: { orderId: 'ord-stale-1', roomId: 'oldroom', isPaymentSuccessful: true, sellingPrice: '$5' }, stagedSkus: [{ id: 'sku1', qty: 1 }], result: 'sold' });
    await sleep(15);
    const after = sw.calls.slice(before);
    ok('c1 attaches to existing session (RPC bind fired)', after.some((c) => c.url.includes('/rpc/lensed_log_auction')));
    ok('c1 creates NO live_sessions row', countPost(after, 'live_sessions') === 0);
    ok('c1 sale still captured (capture_events POST)', countPost(after, 'capture_events') >= 1);
  }
  { // c2: room has NO session → captured-only, no POST, no RPC
    const sw = boot({ liveSessionsGet: [] }); await sleep(40);
    sw.T.setPinned(null, null);
    const before = sw.calls.length;
    await sw.T.replay({ sale: { orderId: 'ord-stale-2', roomId: 'deadroom', isPaymentSuccessful: true, sellingPrice: '$5' }, stagedSkus: [{ id: 'sku1', qty: 1 }], result: 'sold' });
    await sleep(15);
    const after = sw.calls.slice(before);
    ok('c2 creates NO live_sessions row (captured-only)', countPost(after, 'live_sessions') === 0);
    ok('c2 sale still captured (capture_events POST)', countPost(after, 'capture_events') >= 1);
    ok('c2 no phantom bind (no RPC to a made-up session)', !after.some((c) => c.url.includes('/rpc/lensed_log_auction')));
  }

  console.log('\n' + (fail === 0 ? '✓ ALL PASS' : '✗ ' + fail + ' FAILED') + '  (' + pass + ' passed)');
  process.exit(fail === 0 ? 0 : 1);
}
run();
