// Pre-session persistence test (fix/extension-auth-preserve-runtime).
// Loads the REAL tiktok-content.js in jsdom with a mocked chrome and drives the ACTUAL
// content-script lifecycle (init → GET_AUTH_STATUS reply → room detection → stage → reset)
// plus the real persistPreSession / restorePreSession / presessionMatches / adoptSession /
// onSessionReset functions. Proves pre-first-sale staged/counter/host survive a reload for
// the same user+room, migrate to session scope, and are rejected for a different user/room/
// stale/malformed record.
//
// Run: node test/content-presession.test.mjs   (from extension/)
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const scriptText = readFileSync(join(here, '..', 'tiktok-content.js'), 'utf8');

const LK_PRESESSION = 'lensed_presession_state';
const LK_STAGED = 'lensed_staged_skus';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  → ' + x : '')); } };

// A shared chrome mock over a caller-owned `store` object (so state survives a "reinjection"
// = a fresh jsdom sharing the same store). GET_AUTH_STATUS / RESOLVE_SKU replies are configurable.
function makeChrome(store, cfg) {
  const read = (keys) => { const o = {}; (Array.isArray(keys) ? keys : keys == null ? Object.keys(store) : [keys]).forEach((k) => { if (k in store) o[k] = store[k]; }); return o; };
  return {
    runtime: {
      lastError: null, id: 'test-ext', getManifest: () => ({ version: '0.2.25' }),
      onMessage: { addListener: (fn) => { cfg.onMsg = fn; } },
      sendMessage(msg, cb) {
        let reply = {};
        if (msg && msg.type === 'GET_AUTH_STATUS') reply = cfg.authReply || { authenticated: true, userId: cfg.userId || null, sessionId: null, roomId: null };
        else if (msg && msg.type === 'RESOLVE_SKU') { cfg.resolveCalls.push(msg.skuNumber); reply = cfg.resolveReply || { sku: null, status: 'not_found' }; }
        else if (msg && msg.type === 'FETCH_HOSTS') reply = { hosts: cfg.hosts || [] };
        else if (msg && msg.type === 'SET_SESSION_HOST') reply = { ok: true };
        if (typeof cb === 'function') { cb(reply); return undefined; }
        return Promise.resolve(reply); // promise form (TIKTOK_ROOM/TIKTOK_SALE use .catch)
      },
    },
    storage: { local: {
      get(keys, cb) { const v = read(keys); if (typeof cb === 'function') { cb(v); return undefined; } return Promise.resolve(v); },
      set(obj, cb) { Object.assign(store, obj); if (typeof cb === 'function') cb(); return Promise.resolve(); },
      remove(keys, cb) { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete store[k]); if (typeof cb === 'function') cb(); return Promise.resolve(); },
    } },
  };
}

// Boot a fresh content-script instance over `store`. Replicates the real load timing
// (document_start with no <body> → init defers to DOMContentLoaded).
function boot(store, cfg) {
  let clock = 10000;
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://shop.tiktok.com/live', pretendToBeVisual: true, runScripts: 'dangerously' });
  const { window } = dom;
  window.chrome = makeChrome(store, cfg);
  window.performance.now = () => clock;
  window.requestAnimationFrame = (fn) => setTimeout(() => fn(clock), 0);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  window.document.body.remove();
  window.eval(scriptText);
  window.document.documentElement.appendChild(window.document.createElement('body'));
  return { window, tick: (ms) => { clock += ms; } };
}
const shadowOf = (window) => window.document.getElementById('lensed-overlay-root')?.shadowRoot;
const pillCount = (window) => shadowOf(window)?.querySelectorAll('.lensed-staged-item').length || 0;
const counterText = (window) => shadowOf(window)?.querySelector('.lensed-count, .lensed-counter, [data-lensed-count]')?.textContent || null;

// Fire the MAIN-world room-detection message (event.source must be window to pass the guard).
function detectRoom(window, roomId) {
  window.dispatchEvent(new window.MessageEvent('message', { data: { source: 'lensed-tiktok-room', roomId }, source: window }));
}
const hostSelect = (window) => shadowOf(window)?.querySelector('.lensed-host-select');
function pickHost(window, id) { const s = hostSelect(window); if (!s) return false; s.value = id; s.dispatchEvent(new window.Event('change', { bubbles: true })); return s.value === id; }
// Stage one SKU via the REAL overlay scan input (manual entry: set value + Enter →
// resolveSkuInput → RESOLVE_SKU reply → stageCurrentSku → persistStaged → persistPreSession).
function stageViaInput(window, cfg, sku) {
  cfg.resolveReply = { sku };
  const input = shadowOf(window)?.querySelector('.lensed-sku-input');
  if (!input) return false;
  input.value = String(sku.sku_number);
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  return true;
}
const presessionSeed = (over) => Object.assign({ v: 1, userId: 'user-A', roomId: 'R1', ts: Date.now(), skus: [{ id: 'sku-1', sku_number: 14, title: 'iPad', qty: 2 }], salesCount: 3, orderIds: ['o1', 'o2', 'o3'], capturedOnly: 1, hostId: 'host-1' }, over || {});

async function run() {
  // ── A) Persist side: stage a SKU pre-session (no session id) → LK_PRESESSION written ──
  {
    const store = {};
    const cfg = { userId: 'user-A', resolveCalls: [] };
    const ctx = boot(store, cfg);
    await sleep(60);                                   // overlay + init (GET_AUTH_STATUS → authUserId=user-A)
    detectRoom(ctx.window, 'R1'); await sleep(20);     // room known → maybeRestorePreSession (nothing yet)
    const staged = stageViaInput(ctx.window, cfg, { id: 'sku-1', sku_number: 14, title: 'iPad', qty_on_hand: 5 });
    await sleep(450);                                  // resolveSkuInput → +300ms → stageCurrentSku → persistStaged
    const rec = store[LK_PRESESSION];
    ok('A0) scan input present + RESOLVE_SKU sent', staged && cfg.resolveCalls.length > 0, 'staged=' + staged + ' calls=' + JSON.stringify(cfg.resolveCalls));
    ok('A1) staged pre-session → LK_PRESESSION written (real persistPreSession)', !!rec, JSON.stringify(Object.keys(store)));
    ok('A2) record scoped by user + room + ts', !!rec && rec.userId === 'user-A' && rec.roomId === 'R1' && typeof rec.ts === 'number', JSON.stringify(rec && { u: rec.userId, r: rec.roomId }));
    ok('A3) staged SKU captured in record', !!rec && Array.isArray(rec.skus) && rec.skus.length === 1, JSON.stringify(rec && rec.skus));
    ok('A4) no session-scoped LK_STAGED written pre-session', !store[LK_STAGED], JSON.stringify(store[LK_STAGED] || null));
  }

  // ── B) Restore side (reinjection), same user + room → staged/counter/host restored ──
  {
    const store = { [LK_PRESESSION]: presessionSeed() };
    const cfg = { userId: 'user-A', resolveCalls: [] };
    const ctx = boot(store, cfg);
    await sleep(60);
    detectRoom(ctx.window, 'R1'); await sleep(60);     // user+room → real restorePreSession
    ok('B4) staged SKU restored for same user+room', pillCount(ctx.window) === 1, 'pills=' + pillCount(ctx.window));
    ok('B5) counter restored (salesCount 3)', /3/.test(shadowOf(ctx.window)?.textContent || ''), 'no 3 in overlay');
    ok('B*) pre-session record retained until migration', !!store[LK_PRESESSION]);
  }

  // ── C) Reject: different user ──
  {
    const store = { [LK_PRESESSION]: presessionSeed({ userId: 'user-A' }) };
    const cfg = { userId: 'user-B', resolveCalls: [] }; // different user signs in
    const ctx = boot(store, cfg);
    await sleep(60); detectRoom(ctx.window, 'R1'); await sleep(60);
    ok('C7) different user → record rejected+cleared', !store[LK_PRESESSION], JSON.stringify(store[LK_PRESESSION] || null));
    ok('C7) different user → nothing staged', pillCount(ctx.window) === 0, 'pills=' + pillCount(ctx.window));
  }

  // ── D) Reject: different room ──
  {
    const store = { [LK_PRESESSION]: presessionSeed({ roomId: 'R1' }) };
    const cfg = { userId: 'user-A', resolveCalls: [] };
    const ctx = boot(store, cfg);
    await sleep(60); detectRoom(ctx.window, 'R2'); await sleep(60); // different room
    ok('D8) different room → record rejected+cleared', !store[LK_PRESESSION], JSON.stringify(store[LK_PRESESSION] || null));
    ok('D8) different room → nothing staged', pillCount(ctx.window) === 0, 'pills=' + pillCount(ctx.window));
  }

  // ── E) Reject: stale + malformed ──
  {
    const store = { [LK_PRESESSION]: presessionSeed({ ts: Date.now() - (13 * 60 * 60 * 1000) }) }; // > 12h
    const cfg = { userId: 'user-A', resolveCalls: [] };
    const ctx = boot(store, cfg);
    await sleep(60); detectRoom(ctx.window, 'R1'); await sleep(60);
    ok('E9) stale record rejected+cleared', !store[LK_PRESESSION]);
    ok('E9) stale → nothing staged', pillCount(ctx.window) === 0, 'pills=' + pillCount(ctx.window));

    const store2 = { [LK_PRESESSION]: { v: 1, userId: 'user-A', roomId: 'R1', ts: Date.now(), skus: 'not-an-array' } };
    const cfg2 = { userId: 'user-A', resolveCalls: [] };
    const ctx2 = boot(store2, cfg2);
    await sleep(60); detectRoom(ctx2.window, 'R1'); await sleep(60);
    ok('E9) malformed record rejected+cleared', !store2[LK_PRESESSION]);
  }

  // ── F) Migration: restore then a session is created → migrate to session scope, no dup ──
  {
    const store = { [LK_PRESESSION]: presessionSeed() };
    const cfg = { userId: 'user-A', resolveCalls: [] };
    const ctx = boot(store, cfg);
    await sleep(60); detectRoom(ctx.window, 'R1'); await sleep(60);
    ok('F10) restored before migration', pillCount(ctx.window) === 1, 'pills=' + pillCount(ctx.window));
    // Background reports a newly-created session id → real adoptSession migrates.
    cfg.onMsg && cfg.onMsg({ type: 'LENSED_SESSION', sessionId: 'S1', roomId: 'R1' });
    await sleep(60);
    ok('F10) migrated → session-scoped LK_STAGED written under new session', !!store[LK_STAGED] && store[LK_STAGED].sessionId === 'S1' && store[LK_STAGED].skus.length === 1, JSON.stringify(store[LK_STAGED] || null));
    ok('F10) pre-session record removed after migration', !store[LK_PRESESSION], JSON.stringify(store[LK_PRESESSION] || null));
    ok('F11) no duplicate staging after migration (still 1 pill)', pillCount(ctx.window) === 1, 'pills=' + pillCount(ctx.window));
  }

  // ── G) Reason-tagged internal reset (NOT a web logout) clears staged + pre-session ──
  // Fired by the background null-session broadcast: reason 'user_changed' (a DIFFERENT-user
  // LENSED_AUTH relay) or 'room_changed' (a TikTok room change). A genuine web Log Out does
  // NOT reach the extension (useExtensionAuth only relays when a session is present).
  {
    const store = { [LK_PRESESSION]: presessionSeed() };
    const cfg = { userId: 'user-A', resolveCalls: [] };
    const ctx = boot(store, cfg);
    await sleep(60); detectRoom(ctx.window, 'R1'); await sleep(60);
    ok('G) restored before reset', pillCount(ctx.window) === 1, 'pills=' + pillCount(ctx.window));
    cfg.onMsg && cfg.onMsg({ type: 'LENSED_SESSION', sessionId: null, reason: 'user_changed' }); // real onSessionReset('user_changed')
    await sleep(40);
    ok('G13) user_changed reset cleared staged pills', pillCount(ctx.window) === 0, 'pills=' + pillCount(ctx.window));
    ok('G13) user_changed reset removed pre-session record', !store[LK_PRESESSION], JSON.stringify(store[LK_PRESESSION] || null));
  }
  // Room-changed reason path.
  {
    const store = { [LK_PRESESSION]: presessionSeed() };
    const cfg = { userId: 'user-A', resolveCalls: [] };
    const ctx = boot(store, cfg);
    await sleep(60); detectRoom(ctx.window, 'R1'); await sleep(60);
    cfg.onMsg && cfg.onMsg({ type: 'LENSED_SESSION', sessionId: null, reason: 'room_changed' });
    await sleep(40);
    ok('G14) room_changed reset cleared staged + pre-session', pillCount(ctx.window) === 0 && !store[LK_PRESESSION], 'pills=' + pillCount(ctx.window));
  }

  // ── H) Arrival order: AUTH first, room later → restore only after room known ──
  {
    const store = { [LK_PRESESSION]: presessionSeed() };
    const cfg = { userId: 'user-A', resolveCalls: [] };
    const ctx = boot(store, cfg);
    await sleep(60); // GET_AUTH_STATUS → authUserId=user-A; room still unknown → guard stays retryable
    ok('H) auth-first: no restore while room unknown', pillCount(ctx.window) === 0 && !!store[LK_PRESESSION], 'pills=' + pillCount(ctx.window));
    detectRoom(ctx.window, 'R1'); await sleep(60);
    ok('H) auth-first: restore after room detected', pillCount(ctx.window) === 1, 'pills=' + pillCount(ctx.window));
  }

  // ── I) Arrival order: ROOM first, auth later → restore only after user known ──
  {
    const store = { [LK_PRESESSION]: presessionSeed() };
    const cfg = { resolveCalls: [], authReply: { authenticated: false, userId: null, sessionId: null, roomId: null } };
    const ctx = boot(store, cfg);
    await sleep(60);
    detectRoom(ctx.window, 'R1'); await sleep(40); // room known, no user yet → guard stays retryable
    ok('I) room-first: no restore while user unknown', pillCount(ctx.window) === 0 && !!store[LK_PRESESSION], 'pills=' + pillCount(ctx.window));
    cfg.onMsg && cfg.onMsg({ type: 'LENSED_AUTH_STATUS', authenticated: true, userId: 'user-A' }); // auth arrives late
    await sleep(60);
    ok('I) room-first: restore after auth arrives', pillCount(ctx.window) === 1, 'pills=' + pillCount(ctx.window));
  }

  // ── J) Duplicate auth/room notifications → restore once, no duplication ──
  {
    const store = { [LK_PRESESSION]: presessionSeed() };
    const cfg = { userId: 'user-A', resolveCalls: [] };
    const ctx = boot(store, cfg);
    await sleep(60);
    detectRoom(ctx.window, 'R1'); detectRoom(ctx.window, 'R1'); // duplicate room events
    cfg.onMsg && cfg.onMsg({ type: 'LENSED_AUTH_STATUS', authenticated: true, userId: 'user-A' });
    cfg.onMsg && cfg.onMsg({ type: 'LENSED_AUTH_STATUS', authenticated: true, userId: 'user-A' }); // duplicate auth
    detectRoom(ctx.window, 'R1');
    await sleep(80);
    ok('J-C) duplicate events → staged restored exactly once (1 pill, no dup)', pillCount(ctx.window) === 1, 'pills=' + pillCount(ctx.window));
    ok('J-C) duplicate events → counter/orderIds not duplicated (record salesCount 3)', store[LK_PRESESSION] && store[LK_PRESESSION].salesCount === 3 && store[LK_PRESESSION].orderIds.length === 3, JSON.stringify(store[LK_PRESESSION] && { s: store[LK_PRESESSION].salesCount, o: store[LK_PRESESSION].orderIds.length }));
  }

  // ── K) Host selected BEFORE room detection → durable once room known, restored on reload ──
  {
    const store = {};
    const cfg = { userId: 'user-A', resolveCalls: [], hosts: [{ id: 'host-1', name: 'Alice', role: 'host' }] };
    const ctx = boot(store, cfg);
    await sleep(90); // auth connect → fetchHosts → dropdown populated
    const picked = pickHost(ctx.window, 'host-1'); // NO room yet
    await sleep(20);
    ok('K) host pickable before room detection', picked === true, 'value=' + (hostSelect(ctx.window)?.value || null));
    ok('K) pre-room host not yet durable (no room → no pre-session record)', !store[LK_PRESESSION], JSON.stringify(store[LK_PRESESSION] || null));
    detectRoom(ctx.window, 'R1'); await sleep(60); // room known → flush into user+room record
    ok('K) host flushed into pre-session record (user+room)', !!store[LK_PRESESSION] && store[LK_PRESESSION].hostId === 'host-1' && store[LK_PRESESSION].roomId === 'R1', JSON.stringify(store[LK_PRESESSION] || null));

    const cfg2 = { userId: 'user-A', resolveCalls: [], hosts: [{ id: 'host-1', name: 'Alice', role: 'host' }] };
    const ctx2 = boot(store, cfg2);        // reinjection, same store
    await sleep(90); detectRoom(ctx2.window, 'R1'); await sleep(90);
    ok('K) reload after room detection restores the host', hostSelect(ctx2.window)?.value === 'host-1', 'value=' + (hostSelect(ctx2.window)?.value || null));
  }

  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + `: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
run().catch((e) => { console.error(e); process.exit(2); });
