// LENSED_AUTH relay identity-guard test (fix/extension-same-user-auth-preserve).
// Loads the REAL background.js in jsdom with mocked chrome + fetch and drives the
// actual onMessageExternal(LENSED_AUTH) handler. Proves:
//   1) same Lensed user (routine token refresh) → tokens rotate, live session/room
//      mapping preserved, NO null-session broadcast (staged SKUs/counter kept)
//   2) different Lensed user → full user-switch reset (null-session broadcast,
//      pinned session removed, identity updated)
//   3) service-worker restart: persisted user A + session rehydrate, then a same-user
//      refresh preserves the session (decision reads persisted user id, not in-memory)
//   4) missing/invalid incoming user → treated as identity change → reset (A not kept)
//   5) initial auth on empty storage → reset (no stale unknown state survives)
//   6) room change after a same-user refresh → existing room-change reset still fires
//   7) selected host preserved across a same-user refresh (session survives via host API)
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
// Non-expired JWTs so isAuthenticated() is true with no network refresh. `tag` lets
// two tokens for the SAME user be distinct strings (to prove the token actually rotated).
const jwt = (sub, tag) => 'h.' + b64url({ sub, tag: tag || 0, exp: 4102444800 }) + '.s';

const httpResp = (status, bodyText, jsonVal) => ({
  ok: status >= 200 && status < 300, status,
  text: () => Promise.resolve(bodyText || ''),
  json: () => Promise.resolve(jsonVal !== undefined ? jsonVal : []),
});

// Storage keys (mirror background.js constants).
const K_AT = 'lensed_access_token', K_RT = 'lensed_refresh_token', K_UID = 'lensed_user_id';
const K_SID = 'lensed_session_id', K_ROOM = 'lensed_room_id', K_TS = 'lensed_session_ts';

function boot(seed) {
  const store = Object.assign({}, seed);
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://shop.tiktok.com/', runScripts: 'dangerously' });
  const { window } = dom;
  let onMessage = null, onExternal = null;
  const broadcasts = [];
  const rpcCalls = [];
  const read = (keys) => { const o = {}; (Array.isArray(keys) ? keys : keys == null ? Object.keys(store) : [keys]).forEach((k) => { if (k in store) o[k] = store[k]; }); return o; };
  const asPromiseOrCb = (compute, cb) => { const p = new Promise((r) => setTimeout(() => r(compute()), 1)); if (cb) { p.then(cb); return undefined; } return p; };
  window.chrome = {
    runtime: {
      lastError: null, id: 't', getManifest: () => ({ version: '0.2.24' }),
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
    },
  };
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes('/auth/v1/token')) return Promise.resolve(httpResp(200, '', { access_token: jwt('user-A', 99), refresh_token: 'refreshed' }));
    if (u.includes('/rest/v1/rpc/set_session_host')) { rpcCalls.push({ url: u, body: opts && opts.body }); return Promise.resolve(httpResp(200, '[]', [])); }
    return Promise.resolve(httpResp(200, '[]', []));
  };
  window.eval(bgText);
  return {
    getExternal: () => onExternal, getInternal: () => onMessage,
    broadcasts, rpcCalls, store,
    clearBroadcasts: () => { broadcasts.length = 0; },
    sessionBroadcasts: () => broadcasts.filter((m) => m && m.type === 'LENSED_SESSION'),
  };
}
const send = (fn, msg) => new Promise((res) => { const r = fn(msg, {}, (resp) => res(resp)); if (r !== true) res(undefined); });
const freshSessionSeed = (uid) => ({ [K_AT]: jwt(uid, 1), [K_RT]: 'r-' + uid, [K_UID]: uid, [K_SID]: 'sess-' + uid, [K_ROOM]: 'room-' + uid, [K_TS]: Date.now() });

async function run() {
  // ── 1) Same user, routine token refresh → PRESERVE ──────────────────────────
  {
    const sw = boot(freshSessionSeed('user-A'));
    await sleep(25); // rehydrate restores currentSessionId=sess-user-A, sessionRoomId=room-user-A
    sw.clearBroadcasts();
    const r = await send(sw.getExternal(), { type: 'LENSED_AUTH', accessToken: jwt('user-A', 2), refreshToken: 'rA2' });
    ok('1) same-user relay replies ok with same userId', r && r.ok === true && r.userId === 'user-A', JSON.stringify(r));
    ok('1) access token rotated in storage', sw.store[K_AT] === jwt('user-A', 2), 'stored=' + (sw.store[K_AT] || '').slice(-6));
    ok('1) refresh token rotated in storage', sw.store[K_RT] === 'rA2', sw.store[K_RT]);
    ok('1) NO null-session broadcast during same-user refresh', sw.sessionBroadcasts().length === 0, 'saw ' + JSON.stringify(sw.sessionBroadcasts()));
    ok('1) pinned session id retained in storage', sw.store[K_SID] === 'sess-user-A', String(sw.store[K_SID]));
    // Confirm currentSessionId itself survived: a matching TIKTOK_ROOM re-broadcasts it.
    sw.clearBroadcasts();
    await send(sw.getInternal(), { type: 'TIKTOK_ROOM', roomId: 'room-user-A' });
    await sleep(5);
    const sb = sw.sessionBroadcasts();
    ok('1) session preserved (room-confirm re-broadcasts sess-user-A)', sb.length === 1 && sb[0].sessionId === 'sess-user-A', JSON.stringify(sb));
  }

  // ── 2) Different user → FULL RESET ──────────────────────────────────────────
  {
    const sw = boot(freshSessionSeed('user-A'));
    await sleep(25);
    sw.clearBroadcasts();
    const r = await send(sw.getExternal(), { type: 'LENSED_AUTH', accessToken: jwt('user-B', 1), refreshToken: 'rB' });
    ok('2) different-user relay replies ok with new userId', r && r.ok === true && r.userId === 'user-B', JSON.stringify(r));
    ok('2) identity updated in storage', sw.store[K_UID] === 'user-B' && sw.store[K_AT] === jwt('user-B', 1), sw.store[K_UID]);
    const sb = sw.sessionBroadcasts();
    ok('2) null-session reset broadcast emitted', sb.some((m) => m.sessionId === null), JSON.stringify(sb));
    await sleep(10); // storage.remove is fire-and-forget (as in the original handler) — let it settle
    ok('2) previous pinned session removed from storage', !sw.store[K_SID] && !sw.store[K_ROOM] && !sw.store[K_TS], JSON.stringify({ sid: sw.store[K_SID], room: sw.store[K_ROOM], ts: sw.store[K_TS] }));
  }

  // ── 3) Service-worker restart: persisted user A + session, same-user refresh → PRESERVE ──
  // (This is the SW-restart case: identity is known only from persisted storage, since
  //  in-memory userId starts null after a worker restart. Same setup as (1); asserted
  //  explicitly to document that the decision uses the persisted id, not in-memory.)
  {
    const sw = boot(freshSessionSeed('user-A'));
    await sleep(25);
    sw.clearBroadcasts();
    const r = await send(sw.getExternal(), { type: 'LENSED_AUTH', accessToken: jwt('user-A', 3), refreshToken: 'rA3' });
    ok('3) SW-restart same-user refresh preserves (no null broadcast)', r && r.ok === true && sw.sessionBroadcasts().length === 0 && sw.store[K_SID] === 'sess-user-A', JSON.stringify({ ok: r && r.ok, sb: sw.sessionBroadcasts().length, sid: sw.store[K_SID] }));
  }

  // ── 4) Missing/invalid incoming user → treated as identity change → RESET ────
  {
    const sw = boot(freshSessionSeed('user-A'));
    await sleep(25);
    sw.clearBroadcasts();
    const r = await send(sw.getExternal(), { type: 'LENSED_AUTH', accessToken: 'not-a-valid-jwt', refreshToken: 'rX' });
    ok('4) invalid incoming user → does NOT preserve prior user A (null broadcast)', sw.sessionBroadcasts().some((m) => m.sessionId === null), JSON.stringify(sw.sessionBroadcasts()));
    await sleep(10); // let the fire-and-forget storage.remove settle
    ok('4) prior session removed from storage', !sw.store[K_SID], String(sw.store[K_SID]));
    ok('4) reply present (relay did not hang)', r && typeof r.ok === 'boolean', JSON.stringify(r));
  }

  // ── 5) Initial auth on empty storage (no previous user) → RESET (safe default) ──
  {
    const sw = boot({}); // empty storage, no prior identity/session
    await sleep(25);
    sw.clearBroadcasts();
    const r = await send(sw.getExternal(), { type: 'LENSED_AUTH', accessToken: jwt('user-A', 1), refreshToken: 'rA' });
    ok('5) first auth on empty storage → identity treated as new (reset ran)', sw.sessionBroadcasts().some((m) => m.sessionId === null), JSON.stringify(sw.sessionBroadcasts()));
    ok('5) identity persisted', r && r.ok === true && sw.store[K_UID] === 'user-A', JSON.stringify(r));
  }

  // ── 6) Room change AFTER a same-user refresh → room-change reset still works ──
  {
    const sw = boot(freshSessionSeed('user-A'));
    await sleep(25);
    await send(sw.getExternal(), { type: 'LENSED_AUTH', accessToken: jwt('user-A', 2), refreshToken: 'rA2' }); // preserve
    sw.clearBroadcasts();
    await send(sw.getInternal(), { type: 'TIKTOK_ROOM', roomId: 'room-DIFFERENT' }); // different room than sessionRoomId
    await sleep(5);
    const sb = sw.sessionBroadcasts();
    ok('6) genuine room change still discards session (null broadcast)', sb.some((m) => m.sessionId === null), JSON.stringify(sb));
    ok('6) room-change cleared pinned session in storage', !sw.store[K_SID], String(sw.store[K_SID]));
  }

  // ── 7) Selected host preserved across a same-user refresh ────────────────────
  {
    const sw = boot(freshSessionSeed('user-A'));
    await sleep(25);
    // Select a host for the active session (SET_SESSION_HOST echoes {sessionId, hostId}).
    const setResp = await send(sw.getInternal(), { type: 'SET_SESSION_HOST', hostId: 'host-1' });
    ok('7) host selected against active session', setResp && setResp.ok === true && setResp.hostId === 'host-1' && setResp.sessionId === 'sess-user-A', JSON.stringify(setResp));
    sw.clearBroadcasts();
    await send(sw.getExternal(), { type: 'LENSED_AUTH', accessToken: jwt('user-A', 2), refreshToken: 'rA2' }); // same user
    ok('7) same-user refresh did not reset session (no null broadcast)', sw.sessionBroadcasts().length === 0, JSON.stringify(sw.sessionBroadcasts()));
    // Re-assert host: SET_SESSION_HOST echoes the STILL-CURRENT session id → proves the
    // session (and, in the same reset block, the selected host) survived the refresh.
    const reResp = await send(sw.getInternal(), { type: 'SET_SESSION_HOST', hostId: 'host-1' });
    ok('7) session still current after refresh (host API echoes sess-user-A)', reResp && reResp.sessionId === 'sess-user-A' && reResp.hostId === 'host-1', JSON.stringify(reResp));
  }

  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + `: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
run().catch((e) => { console.error(e); process.exit(2); });
