// Live-END detection verification (feat/ext-live-end-detection).
// Loads the REAL background.js in jsdom, drives handleLiveEnd(room), asserts:
//   1) a single end → exactly one PATCH to live_sessions, BY ROOM (tiktok_live_id),
//      status=eq.live guarded, end_source='live_ended'
//   2) the ~2x end POST → deduped to ONE write within the window
//   3) unauthenticated → no write (best-effort; server auto_ender backstops)
//   4) in-memory session cleared ONLY when the end is for the tracked room
//   5) end for an untracked room → tracked session untouched (DB write still by room)
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
const httpResp = (status, jsonVal) => ({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(JSON.stringify(jsonVal ?? [])), json: () => Promise.resolve(jsonVal ?? []) });

function boot(opts) {
  opts = opts || {};
  const store = opts.authed === false ? {} : { lensed_access_token: jwt('user-A'), lensed_user_id: 'user-A' };
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://shop.tiktok.com/', runScripts: 'dangerously' });
  const { window } = dom;
  let alarmHandler = null;
  const patches = []; // {url, body}
  const read = (keys) => { const o = {}; (Array.isArray(keys) ? keys : keys == null ? Object.keys(store) : [keys]).forEach((k) => { if (k in store) o[k] = store[k]; }); return o; };
  window.chrome = {
    runtime: { lastError: null, id: 't', getManifest: () => ({ version: '0.6.0' }), onMessage: { addListener: () => {} }, onMessageExternal: { addListener: () => {} }, sendMessage: () => {} },
    storage: { local: {
      get: (k, cb) => cb ? setTimeout(() => cb(read(k)), 1) : new Promise((r) => setTimeout(() => r(read(k)), 1)),
      set: (o, cb) => cb ? setTimeout(() => { Object.assign(store, o); cb(); }, 1) : new Promise((r) => setTimeout(() => { Object.assign(store, o); r(); }, 1)),
      remove: (keys, cb) => { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete store[k]); return cb ? cb() : Promise.resolve(); },
    } },
    tabs: { query: (q, cb) => cb && cb([]), sendMessage: () => Promise.resolve(), onRemoved: { addListener() {} } },
    alarms: { create: () => {}, onAlarm: { addListener: (fn) => { alarmHandler = fn; } } },
  };
  window.fetch = (url, o) => {
    const u = String(url); const m = (o && o.method) || 'GET';
    if (u.includes('/rest/v1/live_sessions') && m === 'PATCH') { patches.push({ url: u, body: o && o.body }); return Promise.resolve(httpResp(200, [])); }
    return Promise.resolve(httpResp(200, []));
  };
  const bridge = ';globalThis.__T={'
    + 'liveEnd:function(r){return handleLiveEnd(r);},'
    + 'setTracked:function(s,r){currentSessionId=s;sessionRoomId=r;currentRoomId=r;},'
    + 'state:function(){return {sid:currentSessionId,room:sessionRoomId,croom:currentRoomId};},'
    + 'clearDedup:function(){recentlyEndedRooms.clear();}'
    + '};';
  window.eval(bgText + bridge);
  return { T: window.__T, patches };
}

async function run() {
  const ROOM = '7665137927374031646';

  // ── 1 + 2) single end writes once; double-fire deduped ──────────────
  console.log('(1/2) single end → one write; ~2x fire → deduped:');
  { const sw = boot(); await sleep(20);
    await sw.T.liveEnd(ROOM);
    await sw.T.liveEnd(ROOM); // the second (retry) POST
    await sleep(10);
    ok('exactly ONE PATCH despite double-fire', sw.patches.length === 1, 'patches=' + sw.patches.length);
    const p = sw.patches[0] || {};
    ok('PATCH targets the room via tiktok_live_id', /tiktok_live_id=eq\.7665137927374031646/.test(p.url || ''), p.url);
    ok('PATCH is status=eq.live guarded (idempotent)', /status=eq\.live/.test(p.url || ''), p.url);
    ok('PATCH scoped to user_id', /user_id=eq\.user-A/.test(p.url || ''), p.url);
    const body = p.body ? JSON.parse(p.body) : {};
    ok("end_source = 'live_ended' (primary, not a backstop)", body.end_source === 'live_ended', JSON.stringify(body));
    ok('sets status=ended + ended_at', body.status === 'ended' && !!body.ended_at, JSON.stringify(body));
  }

  // ── 3) unauthenticated → no write ───────────────────────────────────
  console.log('(3) unauthenticated → no write (best-effort):');
  { const sw = boot({ authed: false }); await sleep(20);
    await sw.T.liveEnd(ROOM); await sleep(10);
    ok('no PATCH when unauthenticated', sw.patches.length === 0, 'patches=' + sw.patches.length);
  }

  // ── 4) in-memory cleared only for the TRACKED room ──────────────────
  console.log('(4) in-memory cleanup only for the tracked room:');
  { const sw = boot(); await sleep(20);
    sw.T.setTracked('sess-1', ROOM);
    await sw.T.liveEnd(ROOM); await sleep(10);
    const st = sw.T.state();
    ok('tracked room end clears currentSessionId + sessionRoomId', st.sid === null && st.room === null, JSON.stringify(st));
  }

  // ── 5) end for a DIFFERENT room → tracked session untouched ─────────
  console.log('(5) end for an untracked room → tracked session preserved:');
  { const sw = boot(); await sleep(20);
    sw.T.setTracked('sess-1', ROOM);
    await sw.T.liveEnd('9999999999999999999'); await sleep(10); // a room this machine isn't tracking
    const st = sw.T.state();
    ok('other-room end leaves tracked session intact', st.sid === 'sess-1' && st.room === ROOM, JSON.stringify(st));
    ok('DB write still issued for the other room (by room)', sw.patches.some((p) => /tiktok_live_id=eq\.9999999999999999999/.test(p.url)), 'no patch for other room');
  }

  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + `: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
run().catch((e) => { console.error(e); process.exit(2); });
