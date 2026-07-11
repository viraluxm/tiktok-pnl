/**
 * Lensed tiktok-inject.js — runs in the MAIN world on shop.tiktok.com.
 *
 * Patches fetch and XHR to observe (never modify) responses from TikTok's
 * auction_result/get endpoint. Parses the cumulative order array, dedupes
 * by order_id (in-memory Set), normalizes each order, and relays to the
 * content script (tiktok-content.js) via window.postMessage.
 *
 * room_id is extracted from the ?room_id= query string on streamer_desktop
 * API calls — NOT from URL path markers.
 *
 * Host/account identity is best-effort: a few room lifecycle endpoints (room/status,
 * room/info, room/enter) are inspected for the room OWNER/ANCHOR object and relayed
 * as 'lensed-tiktok-account'. FAIL-OPEN — nothing found means nothing relayed. The
 * JSON paths are UNVERIFIED (see [account detection] below).
 */
(function () {
  'use strict';

  // Duplicate-injection guard (MAIN world). A second injection would double-wrap
  // fetch/XHR — every response then relayed twice. Bail if already installed.
  if (window.__lensedInjected) return;
  window.__lensedInjected = true;

  const SALE_URL_MARKER = 'auction_result/get';

  // ── [account detection] endpoint markers ────────────────────────────
  // Room lifecycle endpoints whose responses are inspected (read-only) for the room
  // OWNER/ANCHOR identity — on the host's own desktop the room owner IS the logged-in
  // host. Path-anchored (not a loose substring) so lookalikes like `multi_room/status`
  // are not matched, and `start_auction` is deliberately excluded (it carries the
  // BUYER/bidder, never the host). Replaces the earlier full-body SPIKE logging.
  const IDENTITY_URL_RE = /\/room\/(status|info|enter)(?:[/?]|$)/;

  function matchIdentity(urlLower) {
    const m = urlLower.match(IDENTITY_URL_RE);
    return m ? ('room/' + m[1]) : null;
  }

  // Dev logging (opt-in, no rebuild): set `window.__LENSED_DEV__ = true` or
  // localStorage 'lensed_dev' = '1' in the page console to log which identity
  // fields were found — and, when none were, a REDACTED structural sketch (keys
  // only, no values) so the true JSON paths can be mapped on a live page. Full raw
  // bodies stay OFF unless the louder `window.__LENSED_DEV_RAW__` / localStorage
  // 'lensed_dev_raw' is set (they can contain PII/tokens).
  function isDev() {
    try {
      return window.__LENSED_DEV__ === true ||
        (window.localStorage && window.localStorage.getItem('lensed_dev') === '1');
    } catch (_) { return false; }
  }
  function isDevRaw() {
    try {
      return window.__LENSED_DEV_RAW__ === true ||
        (window.localStorage && window.localStorage.getItem('lensed_dev_raw') === '1');
    } catch (_) { return false; }
  }

  // ── Diagnostics relay (dev-only flight recorder) ───────────────────
  // MAIN world has no chrome.* — postMessage diagnostic events to the content
  // script, which forwards them to the SW ring buffer. Redacted only: no raw
  // payloads, no tokens. No-op unless lensed_dev / lensed_diagnostics is set, and
  // every call is try-wrapped so logging can never affect sniffing/relay.
  function diagOn() {
    try { return isDev() || (window.localStorage && window.localStorage.getItem('lensed_diagnostics') === '1'); } catch (_) { return false; }
  }
  function diag(type, sev, msg, meta) {
    if (!diagOn()) return;
    try { window.postMessage({ source: 'lensed-diag', event: { ts: Date.now(), comp: 'inject', type: type, sev: sev || 'info', msg: msg || '', meta: meta || null } }, window.location.origin); } catch (_) {}
  }
  try { diag('inject.load', 'info', 'injected script loaded', { path: (function () { try { return location.pathname; } catch (_) { return null; } })() }); } catch (_) {}

  // In-memory dedup — resets on navigation/reload. Sufficient for Phase 1;
  // durable dedup lives in the service worker + Postgres ON CONFLICT later.
  // Keyed by order_id → last-seen payment token so a payment-status FLIP
  // (e.g. failed→paid on auction_result/get's cumulative snapshot) re-relays,
  // while an identical re-send (same order_id + same status) stays suppressed.
  const seenOrderStatus = new Map();
  // Pathological-safety cap so a very long live can't grow this without bound. An
  // evicted-then-re-relayed order is independently de-duped downstream (content
  // boundOrderStatus + background loggedOrderStatus + RPC idempotency on order_id),
  // so eviction never double-counts or double-binds. NOT cleared per-room here — this
  // MAIN-world script cannot see the resolved session id, and clearing mid-live while
  // the content script still holds the order would cause an out-of-order re-relay.
  const SEEN_ORDER_CAP = 5000;

  // Payment token mirrors the downstream sold/not_sold split: a failed payment
  // is 'failed', everything else (paid / unknown / null) is 'ok'.
  function paymentToken(order) {
    return order && order.is_payment_successful === false ? 'failed' : 'ok';
  }

  let lastRoomId = null;

  // ── Relay helpers ──────────────────────────────────────────────────
  function relaySale(sale) {
    diag('sale.relay', 'info', 'sale relayed to content', { order: sale && sale.orderId, status: sale && (sale.isPaymentSuccessful === false ? 'failed' : 'ok') });
    window.postMessage({ source: 'lensed-tiktok-sale', sale }, window.location.origin);
  }

  function relayRoom(roomId) {
    if (!roomId || roomId === lastRoomId) return;
    lastRoomId = roomId;
    console.log('[LENSED][TT] room_id detected:', roomId);
    diag('room.detected', 'info', 'room_id detected', { room: roomId, source: 'auction_url' });
    window.postMessage({ source: 'lensed-tiktok-room', roomId }, window.location.origin);
  }

  // ── [account detection] host/anchor identity ────────────────────────
  // Best-effort + UNVERIFIED: the JSON paths/field names below are hypotheses from
  // TikTok's known webcast API shapes and have NOT been confirmed against a real
  // shop.tiktok.com streamer-desktop response. If nothing matches we relay nothing
  // (the visible-dashboard label in tiktok-content.js is the confirmed fallback).
  // Display + logging only — the relayed identity is not used for any session or
  // Supabase-write decision. Use dev logging (isDev) to confirm the true fields.
  let lastAccountKey = null;

  function firstString(obj, keys) {
    for (let i = 0; i < keys.length; i++) {
      let v = obj[keys[i]];
      if (typeof v === 'number' && isFinite(v)) v = String(v);
      if (typeof v === 'string' && v.trim() !== '') return v.trim();
    }
    return null;
  }

  const SECUID_KEYS = ['sec_uid', 'secUid'];
  // User-specific id fields first; the generic 'id'/'id_str' are last-resort fallbacks
  // (in an owner/anchor object they ARE the user id, but preferring explicit fields
  // avoids grabbing a wrapper's generic id).
  const UID_KEYS = ['user_id', 'owner_user_id', 'anchor_id', 'uid', 'id_str', 'id', 'ownerUserId', 'anchorId'];
  const HANDLE_KEYS = ['unique_id', 'uniqueId', 'display_id', 'displayId', 'handle'];
  const NICK_KEYS = ['nickname', 'nick_name', 'nickName'];

  // Pull an identity from a SINGLE object (no recursion). null unless a field hits.
  function identityFromObj(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const secUid = firstString(obj, SECUID_KEYS);
    const accountId = firstString(obj, UID_KEYS);
    const handle = firstString(obj, HANDLE_KEYS);
    const nickname = firstString(obj, NICK_KEYS);
    if (!secUid && !accountId && !handle) return null;
    return { secUid: secUid, accountId: accountId, handle: handle, nickname: nickname };
  }

  // A strong (confident) identity: a stable sec_uid, or a handle+nickname pair. A
  // bare numeric id is NOT strong alone (could be a room/product id) — only trusted
  // when read from an explicit owner/anchor path below.
  function isStrongIdentity(id) {
    return !!(id && (id.secUid || (id.handle && id.nickname)));
  }

  // Bounded breadth-first scan for an owner-shaped object (defensive against path
  // drift). Only objects reached THROUGH a host-semantic key (owner/anchor/host/
  // creator/streamer, or a descendant of one) are eligible — so a buyer/viewer/guest
  // object elsewhere in the tree is never mistaken for the host. Capped in nodes+depth.
  const HOST_KEY_RE = /owner|anchor|host|creator|streamer/i;
  function deepScanIdentity(root, maxDepth) {
    const queue = [{ o: root, d: 0, host: false }];
    let scanned = 0;
    while (queue.length && scanned < 500) {
      const node = queue.shift();
      scanned++;
      if (!node.o || typeof node.o !== 'object') continue;
      if (node.host) {
        const id = identityFromObj(node.o);
        if (isStrongIdentity(id)) return id;
      }
      if (node.d < maxDepth) {
        const keys = Object.keys(node.o);
        for (let i = 0; i < keys.length; i++) {
          const v = node.o[keys[i]];
          if (v && typeof v === 'object') {
            queue.push({ o: v, d: node.d + 1, host: node.host || HOST_KEY_RE.test(keys[i]) });
          }
        }
      }
    }
    return null;
  }

  // Extract the host identity from a lifecycle response. Explicit owner/anchor
  // paths first (trusted → a bare id is acceptable there), then a strong deep-scan.
  function extractAccountIdentity(json) {
    if (!json || typeof json !== 'object') return null;
    const data = (json.data && typeof json.data === 'object') ? json.data : null;
    const room = (json.room && typeof json.room === 'object') ? json.room
      : (data && data.room && typeof data.room === 'object') ? data.room : null;
    const candidates = [
      room && room.owner, data && data.owner, json.owner,
      room && room.anchor, data && data.anchor, json.anchor,
      data && data.anchor_info, json.anchor_info,
      data && data.owner_user_info, json.owner_user_info,
    ];
    for (let i = 0; i < candidates.length; i++) {
      const id = identityFromObj(candidates[i]);
      if (id) return id; // an explicit owner/anchor path is trusted
    }
    return deepScanIdentity(json, 4);
  }

  function accountKeyOf(id) {
    if (!id) return null;
    if (id.secUid) return 's:' + id.secUid;
    if (id.accountId) return 'i:' + id.accountId;
    if (id.handle) return 'h:' + id.handle.toLowerCase();
    return null;
  }

  // Keys-only structural sketch for dev logging (never values → no PII leak).
  function sketchKeys(json) {
    try {
      const out = { top: Object.keys(json).slice(0, 40) };
      if (json.data && typeof json.data === 'object') out.data = Object.keys(json.data).slice(0, 40);
      const room = (json.room || (json.data && json.data.room));
      if (room && typeof room === 'object') out.room = Object.keys(room).slice(0, 40);
      return out;
    } catch (_) { return null; }
  }

  function relayAccount(id, tag) {
    const key = accountKeyOf(id);
    if (!key || key === lastAccountKey) return;
    lastAccountKey = key;
    const account = {
      key: key,
      id: id.accountId || null,
      secUid: id.secUid || null,
      handle: id.handle || null,
      nickname: id.nickname || null,
      source: tag || null,
    };
    console.log('[LENSED][TT] account detected:', account.handle || account.nickname || key, '(via ' + tag + ')');
    window.postMessage({ source: 'lensed-tiktok-account', account: account }, window.location.origin);
  }

  function handleIdentityText(url, text, tag) {
    if (!text || typeof text !== 'string') return;
    // Only inspect tiktok.com response bodies (never third-party hosts) — mirrors the
    // hostname guard in extractRoomIdFromUrl.
    try {
      const u = new URL(url, window.location.origin);
      if (!/(^|\.)tiktok\.com$/i.test(u.hostname)) return;
    } catch (_) {}
    let json;
    try { json = JSON.parse(text); } catch (_) { return; }
    const id = extractAccountIdentity(json);
    if (id) { relayAccount(id, tag); return; }
    if (isDev()) {
      console.log('[LENSED][TT][dev] no host identity in ' + tag + ' — keys:', sketchKeys(json));
      if (isDevRaw()) console.log('[LENSED][TT][dev-raw] ' + tag + ' BODY:', text);
    }
  }

  // ── Parsing helpers ────────────────────────────────────────────────

  function parsePrice(raw) {
    if (raw == null) return null;
    if (typeof raw === 'number') return isFinite(raw) ? raw : null;
    const cleaned = String(raw).replace(/[^0-9.]/g, '');
    if (cleaned === '') return null;
    const n = parseFloat(cleaned);
    return isFinite(n) ? n : null;
  }

  function parseTimestampMs(raw) {
    if (raw == null) return null;
    const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
    if (!isFinite(n) || n <= 0) return null;
    return n < 1e12 ? n * 1000 : n;
  }

  function normalizeOrder(order) {
    if (!order || typeof order !== 'object') return null;

    const orderId = order.order_id != null ? String(order.order_id) : null;
    if (!orderId) return null;
    // New order → relays (get() is undefined, never equal to a token). A repeat
    // with the SAME payment status → suppressed. A status FLIP → relays again.
    const token = paymentToken(order);
    if (seenOrderStatus.get(orderId) === token) return null;

    let skuRef = null;
    if (order.sku_desc != null) {
      skuRef = String(order.sku_desc).replace(/^#/, '');
    }

    seenOrderStatus.set(orderId, token);
    if (seenOrderStatus.size > SEEN_ORDER_CAP) {
      seenOrderStatus.delete(seenOrderStatus.keys().next().value); // evict oldest
    }

    return {
      orderId,
      buyerUsername: order.user_name != null ? String(order.user_name) : '',
      sellingPrice: order.selling_price != null ? String(order.selling_price) : null,
      productName: order.product_name != null ? String(order.product_name) : '',
      platformSkuRef: skuRef,
      skuId: order.sku_id != null ? String(order.sku_id) : null,
      productId: order.product_id != null ? String(order.product_id) : null,
      imageUrl: order.product_image_url != null ? String(order.product_image_url) : null,
      orderedAtMs: parseTimestampMs(order.order_create_time),
      isPaymentSuccessful: order.is_payment_successful ?? null,
      orderStatus: order.order_status ?? null,
      roomId: lastRoomId,
    };
  }

  // ── Response parsing ───────────────────────────────────────────────

  function extractOrders(json) {
    if (!json || typeof json !== 'object') return [];
    const arr = Array.isArray(json.auction_result_data)
      ? json.auction_result_data
      : (json.data && Array.isArray(json.data.auction_result_data)
        ? json.data.auction_result_data
        : null);
    return Array.isArray(arr) ? arr : [];
  }

  function extractRoomIdFromUrl(url) {
    if (!url) return null;
    try {
      const u = new URL(url, window.location.origin);
      if (!/(^|\.)tiktok\.com$/i.test(u.hostname)) return null;
      const rid = u.searchParams.get('room_id');
      return rid && rid.trim() !== '' ? rid : null;
    } catch (_) {
      const m = String(url).match(/[?&]room_id=([^&]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    }
  }

  // ── Core handler ───────────────────────────────────────────────────

  function handleResponseText(url, text) {
    if (!text || typeof text !== 'string') return;
    if (!url.toLowerCase().includes(SALE_URL_MARKER)) return;

    // room_id from the request URL query string — most reliable source.
    relayRoom(extractRoomIdFromUrl(url));

    let json;
    try { json = JSON.parse(text); } catch (_) { return; }

    const orders = extractOrders(json);
    if (orders.length === 0) return;

    let newCount = 0;
    for (const order of orders) {
      const sale = normalizeOrder(order);
      if (sale) {
        console.log('[LENSED][TT] sale captured:', sale);
        relaySale(sale);
        newCount++;
      }
    }
    if (newCount > 0) {
      console.log(`[LENSED][TT] auction_result/get — ${newCount} new sale(s), ${seenOrderStatus.size} total seen`);
    }
  }

  // ── fetch interceptor (observe only) ────────────────────────────────
  const OriginalFetch = window.fetch;
  window.fetch = function (...args) {
    const [resource] = args;
    const url = typeof resource === 'string' ? resource : (resource && resource.url) || '';
    const p = OriginalFetch.apply(this, args);
    const urlLower = url.toLowerCase();

    if (urlLower.includes('room_id=')) relayRoom(extractRoomIdFromUrl(url));

    const isSale = urlLower.includes(SALE_URL_MARKER);
    const idTag = matchIdentity(urlLower); // [account detection] observe only
    if (!isSale && !idTag) return p;

    return p.then((res) => {
      try {
        res.clone().text().then((text) => {
          if (idTag) { try { handleIdentityText(url, text, idTag); } catch (_) {} }
          if (isSale) { try { handleResponseText(url, text); } catch (_) {} }
        }).catch(() => {});
      } catch (_) {}
      return res;
    });
  };
  console.log('[LENSED][TT] fetch interceptor installed');

  // ── XHR interceptor (observe only) ──────────────────────────────────
  const OriginalXHROpen = XMLHttpRequest.prototype.open;
  const OriginalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._lensed_tt_url = url;
    return OriginalXHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const url = this._lensed_tt_url || '';
    const urlLower = String(url).toLowerCase();

    if (urlLower.includes('room_id=')) relayRoom(extractRoomIdFromUrl(String(url)));

    if (urlLower.includes(SALE_URL_MARKER)) {
      this.addEventListener('load', () => {
        try { handleResponseText(String(url), this.responseText); } catch (_) {}
      });
    }

    // [account detection] observe only — read host identity from lifecycle responses.
    const idTag = matchIdentity(urlLower);
    if (idTag) {
      this.addEventListener('load', () => {
        try { handleIdentityText(String(url), this.responseText, idTag); } catch (_) {}
      });
    }

    return OriginalXHRSend.call(this, body);
  };
  console.log('[LENSED][TT] XHR interceptor installed (MAIN world)');
})();
