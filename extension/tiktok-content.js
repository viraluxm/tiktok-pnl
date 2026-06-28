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
  var skuInputEl = null;
  var resolvedLabelEl = null;   // transient resolve confirmation line (✓ / errors)
  var stagedCountEl = null;     // always-on "N unit(s) staged" line
  var sessionStatusEl = null;
  var aspValueEl = null;
  var breakEvenValueEl = null;
  var collapsed = true;
  var salesCount = 0;

  // SKU staging
  var stagedSkus = [];       // [{id, sku_number, title, qty}, ...] — one entry per distinct SKU
  var previousSkus = [];     // last bound set (with qty), for re-run
  var pendingResolve = null;  // the resolved SKU object waiting to be staged
  var debounceTimer = null;   // trailing resolve timer for manual typing

  // Dedup: order_id → last payment token we auto-bound this page load. Keyed by
  // status (not order_id alone) so a payment FLIP (failed→paid) forwards a second
  // AUTO_BIND, while an identical repeat (same order_id + same status) is skipped.
  var boundOrderStatus = new Map();

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
    .lensed-panel.collapsed { width: auto; max-height: none; border-radius: 8px; }\
    .lensed-header {\
      display: flex; align-items: center; justify-content: space-between;\
      padding: 8px 12px; background: #1a1a1e; cursor: grab; flex-shrink: 0;\
      border-bottom: 1px solid #2a2a2e;\
    }\
    .lensed-header:active { cursor: grabbing; }\
    .lensed-panel.collapsed .lensed-header { border-bottom: none; }\
    .lensed-title {\
      font-weight: 600; font-size: 12px; letter-spacing: 0.3px; color: #a5a5ff;\
      display: flex; align-items: center; gap: 6px;\
    }\
    .lensed-badge {\
      background: #6366f1; color: #fff; font-size: 10px; font-weight: 700;\
      padding: 1px 6px; border-radius: 9px; min-width: 14px; text-align: center;\
    }\
    .lensed-toggle {\
      background: none; border: none; color: #888; cursor: pointer;\
      font-size: 16px; padding: 0 2px; line-height: 1;\
    }\
    .lensed-toggle:hover { color: #e5e5e5; }\
    .lensed-body { overflow-y: auto; flex: 1; padding: 0; }\
    .lensed-panel.collapsed .lensed-body { display: none; }\
    \
    /* SKU controls */\
    .lensed-sku-bar {\
      padding: 8px 12px; border-bottom: 1px solid #2a2a2e; background: #151518;\
      display: flex; gap: 10px; align-items: stretch;\
    }\
    .lensed-sku-main { flex: 1; min-width: 0; }\
    .lensed-asp {\
      flex-shrink: 0; width: 124px; padding-left: 10px;\
      border-left: 1px solid #2a2a2e;\
      display: flex; flex-direction: column; align-items: flex-end;\
      justify-content: center; text-align: right;\
    }\
    .lensed-asp-label {\
      font-size: 9px; font-weight: 600; letter-spacing: 0.6px;\
      text-transform: uppercase; color: #777; margin-bottom: 2px;\
    }\
    .lensed-asp-value {\
      font-size: 48px; font-weight: 800; color: #34d399; line-height: 1;\
      white-space: nowrap;\
    }\
    .lensed-be-label {\
      font-size: 8px; font-weight: 600; letter-spacing: 0.5px;\
      text-transform: uppercase; color: #777; margin-top: 6px;\
    }\
    .lensed-be-value {\
      font-size: 14px; font-weight: 700; color: #9a9aa2; line-height: 1;\
      white-space: nowrap;\
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
    .lensed-resolved {\
      font-size: 11px; color: #34d399; margin-top: 4px; min-height: 16px;\
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;\
    }\
    .lensed-resolved.error { color: #f87171; }\
    .lensed-resolved:empty { display: none; }\
    .lensed-staged-count {\
      font-size: 11px; color: #9a9aa2; margin-top: 4px; min-height: 16px;\
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;\
    }\
    .lensed-staged {\
      display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; min-height: 0;\
    }\
    .lensed-staged:empty { display: none; }\
    .lensed-pill {\
      display: inline-flex; align-items: center; gap: 3px;\
      background: #6366f1; color: #fff; font-size: 11px; font-weight: 600;\
      padding: 2px 8px; border-radius: 10px;\
    }\
    .lensed-session-status {\
      font-size: 10px; color: #555; margin-top: 4px;\
    }\
    .lensed-session-status.active { color: #34d399; }\
    \
    /* Sales list */\
    .lensed-empty {\
      padding: 24px 12px; text-align: center; color: #555; font-size: 12px;\
    }\
    .lensed-sale {\
      display: flex; align-items: center; gap: 8px; padding: 6px 12px;\
      border-bottom: 1px solid #1e1e22; animation: lensed-fade-in 0.25s ease;\
    }\
    .lensed-sale:last-child { border-bottom: none; }\
    .lensed-sale.bound { border-left: 3px solid #6366f1; }\
    .lensed-sale-img {\
      width: 32px; height: 32px; border-radius: 4px; object-fit: cover;\
      flex-shrink: 0; background: #222;\
    }\
    .lensed-sale-info { flex: 1; min-width: 0; }\
    .lensed-sale-top {\
      display: flex; justify-content: space-between; align-items: baseline; gap: 6px;\
    }\
    .lensed-sale-product {\
      font-size: 12px; font-weight: 500; white-space: nowrap;\
      overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0;\
    }\
    .lensed-sale-price {\
      font-size: 12px; font-weight: 600; color: #34d399; flex-shrink: 0;\
    }\
    .lensed-sale-meta {\
      font-size: 11px; color: #666; white-space: nowrap;\
      overflow: hidden; text-overflow: ellipsis;\
    }\
    .lensed-sale-sku { color: #6366f1; font-weight: 500; }\
    .lensed-sale-unpaid { color: #f59e0b; font-size: 10px; font-weight: 600; }\
    .lensed-sale-bound-tag {\
      font-size: 10px; color: #a5a5ff; font-weight: 500;\
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
    stagedCountEl.textContent = totalStagedUnits() + ' unit(s) staged';
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

  // Pill text: "#5" for a single unit, "#5 ×2" once quantity climbs.
  function pillLabel(s) {
    var qty = s.qty || 1;
    return qty > 1 ? '#' + s.sku_number + ' ×' + qty : '#' + s.sku_number;
  }

  function renderStagedPills() {
    if (!stagedListEl) return;
    stagedListEl.innerHTML = '';
    for (var i = 0; i < stagedSkus.length; i++) {
      var pill = el('span', 'lensed-pill');
      pill.textContent = pillLabel(stagedSkus[i]);
      if (stagedSkus[i].title) {
        pill.title = stagedSkus[i].title;
      }
      stagedListEl.appendChild(pill);
    }
    updateAspGoal();
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

  function formatDollars(cents) {
    var d = (cents || 0) / 100;
    return '$' + d.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  function updateAspGoal() {
    if (aspValueEl) aspValueEl.textContent = formatDollars(aspGoalCents());
    if (breakEvenValueEl) breakEvenValueEl.textContent = formatDollars(stagedCostCents());
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
    } else {
      stagedSkus.push({
        id: pendingResolve.id,
        sku_number: pendingResolve.sku_number,
        title: pendingResolve.title,
        qty: 1,
        qty_on_hand: cap,
        unit_cost_cents: pendingResolve.unit_cost_cents,
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
      return { id: s.id, sku_number: s.sku_number, title: s.title, qty: s.qty || 1, qty_on_hand: s.qty_on_hand, unit_cost_cents: s.unit_cost_cents };
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
    try {
      chrome.runtime.sendMessage({ type: 'RESOLVE_SKU', skuNumber: trimmed }, function (resp) {
        if (chrome.runtime.lastError) return;
        if (resp && resp.sku) {
          pendingResolve = resp.sku;
          setResolveLine('\u2713 #' + resp.sku.sku_number + ' ' + (resp.sku.title || ''), false);
        } else {
          pendingResolve = null;
          setResolveLine('SKU not found', true);
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
    try {
      chrome.runtime.sendMessage({ type: 'RESOLVE_SKU', skuNumber: trimmed }, function (resp) {
        if (chrome.runtime.lastError) return;
        if (resp && resp.sku) {
          pendingResolve = resp.sku;
          stageCurrentSku(); // stages (or +1 qty); clears input on success
        } else {
          setResolveLine('SKU not found', true);
        }
        // Always leave the field clean and ready for the next scan.
        if (skuInputEl) skuInputEl.value = '';
        pendingResolve = null;
      });
    } catch (_) {}
  }

  // ── Auto-bind: fire when a new sale arrives ────────────────────────

  // Auto-bind the staged set to a sale. Returns the bind-time snapshot (so the
  // caller can render the bound tag even after an auto-clear). On a SOLD sale we
  // clear the staged pills AFTER snapshotting, so the next auction can't bind to
  // a stale set; on not_sold we leave them so the host can re-run the same item.
  function autoBind(sale) {
    if (!sale || !sale.orderId) return [];
    // New order → binds (get() is undefined ≠ token). Same-status repeat →
    // skipped. Status flip (failed→paid) → binds again so the RPC can transition.
    var token = saleStatusToken(sale);
    if (boundOrderStatus.get(sale.orderId) === token) return [];
    boundOrderStatus.set(sale.orderId, token);

    // Snapshot staged SKUs for this bind (deep-copy so qty edits can't reach the snapshot)
    var skusForBind = stagedSkus.map(function (s) {
      return { id: s.id, sku_number: s.sku_number, title: s.title, qty: s.qty || 1, qty_on_hand: s.qty_on_hand, unit_cost_cents: s.unit_cost_cents };
    });

    if (skusForBind.length > 0) {
      // Save as previousSkus for re-run (independent copy). Persists across the
      // auto-clear below so the ↻ button can re-stage the last bound set.
      previousSkus = skusForBind.map(function (s) {
        return { id: s.id, sku_number: s.sku_number, title: s.title, qty: s.qty || 1, qty_on_hand: s.qty_on_hand, unit_cost_cents: s.unit_cost_cents };
      });
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

    // One winner per auction: clear staged pills on a sold bind, AFTER the
    // snapshot above (which is what the message + bound tag use). Background
    // maps the same status as: not_sold iff isPaymentSuccessful === false.
    var sold = sale.isPaymentSuccessful !== false;
    if (sold && skusForBind.length > 0) {
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

    var panel = el('div', 'lensed-panel collapsed');

    // ── Header ───────────────────────────────────────────────────
    var header = el('div', 'lensed-header');
    var title = el('div', 'lensed-title', 'Lensed');

    countEl = el('span', 'lensed-badge', '0');
    title.appendChild(countEl);

    var toggle = el('button', 'lensed-toggle', '+');
    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      collapsed = !collapsed;
      panel.classList.toggle('collapsed', collapsed);
      toggle.textContent = collapsed ? '+' : '\u2212';
    });

    header.appendChild(title);
    header.appendChild(toggle);

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
    });

    // - button: remove last staged
    var removeBtn = el('button', 'lensed-sku-btn', '\u2212');
    removeBtn.title = 'Remove last SKU';
    removeBtn.addEventListener('click', function () { removeLast(); });

    // \u21bb button: re-run the last bound SKU set
    var rerunBtn = el('button', 'lensed-sku-btn', '\u21bb');
    rerunBtn.title = 'Re-run last bound SKU set';
    rerunBtn.addEventListener('click', function () { rerunPrevious(); });

    skuRow.appendChild(skuInputEl);
    skuRow.appendChild(addBtn);
    skuRow.appendChild(removeBtn);
    skuRow.appendChild(rerunBtn);

    resolvedLabelEl = el('div', 'lensed-resolved', '');
    stagedCountEl = el('div', 'lensed-staged-count', '0 unit(s) staged');
    stagedListEl = el('div', 'lensed-staged');
    sessionStatusEl = el('div', 'lensed-session-status', 'Connecting\u2026');

    // Left column: input row + transient resolve line + always-on staged count
    // + staged pills + session status
    var skuMain = el('div', 'lensed-sku-main');
    skuMain.appendChild(skuRow);
    skuMain.appendChild(resolvedLabelEl);
    skuMain.appendChild(stagedCountEl);
    skuMain.appendChild(stagedListEl);
    skuMain.appendChild(sessionStatusEl);

    // Right column: large live ASP goal + smaller break-even underneath
    var aspBox = el('div', 'lensed-asp');
    var aspLabel = el('div', 'lensed-asp-label', 'ASP Goal');
    aspValueEl = el('div', 'lensed-asp-value', '$0');
    var beLabel = el('div', 'lensed-be-label', 'Break-even');
    breakEvenValueEl = el('div', 'lensed-be-value', '$0');
    aspBox.appendChild(aspLabel);
    aspBox.appendChild(aspValueEl);
    aspBox.appendChild(beLabel);
    aspBox.appendChild(breakEvenValueEl);

    skuBar.appendChild(skuMain);
    skuBar.appendChild(aspBox);

    // ── Sales list ───────────────────────────────────────────────
    var body = el('div', 'lensed-body');
    salesListEl = el('div', '');
    var empty = el('div', 'lensed-empty', 'Waiting for sales\u2026');
    salesListEl.appendChild(empty);
    body.appendChild(salesListEl);

    panel.appendChild(header);
    panel.appendChild(skuBar);
    panel.appendChild(body);
    shadowRoot.appendChild(panel);

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

    document.body.appendChild(host);

    // Re-render staged pills + count if we had them before a re-inject
    renderStagedPills();
    updateStagedLabel();

    // Request auth status from background
    try {
      chrome.runtime.sendMessage({ type: 'GET_AUTH_STATUS' }, function (resp) {
        if (chrome.runtime.lastError) return;
        if (resp) updateAuthStatus(resp.authenticated, resp.userId);
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

    salesCount++;
    if (countEl) countEl.textContent = String(salesCount);

    var row = el('div', 'lensed-sale' + (wasBound ? ' bound' : ''));

    if (sale.imageUrl) {
      var img = document.createElement('img');
      img.className = 'lensed-sale-img';
      img.src = sale.imageUrl;
      img.alt = '';
      img.loading = 'lazy';
      row.appendChild(img);
    }

    var info = el('div', 'lensed-sale-info');
    var top = el('div', 'lensed-sale-top');
    var product = el('span', 'lensed-sale-product', sale.productName || 'Unknown');
    var price = el('span', 'lensed-sale-price', sale.sellingPrice || '$0');
    top.appendChild(product);
    top.appendChild(price);

    var meta = el('div', 'lensed-sale-meta');
    var metaParts = [];
    if (sale.buyerUsername) metaParts.push('@' + sale.buyerUsername);
    if (sale.platformSkuRef) metaParts.push('<span class="lensed-sale-sku">#' + sale.platformSkuRef + '</span>');
    meta.innerHTML = metaParts.join(' \u00B7 ');

    if (sale.isPaymentSuccessful === false) {
      var unpaid = el('span', 'lensed-sale-unpaid', ' UNPAID');
      meta.appendChild(unpaid);
    }

    info.appendChild(top);
    info.appendChild(meta);

    // Bound tag uses the bind-time snapshot (staged pills may have been
    // auto-cleared on a sold bind).
    if (wasBound && boundSkus && boundSkus.length > 0) {
      var boundTag = el('div', 'lensed-sale-bound-tag');
      var skuNums = boundSkus.map(function (s) { return pillLabel(s); });
      boundTag.textContent = '\u2192 ' + skuNums.join(', ');
      info.appendChild(boundTag);
    }

    row.appendChild(info);

    salesListEl.insertBefore(row, salesListEl.firstChild);
    while (salesListEl.children.length > MAX_VISIBLE_SALES) {
      salesListEl.removeChild(salesListEl.lastChild);
    }
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
    // Our input lives in the shadow DOM: when focused, shadowRoot.activeElement
    // is the input (document.activeElement is just the host). Let it type.
    if (shadowRoot && shadowRoot.activeElement === skuInputEl) return;
    // Don't hijack typing in the host page's own fields either.
    if (isEditableTarget(document.activeElement)) return;

    if (e.key === '+') {
      e.preventDefault();
      addAnotherUnitOfLast();
    } else if (e.key === '-') {
      e.preventDefault();
      removeLast();
    } else if (e.key === '*') {
      e.preventDefault();
      rerunPrevious();
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
    }
  });

  console.log('[LENSED][TT] content bridge + overlay installed');
})();
