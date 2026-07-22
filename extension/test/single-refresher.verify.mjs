// Single-refresher verification (fix/ext-single-refresher-v0.4.x).
// Loads the REAL background.js in jsdom and drives the reactive pull-on-401 path that
// dead-looped on 2026-07-22. Proves:
//   1) a Supabase REST 401 triggers a PULL from the lensed.io bridge (LENSED_REQUEST_TOKEN)
//      and the request is retried with the pulled access token — NOT a self-refresh
//   2) the extension NEVER calls Supabase's /auth/v1/token endpoint (no second refresher)
//   3) when NO lensed.io tab can answer, it enters reconnect (auth cleared) instead of
//      looping — the failure mode that previously spun 1,911 times
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
const jwt = (sub, tag) => 'h.' + b64url({ sub, tag: tag || 0, exp: 4102444800 }) + '.s';
const httpResp = (status, jsonVal) => ({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(JSON.stringify(jsonVal ?? [])), json: () => Promise.resolve(jsonVal ?? []) });

// opts.tabAnswers: whether a lensed.io tab bridge answers the pull with a fresh token.
function boot(opts) {
  opts = opts || {};
  const store = { lensed_access_token: jwt('user-A', 1), lensed_user_id: 'user-A' };
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://shop.tiktok.com/', runScripts: 'dangerously' });
  const { window } = dom;
  let alarmHandler = null;
  const pulls = [];
  const calls = [];
  const read = (keys) => { const o = {}; (Array.isArray(keys) ? keys : keys == null ? Object.keys(store) : [keys]).forEach((k) => { if (k in store) o[k] = store[k]; }); return o; };
  // First REST GET 401s; after a successful pull rotates accessToken, subsequent GETs 200.
  let getCount = 0;
  window.chrome = {
    runtime: { lastError: null, id: 't', getManifest: () => ({ version: '0.5.0' }), onMessage: { addListener: () => {} }, onMessageExternal: { addListener: () => {} }, sendMessage: () => {} },
    storage: { local: {
      get: (k, cb) => cb ? setTimeout(() => cb(read(k)), 1) : new Promise((r) => setTimeout(() => r(read(k)), 1)),
      set: (o, cb) => cb ? setTimeout(() => { Object.assign(store, o); cb(); }, 1) : new Promise((r) => setTimeout(() => { Object.assign(store, o); r(); }, 1)),
      remove: (keys, cb) => { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete store[k]); return cb ? cb() : Promise.resolve(); },
    } },
    tabs: {
      query: (qy, cb) => {
        const isLensed = qy && Array.isArray(qy.url) && qy.url.some((u) => u.includes('lensed.io') || u.includes('localhost'));
        const t = (isLensed && opts.tabAnswers) ? [{ id: 9 }] : [];
        return cb ? cb(t) : Promise.resolve(t);
      },
      sendMessage: (id, msg, cb) => {
        if (cb) {
          if (msg && msg.type === 'LENSED_REQUEST_TOKEN') { pulls.push(msg); cb({ accessToken: jwt('user-A', 2) }); }
          else cb(undefined);
          return;
        }
        return Promise.resolve();
      },
      onRemoved: { addListener() {} },
    },
    alarms: { create: () => {}, onAlarm: { addListener: (fn) => { alarmHandler = fn; } } },
  };
  window.fetch = (url, o) => {
    const u = String(url); const m = (o && o.method) || 'GET'; calls.push({ method: m, url: u });
    if (u.includes('/auth/v1/token')) return Promise.resolve(httpResp(200, { access_token: 'SHOULD-NOT-HAPPEN', refresh_token: 'x' }));
    if (u.includes('/rest/v1/inventory_skus')) {
      getCount++;
      if (getCount === 1) return Promise.resolve(httpResp(401, { message: 'JWT expired' }));
      return Promise.resolve(httpResp(200, [{ id: 'sku-1', sku_number: 42 }]));
    }
    return Promise.resolve(httpResp(200, []));
  };
  const bridge = ';globalThis.__T={ get:function(t,q){return supabaseGet(t,q);}, authed:function(){return isAuthenticated();} };';
  window.eval(bgText + bridge);
  return { T: window.__T, calls, pulls, store, getAlarm: () => alarmHandler };
}
const hasRefreshCall = (calls) => calls.some((c) => c.url.includes('/auth/v1/token'));

async function run() {
  // ── 1) 401 → pull → retry succeeds; no self-refresh ─────────────────
  console.log('(1) reactive pull-on-401 recovers and retries:');
  { const sw = boot({ tabAnswers: true }); await sleep(20);
    const rows = await sw.T.get('inventory_skus', 'select=*');
    ok('GET retried and returned data after 401→pull', Array.isArray(rows) && rows.length === 1 && rows[0].sku_number === 42, JSON.stringify(rows));
    ok('pulled a fresh token from the bridge (LENSED_REQUEST_TOKEN)', sw.pulls.length === 1, 'pulls=' + sw.pulls.length);
    ok('NEVER called Supabase /auth/v1/token (no second refresher)', !hasRefreshCall(sw.calls), 'refresh call present');
    ok('access token rotated to the pulled one', sw.store.lensed_access_token === jwt('user-A', 2), (sw.store.lensed_access_token || '').slice(-6));
  }

  // ── 2) 401 with NO lensed.io tab → reconnect, not a loop ────────────
  console.log('(2) 401 with no tab to pull from → clean reconnect (no loop):');
  { const sw = boot({ tabAnswers: false }); await sleep(20);
    let threw = false;
    try { await sw.T.get('inventory_skus', 'select=*'); } catch (_) { threw = true; }
    ok('one pull attempt made, then gave up (no retry storm)', sw.pulls.length === 0, 'pulls=' + sw.pulls.length); // no tabs → query returns [], no sendMessage
    ok('NEVER called /auth/v1/token', !hasRefreshCall(sw.calls), 'refresh call present');
    ok('entered reconnect: auth cleared', sw.T.authed() === false && !sw.store.lensed_access_token, 'still authed');
    ok('surfaced the failure to the caller (no silent hang)', threw === true, 'did not throw');
  }

  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + `: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
run().catch((e) => { console.error(e); process.exit(2); });
