// Verification for the v0.4.1 "Close" channel-corruption guardrails.
// SW part: loads real background.js (jsdom + mocked chrome/fetch) → drives TIKTOK_ACCOUNT.
// Content part: evaluates the REAL UI_STOPWORDS + looksLikeHandle regex + S3 selector from source.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Buffer } from 'node:buffer';
const here = dirname(fileURLToPath(import.meta.url));
const bgText = readFileSync(join(here, '..', 'background.js'), 'utf8');
const ctText = readFileSync(join(here, '..', 'tiktok-content.js'), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  → ' + x : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const JWT = 'h.' + b64url({ sub: 'user-abc-1234', exp: 4102444800 }) + '.s';
const httpResp = (status, jsonVal) => ({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(JSON.stringify(jsonVal ?? [])), json: () => Promise.resolve(jsonVal ?? []) });

function boot(existingHandle) {
  const store = { lensed_access_token: JWT, lensed_refresh_token: 'r', lensed_user_id: 'user-abc-1234' };
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://shop.tiktok.com/', runScripts: 'dangerously' });
  const { window } = dom;
  let onMessage = null;
  const read = (keys) => { const o = {}; (Array.isArray(keys) ? keys : keys == null ? Object.keys(store) : [keys]).forEach((k) => { if (k in store) o[k] = store[k]; }); return o; };
  window.chrome = {
    runtime: { lastError: null, id: 't', getManifest: () => ({ version: '0.4.1' }), onMessage: { addListener: (fn) => { onMessage = fn; } }, onMessageExternal: { addListener: () => {} }, sendMessage: () => {} },
    storage: { local: {
      get: (k, cb) => cb ? setTimeout(() => cb(read(k)), 2) : new Promise((r) => setTimeout(() => r(read(k)), 2)),
      set: (o, cb) => cb ? setTimeout(() => { Object.assign(store, o); cb(); }, 1) : new Promise((r) => setTimeout(() => { Object.assign(store, o); r(); }, 1)),
      remove: (k, cb) => cb && cb(),
    } },
    tabs: { query: (q, cb) => cb && cb([]), sendMessage: () => Promise.resolve(), onRemoved: { addListener() {} } },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  };
  const calls = [];
  window.fetch = (url, o) => {
    const u = String(url); const m = (o && o.method) || 'GET'; const body = o && o.body ? JSON.parse(o.body) : null;
    calls.push({ method: m, url: u, body });
    if (u.includes('/rest/v1/live_sessions') && m === 'GET' && u.includes('select=channel_handle')) return Promise.resolve(httpResp(200, existingHandle === undefined ? [] : [{ channel_handle: existingHandle }]));
    if (u.includes('/rest/v1/live_sessions')) return Promise.resolve(httpResp(200, [{}]));
    return Promise.resolve(httpResp(200, []));
  };
  window.eval(bgText + ';globalThis.__T={ring:function(){return diagRing;},setPinned:function(s,r){currentSessionId=s;sessionRoomId=r;currentRoomId=r;}};');
  return { window, T: window.__T, getOnMessage: () => onMessage, calls };
}
const send = (fn, msg) => new Promise((res) => { const r = fn(msg, { tab: { id: 1 } }, (resp) => res(resp)); if (r !== true) res(undefined); });
const patchOf = (calls) => calls.filter((c) => c.method === 'PATCH' && c.url.includes('live_sessions')).map((c) => c.body);

async function run() {
  console.log('SW GUARDRAIL 1 — non-destructive persist:');
  // (a) weak DOM "Close" must NOT overwrite an existing real handle
  { const sw = boot('jumbosteals'); await sleep(30); sw.T.setPinned('sess1', 'room1');
    await send(sw.getOnMessage(), { type: 'TIKTOK_ACCOUNT', account: { handle: 'Close', source: 'dom' }, roomId: 'room1' }); await sleep(60);
    const patches = patchOf(sw.calls);
    const wroteClose = patches.some((p) => p.channel_handle === 'Close');
    ok('(a) DOM "Close" does NOT overwrite existing handle', !wroteClose, 'patches=' + JSON.stringify(patches));
    ok('(f) rejected overwrite logged always-on (no DIAG_ENABLE)', sw.T.ring().some((e) => e.type === 'channel.overwrite' && e.meta && e.meta.applied === false && e.meta.new === 'Close'));
  }
  // (b) partial DOM message never NULLs existing secUid/nickname/account_id
  { const sw = boot('jumbosteals'); await sleep(30); sw.T.setPinned('sess1', 'room1');
    await send(sw.getOnMessage(), { type: 'TIKTOK_ACCOUNT', account: { handle: 'jumbosteals', source: 'dom' }, roomId: 'room1' }); await sleep(60);
    const patches = patchOf(sw.calls);
    const nulled = patches.some((p) => 'channel_sec_uid' in p || 'channel_nickname' in p || 'channel_account_id' in p);
    ok('(b) partial message never writes/nulls secUid/nickname/account_id', !nulled, 'patches=' + JSON.stringify(patches));
  }
  // (c) first write of a legitimate handle (none existing) still works
  { const sw = boot(undefined); await sleep(30); sw.T.setPinned('sess1', 'room1');
    await send(sw.getOnMessage(), { type: 'TIKTOK_ACCOUNT', account: { handle: 'onlybidss', source: 'dom' }, roomId: 'room1' }); await sleep(60);
    const patches = patchOf(sw.calls);
    ok('(c) first-write persists the handle (store attribution intact)', patches.some((p) => p.channel_handle === 'onlybidss'), JSON.stringify(patches));
    ok('(c) no overwrite event on first write', !sw.T.ring().some((e) => e.type === 'channel.overwrite'));
  }
  // bonus: a STRONG (secUid) identity MAY overwrite + carries its fields (future anchor)
  { const sw = boot('jumbosteals'); await sleep(30); sw.T.setPinned('sess1', 'room1');
    await send(sw.getOnMessage(), { type: 'TIKTOK_ACCOUNT', account: { handle: 'realchan', secUid: 'SEC123', nickname: 'Real' }, roomId: 'room1' }); await sleep(60);
    const patches = patchOf(sw.calls);
    ok('(bonus) strong secUid identity MAY overwrite + writes its fields', patches.some((p) => p.channel_handle === 'realchan' && p.channel_sec_uid === 'SEC123'), JSON.stringify(patches));
    ok('(f) applied overwrite also logged always-on', sw.T.ring().some((e) => e.type === 'channel.overwrite' && e.meta && e.meta.applied === true));
    ok('always-on channel.detected recorded without DIAG_ENABLE', sw.T.ring().some((e) => e.type === 'channel.detected'));
  }

  console.log('CONTENT GUARDRAIL 2 — shape hardening (real regex/selector from source):');
  // (d) evaluate the REAL UI_STOPWORDS + looksLikeHandle from tiktok-content.js
  { const sw = boot('x'); const w = sw.window;
    const stop = new w.RegExp(ctText.match(/var UI_STOPWORDS = (\/\^.*?\$\/i);/)[1].slice(1, -2), 'i');
    const shape = /^@?[A-Za-z0-9][A-Za-z0-9._]{1,23}$/;
    const looksLikeHandle = (s) => { const t = String(s || '').trim(); if (!shape.test(t)) return false; if (stop.test(t.replace(/^@/, ''))) return false; return true; };
    ok('(d) "Close" rejected', looksLikeHandle('Close') === false);
    ok('(d) "Cancel"/"OK"/"Done"/"Save" rejected', ['Cancel', 'OK', 'Done', 'Save', 'Confirm', 'Mute', 'Chat'].every((s) => looksLikeHandle(s) === false));
    ok('(d) real handles still accepted', ['jumbosteals', 'onlybidss', 'auctioneerdeals', 'lotsofsteals'].every((s) => looksLikeHandle(s) === true));
  }
  // (e) S3 selector excludes buttons + skip guard present (jsdom has no layout → source-level)
  { ok('(e) S3 selector no longer includes button', /querySelectorAll\('a,span,div,p'\)/.test(ctText) && !/querySelectorAll\('a,button,span,div,p'\)/.test(ctText));
    ok('(e) S3 has button/[role=button] skip guard', /tagName === 'BUTTON'|role"\) === 'button'|closest\('button/.test(ctText)); }

  console.log('\n' + (fail === 0 ? '✓ ALL PASS' : '✗ ' + fail + ' FAILED') + '  (' + pass + ' passed)');
  process.exit(fail === 0 ? 0 : 1);
}
run();
