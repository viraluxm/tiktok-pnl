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
 * Phase 1: console.log only. No Supabase writes.
 */
(function () {
  'use strict';

  // Duplicate-injection guard (MAIN world). A second injection would double-wrap
  // fetch/XHR — every response then relayed twice. Bail if already installed.
  if (window.__lensedInjected) return;
  window.__lensedInjected = true;

  const SALE_URL_MARKER = 'auction_result/get';

  // ── TEMPORARY SPIKE (observation only) ──────────────────────────────
  // Read-only console logging of two lifecycle-candidate endpoints so we can
  // confirm, during a live, whether they're usable as auction/session signals.
  // This does NOT relay, dedupe, or act on these responses in any way, and the
  // existing auction_result/get capture is untouched. REMOVE after the spike.
  const SPIKE_MARKERS = [
    { marker: 'start_auction', tag: 'start_auction' },
    { marker: 'room/status', tag: 'room_status' },
  ];

  function matchSpike(urlLower) {
    for (let i = 0; i < SPIKE_MARKERS.length; i++) {
      if (urlLower.includes(SPIKE_MARKERS[i].marker)) return SPIKE_MARKERS[i].tag;
    }
    return null;
  }

  function logSpike(tag, url, text) {
    try {
      console.log('[LENSED][SPIKE] ' + tag + ' URL:', url);
      console.log('[LENSED][SPIKE] ' + tag + ' BODY:', text);
    } catch (_) {}
  }

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
    window.postMessage({ source: 'lensed-tiktok-sale', sale }, window.location.origin);
  }

  function relayRoom(roomId) {
    if (!roomId || roomId === lastRoomId) return;
    lastRoomId = roomId;
    console.log('[LENSED][TT] room_id detected:', roomId);
    window.postMessage({ source: 'lensed-tiktok-room', roomId }, window.location.origin);
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
    const spikeTag = matchSpike(urlLower); // SPIKE: observation only
    if (!isSale && !spikeTag) return p;

    return p.then((res) => {
      try {
        res.clone().text().then((text) => {
          if (spikeTag) logSpike(spikeTag, url, text); // SPIKE: log only, no relay
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

    // SPIKE: observation only — log full URL + body for lifecycle-candidate endpoints.
    const spikeTag = matchSpike(urlLower);
    if (spikeTag) {
      this.addEventListener('load', () => {
        try { logSpike(spikeTag, String(url), this.responseText); } catch (_) {}
      });
    }

    return OriginalXHRSend.call(this, body);
  };
  console.log('[LENSED][TT] XHR interceptor installed (MAIN world)');
})();
