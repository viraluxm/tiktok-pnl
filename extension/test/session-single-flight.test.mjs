// Per-room single-flight over getOrCreateSession.
//
// Loads the REAL background.js in jsdom with mocked chrome + fetch and proves:
//   A) two CONCURRENT AUTO_BINDs for the SAME room produce exactly ONE live_sessions POST,
//      and both binds resolve to the SAME session id  (the onlybidss shadow-row race)
//   B) the join is recorded as diagCrit 'session.inflight_join' (always-on, ring off)
//   C) two concurrent rooms are NOT serialised — one POST each, different ids
//   D) a FAILED create does not poison the room: a later call retries and succeeds
//   E) a STALLED create (headers, body never resolves) does not block the room forever
//
// Run:  node extension/test/session-single-flight.test.mjs
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

// The GET is deliberately SLOW. That is the race window: without the guard both callers
// clear the "is there a session?" GET before either INSERT commits, and both insert.
const GET_DELAY_MS = 25;
const POST_DELAY_MS = 10;
const NEVER = new Promise(() => {}); // never settles — models a stalled response body

function boot(opts) {
  opts = opts || {};
  const failFirstPost = !!opts.failFirstPost;
  const stallFirstGet = !!opts.stallFirstGet;
  // background.js is 'use strict', so an indirect eval keeps its top-level `var`s off the
  // window — the staleness window cannot be re-pointed at runtime. Substitute it in the
  // SOURCE instead, and make the substitution itself assertable (below) so a renamed or
  // deleted constant fails the test loudly rather than silently testing nothing.
  let src = bgText;
  let subbed = 0;
  if (opts.inflightMaxMs) {
    const needle = 'var SESSION_INFLIGHT_MAX_MS = 15000;';
    subbed = src.split(needle).length - 1;
    src = src.split(needle).join('var SESSION_INFLIGHT_MAX_MS = ' + opts.inflightMaxMs + ';');
  }
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
    alarms: { create: () => {}, clear: () => {}, onAlarm: { addListener: () => {} } },
  };

  const sessionGets = [];            // every live_sessions GET url
  const sessionPosts = [];           // every live_sessions POST body (the rows that would be created)
  const boundSessions = [];          // p_session_id seen by lensed_log_auction, in order
  let created = 0;

  window.fetch = (url, opts2) => {
    const u = String(url);
    const method = (opts2 && opts2.method) || 'GET';

    if (u.includes('/rest/v1/live_sessions')) {
      if (method === 'POST') {
        let body = {};
        try { body = opts2 && opts2.body ? JSON.parse(opts2.body) : {}; } catch (_) {}
        sessionPosts.push(body);
        const n = ++created;
        if (failFirstPost && n === 1) {
          return new Promise((r) => setTimeout(() => r(httpResp(500, '{"message":"boom"}')), POST_DELAY_MS));
        }
        return new Promise((r) => setTimeout(
          () => r(httpResp(201, '', [{ id: 'sess-' + (body.tiktok_live_id || 'x') + '-' + n }])), POST_DELAY_MS));
      }
      sessionGets.push(u);
      // STALL MODE: headers arrive (the fetch promise settles, so fetchWithTimeout clears its
      // AbortController timer) but the BODY never does. That is the one unbounded await in the
      // chain — supabaseGet's `return res.json()` has no timeout of its own.
      if (stallFirstGet && sessionGets.length === 1) {
        return Promise.resolve({ ok: true, status: 200, text: () => NEVER, json: () => NEVER });
      }
      // No open session for the room → both callers fall through to the INSERT path.
      return new Promise((r) => setTimeout(() => r(httpResp(200, '', [])), GET_DELAY_MS));
    }

    if (u.includes('/rpc/lensed_log_auction')) {
      let body = {};
      try { body = opts2 && opts2.body ? JSON.parse(opts2.body) : {}; } catch (_) {}
      boundSessions.push(body.p_session_id);
      return Promise.resolve(httpResp(200, '', [{ item_id: 'item-1', status: 'sold', replayed: false }]));
    }
    if (u.includes('/rpc/open_session_host_segment')) return Promise.resolve(httpResp(200, '', 'seg-1'));
    if (u.includes('/rest/v1/capture_events')) return Promise.resolve(httpResp(201, '', [{}]));
    return Promise.resolve(httpResp(200, '', []));
  };

  window.eval(src);
  return { getOnMessage: () => onMessage, sessionGets, sessionPosts, boundSessions, win: window, subbed };
}

const STAGED = [{ id: 'sku-1111', qty: 1 }];
const sale = (id, room) => ({ orderId: id, buyerUsername: 'x', sellingPrice: '$5', isPaymentSuccessful: true, roomId: room, orderStatus: 1 });
const send = (fn, msg) => new Promise((res) => { const r = fn(msg, {}, (resp) => res(resp)); if (r !== true) res(undefined); });

async function run() {
  // ── A + B: two concurrent AUTO_BINDs, same room ────────────────────────────────────
  console.log('A/B — two concurrent binds on ONE room');
  {
    const sw = boot();
    await sleep(25);
    const l = sw.getOnMessage();

    // Fire BOTH before awaiting either — this is the overlap the dispatch layer allows
    // (AUTO_BIND is started with handler().then() + `return true`, never serialised).
    const p1 = send(l, { type: 'AUTO_BIND', sale: sale('order-1', 'room1'), stagedSkus: STAGED });
    const p2 = send(l, { type: 'AUTO_BIND', sale: sale('order-2', 'room1'), stagedSkus: STAGED });
    await Promise.all([p1, p2]);
    await sleep(30);

    ok('A) exactly ONE live_sessions POST for the room',
       sw.sessionPosts.length === 1, 'posts=' + sw.sessionPosts.length + ' ' + JSON.stringify(sw.sessionPosts));
    ok('A) exactly ONE live_sessions GET (the joiner does not re-query)',
       sw.sessionGets.length === 1, 'gets=' + sw.sessionGets.length);
    ok('A) both binds resolved to the SAME session id',
       sw.boundSessions.length === 2 && sw.boundSessions[0] && sw.boundSessions[0] === sw.boundSessions[1],
       JSON.stringify(sw.boundSessions));

    const exp = await send(l, { type: 'DIAG_EXPORT' });
    const joins = (exp.events || []).filter((e) => e.type === 'session.inflight_join');
    ok('B) join recorded as diagCrit session.inflight_join (ring never enabled)',
       joins.length === 1 && joins[0].crit === 1 && joins[0].meta && joins[0].meta.room === 'room1',
       JSON.stringify(joins));
  }

  // ── C: different rooms must not block each other ───────────────────────────────────
  console.log('C — two concurrent binds on DIFFERENT rooms');
  {
    const sw = boot();
    await sleep(25);
    const l = sw.getOnMessage();

    const p1 = send(l, { type: 'AUTO_BIND', sale: sale('order-a', 'roomA'), stagedSkus: STAGED });
    const p2 = send(l, { type: 'AUTO_BIND', sale: sale('order-b', 'roomB'), stagedSkus: STAGED });
    await Promise.all([p1, p2]);
    await sleep(30);

    ok('C) one POST per room (guard is per-room, not global)',
       sw.sessionPosts.length === 2, 'posts=' + sw.sessionPosts.length);
    ok('C) the two rooms got DIFFERENT session ids',
       sw.boundSessions.length === 2 && sw.boundSessions[0] !== sw.boundSessions[1],
       JSON.stringify(sw.boundSessions));

    const exp = await send(l, { type: 'DIAG_EXPORT' });
    ok('C) no in-flight join fired across rooms',
       (exp.events || []).filter((e) => e.type === 'session.inflight_join').length === 0);
  }

  // ── D: a failed create must not poison the room ────────────────────────────────────
  console.log('D — failed create does not poison later calls');
  {
    const sw = boot({ failFirstPost: true });
    await sleep(25);
    const l = sw.getOnMessage();

    await send(l, { type: 'AUTO_BIND', sale: sale('order-x', 'room1'), stagedSkus: STAGED });
    await sleep(20);
    ok('D) first attempt POSTed and failed (no session bound)',
       sw.sessionPosts.length === 1 && sw.boundSessions.length === 0,
       'posts=' + sw.sessionPosts.length + ' bound=' + JSON.stringify(sw.boundSessions));

    // Same room again — the Map entry must have been cleared by .finally, so this retries.
    await send(l, { type: 'AUTO_BIND', sale: sale('order-y', 'room1'), stagedSkus: STAGED });
    await sleep(30);
    ok('D) later call for the SAME room retried (entry cleared on the failing path)',
       sw.sessionPosts.length === 2, 'posts=' + sw.sessionPosts.length);
    ok('D) …and bound to the freshly created session',
       sw.boundSessions.length === 1 && !!sw.boundSessions[0], JSON.stringify(sw.boundSessions));
  }

  // ── E: a STALLED create must not kill the room for the worker's lifetime ───────────
  // The one unbounded await: fetchWithTimeout clears its AbortController timer when the
  // FETCH settles (headers), so supabaseGet's `return res.json()` has no timeout. Without
  // the staleness bound every later sale joins the hung promise and the whole show loses
  // its binds. With it, callers past the window start their own attempt.
  console.log('E — stalled create does not permanently block the room');
  {
    const sw = boot({ stallFirstGet: true, inflightMaxMs: 300 }); // 300ms so the test does not sleep 15s
    await sleep(25);
    const l = sw.getOnMessage();

    // Guards the substitution itself: exactly one `var SESSION_INFLIGHT_MAX_MS = 15000;` had
    // to be found and replaced. If the constant is renamed, retuned, or deleted this fails
    // here instead of the rest of E passing against an unbounded guard.
    ok('E) shipped source declares SESSION_INFLIGHT_MAX_MS = 15000 exactly once',
       sw.subbed === 1, 'substitutions=' + sw.subbed);

    l({ type: 'AUTO_BIND', sale: sale('order-s1', 'room1'), stagedSkus: STAGED }, {}, () => {}); // stalls
    await sleep(20);
    l({ type: 'AUTO_BIND', sale: sale('order-s2', 'room1'), stagedSkus: STAGED }, {}, () => {}); // joins, stalls too
    await sleep(60);
    ok('E) inside the window sale 2 JOINS the stalled attempt (no second GET, no POST)',
       sw.sessionGets.length === 1 && sw.sessionPosts.length === 0,
       'gets=' + sw.sessionGets.length + ' posts=' + sw.sessionPosts.length);

    await sleep(320); // past SESSION_INFLIGHT_MAX_MS
    l({ type: 'AUTO_BIND', sale: sale('order-s3', 'room1'), stagedSkus: STAGED }, {}, () => {});
    await sleep(120);
    ok('E) past the window sale 3 issues its OWN GET',
       sw.sessionGets.length === 2, 'gets=' + sw.sessionGets.length);
    ok('E) …and its own POST',
       sw.sessionPosts.length === 1, 'posts=' + sw.sessionPosts.length);
    ok('E) …and BINDS (the room recovered; sales 1-2 stay lost)',
       sw.boundSessions.length === 1 && !!sw.boundSessions[0], JSON.stringify(sw.boundSessions));
  }

  console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ' — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

run();
