// Overlay host-save indicator (Phase 2 spec section 10). Boots the REAL tiktok-content.js in
// jsdom and proves the overlay TELLS THE OPERATOR when a host switch did not register.
//
// The failure this closes: open_session_host_segment was fire-and-forget with a console.warn.
// Nobody reads a console during a live. A silently-failed switch leaves no record that one was
// attempted, so the attribution loss is unrecoverable afterwards — the same class as the
// unauthenticated-sale discard, which is why that one got a loud persistent banner too.
//
// Run: node test/content-host-failure.test.mjs   (from extension/)
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const scriptText = readFileSync(join(here, '..', 'tiktok-content.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const ok = (n, c, x) => { if (c) { passed++; console.log('  ✓ ' + n); } else { failed++; console.log('  ✗ ' + n + (x ? '  — ' + x : '')); } };

const HOSTS = [{ id: 'emp-A', name: 'Madison', role: 'host', status: 'active' },
               { id: 'emp-B', name: 'Bella',   role: 'host', status: 'active' }];

function boot(cfg) {
  const store = {};
  const read = (k) => { const o = {}; (Array.isArray(k) ? k : k == null ? Object.keys(store) : [k]).forEach((x) => { if (x in store) o[x] = store[x]; }); return o; };
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://shop.tiktok.com/live', pretendToBeVisual: true, runScripts: 'dangerously' });
  const { window } = dom;
  window.chrome = {
    runtime: {
      lastError: null, id: 'test-ext', getManifest: () => ({ version: '0.7.0' }),
      onMessage: { addListener: (fn) => { cfg.onMsg = fn; } },
      sendMessage(msg, cb) {
        let reply = {};
        if (msg && msg.type === 'GET_AUTH_STATUS') reply = { authenticated: true, userId: 'user-A', sessionId: 'sess-1', roomId: 'R1' };
        else if (msg && msg.type === 'FETCH_HOSTS') reply = { hosts: HOSTS };
        else if (msg && msg.type === 'SET_SESSION_HOST') { cfg.setCalls.push(msg); reply = cfg.setReply || { ok: true, roomId: msg.roomId, hostId: msg.hostId }; }
        else if (msg && msg.type === 'AUTO_BIND') reply = { ok: true };
        if (typeof cb === 'function') { cb(reply); return undefined; }
        return Promise.resolve(reply);
      },
    },
    storage: { local: {
      get(k, cb) { const v = read(k); if (typeof cb === 'function') { cb(v); return undefined; } return Promise.resolve(v); },
      set(o, cb) { Object.assign(store, o); if (typeof cb === 'function') cb(); return Promise.resolve(); },
      remove(k, cb) { (Array.isArray(k) ? k : [k]).forEach((x) => delete store[x]); if (typeof cb === 'function') cb(); return Promise.resolve(); },
    } },
  };
  window.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  // Collapse the 90s deferral escalation so the timeout path is testable. Only long timers are
  // shortened; the overlay's own short timers keep their real cadence.
  const realTimeout = window.setTimeout;
  window.setTimeout = (fn, ms, ...a) => realTimeout(fn, ms > 5000 ? 30 : ms, ...a);
  window.document.body.remove();
  window.eval(scriptText);
  window.document.documentElement.appendChild(window.document.createElement('body'));
  return window;
}
const sr = (w) => w.document.getElementById('lensed-overlay-root')?.shadowRoot;
const warnEl = (w) => sr(w)?.querySelector('.lensed-host-warn');
const selEl = (w) => sr(w)?.querySelector('.lensed-host-select');
const detectRoom = (w, roomId) => w.dispatchEvent(new w.MessageEvent('message', { data: { source: 'lensed-tiktok-room', roomId }, source: w }));

async function pickHost(w, id) {
  const sel = selEl(w);
  sel.value = id;
  sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  await sleep(20);
}

async function run() {
  // ── A. baseline: a clean save shows NO warning and NO unsaved styling ────────────────
  {
    const cfg = { setCalls: [] };
    const w = boot(cfg); await sleep(60); detectRoom(w, 'R1'); await sleep(20);
    ok('A) overlay renders a host row', !!warnEl(w) && !!selEl(w));
    ok('A) with no host picked, it nudges', (warnEl(w).textContent || '').includes('No host selected'), warnEl(w).textContent);
    await pickHost(w, 'emp-A');
    ok('A) a clean save clears the warning', (warnEl(w).textContent || '') === '', JSON.stringify(warnEl(w).textContent));
    ok('A) …and the dropdown is NOT marked unsaved',
       !(selEl(w).className || '').includes('lensed-host-unsaved'), selEl(w).className);
    ok('A) the pick reached the worker (not a vacuous pass)', cfg.setCalls.length === 1, JSON.stringify(cfg.setCalls.length));
  }

  // ── B. THE FOUR ERROR CASES, each distinguished ──────────────────────────────────────
  const cases = [
    ['HOST_NOT_FOUND_OR_NOT_OWNED', 'inactive'],
    ['SESSION_NOT_FOUND_OR_NOT_OWNED', 'no live session'],
    ['INVALID_SOURCE', 'BUILD ERROR'],
    ['AUTH', 'signed out'],
  ];
  for (const [code, needle] of cases) {
    const cfg = { setCalls: [] };
    const w = boot(cfg); await sleep(60); detectRoom(w, 'R1'); await sleep(20);
    await pickHost(w, 'emp-A');
    // the worker's async failure broadcast, exactly as background.js sends it
    cfg.onMsg({ type: 'LENSED_HOST_SEGMENT_FAILED', roomId: 'R1', hostId: 'emp-A', code, message: 'detail for ' + code });
    await sleep(20);
    const t = warnEl(w).textContent || '';
    ok(`B) ${code} → distinct message ("${needle}")`, t.includes(needle), t);
    ok(`B) ${code} → HOST NOT SAVED shown`, t.includes('HOST NOT SAVED'), t);
    ok(`B) ${code} → error styling`, (warnEl(w).className || '').includes('lensed-host-warn-error'), warnEl(w).className);
    ok(`B) ${code} → dropdown marked NOT cleanly selected`,
       (selEl(w).className || '').includes('lensed-host-unsaved'), selEl(w).className);
    ok(`B) ${code} → the underlying error is in the tooltip`,
       (warnEl(w).title || '').includes('detail for ' + code), warnEl(w).title);
  }

  // ── C. the failure is PERSISTENT, not a toast ────────────────────────────────────────
  {
    const cfg = { setCalls: [] };
    const w = boot(cfg); await sleep(60); detectRoom(w, 'R1'); await sleep(20);
    await pickHost(w, 'emp-A');
    cfg.onMsg({ type: 'LENSED_HOST_SEGMENT_FAILED', roomId: 'R1', hostId: 'emp-A', code: 'AUTH', message: 'x' });
    await sleep(300);
    ok('C) still showing after 300ms (persistent, not a toast)',
       (warnEl(w).textContent || '').includes('HOST NOT SAVED'), warnEl(w).textContent);
    // and a subsequent successful pick clears it
    await pickHost(w, 'emp-B');
    ok('C) a later successful save clears it', (warnEl(w).textContent || '') === '', JSON.stringify(warnEl(w).textContent));
    ok('C) …and clears the unsaved styling too',
       !(selEl(w).className || '').includes('lensed-host-unsaved'), selEl(w).className);
  }

  // ── D. ROOM_UNKNOWN is PENDING, not an error — and it ESCALATES ──────────────────────
  {
    const cfg = { setCalls: [], setReply: { ok: true, deferred: true, reason: 'ROOM_UNKNOWN', hostId: 'emp-A' } };
    const w = boot(cfg); await sleep(60);   // deliberately NO room detected
    await pickHost(w, 'emp-A');
    const t = warnEl(w).textContent || '';
    ok('D) deferred shows a PENDING state, not an error', t.includes('waiting for room'), t);
    ok('D) …styled pending, NOT error',
       (warnEl(w).className || '').includes('lensed-host-warn-pending') &&
       !(warnEl(w).className || '').includes('lensed-host-warn-error'), warnEl(w).className);
    ok('D) …but the dropdown is still not "cleanly selected"',
       (selEl(w).className || '').includes('lensed-host-unsaved'), selEl(w).className);
    // escalation (90s collapsed to 30ms by the harness)
    await sleep(120);
    const t2 = warnEl(w).textContent || '';
    ok('D) an unresolved deferral ESCALATES to HOST NOT SAVED', t2.includes('HOST NOT SAVED'), t2);
    ok('D) …with the room-timeout copy', t2.includes('room never resolved'), t2);
    ok('D) …and error styling', (warnEl(w).className || '').includes('lensed-host-warn-error'), warnEl(w).className);
  }

  // ── E. a deferral that RESOLVES must not escalate ────────────────────────────────────
  {
    const cfg = { setCalls: [], setReply: { ok: true, deferred: true, reason: 'ROOM_UNKNOWN', hostId: 'emp-A' } };
    const w = boot(cfg); await sleep(60);
    await pickHost(w, 'emp-A');
    ok('E) starts deferred', (warnEl(w).textContent || '').includes('waiting for room'), warnEl(w).textContent);
    cfg.setReply = { ok: true, roomId: 'R1', hostId: 'emp-A' };   // room now known
    detectRoom(w, 'R1'); await sleep(20);
    await pickHost(w, 'emp-B');                                   // a real save lands
    await sleep(120);                                             // past the escalation window
    ok('E) a resolved deferral does NOT escalate', (warnEl(w).textContent || '') === '', JSON.stringify(warnEl(w).textContent));
  }

  // ── F. a worker-level rejection (ok:false) also surfaces ─────────────────────────────
  {
    const cfg = { setCalls: [], setReply: { ok: false, error: 'ROOM_REQUIRED' } };
    const w = boot(cfg); await sleep(60); detectRoom(w, 'R1'); await sleep(20);
    await pickHost(w, 'emp-A');
    ok('F) ok:false surfaces as HOST NOT SAVED',
       (warnEl(w).textContent || '').includes('HOST NOT SAVED'), warnEl(w).textContent);
    ok('F) …with the worker error in the tooltip',
       (warnEl(w).title || '').includes('ROOM_REQUIRED'), warnEl(w).title);
  }

  console.log('');
  console.log(failed === 0 ? `ALL PASS: ${passed} passed, 0 failed` : `FAILED: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
run();
