/**
 * Lensed background.js — MV3 service worker.
 *
 * Auth: receives Supabase session from the Lensed web app via
 * externally_connectable (onMessageExternal). Persists to chrome.storage.local.
 * Rehydrates on service worker restart.
 *
 * Real Supabase calls:
 * - SKU resolution (select on inventory_skus)
 * - Session get-or-create (live_sessions)
 * - lensed_log_auction RPC
 * - capture_events upsert
 */
'use strict';

// ─── Configuration ───────────────────────────────────────────────────
// IMPORTANT: replace these with your actual Supabase project values.
// They're public (anon key is safe to embed in client code).
var SUPABASE_URL = 'https://dvucodtdojumvplmgjeu.supabase.co';
var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR2dWNvZHRkb2p1bXZwbG1namV1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA0MjU5MjAsImV4cCI6MjA4NjAwMTkyMH0.cJskj6ADQpsdA0_T9GWoBTp4cpfvYxJxfEyiclaBKqY'; // your anon/public key

// ─── Storage keys ────────────────────────────────────────────────────
var SK_ACCESS_TOKEN = 'lensed_access_token';
var SK_REFRESH_TOKEN = 'lensed_refresh_token';
var SK_USER_ID = 'lensed_user_id';
// Live-session identity — persisted so a Live Manager reload or MV3 service-worker
// eviction RESUMES the same session instead of forking a new one. Auction
// idempotency is scoped to (session_id, order_id), so re-binding an order under a
// fresh session id would create a duplicate row / double-decrement inventory;
// pinning the session id here prevents that.
var SK_SESSION_ID = 'lensed_session_id';
var SK_ROOM_ID = 'lensed_room_id';
// When the session was last pinned (ms). On restore we discard a session pinned
// longer ago than the reuse cutoff, so a session left 'live' from a previous day is
// never resumed — even for the same room.
var SK_SESSION_TS = 'lensed_session_ts';
// Persisted queue of sales captured while UNAUTHENTICATED. MV3 workers suspend, so
// this MUST live in chrome.storage.local (an in-memory queue would be lost on restart,
// reintroducing the silent data loss). Flushed to lensed_log_auction + capture_events
// when auth returns. See enqueueSale / flushSaleQueue.
var SK_SALE_QUEUE = 'lensed_sale_queue';
// Captured streaming CHANNEL/creator identities (room owner/anchor), keyed by room.
// The channel (e.g. "onlybids") is NOT the shop (e.g. "Snore") — kept to later seed a
// channel→store mapping. Persisted here (safe, no DB change) in addition to the console
// log + best-effort live_sessions.channel_* write (a no-op until migration 058).
var SK_CHANNEL_ACCOUNTS = 'lensed_channel_accounts';

// ─── Diagnostics (dev-only flight recorder; no-op unless enabled) ────
// Local-only ring buffer of redacted events, persisted THROTTLED to
// chrome.storage.local. The SW is the single sink: content + inject forward
// their events here (they gate on localStorage; the SW can't read it, so content
// sends DIAG_ENABLE). NEVER stores tokens/cookies/raw payloads. Every call is
// try-wrapped so a logging failure can never affect capture/bind.
var EXT_VERSION = (function () { try { return chrome.runtime.getManifest().version; } catch (_) { return '?'; } })();
// Build marker — identifies THIS canonical combined build in the diagnostics export,
// so there is never confusion about which zip a host loaded. DIAG_BUILD_SHA is the
// literal token '__BUILD_SHA__' in source; build.sh stamps the real short commit SHA
// into the dist copy at build time.
var DIAG_BUILD = 'v0.2.25-main-plus-start-auction';
var DIAG_BUILD_SHA = '__BUILD_SHA__';
var DIAG_KEY = 'lensed_diag_log';
var DIAG_FLAG = 'lensed_diag_enabled';
var DIAG_CAP = 15000; // long-live headroom; noise cut (one scan.detected per attempt) keeps this ample
var diagEnabled = false;
var diagRing = [];
var diagWriteInflight = false;
var diagWritePending = false;
// Persist the WHOLE ring on every change. A 2s setTimeout is unreliable in an MV3
// worker — the SW can suspend before it fires, dropping the ring (the cause of the
// empty export). chrome.storage.local.set keeps the SW alive until it resolves; the
// inflight/pending guard coalesces bursts while never losing the final write.
function diagPersist() {
  if (diagWriteInflight) { diagWritePending = true; return; }
  diagWriteInflight = true;
  try {
    // MERGE-on-write: union the in-memory ring with whatever is already stored, so a
    // freshly-woken SW that records an event before its restore runs can never clobber
    // the prior live's history. Also keeps memory in sync with the durable union.
    chrome.storage.local.get([DIAG_KEY], function (d) {
      var stored = (d && Array.isArray(d[DIAG_KEY])) ? d[DIAG_KEY] : [];
      var merged = diagMerge(stored, diagRing);
      diagRing = merged;
      chrome.storage.local.set({ lensed_diag_log: merged }, function () {
        void chrome.runtime.lastError;
        diagWriteInflight = false;
        if (diagWritePending) { diagWritePending = false; diagPersist(); }
      });
    });
  } catch (_) { diagWriteInflight = false; }
}
// Overwrite the durable ring (used by DIAG_CLEAR, which must NOT merge history back).
function diagWriteRaw(arr) {
  try { chrome.storage.local.set({ lensed_diag_log: arr || [] }, function () { void chrome.runtime.lastError; }); } catch (_) {}
}
// Stable-ish key for dedup when merging rings across SW lives / storage + memory.
function diagKeyOf(e) { return (e && (e.ts + '|' + (e.comp || '') + '|' + (e.type || '') + '|' + (e.msg || ''))) || Math.random(); }
function diagMerge(a, b) {
  var seen = Object.create(null), out = [];
  var all = (a || []).concat(b || []);
  for (var i = 0; i < all.length; i++) { var k = diagKeyOf(all[i]); if (seen[k]) continue; seen[k] = 1; out.push(all[i]); }
  out.sort(function (x, y) { return (x.ts || 0) - (y.ts || 0); });
  if (out.length > DIAG_CAP) out = out.slice(out.length - DIAG_CAP);
  return out;
}
// NOTE: gate is on the CALLER. diag() checks diagEnabled; diagPush records whatever
// it is given (DIAG_EVENT arrives only when a dev-gated content/inject sent it, and
// that handler also flips diagEnabled on) — so a cold-woken SW never drops events
// while waiting for the async enabled-flag restore.
function diagPush(ev) {
  if (!ev) return;
  try {
    diagRing.push(ev);
    if (diagRing.length > DIAG_CAP) diagRing.splice(0, diagRing.length - DIAG_CAP);
    diagPersist();
  } catch (_) {}
}
function diag(type, sev, msg, meta) {
  if (!diagEnabled) return;
  diagPush({ ts: Date.now(), v: EXT_VERSION, comp: 'background', type: type, sev: sev || 'info', msg: msg || '', meta: meta || null });
}
// ALWAYS-ON critical lifecycle logging (ungated). The verbose diag() above stays gated on
// diagEnabled (dev opt-in); this small high-signal subset — worker lifecycle, auth, 401,
// queue, heartbeat/ping stalls, recovery, session resolve — records REGARDLESS, so an
// incident is always diagnosable. The gated ring being off by default is exactly why the
// onlybidss evidence was lost. Same ring/cap/redaction; just not gated. crit:1 marks it.
function diagCrit(type, sev, msg, meta) {
  diagPush({ ts: Date.now(), v: EXT_VERSION, comp: 'background', type: type, sev: sev || 'info', msg: msg || '', meta: meta || null, crit: 1 });
}
// Map a thrown RPC/HTTP error to a stable code for the bind audit.
function diagClassifyErr(e) {
  var m = (e && (e.message || e.msg)) || String(e || '');
  if (/OUT_OF_STOCK/.test(m)) return 'OUT_OF_STOCK';
  if (/SESSION_ENDED/.test(m)) return 'SESSION_ENDED';
  if (/SKU_NOT_FOUND/.test(m)) return 'SKU_NOT_FOUND';
  if (/SESSION_NOT_FOUND/.test(m)) return 'SESSION_NOT_FOUND';
  if (/NO_ORG/.test(m)) return 'NO_ORG';
  if (/NOT_AUTHENTICATED|28000/.test(m)) return 'NOT_AUTHENTICATED';
  if (/Failed to fetch|NetworkError|network|timeout|abort/i.test(m)) return 'network_error';
  return 'unknown';
}
function diagRedactId(v) { v = String(v == null ? '' : v); return v.length <= 4 ? v : ('…' + v.slice(-4)); }
// Parse the HTTP status + PostgREST error body ({code,message,details,hint}) out of a
// thrown "UPSERT x failed (409): {json}" error, so a failure is diagnosable instead of
// "unknown". Truncated; no tokens (the thrown message never contains auth headers).
function diagHttpDetail(e) {
  var m = (e && e.message) || String(e || '');
  var out = { msg: m.slice(0, 300) };
  try { var st = m.match(/\((\d{3})\)/); if (st) out.status = Number(st[1]); } catch (_) {}
  try {
    var i = m.indexOf('{');
    if (i >= 0) { var j = JSON.parse(m.slice(i)); out.pgcode = j.code; out.pgmsg = j.message; out.hint = j.hint; out.details = j.details; }
  } catch (_) {}
  return out;
}
// SW-level uncaught error/rejection capture (message only — never payloads).
try {
  self.addEventListener('error', function (ev) { diag('sw.error', 'error', (ev && ev.message) || 'error', { file: ev && ev.filename, line: ev && ev.lineno }); });
  self.addEventListener('unhandledrejection', function (ev) { var r = ev && ev.reason; diag('sw.unhandledrejection', 'error', (r && (r.message || String(r))) || 'rejection', null); });
} catch (_) {}

// ─── State ───────────────────────────────────────────────────────────
var accessToken = null;
var refreshToken = null;
var userId = null;
var currentRoomId = null;          // the live's DETECTED tiktok room (from the page)
var currentSessionId = null;
// Room that currentSessionId is scoped to (persisted as SK_ROOM_ID). A session is
// reused ONLY when the detected room matches this — so a new live (new tiktok room)
// never attaches its orders to a previous live's session. On rehydrate the restored
// session stays "pending room confirmation" (currentRoomId is left null) until the
// page reports a room that matches.
var sessionRoomId = null;
var loggedOrderStatus = new Map(); // order_id -> last logged status ('sold' | 'not_sold')
var loggedOrderSession = new Map(); // order_id -> session_id of the row we logged (for flip transitions)
var cachedSkus = null;
// Manually-selected live HOST (a person from the Team/Employees roster) chosen in the
// overlay. This is NOT the auto-detected TikTok account/shop — it identifies the
// employee running the show, for host-hours / performance attribution. Held in memory
// and pushed to live_sessions.host_id via set_session_host. The content script owns the
// durable per-room/session persistence and re-asserts it after a SW restart.
var selectedHostId = null;
// The session id we've already pushed selectedHostId to — so the attach RPC fires at
// most once per (session, host) and never per-order on the hot bind path.
var hostAppliedForSession = null;

// ─── Tab-alive heartbeat ─────────────────────────────────────────────
// The live tab pings us every HEARTBEAT_MS (content script) while open; we stamp
// live_sessions.last_seen_at so the server-side auto-ender can distinguish a genuinely
// live show from an orphaned session. This is a TAB-ALIVE signal, independent of
// whether auctions are closing — a host in a no-sale lull must still heartbeat.
var HEARTBEAT_MIN_WRITE_MS = 30 * 1000; // throttle DB writes (content pings ~45s; dedups multi-tab)
var lastHeartbeatWriteTs = 0;
// ─── Recovery alarm + content-ping stall tracking (self-healing) ─────
// The SW has no self-timer; it only wakes on content-script pings. When pings stop
// (tab discarded / worker evicted) nothing refreshed/flushed/heartbeated until a manual
// re-sign-in. A chrome.alarms tick gives the SW its own wake source.
var RECOVERY_ALARM = 'lensed_recovery';
var lastContentPingTs = 0;             // when the live content script last pinged us
var lastHeartbeatLoggedSid = null;     // so heartbeat.start logs once per session
var CONTENT_PING_STALL_MS = 90 * 1000; // >2 missed content pings (they arrive ~45s) → stalled
var HEARTBEAT_BACKSTOP_MAX_MS = 5 * 60 * 1000; // keep the session alive via alarm for at most
                                       // 5 min of ping silence; past that a truly-dead tab must
                                       // NOT zombie-heartbeat — let the server auto-ender reap it.
var NEAR_EXPIRY_BUF_SEC = 180;         // refresh proactively when the token is within 3 min of exp
// The tab id the live heartbeats/sales come from — used for a best-effort "mark ended"
// when that specific tab closes. In-memory only (a SW restart forfeits it; the
// auto-ender is the real backstop, so that's acceptable).
var liveTabId = null;

// Read-only resolve of the session id to heartbeat. Prefers the in-memory pointer (set
// by the sale path); otherwise looks it up BY ROOM — the SAME room→session mapping the
// sale path uses — so a mid-live load (extension attached to a session it did NOT create,
// or authenticated only partway through) still stamps last_seen_at. Never creates a
// session; if there's no live session for the room there is nothing to heartbeat.
// A tiny cache avoids re-querying every ping once resolved.
var heartbeatResolvedRoom = null;
var heartbeatResolvedSid = null;
async function resolveHeartbeatSessionId(room) {
  // Fast path: the sale path already pinned a session for this exact room.
  if (currentSessionId && sessionRoomId && room && sessionRoomId === room) return currentSessionId;
  if (currentSessionId && !room) return currentSessionId; // no room hint — use what we have
  if (!room) return null;
  if (heartbeatResolvedSid && heartbeatResolvedRoom === room) return heartbeatResolvedSid;
  try {
    var rows = await supabaseGet(
      'live_sessions',
      'select=id&tiktok_live_id=eq.' + encodeURIComponent(room) + '&status=eq.live&order=started_at.desc&limit=1'
    );
    if (rows && rows.length > 0) {
      heartbeatResolvedRoom = room;
      heartbeatResolvedSid = rows[0].id;
      return heartbeatResolvedSid;
    }
    console.log('[LENSED][BG] heartbeat: no live session found for room', room);
  } catch (e) {
    console.warn('[LENSED][BG] heartbeat session resolve failed:', String((e && e.message) || e));
  }
  return null;
}

// Stamp last_seen_at=now() for the current live session (throttled). Best-effort: a
// failed heartbeat just means the auto-ender waits one more cycle. Never throws.
async function heartbeatSession(room) {
  if (!isAuthenticated()) { console.log('[LENSED][BG] heartbeat skip — not authenticated'); return; }
  var now = Date.now();
  if (now - lastHeartbeatWriteTs < HEARTBEAT_MIN_WRITE_MS) return;
  var sid = currentSessionId || await resolveHeartbeatSessionId(room);
  console.log('[LENSED][BG] heartbeat: currentSessionId=' + currentSessionId + ' resolvedSid=' + sid + ' room=' + room);
  if (!sid) { console.log('[LENSED][BG] heartbeat skip — no live session to stamp (room ' + room + ')'); return; }
  lastHeartbeatWriteTs = now;
  try {
    await supabasePatch('live_sessions', 'id=eq.' + encodeURIComponent(sid), { last_seen_at: new Date().toISOString() });
    console.log('[LENSED][BG] heartbeat OK — last_seen_at stamped for session ' + sid);
    if (sid !== lastHeartbeatLoggedSid) { lastHeartbeatLoggedSid = sid; diagCrit('heartbeat.start', 'info', 'heartbeat stamping', { session: diagRedactId(sid) }); }
  } catch (e) {
    lastHeartbeatWriteTs = 0; // let the next ping retry promptly
    console.warn('[LENSED][BG] heartbeat failed (non-fatal):', String((e && e.message) || e));
  }
}

// ─── Channel/creator account capture (Half 1) ────────────────────────
// Persist the DETECTED streaming channel (room owner/anchor: secUid / handle / nickname
// / numeric id). The channel (e.g. "onlybids") is NOT the shop (e.g. "Snore") — they
// differ by design; this is the creator identity that will seed a channel→store mapping.
// TONIGHT: capture to console + chrome.storage.local (zero DB risk). The best-effort
// live_sessions.channel_* write is a NO-OP until migration 058 adds those columns — a
// missing-column PATCH is caught and can never affect session creation (separate UPDATE).
var CHANNEL_ACCOUNTS_MAX = 50;
async function handleAccountDetected(account, room) {
  if (!account) return;
  var r = room || currentRoomId || sessionRoomId || null;
  // Resolve the session the SAME robust way the heartbeat does (by room) — works even on
  // a mid-live load where this worker never set currentSessionId.
  var sid = currentSessionId || (r ? await resolveHeartbeatSessionId(r) : null);

  console.log('[LENSED] account detected: handle=' + (account.handle || '?')
    + ' secUid=' + (account.secUid || '?')
    + ' nickname=' + (account.nickname || '?')
    + ' id=' + (account.id || '?')
    + ' room=' + (r || '?')
    + ' → session ' + (sid || '(unresolved)'));
  // Confidence: an identity carrying a sec_uid is the STRONG API anchor; a DOM label
  // (source:'dom', no sec_uid) is WEAK. This drives GUARDRAIL 1 below.
  var incomingStrong = !!account.secUid;
  var src = account.source || (incomingStrong ? 'api' : 'dom');
  // ALWAYS-ON: what was detected, from where, at what confidence (channel logging was gated,
  // which is why the "Close" corruption was invisible).
  diagCrit('channel.detected', 'info', 'channel identity detected', {
    handle: account.handle || null, secUid: account.secUid ? diagRedactId(account.secUid) : null,
    nickname: account.nickname || null, source: src, strategy: account.strategy || null,
    score: account.score || null, strong: incomingStrong, room: r || null, session: sid ? diagRedactId(sid) : null,
  });

  // Read the current channel_handle FIRST (authoritative), then the storage map, so the
  // non-destructive guard can compare against what's already persisted.
  var existingHandle = null;
  if (sid && isAuthenticated()) {
    try {
      var exRows = await supabaseGet('live_sessions', 'select=channel_handle&id=eq.' + encodeURIComponent(sid) + '&limit=1');
      if (exRows && exRows[0]) existingHandle = exRows[0].channel_handle || null;
    } catch (_) {}
  }

  // 1) Storage-map telemetry cache — MERGE (never null an existing field), keyed by room.
  var prevHandle = null;
  var acceptHandle = null; // GUARDRAIL 1 decision, shared with the DB-persist step below
  try {
    var d = await chrome.storage.local.get([SK_CHANNEL_ACCOUNTS]);
    var map = (d && d[SK_CHANNEL_ACCOUNTS] && typeof d[SK_CHANNEL_ACCOUNTS] === 'object') ? d[SK_CHANNEL_ACCOUNTS] : {};
    var mapKey = r || (sid ? ('session:' + sid) : (account.key || account.secUid || account.handle));
    var prev = map[mapKey] || {};
    prevHandle = prev.handle || null;
    if (existingHandle == null) existingHandle = prevHandle; // fall back to cache when DB unread (e.g. unauthenticated)

    // GUARDRAIL 1 — decide if the incoming handle may be written. Never let a WEAK handle
    // OVERWRITE a DIFFERENT already-set handle (the jumbosteals→"Close" corruption). First
    // write is allowed; identical is a no-op; only a STRONG (sec_uid) identity may overwrite.
    var decision;
    if (!account.handle) decision = 'no_handle';
    else if (!existingHandle) { acceptHandle = account.handle; decision = 'first_write'; }
    else if (existingHandle === account.handle) decision = 'unchanged';
    else if (incomingStrong) { acceptHandle = account.handle; decision = 'overwrite_strong'; }
    else decision = 'rejected_weak_overwrite'; // KEEP existing — do NOT clobber
    if (account.handle && existingHandle && existingHandle !== account.handle) {
      diagCrit('channel.overwrite', decision === 'rejected_weak_overwrite' ? 'warn' : 'info',
        'channel_handle "' + existingHandle + '" → "' + account.handle + '" (' + decision + ')',
        { old: existingHandle, new: account.handle, source: src, strong: incomingStrong, applied: decision !== 'rejected_weak_overwrite' });
    }
    map[mapKey] = {
      sec_uid: account.secUid || prev.sec_uid || null,
      account_id: account.id != null ? String(account.id) : (prev.account_id || null),
      handle: acceptHandle || prev.handle || existingHandle || null,
      nickname: account.nickname || prev.nickname || null,
      room_id: r || prev.room_id || null,
      session_id: sid || prev.session_id || null,
      detected_at: new Date().toISOString(),
    };
    var keys = Object.keys(map);
    if (keys.length > CHANNEL_ACCOUNTS_MAX) {
      keys.sort(function (a, b) { return (map[a].detected_at || '').localeCompare(map[b].detected_at || ''); });
      for (var i = 0; i < keys.length - CHANNEL_ACCOUNTS_MAX; i++) delete map[keys[i]];
    }
    var toSet = {}; toSet[SK_CHANNEL_ACCOUNTS] = map;
    await chrome.storage.local.set(toSet);
  } catch (e) {
    console.warn('[LENSED][BG] channel storage write failed (non-fatal):', String((e && e.message) || e));
  }

  // 2) DB persist to live_sessions.channel_* — PARTIAL patch: include ONLY fields the message
  //    actually carries (GUARDRAIL 1). A DOM-only message never NULLs an existing sec_uid /
  //    nickname / account_id, and the handle is only written when the guard above accepted it.
  if (sid && isAuthenticated()) {
    var patch = {};
    if (account.secUid) patch.channel_sec_uid = account.secUid;
    if (account.nickname) patch.channel_nickname = account.nickname;
    if (account.id != null) patch.channel_account_id = String(account.id);
    if (acceptHandle) patch.channel_handle = acceptHandle;
    if (Object.keys(patch).length > 0) {
      try {
        await supabasePatch('live_sessions', 'id=eq.' + encodeURIComponent(sid), patch);
        console.log('[LENSED][BG] channel persisted to live_sessions ' + sid + ' (' + Object.keys(patch).join(',') + ')');
      } catch (e) {
        console.log('[LENSED][BG] channel DB persist deferred:', String((e && e.message) || e));
      }
    }
  }
}

// Best-effort "mark ended" when the live tab closes. Close handlers are unreliable in
// MV3 (the SW may already be gone), so this is opportunistic — the server auto-ender is
// the authoritative backstop. Sets end_source so an auto/tab-close end is distinguishable.
async function markSessionEndedOnTabClose(sid) {
  if (!isAuthenticated() || !sid) return;
  try {
    await supabasePatch(
      'live_sessions',
      'id=eq.' + encodeURIComponent(sid) + '&status=eq.live',
      { status: 'ended', ended_at: new Date().toISOString(), end_source: 'tab_closed' }
    );
    console.log('[LENSED][BG] marked session ended on tab close:', sid);
  } catch (e) {
    console.warn('[LENSED][BG] mark-ended-on-close failed (non-fatal):', String((e && e.message) || e));
  }
}

// Never auto-reuse an extension-created session older than this. A session left in
// 'live' for days (the extension never calls /end) must NOT be adopted for a new
// day's live — even if a room id somehow recurred. Beyond the cutoff we create a
// fresh room-scoped session instead.
var SESSION_REUSE_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12h

// A status-flip transition (e.g. failed→paid) re-calls the RPC to flip an
// EXISTING row; migration 027's transition path decrements the originally-bound
// SKUs and ignores p_skus. But the RPC's NO_SKUS guard rejects an empty p_skus
// at the top, so we pass this minimal non-empty placeholder purely to satisfy
// that guard. The transition never reads it; if (defensively) the row were
// missing and the insert path ran, this nonexistent SKU fails safe (no bad row).
var TRANSITION_PLACEHOLDER_SKUS = [{ sku_id: '00000000-0000-0000-0000-000000000000', qty: 1 }];
var authReady = false; // true once we've tried to rehydrate
// Promise handle for the one-time startup rehydrate. Auth-dependent handlers
// await this so a cold MV3 service worker never acts on null auth before the
// stored session has been rehydrated — the root cause of the first scan falsely
// reporting "SKU not found". Assigned at startup (bottom of file); guarded here
// in case a handler somehow races that assignment.
var authReadyPromise = null;
function ensureAuthReady() {
  return authReadyPromise || Promise.resolve();
}

// ─── JWT helpers ─────────────────────────────────────────────────────

function decodeJwtPayload(token) {
  try {
    var parts = token.split('.');
    if (parts.length !== 3) return null;
    var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64));
  } catch (e) {
    return null;
  }
}

function getUserIdFromToken(token) {
  var payload = decodeJwtPayload(token);
  return payload && payload.sub ? payload.sub : null;
}

function isTokenExpired(token, bufferSec) {
  var buf = bufferSec || 60;
  var payload = decodeJwtPayload(token);
  if (!payload || !payload.exp) return true;
  return payload.exp < (Date.now() / 1000) + buf;
}

// ─── Supabase REST helpers ───────────────────────────────────────────
// No JS client library — raw fetch with headers, keeping the bundle tiny.

function supabaseHeaders() {
  var h = {
    'apikey': SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  };
  if (accessToken) {
    h['Authorization'] = 'Bearer ' + accessToken;
  } else {
    h['Authorization'] = 'Bearer ' + SUPABASE_ANON_KEY;
  }
  return h;
}

// ── Fetch robustness (freeze-hardening) ──────────────────────────────
// A hung socket during a long live can wedge an awaiting handler until the MV3
// worker is finally evicted. Every Supabase call goes through an AbortController
// timeout so it fails fast and predictably instead of hanging.
var FETCH_TIMEOUT_MS = 8000;         // reads / RPC / token refresh
var FETCH_TIMEOUT_WRITE_MS = 12000;  // inserts / upserts (more generous)

function fetchWithTimeout(url, opts, ms) {
  var controller = new AbortController();
  var t = setTimeout(function () { controller.abort(); }, ms);
  var o = Object.assign({}, opts || {}, { signal: controller.signal });
  return fetch(url, o).finally(function () { clearTimeout(t); });
}

// Timeout + at most ONE retry on a TRANSIENT failure (abort/timeout or network
// error — never on an HTTP error status). allowRetry MUST be false for
// non-idempotent writes (the session INSERT has no idempotency key / unique
// constraint, so a committed-but-timed-out retry would fork the session PR2
// exists to prevent). Idempotent calls (GET, merge-duplicates upsert, the
// session+order-keyed RPC, token refresh) pass allowRetry=true.
async function sbFetch(url, opts, ms, allowRetry) {
  try {
    return await fetchWithTimeout(url, opts, ms);
  } catch (e) {
    var transient = e && (e.name === 'AbortError' || e.name === 'TypeError');
    if (allowRetry && transient) {
      console.warn('[LENSED][BG] fetch transient failure, retrying once:', String(url).split('?')[0], e.name);
      await new Promise(function (r) { setTimeout(r, 500); });
      return await fetchWithTimeout(url, opts, ms);
    }
    throw e;
  }
}

// Pathological-safety cap for the per-order dedup Maps (order_id-keyed). Evict the
// oldest key from BOTH maps in lockstep so the flip path (which needs the status
// token AND the session id) never sees one map without the other. Real idempotency
// is server-side (session_id + order_id), so a rare eviction costs at most one extra
// idempotent RPC — never a duplicate row.
var MAP_CAP = 5000;
function capOrderMaps() {
  while (loggedOrderStatus.size > MAP_CAP) {
    var k = loggedOrderStatus.keys().next().value;
    loggedOrderStatus.delete(k);
    loggedOrderSession.delete(k);
  }
}

async function supabaseGet(table, query) {
  var url = SUPABASE_URL + '/rest/v1/' + table + '?' + query;
  var res = await sbFetch(url, { headers: supabaseHeaders() }, FETCH_TIMEOUT_MS, true);
  if (res.status === 401) {
    diagCrit('http.401', 'warn', '401 from Supabase — attempting token refresh', null);
    var refreshed = await tryRefreshToken();
    if (refreshed) {
      res = await sbFetch(url, { headers: supabaseHeaders() }, FETCH_TIMEOUT_MS, true);
    }
  }
  if (!res.ok) {
    var err = await res.text().catch(function () { return res.statusText; });
    throw new Error('GET ' + table + ' failed (' + res.status + '): ' + err);
  }
  return res.json();
}

async function supabasePost(table, body) {
  var url = SUPABASE_URL + '/rest/v1/' + table;
  // allowRetry=false: this creates a live_sessions row (no idempotency key / unique
  // constraint), so a retry after a timed-out-but-committed INSERT would fork sessions.
  var res = await sbFetch(url, {
    method: 'POST',
    headers: supabaseHeaders(),
    body: JSON.stringify(body),
  }, FETCH_TIMEOUT_WRITE_MS, false);
  if (res.status === 401) {
    diagCrit('http.401', 'warn', '401 from Supabase — attempting token refresh', null);
    var refreshed = await tryRefreshToken();
    if (refreshed) {
      res = await sbFetch(url, {
        method: 'POST',
        headers: supabaseHeaders(),
        body: JSON.stringify(body),
      }, FETCH_TIMEOUT_WRITE_MS, false);
    }
  }
  if (!res.ok) {
    var err = await res.text().catch(function () { return res.statusText; });
    throw new Error('POST ' + table + ' failed (' + res.status + '): ' + err);
  }
  return res.json();
}

async function supabaseUpsert(table, body, onConflict) {
  // on_conflict targets a specific unique constraint (else PostgREST uses the PK).
  var url = SUPABASE_URL + '/rest/v1/' + table + (onConflict ? ('?on_conflict=' + encodeURIComponent(onConflict)) : '');
  var headers = supabaseHeaders();
  headers['Prefer'] = 'resolution=merge-duplicates,return=representation';
  // allowRetry=true: merge-duplicates makes a re-send idempotent (same conflict key).
  var res = await sbFetch(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(body),
  }, FETCH_TIMEOUT_WRITE_MS, true);
  if (res.status === 401) {
    diagCrit('http.401', 'warn', '401 from Supabase — attempting token refresh', null);
    var refreshed = await tryRefreshToken();
    if (refreshed) {
      headers = supabaseHeaders();
      headers['Prefer'] = 'resolution=merge-duplicates,return=representation';
      res = await sbFetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
      }, FETCH_TIMEOUT_WRITE_MS, true);
    }
  }
  if (!res.ok) {
    var err = await res.text().catch(function () { return res.statusText; });
    throw new Error('UPSERT ' + table + ' failed (' + res.status + '): ' + err);
  }
  return res.json();
}

async function supabasePatch(table, query, body) {
  // Column update via PostgREST. `query` is a PostgREST filter (e.g. 'id=eq.<uuid>').
  // allowRetry=true: the only caller (heartbeat / mark-ended) is idempotent — it sets
  // an absolute value (last_seen_at=now / status=ended), so a replayed PATCH is a no-op.
  var url = SUPABASE_URL + '/rest/v1/' + table + '?' + query;
  var headers = supabaseHeaders();
  headers['Prefer'] = 'return=minimal';
  var res = await sbFetch(url, {
    method: 'PATCH',
    headers: headers,
    body: JSON.stringify(body),
  }, FETCH_TIMEOUT_WRITE_MS, true);
  if (res.status === 401) {
    diagCrit('http.401', 'warn', '401 from Supabase — attempting token refresh', null);
    var refreshed = await tryRefreshToken();
    if (refreshed) {
      headers = supabaseHeaders();
      headers['Prefer'] = 'return=minimal';
      res = await sbFetch(url, {
        method: 'PATCH',
        headers: headers,
        body: JSON.stringify(body),
      }, FETCH_TIMEOUT_WRITE_MS, true);
    }
  }
  if (!res.ok) {
    var err = await res.text().catch(function () { return res.statusText; });
    throw new Error('PATCH ' + table + ' failed (' + res.status + '): ' + err);
  }
  return true;
}

async function supabaseRpc(fnName, params) {
  var url = SUPABASE_URL + '/rest/v1/rpc/' + fnName;
  // allowRetry=true: lensed_log_auction is idempotent on (session_id, idem_key=
  // order_id) — a retry with the SAME params replays (no duplicate row / decrement).
  // The caller must never change p_session_id/p_idem_key across a retry (it doesn't).
  var res = await sbFetch(url, {
    method: 'POST',
    headers: supabaseHeaders(),
    body: JSON.stringify(params),
  }, FETCH_TIMEOUT_MS, true);
  if (res.status === 401) {
    diagCrit('http.401', 'warn', '401 from Supabase — attempting token refresh', null);
    var refreshed = await tryRefreshToken();
    if (refreshed) {
      res = await sbFetch(url, {
        method: 'POST',
        headers: supabaseHeaders(),
        body: JSON.stringify(params),
      }, FETCH_TIMEOUT_MS, true);
    }
  }
  if (!res.ok) {
    var err = await res.text().catch(function () { return res.statusText; });
    throw new Error('RPC ' + fnName + ' failed (' + res.status + '): ' + err);
  }
  return res.json();
}

// ─── Auth: persist / rehydrate / refresh ─────────────────────────────

async function persistAuth(at, rt) {
  accessToken = at;
  refreshToken = rt;
  userId = getUserIdFromToken(at);
  var data = {};
  data[SK_ACCESS_TOKEN] = at;
  data[SK_REFRESH_TOKEN] = rt;
  if (userId) data[SK_USER_ID] = userId;
  await chrome.storage.local.set(data);
  console.log('[LENSED][BG] auth persisted, user_id:', userId);
  diagCrit('auth.acquired', 'info', 'auth acquired/persisted', { user: diagRedactId(userId), queued: saleQueue.length });
  // Auth just became available (login / web-app relay / token refresh) → drain any sales
  // captured while signed out. Fire-and-forget; never blocks the auth path.
  try { flushSaleQueue(); } catch (_) {}
}

async function rehydrateAuth() {
  // Wrapped so a storage-read failure can never leave the worker "never ready":
  // authReadyPromise resolves regardless, and awaiting handlers fall through to
  // their own isAuthenticated() guards instead of throwing/hanging.
  try {
    var data = await chrome.storage.local.get([SK_ACCESS_TOKEN, SK_REFRESH_TOKEN, SK_USER_ID, SK_SESSION_ID, SK_ROOM_ID, SK_SESSION_TS]);
    if (data[SK_ACCESS_TOKEN]) {
      accessToken = data[SK_ACCESS_TOKEN];
      refreshToken = data[SK_REFRESH_TOKEN] || null;
      userId = data[SK_USER_ID] || getUserIdFromToken(accessToken);

      // If the stored access token is expired, try refreshing immediately
      if (isTokenExpired(accessToken)) {
        console.log('[LENSED][BG] rehydrated token is expired, refreshing...');
        diagCrit('auth.refresh', 'info', 'rehydrate: refreshing expired token', null);
        var refreshed = await tryRefreshToken();
        if (!refreshed) {
          console.warn('[LENSED][BG] rehydrate refresh failed — clearing auth');
          diagCrit('auth.lost', 'warn', 'rehydrate refresh failed — auth cleared', { user: diagRedactId(userId) });
          accessToken = null;
          refreshToken = null;
          userId = null;
        } else {
          diagCrit('auth.acquired', 'info', 'auth restored (refreshed on rehydrate)', { user: diagRedactId(userId) });
        }
      } else {
        console.log('[LENSED][BG] auth rehydrated, user_id:', userId);
        diagCrit('auth.acquired', 'info', 'auth restored from storage', { user: diagRedactId(userId) });
      }

      // Restore the pinned live-session identity so a post-reload/eviction bind
      // resumes the SAME session instead of creating a duplicate. Only when auth
      // survived rehydrate (a cleared token above means don't resume a session).
      if (accessToken) {
        // Restore the pinned session AND the room it was scoped to. Do NOT set
        // currentRoomId — the live's DETECTED room is unknown until the page reports
        // it, so the restored session stays "pending room confirmation" and is reused
        // only once a detected room matches sessionRoomId (see getOrCreateSession and
        // the TIKTOK_ROOM handler). This is what stops a reload/eviction from adopting
        // a stale session for a DIFFERENT live.
        if (data[SK_SESSION_ID]) currentSessionId = data[SK_SESSION_ID];
        if (data[SK_ROOM_ID]) sessionRoomId = data[SK_ROOM_ID];
        // Stale-cutoff on the restored session: a session pinned longer ago than the
        // reuse window (e.g. left 'live' from a previous day) must not be resumed.
        var pinnedTs = Number(data[SK_SESSION_TS]) || 0;
        if (currentSessionId && (!pinnedTs || (Date.now() - pinnedTs) > SESSION_REUSE_MAX_AGE_MS)) {
          console.log('[LENSED][BG] restored session too old — discarding:', currentSessionId);
          currentSessionId = null;
          sessionRoomId = null;
        } else if (currentSessionId) {
          console.log('[LENSED][BG] session restored (pending room confirmation):', currentSessionId, 'room', sessionRoomId);
        }
      }
    } else {
      console.log('[LENSED][BG] no stored auth — waiting for relay from web app');
    }
  } catch (e) {
    console.error('[LENSED][BG] rehydrate storage read failed:', e);
  } finally {
    authReady = true;
  }
}

async function tryRefreshToken() {
  if (!refreshToken) return false;
  try {
    // allowRetry=true (one retry): a transient network blip shouldn't drop auth. The
    // aborted/failed path returns false below, so callers fall through to their own
    // isAuthenticated() guards and nothing hangs (rehydrate always settles authReady).
    var res = await sbFetch(SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    }, FETCH_TIMEOUT_MS, true);
    if (!res.ok) {
      console.error('[LENSED][BG] token refresh failed:', res.status);
      diagCrit('auth.refresh_fail', 'error', 'token refresh rejected', { status: res.status });
      return false;
    }
    var json = await res.json();
    if (json.access_token && json.refresh_token) {
      await persistAuth(json.access_token, json.refresh_token);
      console.log('[LENSED][BG] token refreshed successfully');
      diagCrit('auth.refresh_ok', 'info', 'token refreshed', null);
      return true;
    }
    diagCrit('auth.refresh_fail', 'error', 'token refresh response missing tokens', null);
    return false;
  } catch (e) {
    console.error('[LENSED][BG] token refresh error:', e);
    diagCrit('auth.refresh_fail', 'error', 'token refresh threw', { code: diagClassifyErr(e) });
    return false;
  }
}

async function clearAuth() {
  accessToken = null;
  refreshToken = null;
  userId = null;
  currentSessionId = null;
  currentRoomId = null;
  sessionRoomId = null;
  cachedSkus = null;
  selectedHostId = null;
  hostAppliedForSession = null;
  await chrome.storage.local.remove([SK_ACCESS_TOKEN, SK_REFRESH_TOKEN, SK_USER_ID, SK_SESSION_ID, SK_ROOM_ID, SK_SESSION_TS]);
  console.log('[LENSED][BG] auth cleared');
  diagCrit('auth.lost', 'warn', 'auth cleared', null);
}

function isAuthenticated() {
  return !!accessToken && !!userId;
}

// ─── Real Supabase calls ─────────────────────────────────────────────

var SKU_COLS = 'select=id,sku_number,barcode,title,unit_cost_cents,qty_on_hand,live_seller_notes';

// Normalize a typed/scanned term before lookup. Scanners can append hidden
// control/zero-width characters and hosts may type a leading '#'; we also
// uppercase because every barcode is generated uppercase (genBarcode in
// src/app/api/inventory/skus/route.ts → "SKU<n>-<UPPERHEX>") and both the cache
// match and PostgREST `barcode=eq.` are case-sensitive. sku_number is digits, so
// uppercasing is a no-op for the numeric fallback.
function normalizeScanTerm(term) {
  var s = (term == null ? '' : String(term));
  // Strip C0/C1 controls, DEL, and zero-width/joiner/BOM chars anywhere in the
  // string — a scoped set (not a catch-all) so real barcode chars are untouched.
  s = s.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\u2060\uFEFF]/g, '');
  return s.trim().replace(/^#/, '').toUpperCase();
}

// Resolve a typed-or-scanned term: match barcode first (scanner path), then
// fall back to sku_number (typed path). Term may be alphanumeric (a barcode).
// Returns { sku, status } where status distinguishes a genuine miss ('not_found')
// from a not-yet-signed-in worker ('not_authenticated') or a network error
// ('error') — so the overlay never shows a premature "SKU not found".
async function resolveSkuByNumber(term) {
  var raw = normalizeScanTerm(term);
  if (!raw) return { sku: null, status: 'empty' };
  var n = parseInt(raw, 10);
  var asNumber = (Number.isFinite(n) && n > 0) ? n : null;

  // Check cache first: barcode, then sku_number. A warm worker resolves instantly.
  if (cachedSkus && cachedSkus.length > 0) {
    var byBarcode = cachedSkus.find(function (s) { return s.barcode === raw; });
    if (byBarcode) return { sku: byBarcode, status: 'ok' };
    if (asNumber != null) {
      var byNum = cachedSkus.find(function (s) { return s.sku_number === asNumber; });
      if (byNum) return { sku: byNum, status: 'ok' };
    }
  }

  // Wait for the one-time startup rehydrate before judging auth. Without this, a
  // scan that wakes a cold service worker races rehydrateAuth() and would report
  // "not authenticated" → the false first-scan "SKU not found". Awaiting an
  // already-settled promise on a warm worker is a no-op.
  await ensureAuthReady();
  if (!isAuthenticated()) {
    console.warn('[LENSED][BG] not authenticated, cannot resolve SKU');
    return { sku: null, status: 'not_authenticated' };
  }

  try {
    // Barcode match first…
    var rows = await supabaseGet(
      'inventory_skus',
      SKU_COLS + '&barcode=eq.' + encodeURIComponent(raw) + '&is_active=eq.true&limit=1'
    );
    // …then fall back to sku_number when the term is numeric.
    if ((!rows || rows.length === 0) && asNumber != null) {
      rows = await supabaseGet(
        'inventory_skus',
        SKU_COLS + '&sku_number=eq.' + asNumber + '&is_active=eq.true&limit=1'
      );
    }
    if (rows && rows.length > 0) {
      // Update cache (keyed by id, since match may be by barcode or number).
      if (!cachedSkus) cachedSkus = [];
      var existing = cachedSkus.findIndex(function (s) { return s.id === rows[0].id; });
      if (existing >= 0) cachedSkus[existing] = rows[0];
      else cachedSkus.push(rows[0]);
      return { sku: rows[0], status: 'ok' };
    }
    return { sku: null, status: 'not_found' };
  } catch (e) {
    console.error('[LENSED][BG] resolve SKU error:', e);
    return { sku: null, status: 'error' };
  }
}

async function fetchAllSkus() {
  await ensureAuthReady();
  if (!isAuthenticated()) return [];
  try {
    cachedSkus = await supabaseGet(
      'inventory_skus',
      SKU_COLS + '&is_active=eq.true&order=sku_number.asc'
    );
    return cachedSkus;
  } catch (e) {
    console.error('[LENSED][BG] fetch SKUs error:', e);
    return [];
  }
}

// ─── Live host (Team/Employees roster) ───────────────────────────────
// Columns projected for the overlay dropdown. Employees are user_id-scoped by RLS
// (auth.uid() = user_id), so this returns exactly the signed-in operator's roster.
var HOST_COLS = 'select=id,name,role,status';

// Fetch the ACTIVE employees for the host dropdown. Sorted role='host' first (the
// preset for on-camera staff) then by name — a display preference, NOT a filter: a
// manager may also host, so every active employee is selectable.
async function fetchActiveHosts() {
  await ensureAuthReady();
  if (!isAuthenticated()) return [];
  try {
    var rows = await supabaseGet(
      'employees',
      HOST_COLS + '&status=eq.active&order=name.asc'
    );
    rows = (rows || []).slice().sort(function (a, b) {
      var ah = (a && a.role === 'host') ? 0 : 1;
      var bh = (b && b.role === 'host') ? 0 : 1;
      if (ah !== bh) return ah - bh;
      return String((a && a.name) || '').localeCompare(String((b && b.name) || ''));
    });
    return rows;
  } catch (e) {
    console.error('[LENSED][BG] fetch hosts error:', e);
    return [];
  }
}

// Attach the selected host to the current live session via the set_session_host RPC.
// Fire-and-forget + memoized so it never slows or breaks the capture path: if the RPC
// is absent (migration not yet applied) or fails transiently, it logs and no-ops —
// capture and binding are entirely unaffected. Never added to the session INSERT, so
// session creation cannot fail on a missing host_id column.
function maybeApplyHost() {
  if (!isAuthenticated() || !currentSessionId || !selectedHostId) return;
  if (hostAppliedForSession === currentSessionId) return;
  var sid = currentSessionId;
  var hid = selectedHostId;
  hostAppliedForSession = sid; // optimistic — prevents duplicate concurrent RPCs
  supabaseRpc('set_session_host', { p_session_id: sid, p_host_id: hid })
    .then(function () {
      console.log('[LENSED][BG] host attached to session', sid, '->', hid);
    })
    .catch(function (e) {
      // Reset the memo so a later trigger (next bind / re-assert) can retry.
      if (hostAppliedForSession === sid) hostAppliedForSession = null;
      console.warn('[LENSED][BG] set_session_host failed (non-fatal):', String((e && e.message) || e));
    });
}

// Record the operator's host choice and (re)apply it to the current session. Called
// from the content script on selection change and on post-reload re-assert.
function setSelectedHost(hostId) {
  selectedHostId = hostId || null;
  hostAppliedForSession = null; // force a re-apply to the current session
  maybeApplyHost();
  return { ok: true, sessionId: currentSessionId || null, hostId: selectedHostId };
}

// Resolve (or create) the live session for a specific tiktok room. `roomId` is the
// authoritative room for THIS order (passed from the sale payload); it defends
// against a stale in-memory/persisted session even before a TIKTOK_ROOM arrives.
async function getOrCreateSession(roomId) {
  var room = roomId || currentRoomId || null;

  // Reuse the in-memory session ONLY when it is scoped to the SAME room. A session
  // pinned to a different room (e.g. a restored one from a previous live) is never
  // reused for a new room's orders.
  if (currentSessionId && sessionRoomId && room && sessionRoomId === room) {
    // Hot path (every sale) — do NOT attach the host here. host_id is durable in the
    // DB once applied on create/reuse below, and an explicit change re-applies via
    // setSelectedHost; attaching per-sale would retry the RPC on every order.
    return currentSessionId;
  }
  if (!isAuthenticated()) {
    console.warn('[LENSED][BG] not authenticated, cannot get/create session');
    return null;
  }
  if (!room) {
    // Conservative: with no known room we refuse to adopt a (possibly stale) session
    // or create an unscoped one. The order is still written to capture_events; it is
    // simply not bound to an auction item until a room is known.
    console.warn('[LENSED][BG] room unknown — refusing to bind to a session (order captured only)');
    return null;
  }

  try {
    // Reuse ONLY a recent, extension-created, still-open session for THIS exact room.
    var cutoffIso = new Date(Date.now() - SESSION_REUSE_MAX_AGE_MS).toISOString();
    var rows = await supabaseGet(
      'live_sessions',
      'select=id,status,tiktok_live_id,started_at'
        + '&tiktok_live_id=eq.' + encodeURIComponent(room)
        + '&status=in.(draft,live)&source=eq.extension'
        + '&started_at=gte.' + encodeURIComponent(cutoffIso)
        + '&order=started_at.desc&limit=1'
    );
    if (rows && rows.length > 0) {
      currentSessionId = rows[0].id;
      sessionRoomId = room;
      console.log('[LENSED][BG] reusing room-scoped session:', currentSessionId, 'room', room);
      diagCrit('session.resolve', 'info', 'reused room-scoped session', { session: diagRedactId(currentSessionId), room: room, created: false });
      persistSession();
      broadcastSession();
      maybeApplyHost();
      return currentSessionId;
    }

    // No recent room-scoped session → create a new one, tagged with this room.
    var created = await supabasePost('live_sessions', {
      user_id: userId,
      title: 'TikTok Live',
      status: 'live',
      started_at: new Date().toISOString(),
      source: 'extension',
      tiktok_live_id: room,
      // store_id intentionally omitted — it is not known client-side. Production
      // populates it out-of-band (DB default/trigger). Do NOT add an API round-trip
      // just to fetch it in this PR.
    });
    if (created && created.length > 0) {
      currentSessionId = created[0].id;
      sessionRoomId = room;
      console.log('[LENSED][BG] created room-scoped session:', currentSessionId, 'room', room);
      diagCrit('session.resolve', 'info', 'created room-scoped session', { session: diagRedactId(currentSessionId), room: room, created: true });
      persistSession();
      broadcastSession();
      maybeApplyHost();
      return currentSessionId;
    }
    console.error('[LENSED][BG] session create returned empty');
    return null;
  } catch (e) {
    console.error('[LENSED][BG] session get-or-create error:', e);
    return null;
  }
}

// Resolve — but NEVER create — a session for a queued sale being flushed. A stale queue
// (e.g. a previous live's tail flushed hours later) must attach to that room's EXISTING
// session, not mint a fresh 'live' row (the e4b58b91 ghost). If the room has no session,
// the sale stays captured-only (correct for backfill; it's still saved in capture_events).
// Unlike getOrCreateSession there is NO recency cutoff — a 14h-old flush still finds the
// room's real session — and NO INSERT path.
async function resolveSessionForFlush(room) {
  if (!room) return null;
  // Same-room in-memory session (a mid-show auth drop that just recovered) → use it.
  if (currentSessionId && sessionRoomId && sessionRoomId === room) return currentSessionId;
  if (!isAuthenticated()) return null;
  try {
    var rows = await supabaseGet(
      'live_sessions',
      'select=id,status&tiktok_live_id=eq.' + encodeURIComponent(room)
        + '&source=eq.extension&order=started_at.desc&limit=1'
    );
    if (rows && rows.length > 0) {
      diagCrit('session.resolve', 'info', 'flush resolved to existing session (no create)', { session: diagRedactId(rows[0].id), room: room, status: rows[0].status });
      return rows[0].id;
    }
  } catch (_) { /* fall through — captured-only */ }
  diagCrit('session.resolve', 'warn', 'flush found no session for room — captured-only (no ghost row)', { room: room });
  return null;
}

function parsePriceToCents(priceStr) {
  if (priceStr == null) return null;
  var cleaned = String(priceStr).replace(/[^0-9.]/g, '');
  if (cleaned === '') return null;
  var n = parseFloat(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

async function logAuction(sessionId, result, skus, idemKey) {
  try {
    var data = await supabaseRpc('lensed_log_auction', {
      p_session_id: sessionId,
      p_result: result,
      p_skus: skus,
      p_idem_key: idemKey,
    });
    var row = Array.isArray(data) ? data[0] : data;
    console.log('[LENSED][BG] lensed_log_auction result:', row);
    diag('bind.rpc_ok', 'info', 'lensed_log_auction ok', { order: idemKey, item: row && row.item_id, status: row && row.status, replayed: row && row.replayed, total_cost_cents: row && row.total_cost_cents });
    return row;
  } catch (e) {
    console.error('[LENSED][BG] lensed_log_auction error:', e);
    diag('bind.rpc_error', 'error', 'lensed_log_auction failed', { order: idemKey, code: diagClassifyErr(e), msg: (e && e.message) || String(e) });
    return null;
  }
}

// Build the capture_events row — shared by upsertCaptureEvent and the unauth-queue
// flush replay (replayQueuedSale) so both write the identical shape.
function buildCaptureRow(sale, boundSkuId) {
  return {
    user_id: userId,
    order_id: sale.orderId,
    room_id: sale.roomId || currentRoomId,
    buyer_username: sale.buyerUsername || null,
    selling_price_cents: parsePriceToCents(sale.sellingPrice),
    product_name: sale.productName || null,
    platform_sku_ref: sale.platformSkuRef || null,
    tiktok_sku_id: sale.skuId || null,
    tiktok_product_id: sale.productId || null,
    item_image_url: sale.imageUrl || null,
    ordered_at: sale.orderedAtMs ? new Date(sale.orderedAtMs).toISOString() : null,
    is_payment_successful: sale.isPaymentSuccessful,
    order_status: sale.orderStatus,
    bound_sku_id: boundSkuId || null,
    raw_payload: sale,
  };
}

// Upsert the raw capture_events row. Returns { ok, ... } so the caller can tell the
// content script the truth (capture_events feeds P&L). Idempotent: on_conflict targets
// the real (user_id, order_id) unique index, so a re-sent/replayed order MERGES instead
// of raising 23505 (the empty-upsert bug that failed 135× during the replay storm).
async function upsertCaptureEvent(sale, boundSkuId) {
  if (!isAuthenticated()) { diag('capture.skip_unauth', 'warn', 'not authenticated — capture_events NOT written', { order: sale && sale.orderId }); return { ok: false, reason: 'not_authenticated' }; }
  var row = {
    user_id: userId,
    order_id: sale.orderId,
    room_id: sale.roomId || currentRoomId,
    buyer_username: sale.buyerUsername || null,
    selling_price_cents: parsePriceToCents(sale.sellingPrice),
    product_name: sale.productName || null,
    platform_sku_ref: sale.platformSkuRef || null,
    tiktok_sku_id: sale.skuId || null,
    tiktok_product_id: sale.productId || null,
    item_image_url: sale.imageUrl || null,
    ordered_at: sale.orderedAtMs ? new Date(sale.orderedAtMs).toISOString() : null,
    is_payment_successful: sale.isPaymentSuccessful,
    order_status: sale.orderStatus,
    bound_sku_id: boundSkuId || null,
    raw_payload: sale,
  };
  try {
    await supabaseUpsert('capture_events', row, 'user_id,order_id');
    console.log('[LENSED][BG] capture_events upserted:', sale.orderId);
    diag('capture.write', 'info', 'capture_events upserted', { order: sale.orderId, bound: !!boundSkuId });
    return { ok: true };
  } catch (e) {
    var d = diagHttpDetail(e);
    console.error('[LENSED][BG] capture_events upsert error:', e);
    // Full, diagnosable error — status + PostgREST code/message/hint/details (no "unknown").
    diag('capture.error', 'error', 'capture_events upsert failed', {
      order: sale.orderId, status: d.status || null, code: d.pgcode || diagClassifyErr(e),
      message: d.pgmsg || d.msg, hint: d.hint || null, details: (d.details || '').slice(0, 200) || null,
    });
    return { ok: false, reason: 'capture_write_failed', status: d.status || null, code: d.pgcode || diagClassifyErr(e), message: d.pgmsg || d.msg };
  }
}

// ─── Unauthenticated sale queue (persisted; flushed on sign-in) ───────
// When a sale is captured but we're not authenticated, we ENQUEUE it (persisted to
// chrome.storage.local) instead of discarding it. On auth return we flush in order to
// capture_events + lensed_log_auction. The popup/overlay shows a loud warning while the
// queue is non-empty and unauthenticated — because queue-and-flush only saves data if
// auth eventually returns; the warning is the safety net if it never does.
var SALE_QUEUE_MAX = 1000;
var saleQueue = [];          // [{ sale, stagedSkus, result, enqueuedAt }]
var saleQueueLoaded = false;
var flushingSaleQueue = false;

async function loadSaleQueue() {
  if (saleQueueLoaded) return;
  try {
    var d = await chrome.storage.local.get([SK_SALE_QUEUE]);
    if (Array.isArray(d[SK_SALE_QUEUE])) saleQueue = d[SK_SALE_QUEUE];
  } catch (_) {}
  saleQueueLoaded = true;
}

function persistSaleQueue() {
  try { var d = {}; d[SK_SALE_QUEUE] = saleQueue; chrome.storage.local.set(d); } catch (_) {}
}

async function enqueueSale(sale, stagedSkus, result) {
  await loadSaleQueue();
  // Dedup: the sale snapshot re-arrives every few seconds — don't pile duplicates of
  // the same (order, status). A status flip (not_sold→sold) is a distinct entry.
  for (var i = 0; i < saleQueue.length; i++) {
    if (saleQueue[i].sale && saleQueue[i].sale.orderId === sale.orderId && saleQueue[i].result === result) return;
  }
  saleQueue.push({ sale: sale, stagedSkus: stagedSkus || [], result: result, enqueuedAt: Date.now() });
  if (saleQueue.length > SALE_QUEUE_MAX) {
    var dropped = saleQueue.length - SALE_QUEUE_MAX;
    saleQueue.splice(0, dropped); // oldest-dropped
    console.warn('[LENSED][BG] sale queue over cap (' + SALE_QUEUE_MAX + ') — dropped ' + dropped + ' oldest queued sale(s)');
    diagCrit('queue.overflow', 'warn', 'sale queue overflow — oldest dropped', { dropped: dropped });
  }
  persistSaleQueue();
  console.warn('[LENSED][BG] sale QUEUED (unauthenticated) — ' + saleQueue.length + ' pending:', sale.orderId);
  diagCrit('queue.enqueue', 'warn', 'sale queued (unauthenticated)', { order: sale.orderId, queued: saleQueue.length });
  broadcastAuthStatus(); // refresh the overlay's loud "N queued" warning
}

// Replay one queued sale. Returns true when it is safely logged (or a confirmed dup) and
// may be dropped; false when the attempt failed transiently and it must stay for retry.
async function replayQueuedSale(item) {
  var sale = item && item.sale;
  if (!sale || !sale.orderId) return true; // malformed → drop
  // 1) capture_events — the realized price / audit row (the data that would be LOST).
  //    Idempotent on (user_id, order_id); a dup merges. A throw = transient → retry.
  try {
    await supabaseUpsert('capture_events', buildCaptureRow(sale, null), 'user_id,order_id');
  } catch (e) {
    var msg = String((e && e.message) || e);
    if (msg.indexOf('23505') >= 0 || msg.indexOf('409') >= 0) {
      // Already saved (e.g. via Order-API reconciliation) → treat as dup, drop from queue.
      console.log('[LENSED][BG] flush: capture already exists (dup), dropping:', sale.orderId);
    } else {
      console.warn('[LENSED][BG] flush: capture write failed — will retry:', sale.orderId, msg);
      return false;
    }
  }
  // 2) bind to an auction item (best-effort). The RPC is idempotent on (session, order).
  //    If it can't bind (no room/session/skus), the sale is still SAVED in capture_events
  //    (never lost) — same as the app's normal "captured only" state.
  try {
    if (item.stagedSkus && item.stagedSkus.length > 0 && sale.roomId) {
      // Resolve-DON'T-create on flush: a stale-queue flush must never mint a new 'live'
      // session row (that's how the e4b58b91 ghost appeared). Attach to the room's existing
      // session, or stay captured-only. The live-path bind still uses getOrCreateSession.
      var sessionId = await resolveSessionForFlush(sale.roomId);
      if (sessionId) {
        var byId = {};
        for (var i = 0; i < item.stagedSkus.length; i++) {
          var s = item.stagedSkus[i];
          var q = Math.max(1, Math.trunc(Number(s.qty) || 1));
          if (byId[s.id]) byId[s.id].qty += q; else byId[s.id] = { sku_id: s.id, qty: q };
        }
        var pSkus = Object.keys(byId).map(function (k) { return byId[k]; });
        await logAuction(sessionId, item.result, pSkus, sale.orderId);
      }
    }
  } catch (_) { /* best-effort; capture already saved so nothing is lost */ }
  return true;
}

async function flushSaleQueue() {
  await ensureAuthReady();
  if (!isAuthenticated()) return;
  await loadSaleQueue();
  if (saleQueue.length === 0 || flushingSaleQueue) return;
  flushingSaleQueue = true;
  var startCount = saleQueue.length;
  console.log('[LENSED][BG] flushing ' + startCount + ' queued sale(s)…');
  diagCrit('queue.flush_start', 'info', 'flushing queued sales', { count: startCount });
  try {
    // Process in order. Remove an item ONLY after it is confirmed logged/dup; a failed
    // attempt leaves it (and the rest) queued for the next flush.
    while (saleQueue.length > 0 && isAuthenticated()) {
      var ok = await replayQueuedSale(saleQueue[0]);
      if (!ok) { console.warn('[LENSED][BG] flush paused — leaving ' + saleQueue.length + ' queued for retry'); break; }
      saleQueue.shift();
      persistSaleQueue();
    }
  } finally {
    flushingSaleQueue = false;
    broadcastAuthStatus();
  }
  console.log('[LENSED][BG] flush done — ' + saleQueue.length + ' still queued');
  diagCrit('queue.flush_done', 'info', 'flush complete', { flushed: startCount - saleQueue.length, remaining: saleQueue.length });
}

// ─── Auto-bind: sale + staged SKUs → lensed_log_auction + capture_events

async function handleAutoBind(sale, stagedSkus) {
  if (!sale || !sale.orderId) return { ok: false, reason: 'no_order' };

  // A sale event can wake a cold worker; wait for the rehydrate so the
  // isAuthenticated() gates below don't skip logging on the first bind.
  await ensureAuthReady();

  // Status for this snapshot: a failed payment is not_sold, otherwise sold.
  // (This is exactly the p_result passed to lensed_log_auction below.)
  var result = sale.isPaymentSuccessful === false ? 'not_sold' : 'sold';

  // Dedup on order_id + status, NOT order_id alone. auction_result/get is a
  // cumulative snapshot, so an order whose payment is fixed within ~5 min
  // re-arrives with a CHANGED status (not_sold → sold). Same status as last
  // time → skip (no redundant RPC / spam). A status change falls through.
  var prevToken = loggedOrderStatus.get(sale.orderId);
  if (prevToken === result) {
    console.log('[LENSED][BG] order_id already logged with same status, skipping:', sale.orderId, result);
    diag('bind.skip_dup', 'info', 'duplicate order+status skipped', { order: sale.orderId, status: result });
    return { ok: true, skipped: true, reason: 'duplicate' };
  }
  loggedOrderStatus.set(sale.orderId, result);
  capOrderMaps();
  diag('bind.received', 'info', 'AUTO_BIND received', { order: sale.orderId, status: result, staged: (stagedSkus ? stagedSkus.length : 0), room: !!sale.roomId });

  // A flip = we've processed this order before, with a different status.
  var isFlip = prevToken !== undefined;
  var boundSkuId = null;
  var bound = false;         // did lensed_log_auction actually write/replay an auction row?
  var bindReason = null;     // why not bound (no_staged / no_session / rpc_failed / not_authenticated)

  if (isFlip && isAuthenticated() && loggedOrderSession.has(sale.orderId)) {
    // ── Status-flip transition (e.g. failed→paid) ───────────────────────────
    // We previously LOGGED a row for this order (we recorded its session). The
    // RPC's transition path decrements the ORIGINALLY-bound live_auction_item_skus
    // and ignores p_skus — so the current staged set is irrelevant. Fire the RPC
    // even when nothing is staged now. Use the ORIGINAL session so the RPC finds
    // the existing row (it matches on session_id + idem_key); pass the non-empty
    // placeholder only to satisfy the RPC's NO_SKUS guard.
    var flipSession = loggedOrderSession.get(sale.orderId);
    console.log('[LENSED][BG] status flip — re-calling RPC for transition:', sale.orderId, prevToken, '->', result);
    var flipRow = await logAuction(flipSession, result, TRANSITION_PLACEHOLDER_SKUS, sale.orderId);
    if (flipRow) { bound = true; } else { bindReason = 'rpc_failed'; loggedOrderStatus.delete(sale.orderId); }
  } else if (stagedSkus && stagedSkus.length > 0 && isAuthenticated()) {
    // ── Fresh bind: requires staged SKUs + a room-scoped session ───────────────
    // Pass the sale's own room so a stale in-memory/persisted session (different
    // room) is never reused for this order — the July-3 root cause.
    var sessionId = await getOrCreateSession(sale.roomId);
    if (sessionId) {
      // Aggregate by sku_id, summing per-pill qty (qty defaults to 1 if absent).
      var byId = {};
      for (var i = 0; i < stagedSkus.length; i++) {
        var s = stagedSkus[i];
        var q = Math.max(1, Math.trunc(Number(s.qty) || 1));
        if (byId[s.id]) byId[s.id].qty += q;
        else byId[s.id] = { sku_id: s.id, qty: q };
      }
      var pSkus = Object.keys(byId).map(function (k) { return byId[k]; });

      // `result` (computed above) is 'not_sold' for a failed payment — the RPC
      // then neither decrements inventory (decrement is gated on p_result='sold')
      // nor counts it toward sold totals/profit. On a later paid re-send the flip
      // branch above transitions it once (migration 027).
      diag('bind.session', 'info', 'room-scoped session resolved', { order: sale.orderId, session: diagRedactId(sessionId) });
      var logRow = await logAuction(sessionId, result, pSkus, sale.orderId);
      if (logRow) {
        // Only record success on an actual bind so a later flip can target it.
        loggedOrderSession.set(sale.orderId, sessionId);
        capOrderMaps();
        boundSkuId = stagedSkus.length === 1 ? stagedSkus[0].id : null;
        bound = true;
        diag('bind.ok', 'info', 'order bound to auction item', { order: sale.orderId, boundSkuId: boundSkuId || null });
      } else {
        // Bind failed (RPC error/empty). Don't fake success: roll back the status
        // dedup so an identical re-send RETRIES instead of being silently skipped,
        // and surface it (the order still lands in capture_events below).
        loggedOrderStatus.delete(sale.orderId);
        bindReason = 'rpc_failed';
        console.error('[LENSED][BG] BIND FAILED — order captured only (will retry on re-send):', sale.orderId, 'session', sessionId);
        diag('bind.failed', 'error', 'bind failed — order captured only', { order: sale.orderId, session: diagRedactId(sessionId) });
      }
    } else {
      // Staged SKUs existed but no room-scoped session could be resolved (e.g. room
      // unknown). Roll back dedup so a retry can bind once a room is known.
      loggedOrderStatus.delete(sale.orderId);
      bindReason = 'no_session';
      console.warn('[LENSED][BG] no room-scoped session — order captured only (will retry):', sale.orderId);
      diag('bind.no_session', 'warn', 'no room-scoped session — captured only', { order: sale.orderId, room: sale.roomId || null });
    }
  } else if (!isAuthenticated()) {
    // FIX A + truthful reporting: signed out, so we do NOT discard the sale — ENQUEUE it
    // (persisted to chrome.storage.local) so it survives an SW restart and flushes to
    // capture_events + lensed_log_auction on sign-in. We return early with a TRUTHFUL
    // result: ok:false (nothing is written to the DB yet — it's only locally queued) with
    // queued:true. The overlay's fail-loud "NOT SIGNED IN" banner tells the host until
    // auth returns. Never claims ok:true for a sale that isn't persisted.
    bindReason = 'not_authenticated';
    console.warn('[LENSED][BG] not authenticated — sale QUEUED for flush on sign-in:', sale.orderId);
    diag('bind.not_authenticated', 'warn', 'not authenticated — sale queued', { order: sale.orderId });
    await enqueueSale(sale, stagedSkus, result);
    return { ok: false, bound: false, captureWritten: false, partial: false, queued: true, reason: 'queued_unauthenticated', order: sale.orderId };
  } else {
    // Authenticated, a real new/changed order, but NOTHING was staged → the order is
    // captured raw and NOT bound to an auction item. Surface it (the overlay shows a
    // visible warning; this is the background-side diagnostic) instead of silently
    // dropping the SKU/COGS link — the July-3 captured-only failure mode.
    bindReason = 'no_staged';
    console.warn('[LENSED][BG] no staged SKUs — order captured only, NOT bound to an auction item:', sale.orderId);
    diag('bind.no_staged', 'warn', 'no staged SKUs — captured only', { order: sale.orderId });
  }

  // Always upsert to capture_events (raw revenue/audit row that P&L joins on).
  var cap = await upsertCaptureEvent(sale, boundSkuId);
  if (!cap.ok && cap.reason === 'capture_write_failed') {
    // One immediate idempotent retry (on_conflict=user_id,order_id makes re-upsert a
    // MERGE, never a second row) — clears transient blips. Does NOT touch inventory.
    cap = await upsertCaptureEvent(sale, boundSkuId);
  }
  if (!cap.ok) {
    // The capture row is missing — roll back the status dedup so a later cumulative
    // re-send retries the write. If the RPC already ran, its replay is idempotent on
    // (user_id, order_id) so a retry NEVER double-decrements inventory.
    loggedOrderStatus.delete(sale.orderId);
  }

  // Truthful result for the content script — never claim ok:true when the P&L-critical
  // capture write failed (the "silent green-but-broken" case).
  var partial = bound && !cap.ok;
  return {
    ok: !!cap.ok,
    bound: bound,
    captureWritten: !!cap.ok,
    partial: partial,
    reason: !cap.ok
      ? (partial ? 'capture_write_failed_after_rpc' : (cap.reason || 'capture_write_failed'))
      : (bound ? null : bindReason),
    code: cap.code || null,
    status: cap.status || null,
    order: sale.orderId,
  };
}

// ── [SCREENSHOT] Upload-first store (Storage + live_order_screenshots) ────────
// Content posts a captured JPEG (base64) via CAPTURE_STORE. We upload IMMEDIATELY
// to the private live-screenshots bucket, then upsert live_order_screenshots
// (unique user_id,image_id → idempotent). On success we keep NOTHING locally.
// IndexedDB is a FAILURE-ONLY retry queue (outbox): used when upload/upsert fails
// (offline, auth missing, retryable error), drained opportunistically (SW start,
// next capture, after any success, manual enable). Deleted on confirmed upload.
// Everything is async + guarded so it can never affect the core order flow.
var SHOT_BUCKET = 'live-screenshots';
var SHOT_TABLE = 'live_order_screenshots';
var SHOT_DB_NAME = 'lensed-screenshots';
var SHOT_DB_VERSION = 2;
var SHOT_OUTBOX_CAP = 2000; // pathological bound on the local retry queue

var _shotDbPromise = null;
function shotDb() {
  if (_shotDbPromise) return _shotDbPromise;
  _shotDbPromise = new Promise(function (resolve, reject) {
    var req = indexedDB.open(SHOT_DB_NAME, SHOT_DB_VERSION);
    req.onupgradeneeded = function () {
      var db = req.result;
      // Retry queue only. (v1 images/manifest stores, if present, are left unused
      // and get cleared on demand; upload-first never writes them.)
      if (!db.objectStoreNames.contains('outbox')) {
        db.createObjectStore('outbox', { keyPath: 'image_id' });
      }
      if (!db.objectStoreNames.contains('counters')) {
        db.createObjectStore('counters', { keyPath: 'session_id' });
      }
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
  return _shotDbPromise;
}

function idbReq(r) {
  return new Promise(function (resolve, reject) {
    r.onsuccess = function () { resolve(r.result); };
    r.onerror = function () { reject(r.error); };
  });
}

function base64ToBytes(base64) {
  var bin = atob(base64);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function newImageId() {
  return (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('img-' + Date.now() + '-' + Math.round(Math.random() * 1e9));
}

function shotObjectKey(uid, sessionId, imageId) {
  return uid + '/' + (sessionId || 'nosession') + '/' + imageId + '.jpg';
}

// ── Per-session counters (overlay status only) ───────────────────────
// The counters store's keyPath is session_id, but a no-live capture has a null
// session (manual_test / pre-session). IndexedDB rejects get/put/delete with a
// null/undefined key, so we derive a deterministic NON-EMPTY key. This is a LOCAL
// telemetry key only — the DB row keeps session_id null and the object path keeps
// /nosession/ (both unchanged).
function shotCounterKey(sessionId) {
  return (userId || 'nouser') + ':' + (sessionId || 'nosession');
}
function emptyShotCounter(sessionId) {
  return { session_id: shotCounterKey(sessionId), uploaded: 0, pending: 0, failed: 0, uploaded_bytes: 0, updated_at: Date.now() };
}
async function getShotCounter(db, sessionId) {
  var tx = db.transaction(['counters'], 'readonly');
  var row = await idbReq(tx.objectStore('counters').get(shotCounterKey(sessionId)));
  return row || emptyShotCounter(sessionId);
}
async function putShotCounter(db, c) {
  c.updated_at = Date.now();
  var tx = db.transaction(['counters'], 'readwrite');
  tx.objectStore('counters').put(c);
  return new Promise(function (resolve, reject) { tx.oncomplete = resolve; tx.onerror = function () { reject(tx.error); }; });
}

// ── The two network steps (Storage PUT, then metadata upsert) ────────
// Uses the user's Bearer token (supabaseHeaders). Returns {ok, retryable, status}.
async function uploadShotObject(objectKey, bytes) {
  var url = SUPABASE_URL + '/storage/v1/object/' + SHOT_BUCKET + '/' + objectKey;
  var headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: 'Bearer ' + (accessToken || SUPABASE_ANON_KEY),
    'Content-Type': 'image/jpeg',
    'x-upsert': 'true',
  };
  var res;
  try { res = await sbFetch(url, { method: 'POST', headers: headers, body: bytes }, FETCH_TIMEOUT_WRITE_MS, false); }
  catch (e) { return { ok: false, retryable: true, err: String(e && e.name || e) }; } // abort/network → retry
  if (res.status === 401) {
    diagCrit('http.401', 'warn', '401 from Supabase — attempting token refresh', null);
    var refreshed = await tryRefreshToken();
    if (refreshed) {
      headers.Authorization = 'Bearer ' + accessToken;
      try { res = await sbFetch(url, { method: 'POST', headers: headers, body: bytes }, FETCH_TIMEOUT_WRITE_MS, false); }
      catch (e2) { return { ok: false, retryable: true, err: String(e2 && e2.name || e2) }; }
    }
  }
  if (res.ok) return { ok: true };
  // 4xx (except 401 handled) are non-retryable client errors; 5xx retry later.
  return { ok: false, retryable: res.status >= 500 || res.status === 429, status: res.status };
}

async function upsertShotRow(row) {
  try {
    // merge-duplicates on (user_id,image_id) → idempotent replay.
    await supabaseUpsert(SHOT_TABLE, row, 'user_id,image_id');
    return { ok: true };
  } catch (e) {
    var msg = String(e && e.message || e);
    // Retry only transient/5xx; a constraint/permission error is terminal.
    var retryable = /\((5\d\d|429)\)/.test(msg) || /AbortError|TypeError|Failed to fetch/i.test(msg);
    return { ok: false, retryable: retryable, err: msg };
  }
}

// Build the DB row from a capture message + resolved identity.
function shotRowFrom(msg, imageId, objectKey, status) {
  return {
    user_id: userId,
    image_id: imageId,
    session_id: msg.sessionId || null,
    room_id: msg.roomId || null,
    order_id: msg.orderId || null,
    auction_attempt_id: msg.attemptId || null,
    screenshot_type: msg.screenshotType || (msg.kind === 'end' ? 'auction_end' : (msg.kind === 'manual' ? 'manual_test' : 'auction_end')),
    start_trigger: msg.startTrigger || null,
    tiktok_auction_id: msg.tiktokAuctionId || null,
    tiktok_round_id: msg.tiktokRoundId || null,
    object_key: objectKey,
    storage_provider: 'supabase',
    width: msg.width || null,
    height: msg.height || null,
    bytes: msg.bytes || null,
    staged_skus_snapshot: msg.stagedSnapshot || [],
    buyer_username: msg.buyer || null,
    price_cents: (typeof msg.priceCents === 'number') ? msg.priceCents : null,
    captured_at: msg.ts ? new Date(msg.ts).toISOString() : new Date().toISOString(),
    upload_status: status,
  };
}

async function enqueueOutbox(db, item) {
  var tx = db.transaction(['outbox'], 'readwrite');
  var store = tx.objectStore('outbox');
  store.put(item);
  // Bound the queue: drop the oldest if we somehow exceed the cap.
  var count = await idbReq(store.count());
  if (count > SHOT_OUTBOX_CAP) {
    var cur = await idbReq(store.openCursor());
    if (cur) { store.delete(cur.primaryKey); }
  }
  return new Promise(function (resolve, reject) { tx.oncomplete = resolve; tx.onerror = function () { reject(tx.error); }; });
}
async function deleteOutbox(db, imageId) {
  var tx = db.transaction(['outbox'], 'readwrite');
  tx.objectStore('outbox').delete(imageId);
  return new Promise(function (resolve, reject) { tx.oncomplete = resolve; tx.onerror = function () { reject(tx.error); }; });
}

// ── Main entry: upload-first, enqueue on failure ─────────────────────
async function handleCaptureStore(msg) {
  await ensureAuthReady();
  var db = await shotDb();
  var sessionId = msg.sessionId || currentSessionId || null;

  // [SCREENSHOT] SW is the session authority. For a LIVE shot (non-manual) with a
  // known room + auth + an actual frame, resolve/create the room-scoped session so
  // session_id and the object key are populated even when content's counterSessionId
  // lagged (first-sale race) or nothing was staged. getOrCreateSession is idempotent
  // + room-scoped (the same call the bind path uses) — it never forks a session, and
  // it broadcasts the resolved session so later shots have it too. manual_test
  // (kind='manual' / no roomId) stays /nosession/ with null session_id.
  if (!sessionId && msg.base64 && msg.kind !== 'manual' && msg.roomId && isAuthenticated()) {
    try { sessionId = await getOrCreateSession(msg.roomId); } catch (_) {}
  }
  msg.sessionId = sessionId; // shotRowFrom (row.session_id), object key, and outbox all read this

  var counter = await getShotCounter(db, sessionId);

  // A failed capture (content couldn't get a frame) — record + bail, no upload.
  if (msg.kind === 'failed' || !msg.base64) {
    counter.failed++;
    await putShotCounter(db, counter);
    return await buildStatus(sessionId);
  }

  // Idempotency: auction_end gets a DETERMINISTIC image_id derived from the order,
  // so a re-capture (reload / catch-up / status flip within the freshness window)
  // reuses the SAME object key (x-upsert overwrites in place — no orphan images) AND
  // the SAME row via the existing unique(user_id,image_id) upsert (no duplicate rows).
  // manual_test / auction_start keep a random id (unique per capture).
  var imageId = (msg.screenshotType === 'auction_end' && msg.orderId)
    ? ('end-' + msg.orderId)
    : newImageId();

  // No auth yet → straight to the retry queue (don't lose the shot).
  if (!isAuthenticated()) {
    await enqueueOutbox(db, { image_id: imageId, base64: msg.base64, storage_done: false, msg: msg, attempts: 0, last_error: 'not_authenticated', created_at: Date.now() });
    counter.pending++;
    await putShotCounter(db, counter);
    return await buildStatus(sessionId);
  }

  var objectKey = shotObjectKey(userId, sessionId, imageId);
  var bytes = base64ToBytes(msg.base64);

  // Step 1: upload the object.
  var up = await uploadShotObject(objectKey, bytes);
  if (!up.ok) {
    await enqueueOutbox(db, { image_id: imageId, base64: msg.base64, storage_done: false, msg: msg, attempts: 1, last_error: 'upload_' + (up.status || up.err || 'fail'), created_at: Date.now() });
    counter.pending++;
    await putShotCounter(db, counter);
    console.warn('[LENSED][BG] shot upload failed → queued:', up.status || up.err);
    return await buildStatus(sessionId);
  }

  // Step 2: upsert metadata (object already uploaded — idempotent key).
  var row = shotRowFrom(msg, imageId, objectKey, 'uploaded');
  var meta = await upsertShotRow(row);
  if (!meta.ok) {
    // Storage OK but metadata failed: queue WITHOUT the blob (object exists);
    // drain retries only the upsert. This is the "storage success, metadata fail" path.
    await enqueueOutbox(db, { image_id: imageId, base64: null, storage_done: true, row: row, attempts: 1, last_error: 'meta_' + meta.err, created_at: Date.now() });
    counter.pending++;
    await putShotCounter(db, counter);
    console.warn('[LENSED][BG] shot metadata upsert failed → queued (object uploaded):', meta.err);
    return await buildStatus(sessionId);
  }

  // Both confirmed → keep NOTHING locally.
  counter.uploaded++;
  counter.uploaded_bytes += bytes.length;
  await putShotCounter(db, counter);
  drainOutbox(); // opportunistic
  return await buildStatus(sessionId);
}

// ── Opportunistic drain of the retry queue ───────────────────────────
var _draining = false;
async function drainOutbox() {
  if (_draining) return;
  if (!isAuthenticated()) return;
  _draining = true;
  try {
    var db = await shotDb();
    var items = await idbReq(db.transaction(['outbox'], 'readonly').objectStore('outbox').getAll());
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      try {
        if (!it.storage_done) {
          var objectKey = shotObjectKey(userId, (it.msg && it.msg.sessionId) || null, it.image_id);
          var up = await uploadShotObject(objectKey, base64ToBytes(it.base64));
          if (!up.ok) { it.attempts = (it.attempts || 0) + 1; it.last_error = 'upload_' + (up.status || up.err); await enqueueOutbox(db, it); if (!up.retryable) {} continue; }
          it.storage_done = true;
          it.row = shotRowFrom(it.msg, it.image_id, objectKey, 'uploaded');
          it.base64 = null; // object uploaded; free the blob
        }
        var meta = await upsertShotRow(it.row);
        if (!meta.ok) { it.attempts = (it.attempts || 0) + 1; it.last_error = 'meta_' + meta.err; await enqueueOutbox(db, it); continue; }
        // Confirmed → remove from queue + tick counters.
        await deleteOutbox(db, it.image_id);
        var sid = it.row ? it.row.session_id : null;
        var c = await getShotCounter(db, sid);
        c.uploaded++; if (it.pending_counted !== false) c.pending = Math.max(0, c.pending - 1);
        await putShotCounter(db, c);
      } catch (e) { /* leave item queued for next drain */ }
    }
  } catch (_) {} finally {
    _draining = false;
  }
  try { broadcastShotStatus(await buildStatus(null)); } catch (_) {}
}

// Status for the overlay: this session's counters + queue depth.
async function buildStatus(sessionId) {
  try {
    var db = await shotDb();
    var c = await getShotCounter(db, sessionId);
    var queued = await idbReq(db.transaction(['outbox'], 'readonly').objectStore('outbox').count());
    return {
      sessionId: sessionId,
      uploaded: c.uploaded, pending: c.pending, failed: c.failed,
      uploadedBytes: c.uploaded_bytes, queued: queued,
    };
  } catch (_) {
    return { sessionId: sessionId, uploaded: 0, pending: 0, failed: 0, uploadedBytes: 0, queued: 0 };
  }
}

// Clear this session's local retry queue (does NOT touch uploaded rows in Lensed).
async function clearShots(sessionId) {
  var db = await shotDb();
  var items = await idbReq(db.transaction(['outbox'], 'readonly').objectStore('outbox').getAll());
  var tx = db.transaction(['outbox', 'counters'], 'readwrite');
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var sid = (it.row && it.row.session_id) || (it.msg && it.msg.sessionId) || null;
    if (sid === sessionId) tx.objectStore('outbox').delete(it.image_id);
  }
  tx.objectStore('counters').delete(shotCounterKey(sessionId));
  await new Promise(function (resolve, reject) { tx.oncomplete = resolve; tx.onerror = function () { reject(tx.error); }; });
  return await buildStatus(sessionId);
}

function broadcastShotStatus(status) {
  chrome.tabs.query({ url: 'https://shop.tiktok.com/*' }, function (tabs) {
    if (chrome.runtime.lastError) return;
    for (var i = 0; i < tabs.length; i++) {
      try { chrome.tabs.sendMessage(tabs[i].id, { type: 'SHOT_STATUS', status: status }).catch(function () {}); } catch (_) {}
    }
  });
}


// ─── Broadcast auth status to content scripts ────────────────────────

function broadcastAuthStatus() {
  chrome.tabs.query({ url: 'https://shop.tiktok.com/*' }, function (tabs) {
    if (chrome.runtime.lastError) return;
    for (var i = 0; i < tabs.length; i++) {
      try {
        chrome.tabs.sendMessage(tabs[i].id, {
          type: 'LENSED_AUTH_STATUS',
          authenticated: isAuthenticated(),
          userId: userId,
          queuedSales: (saleQueue && saleQueue.length) || 0,
        }).catch(function () {});
      } catch (_) {}
    }
  });
}

// Persist the resolved live-session identity so a reload / SW eviction resumes
// the same session (see SK_SESSION_ID). Best-effort; failures are non-fatal.
function persistSession() {
  try {
    var data = {};
    data[SK_SESSION_ID] = currentSessionId || null;
    data[SK_ROOM_ID] = sessionRoomId || null; // the room the session is scoped to
    data[SK_SESSION_TS] = currentSessionId ? Date.now() : null; // for the stale-cutoff on restore
    chrome.storage.local.set(data);
  } catch (_) {}
}

// Tell open TikTok tabs which live session they're attached to, so each overlay
// can scope its persisted order counter to this session id.
function broadcastSession(reason) {
  chrome.tabs.query({ url: 'https://shop.tiktok.com/*' }, function (tabs) {
    if (chrome.runtime.lastError) return;
    for (var i = 0; i < tabs.length; i++) {
      try {
        chrome.tabs.sendMessage(tabs[i].id, {
          type: 'LENSED_SESSION',
          sessionId: currentSessionId || null,
          roomId: currentRoomId || null,
          reason: reason || null,
        }).catch(function () {});
      } catch (_) {}
    }
  });
}

// ─── External message handler (from Lensed web app) ──────────────────

chrome.runtime.onMessageExternal.addListener(function (message, sender, sendResponse) {
  if (!message || message.type !== 'LENSED_AUTH') return;

  var at = message.accessToken;
  var rt = message.refreshToken;
  if (!at) {
    sendResponse({ ok: false, error: 'missing accessToken' });
    return;
  }

  // Resolve the incoming Lensed identity up front so we can compare it to the
  // PREVIOUSLY persisted user before persistAuth() overwrites the stored id.
  var incomingUserId = getUserIdFromToken(at);

  // Wait for the one-time startup rehydrate so a cold service worker has restored
  // the persisted session/identity before we decide to preserve vs. reset.
  ensureAuthReady()
    // Authoritative previous identity comes from STORAGE — the in-memory userId is
    // null after every MV3 service-worker restart until rehydrate runs.
    .then(function () { return chrome.storage.local.get(SK_USER_ID); })
    .then(function (prev) {
      var previousUserId = (prev && prev[SK_USER_ID]) || null;
      return persistAuth(at, rt || '').then(function () {
        // Same Lensed user + resolvable ids → a routine token refresh: preserve live
        // context. Otherwise (no known previous user, unresolvable incoming user, or a
        // genuine user switch) run the existing full user-switch reset.
        var identityChanged =
          !previousUserId || !incomingUserId || previousUserId !== incomingUserId;

        if (identityChanged) {
          var hadSession = !!currentSessionId, hadHost = !!selectedHostId;
          cachedSkus = null; // invalidate SKU cache for the new/unknown user
          currentSessionId = null; // re-resolve session for the new user
          currentRoomId = null;
          sessionRoomId = null;
          selectedHostId = null;      // a new user's live must not inherit the prior host
          hostAppliedForSession = null;
          // Drop the previous user's pinned session/room so the new user never resumes
          // it; broadcast the reset (with a reason) so overlays clear staged SKUs and
          // re-scope their counter.
          try { chrome.storage.local.remove([SK_SESSION_ID, SK_ROOM_ID, SK_SESSION_TS]); } catch (_) {}
          broadcastAuthStatus();
          broadcastSession('user_changed');
          console.log('[LENSED][BG] SESSION RESET', { reason: 'user_changed', source: 'LENSED_AUTH', hadSession: hadSession, hadHost: hadHost, hadStagedSku: null });
        } else {
          // Routine same-user refresh: tokens already rotated by persistAuth above.
          // Preserve session / room mapping / host / cached SKUs / dedup state; refresh
          // the content auth status but do NOT broadcast a null session or reset overlays.
          broadcastAuthStatus();
          console.log('[LENSED][BG] LENSED_AUTH: same-user token refresh — live state preserved');
        }
        sendResponse({ ok: true, userId: userId });
      });
    })
    .catch(function (e) {
      console.error('[LENSED][BG] LENSED_AUTH relay failed:', e);
      try { sendResponse({ ok: false, error: (e && e.message) || 'relay failed' }); } catch (_) {}
    });

  return true; // async sendResponse
});

// ─── Internal message handler (from content scripts) ─────────────────

// Best-effort session close when the live tab goes away. onRemoved needs no "tabs"
// permission (it still delivers the tabId). Only acts on the tracked live tab, and
// clears the in-memory session so a reconnect starts a fresh room-scoped session
// (the hot-path reuse at getOrCreateSession keys off in-memory state regardless of
// DB status, so it MUST be cleared here). The server auto-ender is the real backstop.
chrome.tabs.onRemoved.addListener(function (tabId) {
  if (liveTabId == null || tabId !== liveTabId) return;
  var sid = currentSessionId;
  liveTabId = null;
  currentSessionId = null;
  sessionRoomId = null;
  lastHeartbeatWriteTs = 0;
  try { persistSession(); } catch (_) {} // clears SK_SESSION_ID / SK_ROOM_ID
  if (sid) markSessionEndedOnTabClose(sid);
});

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || typeof message !== 'object') return;

  // ── Diagnostics channel (dev-only) ──
  if (message.type === 'DIAG_ENABLE') {
    diagEnabled = true;
    try { chrome.storage.local.set({ lensed_diag_enabled: true }); } catch (_) {}
    diag('diag.enable', 'info', 'diagnostics enabled', { v: EXT_VERSION });
    // Guarantee a background-origin "awake" event even when the SW was already
    // running at enable time (so it never cold-starts → no sw.start this life).
    diag('bg.awake', 'info', 'background service worker awake', { v: EXT_VERSION });
    try { sendResponse({ ok: true, count: diagRing.length }); } catch (_) {}
    return;
  }
  if (message.type === 'DIAG_EVENT') {
    // Receiving an event is itself proof diagnostics is on (content/inject only send
    // when dev-gated) — flip the flag so a cold-woken SW records immediately instead
    // of dropping events until the async flag-restore resolves.
    diagEnabled = true;
    if (message.event) diagPush(message.event);
    try { sendResponse({ ok: true, count: diagRing.length }); } catch (_) {}
    return;
  }
  if (message.type === 'DIAG_COUNT') {
    try { sendResponse({ count: diagRing.length, enabled: diagEnabled, v: EXT_VERSION }); } catch (_) {}
    return;
  }
  if (message.type === 'DIAG_EXPORT') {
    // Read the durable store and MERGE with the in-memory ring, so an export served
    // by a freshly-woken SW (whose async restore may not have run yet) still returns
    // everything that was persisted during the live.
    try {
      chrome.storage.local.get([DIAG_KEY], function (d) {
        var stored = (d && Array.isArray(d[DIAG_KEY])) ? d[DIAG_KEY] : [];
        var merged = diagMerge(stored, diagRing);
        diagRing = merged;
        try { sendResponse({ v: EXT_VERSION, build: DIAG_BUILD, commit: DIAG_BUILD_SHA, count: merged.length, events: merged }); } catch (_) {}
      });
    } catch (_) { try { sendResponse({ v: EXT_VERSION, count: diagRing.length, events: diagRing }); } catch (_) {} }
    return true;
  }
  if (message.type === 'DIAG_CLEAR') {
    diagRing = []; diagWriteRaw([]);
    try { sendResponse({ ok: true }); } catch (_) {}
    return;
  }

  if (message.type === 'TIKTOK_ROOM') {
    var newRoom = message.roomId;
    if (!newRoom || newRoom === currentRoomId) return;
    var oldRoom = currentRoomId;
    currentRoomId = newRoom;
    console.log('[LENSED][BG] new room detected:', newRoom, '(was', oldRoom + ')');

    if (currentSessionId && sessionRoomId && sessionRoomId !== newRoom) {
      // The pinned/restored session belongs to a DIFFERENT room → discard it so
      // this new live's orders never attach to the old live. A fresh room-scoped
      // session is resolved/created on the next bind.
      console.log('[LENSED][BG] session discarded — room mismatch: session', currentSessionId, 'was room', sessionRoomId, '→ new room', newRoom);
      currentSessionId = null;
      sessionRoomId = null;
      // A new live (new room) is a new show — never carry the prior live's host over.
      // The overlay re-selects the host (and warns while none is chosen) for this room.
      selectedHostId = null;
      hostAppliedForSession = null;
      // The discarded session's per-order dedup no longer applies to the new live;
      // clear both maps in lockstep (also bounds them across a multi-live worker).
      loggedOrderStatus.clear();
      loggedOrderSession.clear();
      persistSession();   // clears SK_SESSION_ID / SK_ROOM_ID
      broadcastSession('room_changed'); // sessionId=null → overlays clear staged SKUs + counter
      console.log('[LENSED][BG] SESSION RESET', { reason: 'room_changed', source: 'TIKTOK_ROOM', hadSession: true, hadHost: null, hadStagedSku: null });
    } else if (currentSessionId && sessionRoomId === newRoom) {
      // Restored session's room confirmed by the live page — safe to keep it.
      console.log('[LENSED][BG] session room confirmed:', currentSessionId, 'room', newRoom);
      broadcastSession();
    }
    // else: no session yet — nothing to rotate; a bind will create one for newRoom.
    return;
  }

  if (message.type === 'TIKTOK_HEARTBEAT') {
    // Tab-alive ping from the live content script. Remember which tab it is (for the
    // close-listener), resolve the room (message → background-detected → session-pinned),
    // then stamp last_seen_at. Does NOT require currentSessionId — a mid-live load never
    // set it, so heartbeatSession() resolves the session by room. Only a DEFINITE room
    // mismatch (in-memory session pinned to a different room) is skipped.
    if (sender && sender.tab && sender.tab.id != null) liveTabId = sender.tab.id;
    lastContentPingTs = Date.now(); // for the recovery alarm's ping-stall / backstop logic
    var hbRoom = message.roomId || currentRoomId || sessionRoomId || null;
    console.log('[LENSED][BG] TIKTOK_HEARTBEAT recv; msgRoom=' + message.roomId + ' currentRoomId=' + currentRoomId + ' sessionRoomId=' + sessionRoomId + ' currentSessionId=' + currentSessionId);
    var mismatch = currentSessionId && sessionRoomId && message.roomId && message.roomId !== sessionRoomId;
    if (!mismatch) heartbeatSession(hbRoom);
    return;
  }

  if (message.type === 'TIKTOK_ACCOUNT') {
    // Detected streaming channel/creator identity forwarded from content. Capture it
    // (console + storage + best-effort DB). Fire-and-forget; never blocks anything.
    if (sender && sender.tab && sender.tab.id != null) liveTabId = sender.tab.id;
    handleAccountDetected(message.account, message.roomId);
    return;
  }

  if (message.type === 'TIKTOK_SALE') {
    var sale = message.sale;
    if (!sale) return;
    if (sender && sender.tab && sender.tab.id != null) liveTabId = sender.tab.id;
    console.log('[LENSED][BG] sale received:', sale.orderId, sale.buyerUsername, sale.sellingPrice);
    return;
  }

  if (message.type === 'RESOLVE_SKU') {
    // resolveSkuByNumber returns { sku, status }; forward it verbatim so the
    // overlay can tell a genuine miss from a not-yet-authenticated worker.
    resolveSkuByNumber(message.skuNumber).then(function (result) {
      diag('sku.lookup', (result && result.sku) ? 'info' : 'warn', 'lookup ' + (result && result.status),
        { status: result && result.status, sku_number: result && result.sku && result.sku.sku_number });
      sendResponse(result);
    }).catch(function (e) {
      diag('sku.lookup', 'error', 'lookup threw', { code: diagClassifyErr(e) });
      sendResponse({ sku: null, status: 'error' });
    });
    return true;
  }

  if (message.type === 'AUTO_BIND') {
    handleAutoBind(message.sale, message.stagedSkus).then(function (res) {
      // Reply the TRUTHFUL result — ok:false when the capture_events write failed even
      // if lensed_log_auction succeeded (partial:true), so the content script never
      // reports success on a P&L-breaking failure.
      sendResponse(res || { ok: true });
    }).catch(function (err) {
      console.error('[LENSED][BG] auto-bind error:', err);
      diag('bind.exception', 'error', 'handleAutoBind threw', { order: message.sale && message.sale.orderId, msg: (err && err.message) || String(err) });
      sendResponse({ ok: false, bound: false, reason: 'exception', error: err.message });
    });
    return true;
  }

  if (message.type === 'FETCH_SKUS') {
    fetchAllSkus().then(function (skus) {
      sendResponse({ skus: skus });
    }).catch(function () {
      sendResponse({ skus: [] });
    });
    return true;
  }

  if (message.type === 'FETCH_HOSTS') {
    // Active employees for the overlay host dropdown (roster = people, not the account).
    fetchActiveHosts().then(function (hosts) {
      sendResponse({ hosts: hosts });
    }).catch(function () {
      sendResponse({ hosts: [] });
    });
    return true;
  }

  if (message.type === 'SET_SESSION_HOST') {
    // Operator picked (or re-asserted after reload) the host running this live.
    try {
      sendResponse(setSelectedHost(message.hostId));
    } catch (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    }
    return true;
  }

  if (message.type === 'CHECK_ORDER_LOGGED') {
    // "Has this order been logged at all?" — independent of its status.
    sendResponse({ logged: loggedOrderStatus.has(message.orderId) });
    return true;
  }

  if (message.type === 'GET_AUTH_STATUS') {
    // Wait for the startup rehydrate so a cold worker doesn't report a false
    // "Not connected" on the overlay's first paint.
    ensureAuthReady().then(function () {
      return loadSaleQueue().then(function () {
        sendResponse({
          authenticated: isAuthenticated(),
          userId: userId,
          sessionId: currentSessionId || null,
          roomId: currentRoomId || null,
          queuedSales: saleQueue.length,
        });
      });
    }).catch(function () {
      try { sendResponse({ authenticated: false, userId: null, sessionId: null, roomId: null }); } catch (_) {}
    });
    return true;
  }

  // [SCREENSHOT] Store one captured frame (or a failure/capped marker) locally.
  if (message.type === 'CAPTURE_STORE') {
    handleCaptureStore(message).then(function (status) {
      broadcastShotStatus(status);
      try { sendResponse({ ok: true, status: status }); } catch (_) {}
    }).catch(function (e) {
      console.error('[LENSED][BG] handleCaptureStore error:', e);
      try { sendResponse({ ok: false, error: String(e && e.message || e) }); } catch (_) {}
    });
    return true;
  }

  if (message.type === 'GET_SHOT_STATUS') {
    // Manual enable / overlay refresh — also a drain opportunity.
    try { drainOutbox(); } catch (_) {}
    buildStatus(message.sessionId || null).then(function (status) {
      try { sendResponse({ ok: true, status: status }); } catch (_) {}
    }).catch(function () {
      try { sendResponse({ ok: false }); } catch (_) {}
    });
    return true;
  }

  if (message.type === 'CLEAR_SHOTS') {
    clearShots(message.sessionId || null).then(function (status) {
      broadcastShotStatus(status);
      try { sendResponse({ ok: true, status: status }); } catch (_) {}
    }).catch(function (e) {
      try { sendResponse({ ok: false, error: String(e && e.message || e) }); } catch (_) {}
    });
    return true;
  }
});

// ─── Service worker startup: rehydrate auth from storage ─────────────
// Capture the promise so auth-dependent handlers (resolveSkuByNumber,
// fetchAllSkus, handleAutoBind, GET_AUTH_STATUS) can await it via
// ensureAuthReady() — closing the cold-start race that made the first scan
// falsely report "SKU not found".
authReadyPromise = rehydrateAuth().then(function () {
  broadcastAuthStatus();
  // [SCREENSHOT] Opportunistic drain of any queued failed uploads on SW start.
  try { drainOutbox(); } catch (_) {}
  // Drain any sales captured while signed out on a prior (evicted) worker life.
  try { flushSaleQueue(); } catch (_) {}
}).catch(function (e) {
  // ensureAuthReady() must always settle so no handler hangs on a rejected gate.
  console.error('[LENSED][BG] startup rehydrate failed:', e);
});

console.log('[LENSED][BG] service worker started');

// Diagnostics: restore the enabled flag + prior ring on every cold start. A
// non-empty restored ring means the SW was evicted and restarted mid-live, which
// is itself a signal worth recording (sw.start restart=true).
try {
  chrome.storage.local.get([DIAG_FLAG, DIAG_KEY, SK_SESSION_ID, SK_SESSION_TS], function (d) {
    if (chrome.runtime.lastError || !d) return;
    if (d[DIAG_FLAG]) diagEnabled = true;
    var stored = Array.isArray(d[DIAG_KEY]) ? d[DIAG_KEY] : [];
    // MERGE (not overwrite): events may already have been recorded during the async
    // gap between SW start and this callback — keep them alongside the restored ring.
    if (stored.length) diagRing = diagMerge(stored, diagRing);
    // Gap since the last recorded event: a long gap while a live session was pinned means
    // the SW was SUSPENDED/EVICTED mid-live (no crash log) — the worker-lifecycle signature.
    var lastTs = stored.length ? (stored[stored.length - 1].ts || 0) : 0;
    var gapMs = lastTs ? (Date.now() - lastTs) : null;
    var livePinned = !!d[SK_SESSION_ID];
    // ALWAYS-ON: this is the primary discriminator for suspension vs auth-death next time.
    diagCrit('sw.start', 'info', 'service worker awake', {
      restart: stored.length > 0, priorEvents: stored.length,
      gapMsSinceLastEvent: gapMs, livePinned: livePinned, v: EXT_VERSION,
    });
  });
} catch (_) {}

// ─── Recovery alarm: the SW's own wake source (self-healing) ─────────
// MV3 has no self-timer and this ext is woken only by content-script pings. When pings
// stop, nothing refreshed/flushed/heartbeated until a manual re-sign-in. A ~60s alarm
// (chrome.alarms survives SW suspension — it re-wakes the worker) gives the SW its own
// tick to proactively refresh, flush the queue, and heartbeat — no human needed. Reuses
// the existing tryRefreshToken / flushSaleQueue / heartbeatSession.
try {
  chrome.alarms.create(RECOVERY_ALARM, { periodInMinutes: 1 }); // MV3 min period; ~60s cadence
} catch (_) {}
if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener(function (alarm) {
    if (!alarm || alarm.name !== RECOVERY_ALARM) return;
    runRecoveryTick();
  });
}
async function runRecoveryTick() {
  try {
    await ensureAuthReady();
    var room = sessionRoomId || currentRoomId || null;
    var pinned = !!(currentSessionId && room);
    // Idle ticks (no live pinned) are gated/verbose only — keeps the always-on ring signal-dense.
    if (!pinned) { diag('recovery.idle', 'info', 'recovery tick — no live pinned', null); return; }

    // (a) Proactive refresh: don't wait for a 401 that never comes because no fetch is firing.
    if (accessToken && refreshToken && isTokenExpired(accessToken, NEAR_EXPIRY_BUF_SEC)) {
      diagCrit('recovery.refresh', 'info', 'proactive refresh (token near-expiry)', null);
      await tryRefreshToken();
    }
    // (b) Flush any buffered sales the moment auth is usable — no manual re-sign-in needed.
    if (isAuthenticated() && saleQueue.length > 0) {
      diagCrit('recovery.flush', 'info', 'recovery flushing queued sales', { queued: saleQueue.length });
      try { await flushSaleQueue(); } catch (_) {}
    }
    // (c) Bounded heartbeat backstop: if content pings have stalled but we're still within
    //     the backstop window, keep last_seen_at fresh so a transient stall doesn't read as
    //     "dead". Past HEARTBEAT_BACKSTOP_MAX_MS of silence, STOP — a truly-dead tab must not
    //     zombie-heartbeat; let the server auto-ender reap the session.
    if (isAuthenticated() && lastContentPingTs > 0) {
      var pingAge = Date.now() - lastContentPingTs;
      if (pingAge > CONTENT_PING_STALL_MS) {
        if (pingAge <= HEARTBEAT_BACKSTOP_MAX_MS) {
          diagCrit('content.ping_stall', 'warn', 'content ping stalled — alarm heartbeat backstop', { ageMs: pingAge });
          try { await heartbeatSession(room); } catch (_) {}
        } else {
          diagCrit('content.ping_stall', 'warn', 'content ping stalled past backstop — releasing (no zombie heartbeat)', { ageMs: pingAge });
        }
      }
    }
  } catch (e) {
    diagCrit('recovery.error', 'error', 'recovery tick threw', { msg: String((e && e.message) || e) });
  }
}
