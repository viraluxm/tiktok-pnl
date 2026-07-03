/**
 * Lensed tiktok-content.js — ISOLATED world on shop.tiktok.com.
 *
 * Three jobs:
 * 1. Bridge: relays postMessage from MAIN-world injector -> background SW.
 * 2. Overlay: shadow-DOM sales feed + SKU-binding controls.
 * 3. Auto-bind: when a new sale arrives, binds staged SKUs and calls
 *    lensed_log_auction (via background) with order_id as idem key.
 *
 * SKU flow:
 * - Host types a sku_number into the input, resolved via background -> inventory_skus
 * - Staged SKUs shown as pills; multiple supported for bundles
 * - Three buttons: -> (re-run previous), + (add/stage), - (remove last)
 * - On new sale: auto-bind fires, logs to lensed_log_auction + capture_events
 * - order_id locks after logging (no double-bind on cumulative re-polls)
 */
(function () {
  'use strict';

  var CONTAINER_ID = 'lensed-overlay-root';
  var MAX_VISIBLE_SALES = 50;

  // ── State ──────────────────────────────────────────────────────────
  var shadowRoot = null;
  var salesListEl = null;
  var countEl = null;
  var stagedListEl = null;
  var notesListEl = null;        // grouped talking-points block under the pills
  var skuInputEl = null;
  var resolvedLabelEl = null;   // transient resolve confirmation line (✓ / errors)
  var stagedCountEl = null;     // always-on "N unit(s) staged" line
  var sessionStatusEl = null;
  var aspValueEl = null;
  var breakEvenValueEl = null;
  var ordersHidden = false; // "−" hides only the Recent Orders section, not the whole overlay; persisted
  var hidden = false;       // ✕ hides the whole overlay; a floating tab reopens it; persisted
  var prefsLoaded = false;  // read chrome.storage prefs only once per page load
  var salesCount = 0;

  // Dedup + persistence for the visible "Next order" counter (salesCount).
  // seenOrderIds is the set of order_ids already counted this live: it stops
  // duplicate relays and payment-status flips (failed→paid) from advancing the
  // counter twice, and — once persisted and restored — stops TikTok's cumulative
  // order re-poll from re-inflating the count after a Live Manager reload.
  // counterSessionId scopes the persisted record to ONE live session, so a fresh
  // live never inherits a previous live's number (chrome.storage key below).
  var seenOrderIds = Object.create(null);
  var counterSessionId = null;
  var LK_COUNTER = 'lensed_live_counter';

  // Persisted overlay size (chrome.storage.local key `lensed_overlay_size`), set
  // only by the bottom-right resize grip. Cached in memory so SPA re-injects
  // re-apply instantly. Min/max are enforced in JS.
  var overlaySize = null;
  var OVERLAY_MIN_W = 300, OVERLAY_MAX_W = 720;
  var OVERLAY_MIN_H = 240, OVERLAY_MAX_H = 900;

  // SKU staging
  var stagedSkus = [];       // [{id, sku_number, title, qty}, ...] — one entry per distinct SKU
  var previousSkus = [];     // last bound set (with qty), for re-run
  var pendingResolve = null;  // the resolved SKU object waiting to be staged
  var debounceTimer = null;   // trailing resolve timer for manual typing

  // Dedup: order_id → last payment token we auto-bound this page load. Keyed by
  // status (not order_id alone) so a payment FLIP (failed→paid) forwards a second
  // AUTO_BIND, while an identical repeat (same order_id + same status) is skipped.
  var boundOrderStatus = new Map();

  // order_id → the SKU set bound to it during THIS page session ([{sku_number,
  // title, qty}, ...]). Session-only (never persisted) — lets a recent-order row
  // render its bound item lines reliably on re-render. Orders from before this
  // page load aren't here and show order/buyer/price/status only.
  var sessionBoundSkus = new Map();

  // Payment token mirrors the downstream sold/not_sold split.
  function saleStatusToken(sale) {
    return sale && sale.isPaymentSuccessful === false ? 'failed' : 'ok';
  }

  // ── CSS ────────────────────────────────────────────────────────────
  var OVERLAY_CSS = '\
    :host {\
      all: initial;\
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\
    }\
    .lensed-panel {\
      position: fixed; bottom: 16px; right: 16px; width: 340px; max-height: 520px;\
      background: #111113; border: 1px solid #2a2a2e; border-radius: 10px;\
      color: #e5e5e5; font-size: 13px; z-index: 2147483647;\
      box-shadow: 0 8px 32px rgba(0,0,0,0.5); display: flex; flex-direction: column;\
      overflow: hidden; user-select: none;\
    }\
    /* Resize grip — visible diagonal grip in the bottom-right corner */\
    .lensed-resize-handle {\
      position: absolute; right: 0; bottom: 0; width: 26px; height: 26px;\
      cursor: nwse-resize; z-index: 6;\
      background: linear-gradient(135deg, transparent 50%, #6366f1 50%);\
      border-bottom-right-radius: 10px;\
    }\
    .lensed-resize-handle::before {\
      content: ""; position: absolute; right: 3px; bottom: 3px; width: 12px; height: 12px;\
      background: repeating-linear-gradient(135deg, #fff 0 1.5px, transparent 1.5px 4px);\
      opacity: 0.85;\
    }\
    .lensed-resize-handle:hover { background: linear-gradient(135deg, transparent 50%, #818cf8 50%); }\
    /* Floating reopen tab shown when the overlay is hidden via the X */\
    .lensed-reopen-tab {\
      position: fixed; bottom: 16px; right: 16px; z-index: 2147483647;\
      background: #4f46e5; color: #fff; font-size: 12px; font-weight: 700;\
      padding: 8px 14px; border-radius: 10px; cursor: pointer; letter-spacing: 0.3px;\
      box-shadow: 0 4px 16px rgba(0,0,0,0.45); user-select: none;\
    }\
    .lensed-reopen-tab:hover { background: #5a52f0; }\
    .lensed-header {\
      display: flex; align-items: center; justify-content: space-between;\
      padding: 8px 12px; background: #1a1a1e; cursor: grab; flex-shrink: 0;\
      border-bottom: 1px solid #2a2a2e;\
    }\
    .lensed-header:active { cursor: grabbing; }\
    .lensed-title { display: flex; align-items: center; gap: 8px; }\
    .lensed-brand {\
      font-weight: 700; font-size: 13px; letter-spacing: 0.3px; color: #a5a5ff;\
    }\
    .lensed-next-label {\
      font-size: 10px; font-weight: 700; letter-spacing: 0.4px;\
      text-transform: uppercase; color: #8a8a92;\
    }\
    .lensed-badge {\
      background: #6366f1; color: #fff; font-size: 15px; font-weight: 800;\
      min-width: 26px; height: 26px; padding: 0 7px; border-radius: 13px;\
      display: inline-flex; align-items: center; justify-content: center;\
      box-shadow: 0 0 0 2px rgba(99,102,241,0.25);\
    }\
    .lensed-toggle {\
      background: none; border: none; color: #888; cursor: pointer;\
      font-size: 16px; padding: 0 2px; line-height: 1;\
    }\
    .lensed-toggle:hover { color: #e5e5e5; }\
    .lensed-controls { display: flex; align-items: center; gap: 6px; }\
    .lensed-version {\
      position: absolute; left: 0; bottom: 0; z-index: 4;\
      font-size: 8px; font-weight: 600; color: #5a5a66; letter-spacing: 0.3px;\
      background: #111113; padding: 1px 6px 1px 8px; border-top-right-radius: 6px;\
      pointer-events: none;\
    }\
    .lensed-close-btn {\
      background: none; border: none; color: #888; cursor: pointer;\
      font-size: 15px; line-height: 1; padding: 0 3px;\
    }\
    .lensed-close-btn:hover { color: #f87171; }\
    /* Recent orders: a bounded, scrollable section — NOT the growth region, so\
       the "−" toggle hides only this, and resizing grows the stage instead. */\
    .lensed-body { overflow-y: auto; flex: 0 0 auto; max-height: 200px; padding: 0; }\
    .lensed-panel.orders-hidden .lensed-body { display: none; }\
    \
    /* Stage section: left column (input + staged + talking points), right column (ASP).\
       flex:1 so it absorbs extra height on resize — the talking points grow. */\
    .lensed-sku-bar {\
      padding: 10px 12px; border-bottom: 1px solid #2a2a2e; background: #151518;\
      display: flex; gap: 10px; align-items: stretch; flex: 1 1 auto; min-height: 0;\
    }\
    .lensed-sku-main { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }\
    .lensed-asp {\
      flex-shrink: 0; width: 132px; padding-left: 12px; border-left: 1px solid #2a2a2e;\
      display: flex; flex-direction: column; align-items: flex-end;\
      justify-content: center; text-align: right;\
    }\
    .lensed-asp-label {\
      font-size: 11px; font-weight: 700; letter-spacing: 0.5px;\
      text-transform: uppercase; color: #9a9aa2; margin-bottom: 4px;\
    }\
    .lensed-asp-value {\
      font-size: 40px; font-weight: 800; color: #34d399; line-height: 1; white-space: nowrap;\
    }\
    .lensed-be-label {\
      font-size: 10px; font-weight: 700; letter-spacing: 0.5px;\
      text-transform: uppercase; color: #9a9aa2; margin-top: 12px; margin-bottom: 2px;\
    }\
    .lensed-be-value {\
      font-size: 23px; font-weight: 800; color: #d4d4dc; line-height: 1; white-space: nowrap;\
    }\
    .lensed-sku-row {\
      display: flex; align-items: center; gap: 6px;\
    }\
    .lensed-sku-input {\
      flex: 1; background: #222226; border: 1px solid #333; border-radius: 6px;\
      padding: 5px 8px; font-size: 13px; color: #e5e5e5; outline: none;\
      font-family: inherit; min-width: 0;\
    }\
    .lensed-sku-input:focus { border-color: #6366f1; }\
    .lensed-sku-input::placeholder { color: #555; }\
    .lensed-sku-btn {\
      background: #222226; border: 1px solid #333; border-radius: 6px;\
      color: #aaa; cursor: pointer; font-size: 14px; width: 28px; height: 28px;\
      display: flex; align-items: center; justify-content: center;\
      padding: 0; line-height: 1; flex-shrink: 0;\
    }\
    .lensed-sku-btn:hover { background: #2a2a2e; color: #e5e5e5; border-color: #555; }\
    .lensed-sku-btn:disabled { opacity: 0.3; cursor: default; }\
    .lensed-sku-btn.primary { background: #6366f1; border-color: #6366f1; color: #fff; }\
    .lensed-sku-btn.primary:hover { background: #5558e6; }\
    /* Restage: prominent secondary action — tinted + outlined, brighter icon, bigger */\
    .lensed-sku-btn.restage {\
      width: 34px; height: 34px; font-size: 18px;\
      background: rgba(99,102,241,0.16); border-color: #4f46e5; color: #a5b4ff;\
    }\
    .lensed-sku-btn.restage:hover { background: rgba(99,102,241,0.32); border-color: #6366f1; color: #fff; }\
    .lensed-resolved {\
      font-size: 11px; color: #34d399; margin-top: 4px; min-height: 16px;\
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;\
    }\
    .lensed-resolved.error { color: #f87171; }\
    .lensed-resolved:empty { display: none; }\
    .lensed-staged-count {\
      font-size: 10px; color: #8a8a92; font-weight: 700; letter-spacing: 0.5px;\
      text-transform: uppercase; margin-top: 8px; min-height: 14px;\
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;\
    }\
    .lensed-staged {\
      display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; min-height: 0;\
    }\
    .lensed-staged:empty { display: none; }\
    /* Staged item — readable indigo pill: "2× iPad 9th Gen · #14" */\
    .lensed-staged-item {\
      display: inline-flex; align-items: baseline; gap: 4px; max-width: 100%;\
      box-sizing: border-box; overflow: hidden; white-space: nowrap;\
      background: #4f46e5; color: #fff; font-size: 12px; font-weight: 600;\
      padding: 3px 9px; border-radius: 10px;\
    }\
    .lensed-si-title { overflow: hidden; text-overflow: ellipsis; min-width: 0; }\
    .lensed-si-num { color: #cdcdff; font-weight: 500; flex-shrink: 0; }\
    .lensed-si-num::before { content: "\\00B7 "; }\
    .lensed-session-status {\
      font-size: 10px; color: #555; margin-top: 4px;\
    }\
    .lensed-session-status.active { color: #34d399; }\
    \
    /* Talking points (grouped per staged SKU) */\
    .lensed-notes {\
      margin-top: 8px; padding-top: 8px; border-top: 1px solid #2a2a2e;\
      flex: 1 1 auto; min-height: 0; overflow-y: auto;\
    }\
    .lensed-notes:empty { display: none; }\
    .lensed-notes-head {\
      font-size: 9px; font-weight: 700; letter-spacing: 0.6px;\
      text-transform: uppercase; color: #777; margin-bottom: 6px;\
    }\
    .lensed-note-group { margin-bottom: 8px; }\
    .lensed-note-group:last-child { margin-bottom: 0; }\
    .lensed-note-sku {\
      font-size: 13px; font-weight: 700; color: #a5a5ff; margin-bottom: 4px;\
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;\
    }\
    .lensed-note {\
      font-size: 15px; color: #e2e2e8; line-height: 1.55; padding-left: 17px;\
      position: relative; margin-bottom: 7px;\
    }\
    .lensed-note:last-child { margin-bottom: 0; }\
    .lensed-note::before {\
      content: "\\2022"; position: absolute; left: 1px; top: -1px;\
      color: #818cf8; font-size: 15px; font-weight: 700;\
    }\
    .lensed-note-more {\
      font-size: 11px; color: #777; padding-left: 12px; margin-top: 1px;\
    }\
    \
    /* Section header (sticky within the scroll body) */\
    .lensed-section-head {\
      font-size: 9px; font-weight: 700; letter-spacing: 0.6px;\
      text-transform: uppercase; color: #777;\
      padding: 8px 12px 5px; position: sticky; top: 0;\
      background: #111113; z-index: 1;\
    }\
    /* Recent orders (text-first, no thumbnails) */\
    .lensed-empty {\
      padding: 24px 12px; text-align: center; color: #555; font-size: 12px;\
    }\
    .lensed-sale {\
      display: flex; flex-direction: column; gap: 2px; padding: 7px 12px;\
      border-bottom: 1px solid #1e1e22; animation: lensed-fade-in 0.25s ease;\
    }\
    .lensed-sale:last-child { border-bottom: none; }\
    .lensed-sale.bound { border-left: 3px solid #6366f1; padding-left: 9px; }\
    .lensed-sale-top {\
      display: flex; justify-content: space-between; align-items: baseline; gap: 8px;\
    }\
    .lensed-sale-order {\
      font-size: 12px; font-weight: 600; color: #e5e5e5; flex: 1; min-width: 0;\
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;\
    }\
    .lensed-sale-right {\
      flex-shrink: 0; white-space: nowrap; font-size: 12px;\
    }\
    .lensed-sale-price { font-weight: 700; color: #34d399; }\
    .lensed-sale-status { font-weight: 600; color: #34d399; }\
    .lensed-sale-unpaid { font-weight: 600; color: #f59e0b; }\
    .lensed-sale-sep { color: #555; }\
    .lensed-sale-item {\
      font-size: 12px; color: #c8c8cf; padding-left: 1px;\
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;\
    }\
    @keyframes lensed-fade-in {\
      from { opacity: 0; transform: translateY(-4px); }\
      to   { opacity: 1; transform: translateY(0); }\
    }\
  ';

  // ── Helpers ────────────────────────────────────────────────────────

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  // ── Scanner detection ──────────────────────────────────────────────
  // A barcode scanner types the whole value in a sub-human burst and (usually)
  // sends Enter. We track keystroke timing so a scanned value auto-stages,
  // while manual character-by-character typing keeps the +/Enter flow.
  var SCAN_MAX_INTERKEY_MS = 35; // chars closer than this are machine-fast
  var SCAN_MIN_LENGTH = 3;       // ignore short manual entries (e.g. a sku_number)
  var SCAN_MAX_TOTAL_MS = 250;   // whole burst must complete within this window
  var scanFirstCharTime = 0;
  var scanLastCharTime = 0;
  var scanCharCount = 0;

  // Note a printable keystroke for burst tracking. Resets the sequence when the
  // field is empty or after a human-length pause since the previous keystroke.
  function noteScanKey() {
    var t = nowMs();
    if (scanCharCount === 0 || (t - scanLastCharTime) > 100) {
      scanFirstCharTime = t;
      scanCharCount = 0;
    }
    scanCharCount++;
    scanLastCharTime = t;
  }

  // True when the keystrokes that produced the current value arrived as a
  // machine-fast burst (i.e. a scanner), not human typing.
  function looksLikeScan() {
    if (scanCharCount < SCAN_MIN_LENGTH) return false;
    var elapsed = scanLastCharTime - scanFirstCharTime;
    return elapsed < scanCharCount * SCAN_MAX_INTERKEY_MS && elapsed < SCAN_MAX_TOTAL_MS;
  }

  // ── Global keyboard-wedge scanner (works when the SKU input is NOT focused) ──
  // A separate buffer/timing from the input's own scan state, so the two never
  // interfere. Same burst heuristic; commits through the existing RESOLVE_SKU →
  // stageCurrentSku path (see the global keydown listener near the bottom).
  var gScanBuffer = '';
  var gScanFirst = 0, gScanLast = 0, gScanCount = 0;

  function resetGlobalScan() { gScanBuffer = ''; gScanFirst = 0; gScanLast = 0; gScanCount = 0; }

  function globalLooksLikeScan() {
    if (gScanCount < SCAN_MIN_LENGTH) return false;
    var elapsed = gScanLast - gScanFirst;
    return elapsed < gScanCount * SCAN_MAX_INTERKEY_MS && elapsed < SCAN_MAX_TOTAL_MS;
  }

  // Focus the SKU input so the next scan/keystroke lands there — but only when
  // it's safe: overlay open, input exists, and the user is NOT typing in a host
  // editable field (TikTok chat, textareas, contenteditable). Never steals focus
  // from an editable page element. (isEditableTarget is defined below — hoisted.)
  function focusScanInput() {
    if (hidden || !skuInputEl) return;
    if (isEditableTarget(document.activeElement)) return;
    try { skuInputEl.focus(); } catch (_) {}
  }

  // ── SKU staging logic ──────────────────────────────────────────────

  // Total units across all staged pills (sum of qty).
  function totalStagedUnits() {
    var t = 0;
    for (var i = 0; i < stagedSkus.length; i++) t += (stagedSkus[i].qty || 1);
    return t;
  }

  // Always-on staged-units count line. Updates as SKUs are staged/removed.
  function updateStagedLabel() {
    if (!stagedCountEl) return;
    var n = totalStagedUnits();
    stagedCountEl.textContent = n === 0
      ? 'Nothing staged'
      : ('Staged — ' + n + ' unit' + (n === 1 ? '' : 's'));
  }

  // The resolve-confirmation line is separate and shown only while resolving a
  // typed/scanned SKU. Green for success, red for not-found / out-of-stock.
  function setResolveLine(text, isError) {
    if (!resolvedLabelEl) return;
    resolvedLabelEl.textContent = text;
    resolvedLabelEl.className = isError ? 'lensed-resolved error' : 'lensed-resolved';
  }

  function clearResolveLine() {
    if (!resolvedLabelEl) return;
    resolvedLabelEl.textContent = '';
    resolvedLabelEl.className = 'lensed-resolved';
  }

  // Resolve-line copy. A lookup shows MSG_SEARCHING while the background round-trip
  // is in flight, so "SKU not found" is only ever shown AFTER a lookup completes
  // and only for a genuine miss (status 'not_found'). Other terminal states get
  // their own message instead of being mislabeled as not-found.
  var MSG_SEARCHING = 'Searching…';
  var MSG_NOT_FOUND = 'SKU not found';
  var MSG_NOT_CONNECTED = 'Not connected — open Lensed app to sign in';
  var MSG_LOOKUP_FAILED = 'Lookup failed — try again';

  // Render the correct error line for a RESOLVE_SKU response that produced no SKU.
  // Never shows "SKU not found" for an auth/error state.
  function showResolveMiss(status) {
    if (status === 'not_authenticated') { setResolveLine(MSG_NOT_CONNECTED, true); return; }
    if (status === 'error') { setResolveLine(MSG_LOOKUP_FAILED, true); return; }
    setResolveLine(MSG_NOT_FOUND, true); // 'not_found' (or anything else) → genuine miss
  }

  // Shared identity label for a staged/bound SKU: "1× iPad 9th Gen · #14".
  // Quantity is ALWAYS shown (even 1×). Falls back to "1× #14" when the title is
  // empty. Long titles are handled by CSS ellipsis + a full-value hover, not here.
  // Used by the staged pills, the talking-points headers, and the recent-order
  // bound item lines so the three formats never drift.
  function skuLabel(s) {
    var qty = s.qty || 1;
    var num = '#' + s.sku_number;
    var title = (s.title || '').trim();
    return qty + '× ' + (title ? title + ' · ' + num : num);
  }

  // Render staged SKUs as readable indigo pills: "2× keychain · #2". The title
  // span holds qty + title; the number span shows "#n" (its "· " prefix is CSS).
  function renderStagedPills() {
    if (!stagedListEl) return;
    stagedListEl.innerHTML = '';
    for (var i = 0; i < stagedSkus.length; i++) {
      var s = stagedSkus[i];
      var qty = s.qty || 1;
      var title = (s.title || '').trim();
      var item = el('div', 'lensed-staged-item');
      // Title span carries qty + title; falls back to qty + #number when untitled.
      item.appendChild(el('span', 'lensed-si-title', qty + '× ' + (title || ('#' + s.sku_number))));
      // Number span only when we have a title (otherwise it's already in the title).
      if (title) {
        item.appendChild(el('span', 'lensed-si-num', '#' + s.sku_number));
        item.title = title;
      }
      stagedListEl.appendChild(item);
    }
    updateAspGoal();
    renderTalkingPoints();
  }

  // Max bullets shown per SKU before collapsing to "+N more".
  var MAX_NOTES_PER_SKU = 3;

  // Talking points grouped by unique staged SKU. stagedSkus already holds one
  // entry per distinct SKU (with qty), so each SKU appears once. SKUs without
  // notes are skipped; if none have notes the whole block stays empty/hidden.
  // textContent only — never innerHTML — for seller-authored text.
  function renderTalkingPoints() {
    if (!notesListEl) return;
    notesListEl.innerHTML = '';

    var anyNotes = false;
    for (var i = 0; i < stagedSkus.length; i++) {
      var s = stagedSkus[i];
      var notes = Array.isArray(s.live_seller_notes) ? s.live_seller_notes : [];
      if (notes.length === 0) continue;

      if (!anyNotes) {
        notesListEl.appendChild(el('div', 'lensed-notes-head', 'Talking points'));
        anyNotes = true;
      }

      var group = el('div', 'lensed-note-group');
      // Header uses the shared label: "2× iPad 9th Gen · #12" (qty always shown).
      group.appendChild(el('div', 'lensed-note-sku', skuLabel(s)));

      var shown = Math.min(notes.length, MAX_NOTES_PER_SKU);
      for (var j = 0; j < shown; j++) {
        group.appendChild(el('div', 'lensed-note', notes[j]));
      }
      if (notes.length > MAX_NOTES_PER_SKU) {
        group.appendChild(el('div', 'lensed-note-more', '+' + (notes.length - MAX_NOTES_PER_SKU) + ' more'));
      }
      notesListEl.appendChild(group);
    }
    // notesListEl is empty when no staged SKU has notes -> :empty CSS hides it.
  }

  // Break-even = Σ (unit_cost_cents × qty) — the true $0-profit price (no markup).
  function stagedCostCents() {
    var totalCost = 0;
    for (var i = 0; i < stagedSkus.length; i++) {
      var c = Number(stagedSkus[i].unit_cost_cents);
      if (!Number.isFinite(c)) c = 0;
      totalCost += c * (stagedSkus[i].qty || 1);
    }
    return totalCost;
  }

  // ASP goal = break-even cost × 3 (a 3x markup target on staged cost).
  function aspGoalCents() {
    return stagedCostCents() * 3;
  }

  // Live-auction bids are whole dollars, so the ASP goal and break-even targets
  // are shown as whole dollars too — always rounded UP to the next whole dollar
  // ($12.00 → $12, $12.01 → $13, $12.50 → $13, $12.99 → $13). A target must never
  // display below the true cost, so we ceil rather than round to nearest. Rounding
  // is applied at DISPLAY time only: aspGoalCents()/stagedCostCents() keep returning
  // exact cents and the bind/RPC money path uses raw unit_cost_cents, so this never
  // affects stored/logged profit.
  function formatBidGoalDollars(cents) {
    var c = Number(cents);
    if (!Number.isFinite(c) || c <= 0) return '$0';
    var wholeDollars = Math.ceil(c / 100);
    return '$' + wholeDollars.toLocaleString('en-US');
  }

  function updateAspGoal() {
    if (aspValueEl) aspValueEl.textContent = formatBidGoalDollars(aspGoalCents());
    if (breakEvenValueEl) breakEvenValueEl.textContent = formatBidGoalDollars(stagedCostCents());
  }

  // Show a red stock-limit message (used when an increment would exceed qty_on_hand).
  function showStockLimit(cap) {
    setResolveLine(cap > 0 ? ('Only ' + cap + ' in stock') : 'Out of stock', true);
  }

  function stageCurrentSku() {
    if (!pendingResolve) return;
    // Available units for this SKU. qty_on_hand is `not null default 0`, so a
    // non-finite value means we can't trust stock — treat it as zero (unfulfillable).
    var cap = Number(pendingResolve.qty_on_hand);
    if (!Number.isFinite(cap) || cap < 0) cap = 0;

    // Same SKU again → bump quantity on the existing pill instead of duplicating it.
    var existing = null;
    for (var i = 0; i < stagedSkus.length; i++) {
      if (stagedSkus[i].id === pendingResolve.id) { existing = stagedSkus[i]; break; }
    }
    var currentQty = existing ? (existing.qty || 1) : 0;

    // Block any stage/increment that would push staged qty past available stock.
    if (currentQty + 1 > cap) {
      showStockLimit(cap);
      return;
    }

    if (existing) {
      existing.qty = currentQty + 1;
      existing.qty_on_hand = cap; // refresh with latest stock
      existing.unit_cost_cents = pendingResolve.unit_cost_cents;
      existing.live_seller_notes = pendingResolve.live_seller_notes || [];
    } else {
      stagedSkus.push({
        id: pendingResolve.id,
        sku_number: pendingResolve.sku_number,
        title: pendingResolve.title,
        qty: 1,
        qty_on_hand: cap,
        unit_cost_cents: pendingResolve.unit_cost_cents,
        live_seller_notes: pendingResolve.live_seller_notes || [],
      });
    }
    renderStagedPills();
    // Clear input for next entry
    if (skuInputEl) skuInputEl.value = '';
    pendingResolve = null;
    clearResolveLine(); // staging done — resolve line is no longer relevant
    updateStagedLabel();
  }

  function removeLast() {
    if (stagedSkus.length === 0) return;
    // Decrement the most-recent pill; drop it entirely once quantity hits zero.
    var last = stagedSkus[stagedSkus.length - 1];
    last.qty = (last.qty || 1) - 1;
    if (last.qty <= 0) stagedSkus.pop();
    renderStagedPills();
    clearResolveLine();
    updateStagedLabel();
  }

  // Add another unit of the most recently staged SKU (respects the stock cap).
  // Used by the "+" keyboard shortcut.
  function addAnotherUnitOfLast() {
    if (stagedSkus.length === 0) return;
    var last = stagedSkus[stagedSkus.length - 1];
    var cap = Number(last.qty_on_hand);
    if (!Number.isFinite(cap) || cap < 0) cap = 0;
    var currentQty = last.qty || 1;
    if (currentQty + 1 > cap) { showStockLimit(cap); return; }
    last.qty = currentQty + 1;
    renderStagedPills();
    clearResolveLine();
    updateStagedLabel();
  }

  function rerunPrevious() {
    if (previousSkus.length === 0) return;
    // Deep-copy so later qty edits don't mutate the saved set. The previous set was
    // already within stock when it bound, so it stays valid on re-stage.
    stagedSkus = previousSkus.map(function (s) {
      return { id: s.id, sku_number: s.sku_number, title: s.title, qty: s.qty || 1, qty_on_hand: s.qty_on_hand, unit_cost_cents: s.unit_cost_cents, live_seller_notes: s.live_seller_notes || [] };
    });
    renderStagedPills();
    clearResolveLine();
    updateStagedLabel();
  }

  function resolveSkuInput(value) {
    var trimmed = (value || '').trim().replace(/^#/, '');
    if (!trimmed) {
      pendingResolve = null;
      clearResolveLine();
      updateStagedLabel();
      return;
    }
    setResolveLine(MSG_SEARCHING, false); // progress state \u2014 miss only after lookup
    try {
      chrome.runtime.sendMessage({ type: 'RESOLVE_SKU', skuNumber: trimmed }, function (resp) {
        if (chrome.runtime.lastError) { clearResolveLine(); return; }
        // Ignore a stale reply if the field changed since this lookup fired (a
        // newer keystroke supersedes it) \u2014 stops a slow reply clobbering it.
        if (skuInputEl && (skuInputEl.value || '').trim().replace(/^#/, '') !== trimmed) return;
        if (resp && resp.sku) {
          pendingResolve = resp.sku;
          setResolveLine('\u2713 #' + resp.sku.sku_number + ' ' + (resp.sku.title || ''), false);
        } else {
          pendingResolve = null;
          showResolveMiss(resp && resp.status);
        }
      });
    } catch (_) {}
  }

  // Scan terminator: resolve the scanned value and auto-stage it (clearing the
  // input for the next scan). Same barcode again → increments qty via the
  // existing bundle logic in stageCurrentSku.
  function handleScanCommit(value) {
    clearTimeout(debounceTimer); // cancel the trailing debounced resolve
    var trimmed = (value || '').trim().replace(/^#/, '');
    if (!trimmed) return;
    setResolveLine(MSG_SEARCHING, false); // don't flash "not found" mid-lookup
    try {
      chrome.runtime.sendMessage({ type: 'RESOLVE_SKU', skuNumber: trimmed }, function (resp) {
        if (chrome.runtime.lastError) {
          setResolveLine(MSG_LOOKUP_FAILED, true);
          if (skuInputEl) skuInputEl.value = '';
          pendingResolve = null;
          return;
        }
        if (resp && resp.sku) {
          pendingResolve = resp.sku;
          stageCurrentSku(); // stages (or +1 qty); clears input + resolve line on success
        } else {
          showResolveMiss(resp && resp.status);
        }
        // Always leave the field clean and ready for the next scan.
        if (skuInputEl) skuInputEl.value = '';
        pendingResolve = null;
      });
    } catch (_) {}
  }

  // Commit a globally-captured scanner burst through the SAME path as an in-input
  // scan (RESOLVE_SKU → stageCurrentSku). No SKU-lookup or staging behavior change.
  function globalScanCommit(value) {
    var trimmed = (value || '').trim().replace(/^#/, '');
    if (!trimmed) return;
    setResolveLine(MSG_SEARCHING, false); // show progress; miss only after lookup
    try {
      chrome.runtime.sendMessage({ type: 'RESOLVE_SKU', skuNumber: trimmed }, function (resp) {
        if (chrome.runtime.lastError) {
          setResolveLine(MSG_LOOKUP_FAILED, true);
          pendingResolve = null;
          focusScanInput();
          return;
        }
        if (resp && resp.sku) {
          pendingResolve = resp.sku;
          stageCurrentSku(); // stages (or +1 qty) via the existing path
        } else {
          showResolveMiss(resp && resp.status);
        }
        pendingResolve = null;
        focusScanInput(); // ready for the next scan
      });
    } catch (_) {}
  }

  // ── Auto-bind: fire when a new sale arrives ────────────────────────

  // Auto-bind the staged set to a sale. Returns the bind-time snapshot (so the
  // caller can render the bound items even after the auto-clear below). We clear
  // the staged pills AFTER snapshotting on EVERY bind that had a staged set —
  // paid and failed-payment alike — so no SKU silently carries into the next
  // auction. `previousSkus` keeps the last set for the manual ↻ re-run.
  function autoBind(sale) {
    if (!sale || !sale.orderId) return [];
    // New order → binds (get() is undefined ≠ token). Same-status repeat →
    // skipped. Status flip (failed→paid) → binds again so the RPC can transition.
    var token = saleStatusToken(sale);
    if (boundOrderStatus.get(sale.orderId) === token) return [];
    boundOrderStatus.set(sale.orderId, token);

    // Snapshot staged SKUs for this bind (deep-copy so qty edits can't reach the
    // snapshot). This is the AUTO_BIND payload — kept to exactly the fields the
    // background/RPC use; live_seller_notes is display-only and intentionally NOT
    // included here so the bind payload is unchanged.
    var skusForBind = stagedSkus.map(function (s) {
      return { id: s.id, sku_number: s.sku_number, title: s.title, qty: s.qty || 1, qty_on_hand: s.qty_on_hand, unit_cost_cents: s.unit_cost_cents };
    });

    if (stagedSkus.length > 0) {
      // Save the staged set for re-run (independent copy, WITH notes so the ↻
      // button re-stages talking points too). Sourced from stagedSkus — not the
      // bind payload — so it carries live_seller_notes. Persists across the
      // auto-clear below.
      previousSkus = stagedSkus.map(function (s) {
        return { id: s.id, sku_number: s.sku_number, title: s.title, qty: s.qty || 1, qty_on_hand: s.qty_on_hand, unit_cost_cents: s.unit_cost_cents, live_seller_notes: s.live_seller_notes || [] };
      });
    }

    if (skusForBind.length > 0) {
      // Remember what bound to THIS order for the current page session so the
      // recent-order row can render its item lines on re-render. Lean copy
      // (display fields only); session-only, never persisted. A later status
      // flip (failed→paid) arrives with staging already cleared, so it won't
      // overwrite this entry.
      sessionBoundSkus.set(sale.orderId, skusForBind.map(function (s) {
        return { sku_number: s.sku_number, title: s.title, qty: s.qty };
      }));
    }

    try {
      chrome.runtime.sendMessage({
        type: 'AUTO_BIND',
        sale: sale,
        stagedSkus: skusForBind,
      }, function (resp) {
        if (chrome.runtime.lastError) {
          console.error('[LENSED][TT] auto-bind sendMessage error:', chrome.runtime.lastError);
        }
      });
    } catch (_) {}

    // One winner per auction: clear the staged pills after EVERY bind that had a
    // staged set — paid AND failed-payment alike — AFTER the snapshot + message
    // above (the AUTO_BIND payload and the row's item lines are already captured)
    // and after `previousSkus` was copied for the ↻ re-run. Clearing on a failed
    // payment (previously skipped) stops the same SKUs from silently carrying
    // over and binding to the NEXT order; the host re-runs manually via ↻. The
    // AUTO_BIND payload and background's not_sold logging are unchanged — the
    // message above still fires for failed payments.
    if (skusForBind.length > 0) {
      clearStaged();
    }

    return skusForBind;
  }

  // Clear all staged pills and reset the count / ASP goal / break-even displays.
  function clearStaged() {
    stagedSkus = [];
    renderStagedPills();   // empties pills and drives ASP + break-even back to $0
    clearResolveLine();
    updateStagedLabel();   // "0 unit(s) staged"
  }

  // ── Build overlay DOM ──────────────────────────────────────────────

  function createOverlay() {
    var existing = document.getElementById(CONTAINER_ID);
    if (existing) existing.remove();

    var host = document.createElement('div');
    host.id = CONTAINER_ID;
    shadowRoot = host.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent = OVERLAY_CSS;
    shadowRoot.appendChild(style);

    var panel = el('div', 'lensed-panel' + (ordersHidden ? ' orders-hidden' : ''));

    // ── Header ───────────────────────────────────────────────────
    var header = el('div', 'lensed-header');
    var title = el('div', 'lensed-title');
    title.appendChild(el('span', 'lensed-brand', 'Lensed'));
    title.appendChild(el('span', 'lensed-next-label', '\u2014 Next order'));

    // Prominent current/next order number.
    countEl = el('span', 'lensed-badge', '0');
    title.appendChild(countEl);

    // Close (X): hides the whole overlay; a floating "Lensed" tab reopens it.
    var closeBtn = el('button', 'lensed-close-btn', '\u2715');
    closeBtn.title = 'Hide overlay';
    closeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      setHidden(true);
    });

    var toggle = el('button', 'lensed-toggle', ordersHidden ? '+' : '\u2212');
    toggle.title = 'Show / hide Recent orders';
    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      ordersHidden = !ordersHidden;
      panel.classList.toggle('orders-hidden', ordersHidden);
      toggle.textContent = ordersHidden ? '+' : '\u2212';
      persistPrefs();
      focusScanInput();
    });

    var controls = el('div', 'lensed-controls');
    controls.appendChild(closeBtn);
    controls.appendChild(toggle);

    header.appendChild(title);
    header.appendChild(controls);

    // ── SKU bar ──────────────────────────────────────────────────
    var skuBar = el('div', 'lensed-sku-bar');

    var skuRow = el('div', 'lensed-sku-row');

    skuInputEl = document.createElement('input');
    skuInputEl.className = 'lensed-sku-input';
    skuInputEl.type = 'text';
    skuInputEl.placeholder = 'Type or scan SKU';

    skuInputEl.addEventListener('input', function () {
      clearTimeout(debounceTimer);
      var val = skuInputEl.value;
      debounceTimer = setTimeout(function () { resolveSkuInput(val); }, 200);
    });

    skuInputEl.addEventListener('keydown', function (e) {
      // Track printable keystrokes for scanner-burst detection.
      if (e.key && e.key.length === 1) noteScanKey();

      if (e.key === 'Enter') {
        e.preventDefault();
        // Enter commits now, so cancel the still-armed trailing input-debounce —
        // otherwise it fires a second, redundant resolve (and 'Searching…' write)
        // ~200ms later for the same value.
        clearTimeout(debounceTimer);
        // Scanner: value arrived as a machine-fast burst → auto-stage and reset.
        if (looksLikeScan()) {
          var scanned = skuInputEl.value;
          scanCharCount = 0;
          handleScanCommit(scanned);
          return;
        }
        // Manual entry (unchanged): stage the resolved SKU, or resolve then stage.
        scanCharCount = 0;
        if (pendingResolve) {
          stageCurrentSku();
        } else {
          resolveSkuInput(skuInputEl.value);
          setTimeout(function () {
            if (pendingResolve) stageCurrentSku();
          }, 300);
        }
      }
    });

    // + button: stage the resolved SKU (or another unit)
    var addBtn = el('button', 'lensed-sku-btn primary', '+');
    addBtn.title = 'Stage SKU';
    addBtn.addEventListener('click', function () {
      if (pendingResolve) {
        stageCurrentSku();
      }
      focusScanInput();
    });

    // - button: remove last staged
    var removeBtn = el('button', 'lensed-sku-btn', '\u2212');
    removeBtn.title = 'Remove last SKU';
    removeBtn.addEventListener('click', function () { removeLast(); focusScanInput(); });

    // \u21bb restage button \u2014 prominent secondary action (re-runs the last bound set)
    var rerunBtn = el('button', 'lensed-sku-btn restage', '\u21bb');
    rerunBtn.title = 'Restage previous SKUs';
    rerunBtn.addEventListener('click', function () { rerunPrevious(); focusScanInput(); });

    skuRow.appendChild(skuInputEl);
    skuRow.appendChild(addBtn);
    skuRow.appendChild(removeBtn);
    skuRow.appendChild(rerunBtn);

    resolvedLabelEl = el('div', 'lensed-resolved', '');
    stagedCountEl = el('div', 'lensed-staged-count', 'Nothing staged');
    stagedListEl = el('div', 'lensed-staged');
    notesListEl = el('div', 'lensed-notes');
    sessionStatusEl = el('div', 'lensed-session-status', 'Connecting\u2026');

    // Stage section: input row + transient resolve line + always-on staged count
    // + staged items + talking points + session status
    var skuMain = el('div', 'lensed-sku-main');
    skuMain.appendChild(skuRow);
    skuMain.appendChild(resolvedLabelEl);
    skuMain.appendChild(stagedCountEl);
    skuMain.appendChild(stagedListEl);
    skuMain.appendChild(notesListEl);
    skuMain.appendChild(sessionStatusEl);

    // Right column of the stage section: compact ASP goal + break-even. Readable
    // but sized so it doesn't overpower the staged SKUs on the left.
    var aspBox = el('div', 'lensed-asp');
    aspBox.appendChild(el('div', 'lensed-asp-label', 'ASP goal'));
    aspValueEl = el('div', 'lensed-asp-value', '$0');
    aspBox.appendChild(aspValueEl);
    aspBox.appendChild(el('div', 'lensed-be-label', 'Break-even'));
    breakEvenValueEl = el('div', 'lensed-be-value', '$0');
    aspBox.appendChild(breakEvenValueEl);

    skuBar.appendChild(skuMain);
    skuBar.appendChild(aspBox);

    // ── Sales list ───────────────────────────────────────────────
    var body = el('div', 'lensed-body');
    body.appendChild(el('div', 'lensed-section-head', 'Recent orders'));
    salesListEl = el('div', '');
    var empty = el('div', 'lensed-empty', 'Waiting for sales\u2026');
    salesListEl.appendChild(empty);
    body.appendChild(salesListEl);

    panel.appendChild(header);
    panel.appendChild(skuBar);
    panel.appendChild(body);
    // Unobtrusive runtime version marker (muted, bottom-left corner) for testing.
    var verStr = 'v?';
    try { verStr = 'v' + chrome.runtime.getManifest().version; } catch (_) {}
    panel.appendChild(el('span', 'lensed-version', verStr));
    shadowRoot.appendChild(panel);

    // Floating reopen tab — shown only while the overlay is hidden (via the X).
    // Lives in the same shadow root as the panel, so a re-inject always recreates
    // it and the host can never get stuck with no way back.
    var reopenTab = el('div', 'lensed-reopen-tab', 'Lensed');
    reopenTab.title = 'Show Lensed overlay';
    reopenTab.style.display = 'none';
    reopenTab.addEventListener('click', function () { setHidden(false); });
    shadowRoot.appendChild(reopenTab);

    // ── Dragging ─────────────────────────────────────────────────
    var dragging = false;
    var dragOffsetX = 0;
    var dragOffsetY = 0;

    header.addEventListener('mousedown', function (e) {
      if (e.target === toggle) return;
      dragging = true;
      var rect = panel.getBoundingClientRect();
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;
      panel.style.transition = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      panel.style.left = (e.clientX - dragOffsetX) + 'px';
      panel.style.top = (e.clientY - dragOffsetY) + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      panel.style.transition = '';
    });

    // ── Resizing ─────────────────────────────────────────────────
    // Top-left corner handle. The panel docks bottom-right, so at resize start we
    // pin the current bottom-right corner and grow toward the top-left — the
    // natural gesture for a bottom-docked panel, and it works whether or not the
    // panel was previously dragged (drag anchors top-left). A separate `resizing`
    // flag + its own listeners keep the header drag above untouched. It never
    // touches skuInputEl, so scanner-input focus is unaffected. Min/max clamp in JS.
    var resizeHandle = el('div', 'lensed-resize-handle');
    resizeHandle.title = 'Resize';
    panel.appendChild(resizeHandle);

    var resizing = false;
    var resizeStartX = 0, resizeStartY = 0, resizeStartW = 0, resizeStartH = 0;

    function overlayMaxW() { return Math.min(OVERLAY_MAX_W, window.innerWidth - 32); }
    function overlayMaxH() { return Math.min(OVERLAY_MAX_H, window.innerHeight - 32); }
    function clampW(w) { return Math.max(OVERLAY_MIN_W, Math.min(overlayMaxW(), w)); }
    function clampH(h) { return Math.max(OVERLAY_MIN_H, Math.min(overlayMaxH(), h)); }

    // Persist size + Recent-Orders-hidden + whole-overlay-hidden together (guarded).
    function persistPrefs() {
      try {
        chrome.storage.local.set({
          lensed_overlay_size: overlaySize,
          lensed_overlay_orders_hidden: ordersHidden,
          lensed_overlay_hidden: hidden
        });
      } catch (_) {}
    }

    // Hide/show the whole overlay. Hidden → panel gone, floating tab shown.
    function applyHidden() {
      panel.style.display = hidden ? 'none' : '';
      if (reopenTab) reopenTab.style.display = hidden ? '' : 'none';
    }
    function setHidden(v) {
      hidden = v;
      applyHidden();
      persistPrefs();
      if (!v) focusScanInput(); // reopening → ready to scan
    }

    // Apply the persisted (grip-resized) size whenever the overlay is open.
    function applyOverlaySize() {
      if (overlaySize && overlaySize.width && overlaySize.height) {
        panel.style.width = clampW(overlaySize.width) + 'px';
        panel.style.height = clampH(overlaySize.height) + 'px';
        panel.style.maxHeight = 'none';
      }
    }

    resizeHandle.addEventListener('mousedown', function (e) {
      resizing = true;
      var rect = panel.getBoundingClientRect();
      resizeStartX = e.clientX;
      resizeStartY = e.clientY;
      resizeStartW = rect.width;
      resizeStartH = rect.height;
      // Pin the top-left corner so dragging the bottom-right grip grows down-right.
      panel.style.left = rect.left + 'px';
      panel.style.top = rect.top + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.maxHeight = 'none';
      panel.style.transition = 'none';
      e.preventDefault();
      e.stopPropagation();
    });

    document.addEventListener('mousemove', function (e) {
      if (!resizing) return;
      panel.style.width = clampW(resizeStartW + (e.clientX - resizeStartX)) + 'px';
      panel.style.height = clampH(resizeStartH + (e.clientY - resizeStartY)) + 'px';
    });

    document.addEventListener('mouseup', function () {
      if (!resizing) return;
      resizing = false;
      panel.style.transition = '';
      var rect = panel.getBoundingClientRect();
      overlaySize = { width: Math.round(rect.width), height: Math.round(rect.height) };
      persistPrefs();
    });

    getOverlayMountRoot().appendChild(host);

    // Re-render staged pills + count if we had them before a re-inject
    renderStagedPills();
    updateStagedLabel();

    // Reflect the current (module-scoped) prefs onto the freshly built DOM —
    // correct immediately on SPA re-inject. On the first injection this page, also
    // read chrome.storage.local once to hydrate those prefs, then re-apply.
    function applyPrefs() {
      panel.classList.toggle('orders-hidden', ordersHidden);
      if (toggle) toggle.textContent = ordersHidden ? '+' : '−';
      applyOverlaySize();
      applyHidden();
    }

    applyPrefs();

    if (!prefsLoaded) {
      prefsLoaded = true;
      try {
        chrome.storage.local.get(
          ['lensed_overlay_size', 'lensed_overlay_orders_hidden', 'lensed_overlay_hidden'],
          function (data) {
            if (chrome.runtime.lastError || !data) return;
            if (typeof data.lensed_overlay_orders_hidden === 'boolean') ordersHidden = data.lensed_overlay_orders_hidden;
            if (typeof data.lensed_overlay_hidden === 'boolean') hidden = data.lensed_overlay_hidden;
            if (data.lensed_overlay_size) overlaySize = data.lensed_overlay_size;
            applyPrefs();
          }
        );
      } catch (_) {}
    }

    // Request auth status from background
    try {
      chrome.runtime.sendMessage({ type: 'GET_AUTH_STATUS' }, function (resp) {
        if (chrome.runtime.lastError) return;
        if (resp) {
          updateAuthStatus(resp.authenticated, resp.userId);
          if (resp.sessionId) adoptSession(resp.sessionId);
        }
      });
    } catch (_) {}

    console.log('[LENSED][TT] overlay injected');
    return host;
  }

  // ── Render a sale row ──────────────────────────────────────────────

  function renderSale(sale, wasBound, boundSkus) {
    if (!salesListEl) return;

    var empty = salesListEl.querySelector('.lensed-empty');
    if (empty) empty.remove();

    // Count each order at most once per live. Duplicate relays and payment-status
    // flips re-emit the same order_id and must NOT advance the visible counter;
    // the row itself is still (re-)rendered below so its Paid/Unpaid state updates.
    var countOrderId = sale && sale.orderId;
    if (!countOrderId || !seenOrderIds[countOrderId]) {
      if (countOrderId) seenOrderIds[countOrderId] = true;
      salesCount++;
      if (countEl) countEl.textContent = String(salesCount);
      persistCounter();
    }

    // Bound items for this order, preferring the session Map (survives re-render)
    // and falling back to the bind-time snapshot passed by the caller.
    var boundItems = (sale.orderId && sessionBoundSkus.get(sale.orderId)) ||
      (boundSkus && boundSkus.length ? boundSkus : null);

    var row = el('div', 'lensed-sale' + (wasBound ? ' bound' : ''));

    // \u2500\u2500 Line 1: "#order \u00B7 @buyer" (left, ellipsizes) + "price \u00B7 status" (right).
    // Text-first \u2014 no thumbnail. All values via textContent (never innerHTML).
    var top = el('div', 'lensed-sale-top');

    var leftParts = [];
    if (sale.orderId) leftParts.push('#' + sale.orderId);
    if (sale.buyerUsername) leftParts.push('@' + sale.buyerUsername);
    var orderText = leftParts.join(' \u00B7 ');
    var orderEl = el('span', 'lensed-sale-order', orderText || 'Order');
    if (orderText) orderEl.title = orderText;
    top.appendChild(orderEl);

    var right = el('span', 'lensed-sale-right');
    right.appendChild(el('span', 'lensed-sale-price', sale.sellingPrice || '$0'));
    right.appendChild(el('span', 'lensed-sale-sep', ' \u00B7 '));
    var failed = sale.isPaymentSuccessful === false;
    right.appendChild(el('span', failed ? 'lensed-sale-unpaid' : 'lensed-sale-status', failed ? 'Unpaid' : 'Paid'));
    top.appendChild(right);

    row.appendChild(top);

    // \u2500\u2500 Line 2+: one line per bound item \u2014 "2\u00D7 iPad 9th Gen \u00B7 #14". Only present
    // for orders bound during this page session (via the session Map).
    if (boundItems && boundItems.length > 0) {
      for (var i = 0; i < boundItems.length; i++) {
        var itemText = skuLabel(boundItems[i]);
        var itemEl = el('div', 'lensed-sale-item', itemText);
        itemEl.title = itemText;
        row.appendChild(itemEl);
      }
    }

    salesListEl.insertBefore(row, salesListEl.firstChild);
    while (salesListEl.children.length > MAX_VISIBLE_SALES) {
      salesListEl.removeChild(salesListEl.lastChild);
    }
  }

  // ── Live order counter: persistence + session scoping ───────────────
  // The counter is otherwise in-memory only, so a Live Manager reload/crash
  // restarts it at 0. Persist salesCount + the counted order_ids under one key,
  // SCOPED to the live session id, and restore them when we re-attach to that
  // same session. persistCounter is a no-op until the session id is known, so
  // nothing durable is ever written unscoped.
  function persistCounter() {
    if (!counterSessionId) return;
    try {
      var rec = {};
      rec[LK_COUNTER] = {
        sessionId: counterSessionId,
        salesCount: salesCount,
        orderIds: Object.keys(seenOrderIds)
      };
      chrome.storage.local.set(rec);
    } catch (_) {}
  }

  // Adopt the live session id reported by the background worker (via
  // GET_AUTH_STATUS or a LENSED_SESSION broadcast). On a persisted record for the
  // SAME session we restore the counter + dedup set (recovering across a reload).
  // For a new session id we flush the current in-memory count under it, so the
  // first live of a session starts clean and never inherits a prior live's number.
  function adoptSession(sessionId) {
    if (!sessionId || sessionId === counterSessionId) return;
    counterSessionId = sessionId;
    try {
      chrome.storage.local.get([LK_COUNTER], function (data) {
        if (chrome.runtime.lastError || !data) return;
        var rec = data[LK_COUNTER];
        if (rec && rec.sessionId === counterSessionId) {
          seenOrderIds = Object.create(null);
          if (Array.isArray(rec.orderIds)) {
            for (var i = 0; i < rec.orderIds.length; i++) seenOrderIds[rec.orderIds[i]] = true;
          }
          salesCount = typeof rec.salesCount === 'number' ? rec.salesCount : rec.orderIds ? rec.orderIds.length : 0;
          if (countEl) countEl.textContent = String(salesCount);
          console.log('[LENSED][TT] counter restored for session', counterSessionId, '→', salesCount);
        } else {
          console.log('[LENSED][TT] counter scoped to new session', counterSessionId);
          persistCounter();
        }
      });
    } catch (_) {}
  }

  // ── Fullscreen-aware mount root ────────────────────────────────────
  // TikTok Live Manager uses the Fullscreen API. When an element goes
  // fullscreen the browser paints ONLY that element's subtree in the top
  // layer — anything outside it (our overlay, appended to <body>) is not
  // rendered at all, regardless of z-index. So while fullscreen is active
  // the overlay host must live inside the fullscreen element, and move back
  // to <body> when it exits.
  function getOverlayMountRoot() {
    return document.fullscreenElement || document.webkitFullscreenElement || document.body;
  }

  // Relocate the existing overlay host into the correct root WITHOUT
  // recreating it — appendChild() moves the node, preserving its shadow DOM,
  // all internal state (staged SKUs, ASP/break-even, size, auth), and event
  // listeners. Recreate only when the host is actually missing.
  function ensureOverlayMountedInCorrectRoot() {
    var host = document.getElementById(CONTAINER_ID);
    if (!host) { ensureOverlay(); return; }
    var root = getOverlayMountRoot();
    if (host.parentNode !== root) root.appendChild(host);
  }

  // ── MutationObserver: re-inject if TikTok SPA removes our container
  function ensureOverlay() {
    if (!document.getElementById(CONTAINER_ID)) {
      createOverlay();
      if (salesCount > 0 && countEl) {
        countEl.textContent = String(salesCount);
        var empty = salesListEl && salesListEl.querySelector('.lensed-empty');
        if (empty) empty.remove();
      }
    }
  }

  function init() {
    if (!document.body) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
      } else {
        setTimeout(init, 50);
      }
      return;
    }

    createOverlay();

    var observer = new MutationObserver(function () { ensureOverlay(); });
    observer.observe(document.body, { childList: true, subtree: false });

    // Keep the overlay inside the rendered subtree when Live Manager enters or
    // exits fullscreen (see getOverlayMountRoot). webkit* is a defensive
    // fallback for older Chromium builds that only fire the prefixed event.
    document.addEventListener('fullscreenchange', ensureOverlayMountedInCorrectRoot);
    document.addEventListener('webkitfullscreenchange', ensureOverlayMountedInCorrectRoot);
  }

  init();

  // ── Global keyboard shortcuts (only when the SKU input is NOT focused) ─
  // +  add another unit of the most recently staged SKU
  // -  remove the last staged unit
  // *  trigger re-run (the → button)
  // When the SKU input (or any other editable field) is focused these keys
  // type normally — we bail before handling.
  function isEditableTarget(node) {
    if (!node) return false;
    var tag = (node.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    return !!node.isContentEditable;
  }

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Overlay closed (✕) → scanner + shortcuts are inactive.
    if (hidden) return;
    // Our input lives in the shadow DOM: when focused, shadowRoot.activeElement
    // is the input — let its own listener handle typing/scans.
    if (shadowRoot && shadowRoot.activeElement === skuInputEl) return;
    // Don't hijack typing in the host page's own fields either.
    if (isEditableTarget(document.activeElement)) return;

    // Enter → commit a global wedge-scanner burst if it looks machine-fast.
    if (e.key === 'Enter') {
      if (globalLooksLikeScan()) {
        e.preventDefault();
        var scanned = gScanBuffer;
        resetGlobalScan();
        globalScanCommit(scanned);
      } else {
        resetGlobalScan();
      }
      return;
    }

    // Buffer printable single characters for wedge-scanner detection. We update
    // the buffer FIRST so barcode chars (incl. the "-" in SKU<n>-<hex>) that
    // arrive mid-burst are captured as scan data, not treated as shortcuts.
    if (e.key && e.key.length === 1) {
      var t = nowMs();
      var interkey = t - gScanLast;
      if (gScanCount === 0 || interkey > 100) { gScanFirst = t; gScanCount = 0; gScanBuffer = ''; }
      gScanCount++;
      gScanLast = t;
      gScanBuffer += e.key;

      // +/-/* shortcuts fire ONLY for a standalone press — never mid machine-burst.
      // Barcodes are "SKU<n>-<hex>" (never START with +/-/*), so a burst's first
      // char is a letter; a +/-/* arriving fast within a burst is scan data.
      if (e.key === '+' || e.key === '-' || e.key === '*') {
        var standalone = gScanCount <= 1 || interkey > SCAN_MAX_INTERKEY_MS;
        if (standalone) {
          e.preventDefault();
          if (e.key === '+') addAnotherUnitOfLast();
          else if (e.key === '-') removeLast();
          else rerunPrevious();
          resetGlobalScan(); // consumed as a shortcut, not part of a scan
        }
        // else: fast burst char → leave buffered, no shortcut, no preventDefault
      }
    }
  }, true);

  // ── Message bridge: MAIN world -> background + overlay + auto-bind ─

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.source === 'lensed-tiktok-sale') {
      var sale = data.sale;

      // Forward to background
      try {
        chrome.runtime.sendMessage({ type: 'TIKTOK_SALE', sale: sale }).catch(function () {});
      } catch (_) {}

      // Auto-bind fires for a new order OR a status flip of an already-bound one.
      // wasBound mirrors that dedup decision (computed before autoBind updates it)
      // so the bound tag renders whenever this call will actually bind.
      var wasBound = boundOrderStatus.get(sale.orderId) !== saleStatusToken(sale) && stagedSkus.length > 0;
      var boundSkus = autoBind(sale);

      // Render in overlay
      renderSale(sale, wasBound, boundSkus);

      // A bind just cleared staging — refocus so the host can scan the next item
      // immediately (guarded: won't steal focus from TikTok chat/host fields).
      if (boundSkus && boundSkus.length > 0) focusScanInput();
      return;
    }

    if (data.source === 'lensed-tiktok-room') {
      try {
        chrome.runtime.sendMessage({ type: 'TIKTOK_ROOM', roomId: data.roomId }).catch(function () {});
      } catch (_) {}
      return;
    }
  });

  // ── Auth status display ─────────────────────────────────────────────

  function updateAuthStatus(authenticated, uid) {
    if (!sessionStatusEl) return;
    if (authenticated) {
      sessionStatusEl.textContent = 'Connected';
      sessionStatusEl.className = 'lensed-session-status active';
    } else {
      sessionStatusEl.textContent = 'Not connected \u2014 open Lensed app to sign in';
      sessionStatusEl.className = 'lensed-session-status';
    }
  }

  // Listen for auth status broadcasts from background
  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'LENSED_AUTH_STATUS') {
      updateAuthStatus(message.authenticated, message.userId);
    } else if (message.type === 'LENSED_SESSION') {
      // Background resolved/changed the live session — scope our counter to it.
      if (message.sessionId) adoptSession(message.sessionId);
    }
  });

  console.log('[LENSED][TT] content bridge + overlay installed');
})();
