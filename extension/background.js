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
  var url = SUPABASE_URL + '/rest/v1/' + table;
  var headers = supabaseHeaders();
  headers['Prefer'] = 'resolution=merge-duplicates,return=representation';
  // allowRetry=true: merge-duplicates makes a re-send idempotent (same conflict key).
  var res = await sbFetch(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(body),
  }, FETCH_TIMEOUT_WRITE_MS, true);
  if (res.status === 401) {
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
        var refreshed = await tryRefreshToken();
        if (!refreshed) {
          console.warn('[LENSED][BG] rehydrate refresh failed — clearing auth');
          accessToken = null;
          refreshToken = null;
          userId = null;
        }
      } else {
        console.log('[LENSED][BG] auth rehydrated, user_id:', userId);
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
      return false;
    }
    var json = await res.json();
    if (json.access_token && json.refresh_token) {
      await persistAuth(json.access_token, json.refresh_token);
      console.log('[LENSED][BG] token refreshed successfully');
      return true;
    }
    return false;
  } catch (e) {
    console.error('[LENSED][BG] token refresh error:', e);
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
  await chrome.storage.local.remove([SK_ACCESS_TOKEN, SK_REFRESH_TOKEN, SK_USER_ID, SK_SESSION_ID, SK_ROOM_ID, SK_SESSION_TS]);
  console.log('[LENSED][BG] auth cleared');
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

// Resolve (or create) the live session for a specific tiktok room. `roomId` is the
// authoritative room for THIS order (passed from the sale payload); it defends
// against a stale in-memory/persisted session even before a TIKTOK_ROOM arrives.
async function getOrCreateSession(roomId) {
  var room = roomId || currentRoomId || null;

  // Reuse the in-memory session ONLY when it is scoped to the SAME room. A session
  // pinned to a different room (e.g. a restored one from a previous live) is never
  // reused for a new room's orders.
  if (currentSessionId && sessionRoomId && room && sessionRoomId === room) {
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
      persistSession();
      broadcastSession();
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
      persistSession();
      broadcastSession();
      return currentSessionId;
    }
    console.error('[LENSED][BG] session create returned empty');
    return null;
  } catch (e) {
    console.error('[LENSED][BG] session get-or-create error:', e);
    return null;
  }
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
    return row;
  } catch (e) {
    console.error('[LENSED][BG] lensed_log_auction error:', e);
    return null;
  }
}

async function upsertCaptureEvent(sale, boundSkuId) {
  if (!isAuthenticated()) return;
  try {
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
    await supabaseUpsert('capture_events', row);
    console.log('[LENSED][BG] capture_events upserted:', sale.orderId);
  } catch (e) {
    console.error('[LENSED][BG] capture_events upsert error:', e);
  }
}

// ─── Auto-bind: sale + staged SKUs → lensed_log_auction + capture_events

async function handleAutoBind(sale, stagedSkus) {
  if (!sale || !sale.orderId) return;

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
    return;
  }
  loggedOrderStatus.set(sale.orderId, result);
  capOrderMaps();

  // A flip = we've processed this order before, with a different status.
  var isFlip = prevToken !== undefined;
  var boundSkuId = null;

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
    await logAuction(flipSession, result, TRANSITION_PLACEHOLDER_SKUS, sale.orderId);
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
      var logRow = await logAuction(sessionId, result, pSkus, sale.orderId);
      if (logRow) {
        // Only record success on an actual bind so a later flip can target it.
        loggedOrderSession.set(sale.orderId, sessionId);
        capOrderMaps();
        boundSkuId = stagedSkus.length === 1 ? stagedSkus[0].id : null;
      } else {
        // Bind failed (RPC error/empty). Don't fake success: roll back the status
        // dedup so an identical re-send RETRIES instead of being silently skipped,
        // and surface it (the order still lands in capture_events below).
        loggedOrderStatus.delete(sale.orderId);
        console.error('[LENSED][BG] BIND FAILED — order captured only (will retry on re-send):', sale.orderId, 'session', sessionId);
      }
    } else {
      // Staged SKUs existed but no room-scoped session could be resolved (e.g. room
      // unknown). Roll back dedup so a retry can bind once a room is known.
      loggedOrderStatus.delete(sale.orderId);
      console.warn('[LENSED][BG] no room-scoped session — order captured only (will retry):', sale.orderId);
    }
  } else if (!isAuthenticated()) {
    console.warn('[LENSED][BG] not authenticated — sale captured but not logged to lensed_log_auction:', sale.orderId);
  } else {
    // Authenticated, a real new/changed order, but NOTHING was staged → the order is
    // captured raw and NOT bound to an auction item. Surface it (the overlay shows a
    // visible warning; this is the background-side diagnostic) instead of silently
    // dropping the SKU/COGS link — the July-3 captured-only failure mode.
    console.warn('[LENSED][BG] no staged SKUs — order captured only, NOT bound to an auction item:', sale.orderId);
  }

  // Always upsert to capture_events (raw audit log)
  await upsertCaptureEvent(sale, boundSkuId);
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
function broadcastSession() {
  chrome.tabs.query({ url: 'https://shop.tiktok.com/*' }, function (tabs) {
    if (chrome.runtime.lastError) return;
    for (var i = 0; i < tabs.length; i++) {
      try {
        chrome.tabs.sendMessage(tabs[i].id, {
          type: 'LENSED_SESSION',
          sessionId: currentSessionId || null,
          roomId: currentRoomId || null,
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

  persistAuth(at, rt || '').then(function () {
    cachedSkus = null; // invalidate SKU cache for new user
    currentSessionId = null; // re-resolve session for new user
    currentRoomId = null;
    sessionRoomId = null;
    // Drop the previous user's pinned session/room so the new user never resumes
    // it; broadcast the reset so overlays clear staged SKUs and re-scope their counter.
    try { chrome.storage.local.remove([SK_SESSION_ID, SK_ROOM_ID, SK_SESSION_TS]); } catch (_) {}
    broadcastAuthStatus();
    broadcastSession();
    sendResponse({ ok: true, userId: userId });
  });

  return true; // async sendResponse
});

// ─── Internal message handler (from content scripts) ─────────────────

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || typeof message !== 'object') return;

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
      // The discarded session's per-order dedup no longer applies to the new live;
      // clear both maps in lockstep (also bounds them across a multi-live worker).
      loggedOrderStatus.clear();
      loggedOrderSession.clear();
      persistSession();   // clears SK_SESSION_ID / SK_ROOM_ID
      broadcastSession(); // sessionId=null → overlays clear staged SKUs + counter
    } else if (currentSessionId && sessionRoomId === newRoom) {
      // Restored session's room confirmed by the live page — safe to keep it.
      console.log('[LENSED][BG] session room confirmed:', currentSessionId, 'room', newRoom);
      broadcastSession();
    }
    // else: no session yet — nothing to rotate; a bind will create one for newRoom.
    return;
  }

  if (message.type === 'TIKTOK_SALE') {
    var sale = message.sale;
    if (!sale) return;
    console.log('[LENSED][BG] sale received:', sale.orderId, sale.buyerUsername, sale.sellingPrice);
    return;
  }

  if (message.type === 'RESOLVE_SKU') {
    // resolveSkuByNumber returns { sku, status }; forward it verbatim so the
    // overlay can tell a genuine miss from a not-yet-authenticated worker.
    resolveSkuByNumber(message.skuNumber).then(function (result) {
      sendResponse(result);
    }).catch(function () {
      sendResponse({ sku: null, status: 'error' });
    });
    return true;
  }

  if (message.type === 'AUTO_BIND') {
    handleAutoBind(message.sale, message.stagedSkus).then(function () {
      sendResponse({ ok: true });
    }).catch(function (err) {
      console.error('[LENSED][BG] auto-bind error:', err);
      sendResponse({ ok: false, error: err.message });
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

  if (message.type === 'CHECK_ORDER_LOGGED') {
    // "Has this order been logged at all?" — independent of its status.
    sendResponse({ logged: loggedOrderStatus.has(message.orderId) });
    return true;
  }

  if (message.type === 'GET_AUTH_STATUS') {
    // Wait for the startup rehydrate so a cold worker doesn't report a false
    // "Not connected" on the overlay's first paint.
    ensureAuthReady().then(function () {
      sendResponse({
        authenticated: isAuthenticated(),
        userId: userId,
        sessionId: currentSessionId || null,
        roomId: currentRoomId || null,
      });
    }).catch(function () {
      try { sendResponse({ authenticated: false, userId: null, sessionId: null, roomId: null }); } catch (_) {}
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
}).catch(function (e) {
  // ensureAuthReady() must always settle so no handler hangs on a rejected gate.
  console.error('[LENSED][BG] startup rehydrate failed:', e);
});

console.log('[LENSED][BG] service worker started');
