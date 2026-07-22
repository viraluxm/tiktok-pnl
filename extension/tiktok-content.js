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
 * - Overlay controls: Start (TikTok auction), + (add/stage), ↻ (re-run previous)
 * - Macro/numpad hotkeys: NumpadAdd → Start auction (discovery only this phase;
 *   activation pending live-test), NumpadSubtract → add unit, NumpadMultiply → restage
 * - On new sale: auto-bind fires, logs to lensed_log_auction + capture_events
 * - order_id locks after logging (no double-bind on cumulative re-polls)
 */
(function () {
  'use strict';

  // Duplicate-injection guard. Set on window (shared across ISOLATED-world injections
  // of the same frame) so a re-injection (dev reload / executeScript) becomes a full
  // no-op instead of doubling every top-level listener, the observer, and the counter.
  if (window.__lensedContentLoaded) return;
  window.__lensedContentLoaded = true;

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
  var sessionStatusEl = null;    // compact combined row: "Connected · ● account"
  var authConnected = false;     // last auth state (drives the status row)
  var authStatusReceived = false; // keep "Connecting…" until the first auth status arrives
  var capturedOnlyWarnEl = null; // visible "orders captured but not bound" warning
  var queueBannerEl = null;      // FAIL-LOUD: "NOT SIGNED IN — N sales queued, not saved"
  var queuedSalesCount = 0;      // sales captured-but-unsaved (from background auth status)
  var lastScanEl = null;         // temporary visible "Last scan: … · <state>" line
  var diagStatusEl = null;       // dev-only "◉ Diagnostics ON · N events" indicator
  var diagPollStarted = false;   // single count-refresh interval across re-injects
  var scanDetectLogged = false;  // collapse per-character 'detected' diag to one per scan attempt
  var reopenOverlay = null;      // module handle to reopen the overlay from the global scanner
  var shotStatusEl = null;       // [SCREENSHOT] compact counts (inside debug row)
  var shotWarnEl = null;         // [SCREENSHOT] storage/capture warning (debug row)
  var shotDebugEl = null;        // [SCREENSHOT] collapsed debug row (hidden unless enabled)
  var shotDotEl = null;          // [SCREENSHOT] tiny header toggle dot
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
  // Persisted staged-SKU selection, scoped to a session id. Restored after a Live
  // Manager reload / SW restart / reconnect so a mid-auction selection survives;
  // cleared on session/room change so a new live never inherits it.
  var LK_STAGED = 'lensed_staged_skus';
  // Pre-first-sale durable state. Before the first bound sale creates a live session
  // there is no session id, so LK_COUNTER/LK_STAGED (session-scoped) cannot persist.
  // This ONE record holds staged SKUs + counter + host BEFORE a session exists, scoped
  // by the strongest available context (Lensed user id + TikTok room id + timestamp).
  // adoptSession() migrates it into the session-scoped records once a session is
  // created, then removes it. Written only when BOTH user and room are known.
  var LK_PRESESSION = 'lensed_presession_state';
  var PRESESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12h — mirrors background session-reuse cutoff
  var preSessionRestoreDone = false;               // restore pre-session state once per user+room
  var authUserId = null;                           // current Lensed user id (from auth status) — for user-scoping
  // The live's detected tiktok room (mirrors what inject relays to background). Used
  // to scope persisted staged SKUs.
  var currentRoomId = null;
  // Tab-alive heartbeat: while this live tab is open, ping the background every
  // HEARTBEAT_MS so it can advance live_sessions.last_seen_at (a tab-alive signal,
  // independent of auctions). The interval dies with the content script on tab close.
  var HEARTBEAT_MS = 45000;
  var heartbeatTimer = null;
  // Detected tiktok host account from the MAIN-world injector's API path (room
  // owner/anchor, relayed as 'lensed-tiktok-account'). Display only — labels the
  // overlay; takes priority over the DOM label. See renderAccount / renderStatusLine.
  var currentAccount = null;
  // Account label read from the VISIBLE Live Manager dashboard DOM (top-right account
  // area). Detection-verification fallback only — display-only, never forwarded to the
  // background/session logic. API detection (currentAccount) takes priority. See
  // detectVisibleAccount / renderStatusLine.
  var domAccountLabel = null;
  // Half-2: the DOM-read channel name is sent to the background (→ persisted on the
  // session, → mapped to a store). Dedup key = name|room so it re-sends when either
  // changes (e.g. label detected before the room, then the room arrives).
  var lastChannelNameSentKey = null;
  // GUARDRAIL 2 corroboration: a weak (S3, score-6) DOM label must be seen twice in a row
  // before it's trusted; strategy/score are threaded to the SW for always-on logging.
  var weakCandidateLabel = null;
  var lastDetectWhy = null;
  var lastDetectScore = null;
  // Count of orders captured this session that did NOT bind to a SKU (nothing staged
  // at capture time). Surfaced as a visible overlay warning so it is never silent.
  var capturedOnlyCount = 0;
  var bindIssueCount = 0;        // orders whose capture/bind WRITE failed (background reported ok:false)
  var lastBindIssueReason = null;
  // ── [SCREENSHOT] Capture state — OFF by default, opt-in, lazy ───────
  // The screenshot feature must NEVER slow the core flow. It is disabled by
  // default (chrome.storage key LK_SHOTS), initializes lazily well after the
  // overlay/order system is stable, does NO polling, and only end-captures LIVE
  // sales (never the reload backlog). Auto-start via DOM is disabled for now
  // (fired before the video was ready → no_video). Manual "Test capture" only.
  var LK_SHOTS = 'lensed_shots_enabled';
  var SHOTS_DEBUG = false;              // verbose screenshot logs (off in prod)
  var shotsEnabled = false;             // feature toggle (persisted)
  var shotsReady = false;               // lazy-init complete + past catch-up
  // Per-order auction_end dedup: order_ids we've already captured/uploaded a screenshot
  // for. In-memory catches within-session re-fires; persisted (scoped to session) so a
  // reload/catch-up within the freshness window doesn't re-upload. (The SW's
  // deterministic 'end-<order_id>' key is the hard idempotency backstop.)
  var LK_SHOT_ENDS = 'lensed_shot_end_orders';
  var shotEndOrderIds = Object.create(null);
  var cachedVideo = null;               // resolved <video>, revalidated per capture
  var shotFailLogged = false;           // log first capture failure only, then quiet
  var currentAuctionAttemptId = null;   // active attempt (auto-start disabled → null)
  var auctionSaleSeenForAttempt = false;
  var shotStatus = null;                // latest SHOT_STATUS from background
  var lastCaptureTs = 0;

  // ── Live host selector ─────────────────────────────────────────────
  // The MANUAL host running this live (a person from Lensed's Team/Employees roster) —
  // deliberately distinct from the AUTO-detected TikTok account/shop shown in the status
  // line (currentAccount / domAccountLabel). Never auto-filled from the account. Persisted
  // per room/session so a Live Manager reload restores it, and re-asserted to the worker
  // so live_sessions.host_id survives a service-worker restart.
  var LK_HOST = 'lensed_selected_host';
  var hosts = [];             // active employees [{id, name, role}, ...] for the dropdown
  var selectedHostId = null;  // id of the chosen employee (host) for this live
  var hostRowEl = null;
  var hostSelectEl = null;
  var hostWarnEl = null;

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

  // ── Freeze-hardening: single-attach document handlers + diagnostics ──────
  // The overlay is rebuilt on every SPA re-inject / fullscreen change. Document-
  // level drag/resize listeners MUST attach ONCE per page — never per rebuild — or
  // they accumulate into thousands of mousemove handlers and progressively freeze
  // the tab (the reported bug). These module-scoped handlers act on `activePanel`
  // (the current overlay) via shared drag/resize state, so a rebuild only swaps the
  // panel reference; the document listener count stays flat.
  var activePanel = null;
  var dragState = { on: false, offX: 0, offY: 0 };
  var resizeState = { on: false, startX: 0, startY: 0, startW: 0, startH: 0 };
  var docHandlersAttached = false;
  var pageWiringActive = false;     // overlay + observer + fullscreen listeners are live
  var windowLifecycleBound = false; // pagehide/pageshow bound once (survive bfcache)
  var overlayObserver = null;       // module-scoped so cleanup can disconnect it

  // Cap for the per-order dedup Maps — a pathological-safety net so a single very
  // long live can't grow them without bound. Normal lives stay far below this.
  var MAP_CAP = 5000;
  function capMap(m) { if (m.size > MAP_CAP) { var k = m.keys().next().value; m.delete(k); } }

  // Lightweight diagnostics — inspect via `window.__lensedDiag` in the content-script
  // context, or call lensedLogDiag(). Cheap counters only.
  var diag = {
    overlayCreateCount: 0,      // createOverlay() invocations
    overlayRemountCount: 0,     // ensureOverlay() calls that actually rebuilt a removed overlay
    overlayRelocateCount: 0,    // fullscreen relocate (move host, no rebuild)
    docListenerAttachCount: 0,  // times the document drag/resize pair was attached (must stay 1)
    observerRebuildCount: 0,    // MutationObserver-triggered rebuilds
    lastCaptureTs: 0,           // last relayed sale rendered (ms)
    lastBindTs: 0,              // last AUTO_BIND dispatched (ms)
  };
  try { window.__lensedDiag = diag; } catch (_) {}
  function lensedLogDiag() { try { console.log('[LENSED][TT][diag]', JSON.stringify(diag)); } catch (_) {} }

  function overlayMaxW() { return Math.min(OVERLAY_MAX_W, window.innerWidth - 32); }
  function overlayMaxH() { return Math.min(OVERLAY_MAX_H, window.innerHeight - 32); }
  function clampW(w) { return Math.max(OVERLAY_MIN_W, Math.min(overlayMaxW(), w)); }
  function clampH(h) { return Math.max(OVERLAY_MIN_H, Math.min(overlayMaxH(), h)); }

  // Persist overlay size + hidden prefs (module state). Shared by the hoisted
  // document handlers and the in-overlay buttons.
  function persistPrefs() {
    try {
      chrome.storage.local.set({
        lensed_overlay_size: overlaySize,
        lensed_overlay_orders_hidden: ordersHidden,
        lensed_overlay_hidden: hidden
      });
    } catch (_) {}
  }

  // The ONE pair of document pointer handlers, shared across every overlay rebuild.
  function onDocMouseMove(e) {
    var panel = activePanel;
    if (!panel) return;
    if (dragState.on) {
      panel.style.left = (e.clientX - dragState.offX) + 'px';
      panel.style.top = (e.clientY - dragState.offY) + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    } else if (resizeState.on) {
      panel.style.width = clampW(resizeState.startW + (e.clientX - resizeState.startX)) + 'px';
      panel.style.height = clampH(resizeState.startH + (e.clientY - resizeState.startY)) + 'px';
    }
  }
  function onDocMouseUp() {
    var panel = activePanel;
    if (dragState.on) { dragState.on = false; if (panel) panel.style.transition = ''; }
    if (resizeState.on) {
      resizeState.on = false;
      if (panel) {
        panel.style.transition = '';
        var rect = panel.getBoundingClientRect();
        overlaySize = { width: Math.round(rect.width), height: Math.round(rect.height) };
        persistPrefs();
      }
    }
  }
  function attachDocHandlersOnce() {
    if (docHandlersAttached) return;
    docHandlersAttached = true;
    document.addEventListener('mousemove', onDocMouseMove);
    document.addEventListener('mouseup', onDocMouseUp);
    diag.docListenerAttachCount++;
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
    /* Start: page-affecting action — visually distinct from the indigo inventory\
       controls (green accent, text label, separated by a right margin). */\
    .lensed-sku-btn.start {\
      width: auto; padding: 0 12px; height: 34px; font-size: 12px; font-weight: 600;\
      letter-spacing: 0.02em; margin-right: 4px;\
      background: #10b981; border-color: #059669; color: #fff;\
    }\
    .lensed-sku-btn.start:hover { background: #0ea371; border-color: #10b981; color: #fff; }\
    .lensed-resolved {\
      font-size: 11px; color: #34d399; margin-top: 4px; min-height: 16px;\
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;\
    }\
    .lensed-resolved.error { color: #f87171; }\
    .lensed-resolved:empty { display: none; }\
    .lensed-lastscan {\
      font-size: 10px; color: #9aa0aa; margin-top: 3px; min-height: 14px;\
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;\
    }\
    .lensed-lastscan.ok { color: #34d399; }\
    .lensed-lastscan.error { color: #f87171; }\
    /* Current-item card — the single most prominent element for the host. */\
    .lensed-current-card {\
      margin-top: 10px; padding: 12px 14px; border-radius: 12px;\
      border: 2px solid #4f46e5;\
      background: linear-gradient(180deg, rgba(99,102,241,0.16), rgba(99,102,241,0.05));\
      box-shadow: 0 0 0 3px rgba(99,102,241,0.18), 0 6px 22px rgba(79,70,229,0.28);\
    }\
    /* Muted empty state (Chrome 114+ :has) when nothing is staged. */\
    .lensed-current-card:has(.lensed-staged:empty) {\
      border-color: #2f2f36; background: #151518; box-shadow: none;\
    }\
    .lensed-current-head {\
      font-size: 10px; font-weight: 800; letter-spacing: 1px;\
      text-transform: uppercase; color: #a5b4ff; margin-bottom: 8px;\
    }\
    .lensed-current-card:has(.lensed-staged:empty) .lensed-current-head { color: #6b7280; }\
    .lensed-staged-count {\
      font-size: 10px; color: #8a8a92; font-weight: 700; letter-spacing: 0.5px;\
      text-transform: uppercase; margin-top: 8px; min-height: 14px;\
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;\
    }\
    .lensed-staged {\
      display: flex; flex-direction: column; gap: 8px; margin-top: 0; min-height: 0;\
    }\
    .lensed-staged:empty { display: none; }\
    /* Staged item — LARGE, high-contrast current item: "1× iPad Air 2nd Gen · #1" */\
    .lensed-staged-item {\
      display: flex; align-items: baseline; gap: 8px; width: 100%;\
      box-sizing: border-box; overflow: hidden;\
      color: #ffffff; font-size: 22px; font-weight: 800; line-height: 1.2;\
    }\
    .lensed-si-title { min-width: 0; overflow: hidden; word-break: break-word; }\
    .lensed-si-num { color: #a5b4ff; font-weight: 700; font-size: 15px; flex-shrink: 0; }\
    .lensed-si-num::before { content: "\\00B7 "; }\
    .lensed-si-remove {\
      margin-left: auto; flex-shrink: 0; cursor: pointer; align-self: center;\
      background: transparent; border: none; color: #9aa0aa;\
      font-size: 16px; line-height: 1; padding: 2px 7px; border-radius: 6px;\
    }\
    .lensed-si-remove:hover { color: #ff6b6b; background: rgba(255,107,107,0.14); }\
    .lensed-session-status {\
      font-size: 10px; color: #555; margin-top: 4px;\
    }\
    .lensed-session-status.active { color: #34d399; }\
    .lensed-acct-sep { color: #4b5563; }\
    .lensed-acct-dot { color: #34d399; }\
    .lensed-acct-name { color: #9ca3af; }\
    .lensed-acct-warn { color: #6b7280; }\
    .lensed-host-row { display: flex; align-items: center; gap: 6px; margin-top: 5px; font-size: 12px; }\
    .lensed-host-label { color: #9ca3af; flex: 0 0 auto; }\
    .lensed-host-select {\
      flex: 1 1 auto; min-width: 0; background: #17171a; color: #e5e5e5;\
      border: 1px solid #2a2a2e; border-radius: 6px; padding: 3px 6px;\
      font-size: 12px; font-family: inherit; cursor: pointer;\
    }\
    .lensed-host-select:focus { outline: none; border-color: #34d399; }\
    .lensed-host-warn { color: #d1a054; font-size: 11px; flex: 0 0 auto; white-space: nowrap; }\
    /* Top status bar (below header): connection + host, moved out of the work area. */\
    .lensed-statusbar {\
      display: flex; align-items: center; flex-wrap: wrap; gap: 4px 12px;\
      padding: 6px 12px; background: #151517; border-bottom: 1px solid #2a2a2e; flex-shrink: 0;\
    }\
    .lensed-statusbar .lensed-session-status {\
      margin-top: 0; flex: 1 1 140px; min-width: 0;\
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;\
    }\
    .lensed-statusbar .lensed-host-row { margin-top: 0; flex: 1 1 200px; min-width: 150px; justify-content: flex-end; }\
    /* Captured-only warning — orders are recording but not binding to a SKU */\
    .lensed-warn {\
      margin-top: 8px; padding: 7px 9px; border-radius: 7px;\
      background: #422006; border: 1px solid #b45309; color: #fed7aa;\
      font-size: 11px; font-weight: 700; line-height: 1.35;\
      white-space: normal;\
    }\
    .lensed-warn:empty { display: none; }\
    /* FAIL-LOUD: sales queued but NOT saved while signed out. Unmissable. */\
    .lensed-queue-banner {\
      margin: 0 0 8px 0; padding: 9px 11px; border-radius: 8px;\
      background: #7f1d1d; border: 1px solid #ef4444; color: #fee2e2;\
      font-size: 12px; font-weight: 800; line-height: 1.35; text-align: center;\
      animation: lensed-queue-pulse 1.6s ease-in-out infinite;\
    }\
    .lensed-queue-banner:empty { display: none; }\
    @keyframes lensed-queue-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.55); } 50% { box-shadow: 0 0 0 4px rgba(239,68,68,0); } }\
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
      font-size: 12px; font-weight: 700; color: #9a9aff; margin-bottom: 4px;\
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;\
    }\
    .lensed-note {\
      font-size: 13px; color: #c9c9d2; line-height: 1.45; padding-left: 17px;\
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
  var gLastInterkey = 0;          // inter-key gap of the most recent buffered char
  var gScanTimer = null;          // idle-commit timer (for scanners that omit Enter)
  var SCAN_IDLE_COMMIT_MS = 130;  // quiet gap after the last burst char → auto-commit

  function resetGlobalScan() {
    gScanBuffer = ''; gScanFirst = 0; gScanLast = 0; gScanCount = 0; gLastInterkey = 0;
    if (gScanTimer) { clearTimeout(gScanTimer); gScanTimer = null; }
  }

  function globalLooksLikeScan() {
    if (gScanCount < SCAN_MIN_LENGTH) return false;
    var elapsed = gScanLast - gScanFirst;
    return elapsed < gScanCount * SCAN_MAX_INTERKEY_MS && elapsed < SCAN_MAX_TOTAL_MS;
  }

  // ── Scanner dev diagnostics + visible last-scan status ──────────────
  // Dev logging opt-in: localStorage 'lensed_dev'='1' (or 'lensed_scan_debug'='1').
  // Explains WHY a burst was accepted or rejected, for live troubleshooting.
  function lensedDevOn() {
    try { return localStorage.getItem('lensed_dev') === '1' || localStorage.getItem('lensed_scan_debug') === '1'; } catch (_) { return false; }
  }
  function slog(msg, data) {
    if (!lensedDevOn()) return;
    if (data !== undefined) console.log('[LENSED][SCAN] ' + msg, data);
    else console.log('[LENSED][SCAN] ' + msg);
  }

  // Redact a raw scanned value for the on-stream status line: keep head/tail, mask
  // the middle so a full barcode is never shown on camera.
  function redactScan(v) {
    v = String(v || '');
    if (v.length <= 4) return v.replace(/[^\s]/g, '•');
    return v.slice(0, 2) + '•••' + v.slice(-2);
  }

  // ── Diagnostics (dev-only flight recorder) ─────────────────────────
  // Forwards redacted events to the SW ring buffer. Gated on lensed_dev /
  // lensed_diagnostics; no-op + try-wrapped otherwise, so it can never affect
  // scan/stage/capture. `label`s passed here are already redacted or safe (#num).
  function diagOn() {
    if (lensedDevOn()) return true;
    try { return localStorage.getItem('lensed_diagnostics') === '1'; } catch (_) { return false; }
  }
  var DIAG_VERSION = (function () { try { return chrome.runtime.getManifest().version; } catch (_) { return '?'; } })();
  // NOTE: named dlog (not diag) — `diag` is already an in-memory counters object.
  function dlog(type, sev, msg, meta) {
    if (!diagOn()) return;
    try {
      chrome.runtime.sendMessage(
        { type: 'DIAG_EVENT', event: { ts: Date.now(), v: DIAG_VERSION, comp: 'content', type: type, sev: sev || 'info', msg: msg || '', meta: meta || null } },
        function () { void chrome.runtime.lastError; }
      );
    } catch (_) {}
  }
  // Ask the SW how many events it has recorded and paint the indicator, so the host
  // can SEE the recorder is actually capturing (not silently empty like the first run).
  function refreshDiagCount() {
    if (!diagStatusEl) return;
    try {
      chrome.runtime.sendMessage({ type: 'DIAG_COUNT' }, function (resp) {
        if (chrome.runtime.lastError || !resp || !diagStatusEl) return;
        diagStatusEl.textContent = '◉ Diagnostics ON · ' + (resp.count || 0) + ' events';
      });
    } catch (_) {}
  }

  // Download the SW diagnostic ring as a JSON file (dev-only export button).
  function exportDiagnostics() {
    try {
      chrome.runtime.sendMessage({ type: 'DIAG_EXPORT' }, function (resp) {
        if (chrome.runtime.lastError || !resp) return;
        var payload = { tool: 'lensed-extension', exported_at: new Date().toISOString(), version: resp.v, diag_build: resp.build || null, commit: resp.commit || null, count: resp.count, events: resp.events || [] };
        try {
          var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url; a.download = 'lensed-diagnostics-' + Date.now() + '.json';
          (document.body || document.documentElement).appendChild(a);
          a.click();
          setTimeout(function () { try { URL.revokeObjectURL(url); a.remove(); } catch (_) {} }, 1500);
        } catch (_) {}
      });
    } catch (_) {}
  }

  // Temporary visible last-scan status so hosts can SEE a scan actually happened.
  // state: detected | searching | staged | notfound | failed. `label` overrides the
  // left value (e.g. the resolved "#14"); pass null to keep it generic.
  function setScanStatus(label, state) {
    // Diagnostics noise control: the input path calls this on EVERY keystroke of a
    // burst with state 'detected'. Log at most ONE scan.detected per attempt; a terminal
    // state (staged/notfound/failed) re-arms it. searching + terminals stay logged (they
    // are one-per-attempt), so the flight recorder keeps the useful events without spam.
    if (state === 'detected') {
      if (!scanDetectLogged) { scanDetectLogged = true; dlog('scan.detected', 'info', 'scan detected', { label: label || null }); }
    } else {
      if (state === 'staged' || state === 'notfound' || state === 'failed') scanDetectLogged = false;
      dlog('scan.status', (state === 'notfound' || state === 'failed') ? 'warn' : 'info', 'scan ' + state, { state: state, label: label || null });
    }
    if (!lastScanEl) return;
    var words = { detected: 'detected', searching: 'searching…', staged: 'staged ✓', notfound: 'no SKU matched', failed: 'failed' };
    var cls = (state === 'staged') ? ' ok' : (state === 'notfound' || state === 'failed') ? ' error' : '';
    lastScanEl.className = 'lensed-lastscan' + cls;
    lastScanEl.textContent = 'Last scan: ' + (label || '—') + ' · ' + (words[state] || state || '');
  }

  // Commit the buffered global scan if it still passes the burst heuristic. Shared
  // by the Enter path and the idle timer (no-Enter scanners). Never commits human
  // typing — globalLooksLikeScan() gates it.
  function commitGlobalScanIfReady(reason) {
    if (gScanTimer) { clearTimeout(gScanTimer); gScanTimer = null; }
    if (globalLooksLikeScan()) {
      var scanned = gScanBuffer;
      slog('commit (' + reason + ')', { value: redactScan(scanned), count: gScanCount });
      resetGlobalScan();
      globalScanCommit(scanned);
      return true;
    }
    slog('commit skipped — not a scan (' + reason + ')', { count: gScanCount, value: redactScan(gScanBuffer) });
    resetGlobalScan();
    return false;
  }
  function scheduleGlobalIdleCommit() {
    if (gScanTimer) clearTimeout(gScanTimer);
    gScanTimer = setTimeout(function () { gScanTimer = null; commitGlobalScanIfReady('idle'); }, SCAN_IDLE_COMMIT_MS);
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
      // Per-pill remove (✕): drops THIS specific staged SKU (better than "remove last"
      // — lets the host clear a mis-scanned item). IIFE captures this row's id.
      var rm = el('button', 'lensed-si-remove', '✕');
      rm.title = 'Remove ' + (title || ('#' + s.sku_number));
      (function (id) {
        rm.addEventListener('click', function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          removeStagedItem(id);
        });
      })(s.id);
      item.appendChild(rm);
      stagedListEl.appendChild(item);
    }
    updateAspGoal();
    renderTalkingPoints();
  }

  // Remove ONE staged SKU by id, then refresh the stage exactly like add-unit does
  // (renderStagedPills re-runs updateAspGoal + renderTalkingPoints, so the ASP-goal /
  // break-even display and talking points update too). No-op if the id isn't staged.
  function removeStagedItem(id) {
    var before = stagedSkus.length;
    stagedSkus = stagedSkus.filter(function (s) { return s.id !== id; });
    if (stagedSkus.length === before) return;
    renderStagedPills();
    clearResolveLine();
    updateStagedLabel();
    persistStaged();
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
    persistStaged();
  }

  // Add another unit of the most recently staged SKU (respects the stock cap).
  // Bound to the NumpadSubtract macro key (macro button 2) and the standalone "-".
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
    persistStaged();
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
    persistStaged();
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
    setScanStatus(redactScan(trimmed), 'searching');
    try {
      chrome.runtime.sendMessage({ type: 'RESOLVE_SKU', skuNumber: trimmed }, function (resp) {
        if (chrome.runtime.lastError) {
          setResolveLine(MSG_LOOKUP_FAILED, true);
          setScanStatus(redactScan(trimmed), 'failed');
          if (skuInputEl) skuInputEl.value = '';
          pendingResolve = null;
          return;
        }
        if (resp && resp.sku) {
          pendingResolve = resp.sku;
          stageCurrentSku(); // stages (or +1 qty); clears input + resolve line on success
          setScanStatus('#' + resp.sku.sku_number + ' ' + (resp.sku.title || ''), 'staged');
        } else {
          showResolveMiss(resp && resp.status);
          var st = resp && resp.status;
          setScanStatus(redactScan(trimmed), (st === 'not_authenticated' || st === 'error') ? 'failed' : 'notfound');
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
    // A scan committed while the overlay is hidden must NOT be silently dropped:
    // reopen the overlay so the host sees the staged result (req 4a).
    if (hidden && typeof reopenOverlay === 'function') { try { reopenOverlay(); } catch (_) {} }
    setResolveLine(MSG_SEARCHING, false); // show progress; miss only after lookup
    setScanStatus(redactScan(trimmed), 'searching');
    try {
      chrome.runtime.sendMessage({ type: 'RESOLVE_SKU', skuNumber: trimmed }, function (resp) {
        if (chrome.runtime.lastError) {
          setResolveLine(MSG_LOOKUP_FAILED, true);
          setScanStatus(redactScan(trimmed), 'failed');
          slog('resolve failed (runtime.lastError)', { value: redactScan(trimmed) });
          pendingResolve = null;
          focusScanInput();
          return;
        }
        if (resp && resp.sku) {
          pendingResolve = resp.sku;
          stageCurrentSku(); // stages (or +1 qty) via the existing path
          setScanStatus('#' + resp.sku.sku_number + ' ' + (resp.sku.title || ''), 'staged');
          slog('staged', { sku: resp.sku.sku_number });
        } else {
          showResolveMiss(resp && resp.status);
          var st = resp && resp.status;
          setScanStatus(redactScan(trimmed), (st === 'not_authenticated' || st === 'error') ? 'failed' : 'notfound');
          slog('no SKU matched', { value: redactScan(trimmed), status: st });
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
    // The dedup token is committed AFTER the AUTO_BIND message is dispatched (below),
    // so a synchronous throw before dispatch can't permanently suppress a retry.

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
      capMap(sessionBoundSkus);
    }

    var dispatched = false;
    dlog('bind.sent', 'info', 'AUTO_BIND dispatched to background', { order: sale.orderId, staged: skusForBind.length, room: !!currentRoomId, session: !!counterSessionId });
    try {
      chrome.runtime.sendMessage({
        type: 'AUTO_BIND',
        sale: sale,
        stagedSkus: skusForBind,
      }, function (resp) {
        if (chrome.runtime.lastError) {
          console.error('[LENSED][TT] auto-bind sendMessage error:', chrome.runtime.lastError);
          dlog('bind.reply', 'error', 'AUTO_BIND no reply (runtime error)', { order: sale.orderId, error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'lastError' });
          return;
        }
        // Record the TRUTHFUL background result. resp.ok is false when the capture_events
        // write failed (even if the RPC succeeded → resp.partial). Surface it instead of
        // treating everything as good; the background retries the missing write.
        var ok = !!(resp && resp.ok);
        dlog('bind.reply', ok ? 'info' : 'warn', 'AUTO_BIND reply', {
          order: sale.orderId, ok: ok, bound: !!(resp && resp.bound), captureWritten: !!(resp && resp.captureWritten),
          partial: !!(resp && resp.partial), reason: (resp && resp.reason) || null, code: (resp && resp.code) || null, status: (resp && resp.status) || null,
        });
        if (resp && resp.ok === false && resp.reason !== 'no_staged' && resp.reason !== 'not_authenticated') {
          console.warn('[LENSED][TT] AUTO_BIND not fully OK:', sale.orderId, resp.reason, resp.code || '');
          showBindIssue(resp);
        }
      });
      dispatched = true;
    } catch (err) {
      console.error('[LENSED][TT] auto-bind dispatch failed:', err);
      dlog('bind.dispatch_failed', 'error', 'AUTO_BIND dispatch threw', { order: sale.orderId });
    }

    // Commit the dedup token only once the message actually dispatched, so a failed
    // dispatch leaves the order retry-able (and staged SKUs intact) instead of
    // silently suppressed.
    if (dispatched) {
      boundOrderStatus.set(sale.orderId, token);
      capMap(boundOrderStatus);
      diag.lastBindTs = Date.now();
    }

    // One winner per auction: clear the staged pills after a dispatched bind that had
    // a staged set — paid AND failed-payment alike — AFTER the snapshot + message and
    // after `previousSkus` was copied for the ↻ re-run. If dispatch failed we keep the
    // staged set so a retry can still bind.
    if (dispatched && skusForBind.length > 0) {
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
    persistStaged();       // persist the now-empty selection for this session
  }

  // ── Build overlay DOM ──────────────────────────────────────────────

  function createOverlay() {
    diag.overlayCreateCount++;
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

    // [SCREENSHOT] Tiny header dot — toggles the (default-off) debug section. Shown
    // ONLY in dev mode (localStorage.lensed_dev='1') so it never occupies host space.
    // Capture logic + persisted state are unchanged; applyShotsUi/renderShotStatus
    // guard on `if (shotDotEl)`, so a null dot in normal mode is a safe no-op.
    if (lensedDevOn()) {
      shotDotEl = el('button', 'lensed-toggle', '·');
      shotDotEl.title = 'Screenshots (debug)';
      shotDotEl.style.cssText = 'font-size:18px;line-height:1;opacity:0.35;';
      shotDotEl.addEventListener('click', function (e) { e.stopPropagation(); setShotsEnabled(!shotsEnabled); });
      controls.appendChild(shotDotEl);
    } else {
      shotDotEl = null;
    }

    header.appendChild(title);
    header.appendChild(controls);

    // ── SKU bar ──────────────────────────────────────────────────
    var skuBar = el('div', 'lensed-sku-bar');

    var skuRow = el('div', 'lensed-sku-row');

    skuInputEl = document.createElement('input');
    skuInputEl.className = 'lensed-sku-input';
    skuInputEl.type = 'text';
    skuInputEl.placeholder = 'Type or scan SKU';

    var inputScanTimer = null;
    skuInputEl.addEventListener('input', function () {
      clearTimeout(debounceTimer);
      var val = skuInputEl.value;
      debounceTimer = setTimeout(function () { resolveSkuInput(val); }, 200);
      // No-Enter scanner into the focused input: once the value is arriving as a
      // machine-fast burst, auto-stage after a short idle gap even without Enter.
      if (inputScanTimer) { clearTimeout(inputScanTimer); inputScanTimer = null; }
      if (looksLikeScan()) {
        setScanStatus(redactScan(val), 'detected');
        inputScanTimer = setTimeout(function () {
          inputScanTimer = null;
          if (looksLikeScan() && skuInputEl && skuInputEl.value) {
            scanCharCount = 0;
            handleScanCommit(skuInputEl.value);
          }
        }, SCAN_IDLE_COMMIT_MS);
      }
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

    // Start button: triggers the guarded Start-auction routine (macro NumpadAdd routes
    // to the SAME routine). Visually distinct (green) \u2014 it is page-affecting, unlike the
    // inventory controls. This phase performs discovery/state-validation only and stops
    // before clicking TikTok (activation pending live-test).
    var startBtn = el('button', 'lensed-sku-btn start', 'Start');
    startBtn.title = 'Start TikTok auction';
    startBtn.addEventListener('click', function () { runStartAuction('overlay'); });

    // + button: stage the resolved SKU (or another unit)
    var addBtn = el('button', 'lensed-sku-btn primary', '+');
    addBtn.title = 'Stage SKU';
    addBtn.addEventListener('click', function () {
      if (pendingResolve) {
        stageCurrentSku();
      }
      focusScanInput();
    });

    // \u21bb restage button \u2014 prominent secondary action (re-runs the last bound set)
    var rerunBtn = el('button', 'lensed-sku-btn restage', '\u21bb');
    rerunBtn.title = 'Restage previous SKUs';
    rerunBtn.addEventListener('click', function () { rerunPrevious(); focusScanInput(); });

    skuRow.appendChild(skuInputEl);
    skuRow.appendChild(startBtn);
    skuRow.appendChild(addBtn);
    skuRow.appendChild(rerunBtn);

    resolvedLabelEl = el('div', 'lensed-resolved', '');
    lastScanEl = el('div', 'lensed-lastscan', 'Last scan: —');
    stagedCountEl = el('div', 'lensed-staged-count', 'Nothing staged');
    stagedListEl = el('div', 'lensed-staged');
    notesListEl = el('div', 'lensed-notes');
    sessionStatusEl = el('div', 'lensed-session-status', 'Connecting\u2026');
    renderStatusLine(); // repaint combined status+account on re-inject (self-guards until auth known)

    // Host selector row \u2014 the MANUAL person running the live (Team/Employees roster),
    // kept visually + semantically separate from the auto-detected account above.
    hostRowEl = el('div', 'lensed-host-row');
    hostRowEl.appendChild(el('span', 'lensed-host-label', 'Host'));
    hostSelectEl = el('select', 'lensed-host-select');
    hostSelectEl.addEventListener('change', onHostChange);
    hostRowEl.appendChild(hostSelectEl);
    hostWarnEl = el('span', 'lensed-host-warn', '');
    hostRowEl.appendChild(hostWarnEl);
    renderHostOptions(); // paint from in-memory roster + current selection (self-guards on empty)

    queueBannerEl = el('div', 'lensed-queue-banner', '');
    renderQueueWarning(); // repaint on re-inject if sales are already queued
    capturedOnlyWarnEl = el('div', 'lensed-warn', '');
    renderCapturedOnlyWarning(); // repaint if a re-inject happens with a live count

    // [SCREENSHOT] Collapsed debug row — hidden unless the feature is enabled via
    // the header dot. Small, muted; never part of the main host workflow.
    shotDebugEl = el('div', '');
    shotDebugEl.style.cssText = 'display:none;margin-top:6px;font-size:10px;color:#8a8a92;';
    shotStatusEl = el('span', '', 'shots off');
    var shotTestBtn = el('button', 'lensed-sku-btn', 'Test');
    shotTestBtn.style.cssText = 'width:auto;padding:0 8px;font-size:10px;height:20px;margin-left:6px;';
    shotTestBtn.title = 'Test screenshot capture';
    shotTestBtn.addEventListener('click', function (e) { e.stopPropagation(); captureShot('manual'); });
    var shotClearBtn = el('button', 'lensed-sku-btn', 'Clear');
    shotClearBtn.style.cssText = 'width:auto;padding:0 8px;font-size:10px;height:20px;margin-left:4px;';
    shotClearBtn.title = 'Clear this live’s screenshots';
    shotClearBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!counterSessionId) return;
      if (typeof window.confirm === 'function' && !window.confirm('Delete this live’s local screenshots?')) return;
      try { chrome.runtime.sendMessage({ type: 'CLEAR_SHOTS', sessionId: counterSessionId, roomId: currentRoomId }, function (r) { if (r && r.status) applyShotStatus(r.status); }); } catch (_) {}
    });
    shotWarnEl = el('span', '');
    shotWarnEl.style.cssText = 'display:block;color:#f59e0b;margin-top:3px;';
    shotDebugEl.appendChild(shotStatusEl);
    shotDebugEl.appendChild(shotTestBtn);
    shotDebugEl.appendChild(shotClearBtn);
    shotDebugEl.appendChild(shotWarnEl);

    // Current-item card — the single most prominent element: big staged SKU(s) + unit count.
    var currentCard = el('div', 'lensed-current-card');
    currentCard.appendChild(el('div', 'lensed-current-head', 'Current item'));
    currentCard.appendChild(stagedListEl);
    currentCard.appendChild(stagedCountEl);

    // Stage section: scan row + transient resolve/scan feedback + big current-item card
    // + talking points + captured-only warning. Connection + host move to the top status
    // bar; the screenshot debug row is appended only in dev mode.
    var skuMain = el('div', 'lensed-sku-main');
    // Dev-only diagnostics indicator: proves the recorder is actually capturing
    // (count > 0) and gives a manual Test + Export right in the overlay.
    if (diagOn()) {
      var diagRow = el('div', '');
      diagRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:6px;font-size:10px;font-weight:700;color:#a5b4ff;';
      diagStatusEl = el('span', '', '◉ Diagnostics ON · … events');
      diagStatusEl.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      var diagTestBtn = el('button', 'lensed-sku-btn', 'Test');
      diagTestBtn.style.cssText = 'width:auto;padding:0 8px;font-size:10px;height:20px;';
      diagTestBtn.title = 'Emit a test diagnostic event';
      diagTestBtn.addEventListener('click', function (e) { e.stopPropagation(); dlog('diag.test', 'info', 'manual test event', { at: Date.now() }); setTimeout(refreshDiagCount, 200); });
      var diagExpBtn = el('button', 'lensed-sku-btn', 'Export');
      diagExpBtn.style.cssText = 'width:auto;padding:0 8px;font-size:10px;height:20px;';
      diagExpBtn.title = 'Download diagnostics JSON';
      diagExpBtn.addEventListener('click', function (e) { e.stopPropagation(); exportDiagnostics(); setTimeout(refreshDiagCount, 200); });
      diagRow.appendChild(diagStatusEl);
      diagRow.appendChild(diagTestBtn);
      diagRow.appendChild(diagExpBtn);
      skuMain.appendChild(diagRow);
      refreshDiagCount();
      if (!diagPollStarted) { diagPollStarted = true; try { setInterval(refreshDiagCount, 5000); } catch (_) {} }
    }

    skuMain.appendChild(skuRow);
    skuMain.appendChild(resolvedLabelEl);
    skuMain.appendChild(lastScanEl);
    skuMain.appendChild(currentCard);
    skuMain.appendChild(notesListEl);
    skuMain.appendChild(capturedOnlyWarnEl);
    if (lensedDevOn()) skuMain.appendChild(shotDebugEl);
    renderShotStatus();

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

    // Top status bar (below the header): connection + host selector, moved out of the
    // main work area so the scan row and current-item card own that space.
    var statusBar = el('div', 'lensed-statusbar');
    statusBar.appendChild(sessionStatusEl);
    statusBar.appendChild(hostRowEl);

    panel.appendChild(header);
    panel.appendChild(queueBannerEl); // top of panel, under the header — most visible
    panel.appendChild(statusBar);
    panel.appendChild(skuBar);
    panel.appendChild(body);
    // Unobtrusive runtime version marker (muted, bottom-left corner) for testing.
    var verStr = 'v?';
    try { verStr = 'v' + chrome.runtime.getManifest().version; } catch (_) {}
    // [VALIDATION] visible build tag so the correct unpacked folder is obvious on-screen.
    panel.appendChild(el('span', 'lensed-version', verStr + ' · sniffer-v2'));
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
    // Only the per-overlay mousedown lives here; the document mousemove/mouseup are
    // hoisted to module scope and attached ONCE (attachDocHandlersOnce) so a rebuild
    // never adds another document listener. mousedown sets the shared drag state and
    // points activePanel at THIS build.
    header.addEventListener('mousedown', function (e) {
      if (e.target === toggle) return;
      activePanel = panel;
      var rect = panel.getBoundingClientRect();
      dragState.offX = e.clientX - rect.left;
      dragState.offY = e.clientY - rect.top;
      dragState.on = true;
      panel.style.transition = 'none';
      e.preventDefault();
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

    // (clampW/clampH/overlayMax* and persistPrefs are module-level now, so the single
    // hoisted document resize handler can share them — see the freeze-hardening block.)

    // Hide/show the whole overlay. Hidden → panel gone, floating tab shown.
    function applyHidden() {
      panel.style.display = hidden ? 'none' : '';
      if (reopenTab) reopenTab.style.display = hidden ? '' : 'none';
    }
    // Expose a module-level reopen so the global wedge-scanner (defined outside this
    // closure) can pop the overlay back open when a scan lands while it's hidden.
    reopenOverlay = function () { setHidden(false); };

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
      activePanel = panel;
      var rect = panel.getBoundingClientRect();
      resizeState.startX = e.clientX;
      resizeState.startY = e.clientY;
      resizeState.startW = rect.width;
      resizeState.startH = rect.height;
      resizeState.on = true;
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

    // Attach the shared document drag/resize handlers exactly once per page, and point
    // them at this (latest) build. Rebuilds never grow the document listener count.
    activePanel = panel;
    attachDocHandlersOnce();

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
          updateAuthStatus(resp.authenticated, resp.userId, resp.queuedSales);
          if (resp.sessionId) adoptSession(resp.sessionId);
        }
      });
    } catch (_) {}

    applyShotsUi(); // [SCREENSHOT] reflect current toggle state (no work if disabled)
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
    if (!counterSessionId) { persistPreSession(); return; }
    try {
      var rec = {};
      rec[LK_COUNTER] = {
        sessionId: counterSessionId,
        salesCount: salesCount,
        orderIds: Object.keys(seenOrderIds),
        capturedOnly: capturedOnlyCount
      };
      chrome.storage.local.set(rec);
    } catch (_) {}
  }

  // Persist the set of order_ids already auction_end-screenshotted, scoped to the live
  // session, so a reload within the freshness window doesn't re-upload. No-op until the
  // session id is known. (Deterministic 'end-<order_id>' key is the hard backstop.)
  function persistShotEnds() {
    if (!counterSessionId) return;
    try {
      var rec = {};
      rec[LK_SHOT_ENDS] = { sessionId: counterSessionId, orderIds: Object.keys(shotEndOrderIds) };
      chrome.storage.local.set(rec);
    } catch (_) {}
  }

  // Persist the current staged-SKU selection, scoped to the live session id, so a
  // Live Manager reload / SW restart restores it. A no-op until the session id is
  // known (nothing durable is written unscoped). Called on every staged-set change.
  function persistStaged() {
    if (!counterSessionId) { persistPreSession(); return; }
    try {
      var rec = {};
      rec[LK_STAGED] = { sessionId: counterSessionId, roomId: currentRoomId || null, skus: stagedSkus };
      chrome.storage.local.set(rec);
    } catch (_) {}
  }

  // ── Pre-session (pre-first-sale) durable state ─────────────────────────────
  // Persist staged SKUs + counter + host under ONE (userId, roomId, ts) record while no
  // session exists. Written ONLY with both a user and a room (never unscoped).
  function persistPreSession() {
    if (counterSessionId) return;              // a session exists → session-scoped persistence owns it
    if (!authUserId || !currentRoomId) return; // never persist without BOTH user and room
    try {
      var rec = {};
      rec[LK_PRESESSION] = {
        v: 1,
        userId: authUserId,
        roomId: currentRoomId,
        ts: Date.now(),
        skus: stagedSkus,
        salesCount: salesCount,
        orderIds: Object.keys(seenOrderIds),
        capturedOnly: capturedOnlyCount,
        hostId: selectedHostId || null
      };
      chrome.storage.local.set(rec);
    } catch (_) {}
  }

  // A stored pre-session record is restorable only for the SAME user + room, a well-formed
  // shape, and within the freshness window. Anything else is rejected (and cleared).
  function presessionMatches(rec) {
    return !!(rec && rec.v === 1 && authUserId && currentRoomId
      && rec.userId === authUserId && rec.roomId === currentRoomId
      && typeof rec.ts === 'number' && (Date.now() - rec.ts) <= PRESESSION_MAX_AGE_MS
      && Array.isArray(rec.skus));
  }

  // Restore pre-session staged/counter/host for the current user+room when no session
  // exists yet. Rejects+clears a record for a different user/room, stale, or malformed.
  // Runs at most once per user+room (re-armed on identity/room change and reset).
  function restorePreSession() {
    if (counterSessionId || preSessionRestoreDone) return;
    if (!authUserId || !currentRoomId) return;
    preSessionRestoreDone = true;
    try {
      chrome.storage.local.get([LK_PRESESSION], function (data) {
        if (chrome.runtime.lastError || !data) return;
        var rec = data[LK_PRESESSION];
        var userMatches = !!(rec && rec.userId === authUserId);
        var roomMatches = !!(rec && rec.roomId === currentRoomId);
        if (!presessionMatches(rec)) {
          if (rec) { try { chrome.storage.local.remove([LK_PRESESSION]); } catch (_) {} } // reject → clear
          // Flush any PRE-ROOM in-memory selection (host and/or staged SKUs picked BEFORE
          // the room was known — when persistPreSession no-ops for lack of a room) into a
          // durable record for THIS user+room, now that both are known. This runs AFTER the
          // read above, so it can never clobber a record mid-restore. persistSelectedHost
          // also refreshes the room-scoped LK_HOST; persistPreSession covers staged-only.
          if (!counterSessionId && (selectedHostId || stagedSkus.length > 0)) {
            if (selectedHostId) persistSelectedHost(); else persistPreSession();
          }
          console.log('[LENSED][TT] PRESESSION restore', { userMatches: userMatches, roomMatches: roomMatches, stagedCount: stagedSkus.length, hasHost: !!selectedHostId, hasCounter: salesCount > 0 });
          return;
        }
        stagedSkus = rec.skus.map(function (s) {
          return { id: s.id, sku_number: s.sku_number, title: s.title, qty: s.qty || 1, qty_on_hand: s.qty_on_hand, unit_cost_cents: s.unit_cost_cents, live_seller_notes: s.live_seller_notes || [] };
        });
        seenOrderIds = Object.create(null);
        if (Array.isArray(rec.orderIds)) { for (var i = 0; i < rec.orderIds.length; i++) seenOrderIds[rec.orderIds[i]] = true; }
        salesCount = typeof rec.salesCount === 'number' ? rec.salesCount : 0;
        capturedOnlyCount = typeof rec.capturedOnly === 'number' ? rec.capturedOnly : 0;
        if (rec.hostId && !selectedHostId) selectedHostId = rec.hostId;
        try { renderStagedPills(); updateStagedLabel(); } catch (_) {}
        try { if (countEl) countEl.textContent = String(salesCount); renderCapturedOnlyWarning(); } catch (_) {}
        try { renderHostOptions(); } catch (_) {}
        console.log('[LENSED][TT] PRESESSION restore', { userMatches: true, roomMatches: true, stagedCount: stagedSkus.length, hasHost: !!selectedHostId, hasCounter: salesCount > 0 });
      });
    } catch (_) {}
  }

  // Attempt a pre-session restore only when it is safe and not yet done.
  function maybeRestorePreSession() {
    if (!counterSessionId && !preSessionRestoreDone && authUserId && currentRoomId) restorePreSession();
  }

  // Paint (or hide) the captured-only warning from the current count.
  function renderCapturedOnlyWarning() {
    if (!capturedOnlyWarnEl) return;
    var msgs = [];
    if (capturedOnlyCount > 0) {
      msgs.push('⚠ ' + capturedOnlyCount + ' order' + (capturedOnlyCount === 1 ? '' : 's')
        + ' captured but NOT bound to a SKU. Stage a SKU before the sale to bind it.');
    }
    if (bindIssueCount > 0) {
      msgs.push('⚠ ' + bindIssueCount + ' order' + (bindIssueCount === 1 ? '' : 's')
        + ' had a WRITE problem (' + (lastBindIssueReason || 'error') + '). Auto-retrying — check diagnostics.');
    }
    capturedOnlyWarnEl.textContent = msgs.join('  ');
  }

  // Background reported a non-OK AUTO_BIND (e.g. capture_events write failed even though
  // the auction RPC succeeded). Surface it visibly instead of the old silent ok:true.
  function showBindIssue(resp) {
    bindIssueCount++;
    lastBindIssueReason = (resp && resp.reason) || 'error';
    renderCapturedOnlyWarning();
  }

  // Background signalled a session reset (room change / user switch / session end):
  // clear the staged selection and the per-live counter so the next live starts clean.
  function onSessionReset(reason) {
    var hadHost = !!selectedHostId, hadStaged = stagedSkus.length > 0, prevSession = counterSessionId || null;
    counterSessionId = null;
    seenOrderIds = Object.create(null);
    shotEndOrderIds = Object.create(null); // new live → its own auction_end dedup set
    salesCount = 0;
    capturedOnlyCount = 0;
    // Clear the per-order dedup Maps too: a new live's orders are legitimately
    // distinct, so cross-live dedup state must not carry over (and this bounds them).
    boundOrderStatus = new Map();
    sessionBoundSkus = new Map();
    if (countEl) countEl.textContent = '0';
    renderCapturedOnlyWarning();
    if (stagedSkus.length > 0) clearStaged();
    // A new live is a new show: drop the host selection (and its persisted record) so
    // the next live never inherits the prior host. The overlay re-prompts.
    selectedHostId = null;
    renderHostOptions();
    // A genuine reset also discards any pre-session record, and re-arms the pre-session
    // restore guard so the NEXT user+room can restore its own state.
    try { chrome.storage.local.remove([LK_HOST, LK_PRESESSION]); } catch (_) {}
    preSessionRestoreDone = false;
    console.log('[LENSED][TT] CONTENT onSessionReset', { reason: reason || 'unspecified', previousSessionId: prevSession, hadHost: hadHost, hadStagedSku: hadStaged });
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
      chrome.storage.local.get([LK_COUNTER, LK_STAGED, LK_HOST, LK_SHOT_ENDS, LK_PRESESSION], function (data) {
        if (chrome.runtime.lastError || !data) return;
        // Pre-session → session migration: a matching (user+room) pre-session record means
        // the in-memory staged/counter/host were restored pre-session and must be carried
        // into this new session (never cleared), then the pre-session record removed.
        var migrating = presessionMatches(data[LK_PRESESSION]);
        // Restore the auction_end dedup set for THIS session (skip re-upload after reload).
        var srec = data[LK_SHOT_ENDS];
        shotEndOrderIds = Object.create(null);
        if (srec && srec.sessionId === counterSessionId && Array.isArray(srec.orderIds)) {
          for (var si = 0; si < srec.orderIds.length; si++) shotEndOrderIds[srec.orderIds[si]] = true;
        }
        var rec = data[LK_COUNTER];
        if (rec && rec.sessionId === counterSessionId) {
          seenOrderIds = Object.create(null);
          if (Array.isArray(rec.orderIds)) {
            for (var i = 0; i < rec.orderIds.length; i++) seenOrderIds[rec.orderIds[i]] = true;
          }
          salesCount = typeof rec.salesCount === 'number' ? rec.salesCount : rec.orderIds ? rec.orderIds.length : 0;
          capturedOnlyCount = typeof rec.capturedOnly === 'number' ? rec.capturedOnly : 0;
          if (countEl) countEl.textContent = String(salesCount);
          renderCapturedOnlyWarning();
          console.log('[LENSED][TT] counter restored for session', counterSessionId, '→', salesCount, '· captured-only', capturedOnlyCount);
        } else {
          // New session. On a pre-session migration, KEEP the restored in-memory counter;
          // otherwise start this session's captured-only tally clean. Persist either way.
          console.log('[LENSED][TT] counter scoped to new session', counterSessionId, migrating ? '(migrated)' : '');
          if (!migrating) capturedOnlyCount = 0;
          renderCapturedOnlyWarning();
          persistCounter();
        }

        // Staged SKUs: restore ONLY the selection saved for THIS session (recovering a
        // mid-auction selection across a reload / SW restart). On a different/new
        // session, drop any in-memory selection so a prior live never leaks in.
        var srec = data[LK_STAGED];
        if (srec && srec.sessionId === counterSessionId && Array.isArray(srec.skus) && srec.skus.length > 0) {
          stagedSkus = srec.skus.map(function (s) {
            return { id: s.id, sku_number: s.sku_number, title: s.title, qty: s.qty || 1, qty_on_hand: s.qty_on_hand, unit_cost_cents: s.unit_cost_cents, live_seller_notes: s.live_seller_notes || [] };
          });
          renderStagedPills();
          updateStagedLabel();
          console.log('[LENSED][TT] staged SKUs restored for session', counterSessionId, '→', stagedSkus.length);
        } else if (migrating) {
          // Migration: the in-memory staged selection was restored from the pre-session
          // record for THIS user+room. Keep it and persist it under the new session id —
          // never clear it (persistStaged is now session-scoped since counterSessionId is set).
          persistStaged();
          console.log('[LENSED][TT] staged SKUs migrated pre-session → session', counterSessionId, '→', stagedSkus.length);
        } else if (stagedSkus.length > 0) {
          clearStaged();
        }

        // Selected host: restore ONLY the choice saved for THIS session (recovering it
        // across a reload / SW restart) and re-assert to the worker so live_sessions
        // .host_id is re-applied if the background lost it on eviction. A different
        // session leaves the current selection untouched (room reset clears it).
        var hrec = data[LK_HOST];
        if (hrec && hrec.sessionId === counterSessionId && hrec.hostId) {
          selectedHostId = hrec.hostId;
          renderHostOptions();
          try {
            chrome.runtime.sendMessage(
              { type: 'SET_SESSION_HOST', hostId: selectedHostId, roomId: currentRoomId || null },
              function () { if (chrome.runtime.lastError) return; }
            );
          } catch (_) {}
          console.log('[LENSED][TT] host restored for session', counterSessionId, '→', selectedHostId);
        } else if (migrating && selectedHostId) {
          // Migrate the pre-session host under the new session id and re-assert it.
          persistSelectedHost();
          try {
            chrome.runtime.sendMessage(
              { type: 'SET_SESSION_HOST', hostId: selectedHostId, roomId: currentRoomId || null },
              function () { if (chrome.runtime.lastError) return; }
            );
          } catch (_) {}
          console.log('[LENSED][TT] host migrated pre-session → session', counterSessionId, '→', selectedHostId);
        }

        // Migration complete → remove the obsolete pre-session record so it can never be
        // re-applied to a later live. Done only AFTER the state above was re-persisted
        // under the new session id.
        if (migrating) { try { chrome.storage.local.remove([LK_PRESESSION]); } catch (_) {} }
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
    if (host.parentNode !== root) { root.appendChild(host); diag.overlayRelocateCount++; }
  }

  // ── MutationObserver: re-inject if TikTok SPA removes our container.
  // Returns true when it actually rebuilt (used by the observer to count rebuilds).
  function ensureOverlay() {
    if (!document.getElementById(CONTAINER_ID)) {
      diag.overlayRemountCount++;
      createOverlay();
      if (salesCount > 0 && countEl) {
        countEl.textContent = String(salesCount);
        var empty = salesListEl && salesListEl.querySelector('.lensed-empty');
        if (empty) empty.remove();
      }
      return true;
    }
    return false;
  }

  // Coalesce SPA-mutation bursts: at most one ensureOverlay() per frame, and never
  // let an exception in the callback kill the observer.
  var rebuildScheduled = false;
  function onBodyMutation() {
    if (rebuildScheduled) return;
    rebuildScheduled = true;
    var run = function () {
      rebuildScheduled = false;
      try { if (ensureOverlay()) diag.observerRebuildCount++; } catch (_) {}
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  // Build the overlay + attach the observer/fullscreen listeners. Restartable:
  // idempotent via pageWiringActive so it runs once now and again after a bfcache
  // restore (see pageshow). createOverlay() attaches the shared doc handlers once.
  function startPageWiring() {
    if (pageWiringActive) return;
    pageWiringActive = true;
    createOverlay();
    scheduleAccountDetection(); // detection-verification only (display + logs)
    startHeartbeat();
    overlayObserver = new MutationObserver(onBodyMutation);
    overlayObserver.observe(document.body, { childList: true, subtree: false });
    // Keep the overlay inside the rendered subtree on fullscreen enter/exit (webkit*
    // is a defensive fallback for older Chromium).
    document.addEventListener('fullscreenchange', ensureOverlayMountedInCorrectRoot);
    document.addEventListener('webkitfullscreenchange', ensureOverlayMountedInCorrectRoot);
  }

  // Tab-alive heartbeat loop. Idempotent (one timer per wired page). Only pings once a
  // live room is known — during a no-sale lull the room stays set, so the heartbeat
  // keeps advancing last_seen_at. Torn down with the page (teardown / tab close).
  function startHeartbeat() {
    if (heartbeatTimer) return;
    try {
      heartbeatTimer = setInterval(function () {
        // Always ping (roomId may be null early); the background resolves the live
        // session by room — from this roomId, its own detected room, or the pinned
        // session — so a mid-live load with a lagging content-side room still heartbeats.
        try {
          console.log('[LENSED][content] heartbeat → bg (room ' + currentRoomId + ')');
          chrome.runtime.sendMessage({ type: 'TIKTOK_HEARTBEAT', roomId: currentRoomId || null }, function () { void chrome.runtime.lastError; });
        } catch (_) {}
      }, HEARTBEAT_MS);
    } catch (_) {}
  }

  // Tear down everything page-scoped so a navigation / bfcache eviction leaves nothing
  // live. Idempotent. Uses pagehide (bfcache-safe) — NOT unload/visibilitychange (the
  // tab is backgrounded constantly during a live; tearing down there would drop the
  // overlay + in-memory counter mid-live). The persisted counter/staged are written
  // eagerly, so no save is needed here.
  function teardown() {
    pageWiringActive = false;
    try { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } } catch (_) {}
    try { if (overlayObserver) { overlayObserver.disconnect(); overlayObserver = null; } } catch (_) {}
    try { document.removeEventListener('mousemove', onDocMouseMove); } catch (_) {}
    try { document.removeEventListener('mouseup', onDocMouseUp); } catch (_) {}
    docHandlersAttached = false;
    try { document.removeEventListener('fullscreenchange', ensureOverlayMountedInCorrectRoot); } catch (_) {}
    try { document.removeEventListener('webkitfullscreenchange', ensureOverlayMountedInCorrectRoot); } catch (_) {}
    try { if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; } } catch (_) {}
    try { var host = document.getElementById(CONTAINER_ID); if (host) host.remove(); } catch (_) {}
    shadowRoot = null; salesListEl = null; countEl = null; stagedListEl = null; notesListEl = null;
    skuInputEl = null; resolvedLabelEl = null; lastScanEl = null; stagedCountEl = null; sessionStatusEl = null;
    capturedOnlyWarnEl = null; aspValueEl = null; breakEvenValueEl = null; activePanel = null;
    hostRowEl = null; hostSelectEl = null; hostWarnEl = null; queueBannerEl = null;
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
    // Window lifecycle listeners attach exactly once and survive bfcache (the frozen
    // page keeps them). pagehide tears page wiring down; pageshow(persisted) rebuilds
    // it — a bfcache-restored page does NOT re-run the content script.
    if (!windowLifecycleBound) {
      windowLifecycleBound = true;
      window.addEventListener('pagehide', teardown);
      window.addEventListener('pageshow', function (e) { if (e && e.persisted) startPageWiring(); });
    }
    startPageWiring();
  }

  // Diagnostics: turn on the SW ring buffer + record content load (dev-only, no-op otherwise).
  if (diagOn()) {
    try { chrome.runtime.sendMessage({ type: 'DIAG_ENABLE' }, function () { void chrome.runtime.lastError; }); } catch (_) {}
    dlog('content.load', 'info', 'content script loaded', { frame: window.top === window ? 'top' : 'iframe', path: (function () { try { return location.pathname; } catch (_) { return null; } })(), version: DIAG_VERSION });
  }

  init();

  // ── Global keyboard shortcuts (only when the SKU input is NOT focused) ─
  // NumpadAdd       (button 1) Start the TikTok auction (discovery-only this phase)
  // -  / NumpadSubtract (button 2) add another unit of the most recently staged SKU
  // *  / NumpadMultiply (button 3) trigger re-run (the ↻ restage button)
  // Start responds ONLY to the NumpadAdd event.code — a printable '+' never starts.
  // Physical numpad / macro-pad keys are matched by event.code so pads that emit
  // only a code (no printable key) still work. When the SKU input (or any other
  // editable field) is focused these keys type normally — we bail before handling.
  function isEditableTarget(node) {
    if (!node) return false;
    var tag = (node.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    return !!node.isContentEditable;
  }

  // ── Hotkey debugging ── off by default. Opt in at runtime with
  // localStorage 'lensed_hotkey_debug' = '1' to log every step of the +/-/*
  // shortcut path (receipt, gating, match, and dispatch).
  var HOTKEY_DEBUG = false;
  function hotkeyDebugOn() {
    if (HOTKEY_DEBUG) return true;
    try { return localStorage.getItem('lensed_hotkey_debug') === '1'; } catch (_) { return false; }
  }
  function hlog(msg, data) {
    if (!hotkeyDebugOn()) return;
    if (data !== undefined) console.log('[LENSED][HOTKEY] ' + msg, data);
    else console.log('[LENSED][HOTKEY] ' + msg);
  }
  function describeTarget(node) {
    if (!node) return null;
    var tag = (node.tagName || '').toLowerCase();
    return tag + (node.id ? '#' + node.id : '') + (node.className && node.className.baseVal === undefined ? '.' + String(node.className).split(' ').filter(Boolean).join('.') : '');
  }
  // Confirm which frame this listener is bound in (top vs iframe) and the URL.
  hlog('keydown listener attached', {
    isTopFrame: window.top === window,
    href: (function () { try { return location.href; } catch (_) { return '(cross-origin)'; } })()
  });

  // Dispatch a matched hotkey, logging whether it fired or was blocked by an
  // empty staged/previous set (the underlying fns silently no-op otherwise).
  function fireHotkey(action) {
    if (action === 'add') {
      if (stagedSkus.length === 0) { hlog('matched but no staged item to add'); return; }
      addAnotherUnitOfLast(); hlog('fired add'); return;
    }
    if (action === 'rerun') {
      if (previousSkus.length === 0) { hlog('matched but no previous item to rerun'); return; }
      rerunPrevious(); hlog('fired rerun'); return;
    }
  }

  // ── One-button Start-auction (discovery + fail-closed state only) ─────────────
  // NumpadAdd (macro button 1) and the overlay "Start" button both route into
  // runStartAuction(). THIS PHASE ONLY discovers the TikTok auction panel and
  // classifies its state — it NEVER clicks TikTok, dispatches synthetic events, or
  // calls a TikTok handler/endpoint. The verified activation method is added AFTER a
  // live-broadcast test; until then a single ready auction reports "Start ready —
  // activation not enabled" and stops. All selectors are structural/role/exact-text —
  // no generated class names (Arco's `arco-btn-disabled` is used only as a state flag).
  var START_DEBOUNCE_MS = 1800;   // ignore repeat Start presses within ~1.8s (no auto-retry)
  var startDiscoverUntil = 0;     // debounce window end (timestamp via nowMs())
  var startInFlight = false;      // re-entrancy guard; always released in finally

  // Feedback copy — surfaced through the existing overlay resolve line.
  var MSG_START_WRONG_SCREEN = 'Wrong TikTok screen';
  var MSG_START_UNAVAILABLE = 'Start button unavailable';
  var MSG_START_MULTIPLE = 'Multiple auctions ready';
  var MSG_START_READY = 'Start ready — activation not enabled';

  // Start-flow diagnostics — reuse the existing hotkey-debug opt-in
  // (localStorage 'lensed_hotkey_debug' = '1'). Never sent to any backend/Supabase.
  function startLog(msg, data) {
    if (!hotkeyDebugOn()) return;
    if (data !== undefined) console.log('[LENSED][START] ' + msg, data);
    else console.log('[LENSED][START] ' + msg);
  }

  function startFeedback(text, isError) {
    try { setResolveLine(text, !!isError); } catch (_) {}
  }

  function startIsVisible(node) {
    if (!node) return false;
    var r = node.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    var cs;
    try { cs = getComputedStyle(node); } catch (_) { return true; }
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  // The selected Auctions tab: role=tab, aria-selected=true, visible text begins with
  // "Auctions". Never hard-codes the Arco panel id nor trusts aria-controls resolving.
  function findAuctionsTab() {
    var tabs = document.querySelectorAll('[role="tab"]');
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i];
      if (t.getAttribute('aria-selected') !== 'true') continue;
      if (/^\s*Auctions\b/.test(t.textContent || '')) return t;
    }
    return null;
  }

  // Structural signature of an auction row: an index (#N) + a starting price + a
  // quantity. Text-based, NOT class-based (analytics panels lack this signature).
  function looksLikeAuctionRow(text) {
    return /#\d+/.test(text) && /Starting price/i.test(text) && /Quantity/i.test(text);
  }

  // Every structurally-valid auction row: the SMALLEST visible ancestor carrying the
  // signature and at least one native <button>. Returns ALL candidates — never picks
  // the first. Multiple configured rows are expected during a live.
  function findAuctionRows() {
    var divs = document.querySelectorAll('div');
    var matches = [];
    for (var i = 0; i < divs.length; i++) {
      var d = divs[i];
      var txt = d.innerText || '';
      if (txt.length > 500) continue;                 // too large to be a single row
      if (!looksLikeAuctionRow(txt)) continue;
      if (!d.querySelector('button')) continue;
      matches.push(d);
    }
    // Keep only innermost matches (drop any that contains another match).
    var minimal = matches.filter(function (m) {
      for (var j = 0; j < matches.length; j++) {
        if (matches[j] !== m && m.contains(matches[j])) return false;
      }
      return true;
    });
    return minimal.filter(startIsVisible);
  }

  // Row title for diagnostics: the "#N …" line, trimmed.
  function auctionRowTitle(row) {
    try {
      var m = (row.innerText || '').match(/#\d+[^\n]*/);
      return m ? m[0].trim().slice(0, 60) : null;
    } catch (_) { return null; }
  }

  // Enabled means: no native `disabled`, no `arco-btn-disabled` class, and computed
  // pointer-events !== 'none' (the observed disabled markup uses all three).
  function isStartButtonEnabled(b) {
    if (b.disabled) return false;
    if ((' ' + b.className + ' ').indexOf(' arco-btn-disabled ') !== -1) return false;
    try { if (getComputedStyle(b).pointerEvents === 'none') return false; } catch (_) {}
    return true;
  }

  // True if the row contains ANY native <button> whose exact text is "Start"
  // (regardless of enabled state) — used to tell "disabled" from "no Start at all".
  function rowHasStartText(row) {
    var btns = row.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if ((btns[i].textContent || '').trim() === 'Start') return true;
    }
    return false;
  }

  // The single visible + enabled native "Start" button in a row, or null when zero OR
  // more than one qualify. Exact text "Start" excludes "Go LIVE"/"Go LIVE now".
  // data-tid="m4b_button" is NOT used (it is present on many page buttons).
  function enabledStartButtonInRow(row) {
    var btns = row.querySelectorAll('button');
    var hits = [];
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var label = (b.textContent || '').trim();
      if (label !== 'Start') continue;                // excludes Go LIVE / Go LIVE now
      if (!startIsVisible(b)) continue;
      if (!isStartButtonEnabled(b)) continue;
      hits.push(b);
    }
    return hits.length === 1 ? hits[0] : null;
  }

  // Guarded Start entry point. Discovery + fail-closed classification ONLY — never
  // clicks TikTok this phase. `source` is a diagnostic label ('macro' | 'overlay').
  function runStartAuction(source) {
    var now = nowMs();
    if (startInFlight || now < startDiscoverUntil) { startLog('debounced', { source: source }); return; }
    startInFlight = true;
    startDiscoverUntil = now + START_DEBOUNCE_MS;
    try {
      var tab = findAuctionsTab();
      if (!tab) {
        startLog('wrong screen — Auctions tab not selected/found', { source: source });
        startFeedback(MSG_START_WRONG_SCREEN, true);
        return;
      }

      var rows = findAuctionRows();
      var setupPresent = /Temporary auction|Add auction products/i.test(document.body.innerText || '');
      startLog('discovery', { source: source, rows: rows.length, setupPresent: setupPresent });

      if (rows.length === 0) {
        startLog(setupPresent ? 'empty (setup content present)' : 'empty (no auction rows)');
        startFeedback(MSG_START_UNAVAILABLE, true);
        return;
      }

      var startable = [];   // rows with EXACTLY ONE visible + enabled Start button
      var disabledRows = 0; // configured rows whose Start button is disabled
      var noStartRows = 0;  // configured rows with NO Start button (running/unknown)
      for (var i = 0; i < rows.length; i++) {
        if (enabledStartButtonInRow(rows[i])) {
          startable.push({ title: auctionRowTitle(rows[i]) });
        } else if (rowHasStartText(rows[i])) {
          disabledRows++;
        } else {
          noStartRows++;
        }
      }
      startLog('classified', { startable: startable.length, disabledRows: disabledRows, noStartRows: noStartRows });

      if (startable.length > 1) {
        // Ambiguous — never guess which auction to start.
        startLog('ambiguous — multiple startable rows', { titles: startable.map(function (s) { return s.title; }) });
        startFeedback(MSG_START_MULTIPLE, true);
        return;
      }
      if (startable.length === 1) {
        // READY_UNVERIFIED — a single startable auction. Activation is INTENTIONALLY
        // NOT performed: the verified click method is pending a live-broadcast test.
        startLog('READY_UNVERIFIED — activation not enabled', { title: startable[0].title });
        startFeedback(MSG_START_READY, false);
        return;
      }
      // Zero startable rows.
      if (disabledRows > 0) {
        startLog('configured but disabled', { reason: 'not_live_or_disabled', disabledRows: disabledRows });
        startFeedback(MSG_START_UNAVAILABLE, true);
        return;
      }
      // Configured rows but no Start button anywhere → RUNNING_OR_UNKNOWN. Never claim
      // "already running" — the running-state DOM is not yet observed on a live broadcast.
      startLog('running_or_unknown — configured rows without a Start button', { rows: rows.length });
      startFeedback(MSG_START_UNAVAILABLE, true);
    } catch (err) {
      startLog('error during discovery', { error: String((err && err.message) || err) });
      startFeedback(MSG_START_UNAVAILABLE, true);
    } finally {
      startInFlight = false; // release the temporary discovery lock (timestamp still debounces repeats)
    }
  }

  document.addEventListener('keydown', function (e) {
    // Scope debug logging to our candidate keys so we don't flood on normal typing.
    var isHotkeyCandidate = e.key === '+' || e.key === '-' || e.key === '*'
      || e.code === 'NumpadAdd' || e.code === 'NumpadSubtract' || e.code === 'NumpadMultiply';
    if (isHotkeyCandidate) hlog('received', { key: e.key, code: e.code, target: describeTarget(e.target) });

    if (e.ctrlKey || e.metaKey || e.altKey) {
      if (isHotkeyCandidate) hlog('ignored modifier held', { ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey });
      return;
    }

    var isMacroCode = e.code === 'NumpadAdd' || e.code === 'NumpadSubtract' || e.code === 'NumpadMultiply';
    var innerFocus = shadowRoot ? shadowRoot.activeElement : null;
    var ownInputFocused = (innerFocus === skuInputEl);

    // ── (A) GLOBAL WEDGE-SCANNER CAPTURE ──────────────────────────────────────
    // Runs at capture phase BEFORE any focus/hidden gate, so a scanner burst stages
    // even when the host has accidentally clicked the TikTok chat/comment box (the
    // root-cause bug: the old handler bailed on editable-target/hidden and dropped
    // the scan entirely). Skipped only when OUR SKU input is focused — its own
    // listeners own that path. A char is swallowed (preventDefault + stopPropagation)
    // ONLY once it is confirmed part of a machine-fast burst, so human typing is
    // never intercepted; the burst commits on Enter OR after a short idle gap for
    // scanners that don't emit Enter. Only the very first burst char can leak into a
    // focused chat field (it can't be classified until the second char arrives).
    if (!ownInputFocused) {
      if (e.key === 'Enter') {
        if (globalLooksLikeScan()) {
          slog('Enter → commit', { count: gScanCount });
          e.preventDefault();
          e.stopPropagation();
          commitGlobalScanIfReady('enter');
          return;
        }
        // Not a scan → leave Enter alone (e.g. the host sending a chat message).
        if (gScanCount > 0) { slog('Enter — not a scan, reset', { count: gScanCount, value: redactScan(gScanBuffer) }); resetGlobalScan(); }
      } else if (e.key && e.key.length === 1) {
        var t = nowMs();
        var interkey = t - gScanLast;
        if (gScanCount === 0 || interkey > 100) { gScanFirst = t; gScanCount = 0; gScanBuffer = ''; }
        gScanCount++;
        gScanLast = t;
        gLastInterkey = interkey;
        gScanBuffer += e.key;
        scheduleGlobalIdleCommit(); // commit on idle even if Enter never arrives

        // 2nd+ char arriving machine-fast ⇒ confirmed scanner burst. Swallow so it
        // can't land in the chat box, and surface a visible "detected" once.
        var burstChar = gScanCount >= 2 && interkey < SCAN_MAX_INTERKEY_MS;
        if (burstChar) {
          e.preventDefault();
          e.stopPropagation();
          if (gScanCount === 2) { setScanStatus(redactScan(gScanBuffer), 'detected'); slog('burst detected', { interkey: interkey, threshold: SCAN_MAX_INTERKEY_MS }); }
          return;
        }
        // Not (yet) a burst → fall through so a standalone +/-/* can act as a shortcut.
      }
    }

    // Overlay closed (✕) → shortcuts are inactive (the scanner above still works).
    if (hidden) { if (isHotkeyCandidate) hlog('ignored overlay hidden'); return; }

    // ── (B) OVERLAY SHORTCUTS ── gated by focus: a macro/numpad key drives the
    // overlay hands-free even with the SKU input focused, but nothing hijacks the
    // host <select> or a chat/comment field the host is typing in.
    if (innerFocus && innerFocus === hostSelectEl) {
      if (isHotkeyCandidate) hlog('ignored editable target', { active: 'host-select' });
      return;
    }
    if (ownInputFocused) {
      if (isMacroCode) {
        hlog('allowed macro key inside overlay input');
        // fall through — the numpad branch below fires and swallows the char
      } else {
        if (isHotkeyCandidate) hlog('ignored editable target (SKU input focused)');
        return;
      }
    } else if (isEditableTarget(document.activeElement)) {
      if (isHotkeyCandidate) hlog('ignored editable target', { active: describeTarget(document.activeElement) });
      return;
    }

    // Physical numpad / macro-pad keys map to overlay actions by event.code — these
    // codes are produced only by real numpad keys, never by a wedge-scanner burst.
    //   NumpadAdd (button 1) → Start auction   NumpadSubtract (button 2) → add unit
    //   NumpadMultiply (button 3) → restage.   (The old "remove last" action is gone.)
    // Start responds ONLY to NumpadAdd (never a printable '+', handled below).
    var padAction = e.code === 'NumpadAdd' ? 'start'
                  : e.code === 'NumpadSubtract' ? 'add'
                  : e.code === 'NumpadMultiply' ? 'rerun'
                  : null;
    if (padAction) {
      hlog('matched numpad code', { code: e.code, action: padAction });
      e.preventDefault();
      e.stopPropagation();
      if (padAction === 'start') runStartAuction('macro');
      else fireHotkey(padAction);
      resetGlobalScan(); // consumed as a shortcut, not part of a scan
      return;
    }

    // Standalone -/* shortcut — fires ONLY for a deliberate, human-paced press.
    // A -/* arriving mid machine-burst was already buffered/swallowed in (A), so it
    // never reaches here; the standalone check uses the timing captured in (A).
    // A printable '+' is intentionally NOT a shortcut: Start responds only to the
    // NumpadAdd event.code, so a typed '+' can never start an auction.
    if (e.key === '-' || e.key === '*') {
      var action = e.key === '-' ? 'add' : 'rerun';
      var standalone = gScanCount <= 1 || gLastInterkey > SCAN_MAX_INTERKEY_MS;
      hlog('matched symbol key', { key: e.key, action: action, standalone: standalone, gScanCount: gScanCount, interkey: gLastInterkey });
      if (standalone) {
        e.preventDefault();
        e.stopPropagation();
        fireHotkey(action);
        resetGlobalScan(); // consumed as a shortcut, not part of a scan
      } else {
        hlog('matched but suppressed as scan-burst char', { key: e.key, interkey: gLastInterkey, threshold: SCAN_MAX_INTERKEY_MS });
      }
    }
  }, true);

  // ── Message bridge: MAIN world -> background + overlay + auto-bind ─

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || typeof data !== 'object') return;

    // Relay MAIN-world (injector) diagnostic events to the SW ring buffer.
    if (data.source === 'lensed-diag') {
      if (diagOn() && data.event) {
        try { chrome.runtime.sendMessage({ type: 'DIAG_EVENT', event: Object.assign({ v: DIAG_VERSION }, data.event) }, function () { void chrome.runtime.lastError; }); } catch (_) {}
      }
      return;
    }

    if (data.source === 'lensed-tiktok-sale') {
      var sale = data.sale;
      try {
      // Forward to background
      try {
        chrome.runtime.sendMessage({ type: 'TIKTOK_SALE', sale: sale }).catch(function () {});
      } catch (_) {}

      // Auto-bind fires for a new order OR a status flip of an already-bound one.
      // wasBound mirrors that dedup decision (computed before autoBind updates it)
      // so the bound tag renders whenever this call will actually bind.
      // brandNewOrder / hadStaged are captured BEFORE renderSale (which marks the
      // order seen) so we can detect a captured-only order below.
      var brandNewOrder = !!(sale && sale.orderId && !seenOrderIds[sale.orderId]);
      var hadStaged = stagedSkus.length > 0;
      var fresh = isFreshSale(sale);
      var hasReliableTs = !!(sale && typeof sale.orderedAtMs === 'number' && isFinite(sale.orderedAtMs) && sale.orderedAtMs > 0);

      // ── Replay/backlog guard (fixes the staged:0 storm) ──────────────────────────
      // Only suppress orders we are CONFIDENT are historical: brand-new-to-this-tab,
      // NOTHING staged, AND a reliable order timestamp that is clearly old (a reload
      // re-sends the cumulative backlog). A staged order always binds (regardless of
      // timestamp). An order with a MISSING/UNRELIABLE timestamp is never discarded —
      // it may be a real fresh sale — it processes normally and is logged as ambiguous
      // below. This prevents both the replay-warning storm AND silently dropping a
      // potentially fresh sale.
      if (brandNewOrder && !hadStaged && hasReliableTs && !fresh) {
        renderSale(sale, false, null); // marks the order seen + shows it in Recent orders
        dlog('order.replayed_skip', 'info', 'historical order (reliable old timestamp, nothing staged) — bind skipped',
          { order: sale && sale.orderId, ageMs: Date.now() - sale.orderedAtMs });
        return;
      }

      var wasBound = boundOrderStatus.get(sale.orderId) !== saleStatusToken(sale) && hadStaged;
      var boundSkus = autoBind(sale);

      // Render in overlay
      renderSale(sale, wasBound, boundSkus);
      diag.lastCaptureTs = Date.now();
      dlog('order.captured', 'info', 'sale rendered', { order: sale && sale.orderId, brandNew: brandNewOrder, hadStaged: hadStaged, fresh: fresh, markedBound: !!wasBound });

      // [SCREENSHOT] Auction END screenshot — only when the feature is enabled AND
      // lazy-init is complete (shotsReady). shotsReady flips well after page load,
      // so the reload backlog burst never triggers capture/IndexedDB work. Wrapped
      // + fire-and-forget so it can never affect sale detection / bind / counter.
      if (brandNewOrder && shotsEnabled && shotsReady) {
        if (sale && sale.orderId && shotEndOrderIds[sale.orderId]) {
          // Already screenshotted this order this live (survives reload via persist).
          console.log('[LENSED][SHOT] skip duplicate auction_end', { orderId: sale.orderId });
        } else if (isFreshSale(sale)) {
          if (sale.orderId) { shotEndOrderIds[sale.orderId] = true; persistShotEnds(); }
          auctionSaleSeenForAttempt = true;
          try { endAuctionAttemptOnSale(sale); } catch (e) { if (SHOTS_DEBUG) console.warn('[LENSED][SHOT] end capture error:', e); }
        } else {
          // Backlog protection: a "new-to-this-tab" order that is actually old (catch-up /
          // late-join cumulative flood, or a reconnect gap) must NOT screenshot — the live
          // frame would be "now", not the sale moment. Counter/bind already handled above.
          var _ageMs = (sale && sale.orderedAtMs) ? (Date.now() - sale.orderedAtMs) : null;
          console.log('[LENSED][SHOT] skip stale auction_end', { orderId: sale && sale.orderId, ageMs: _ageMs });
        }
      }

      // Captured-only: a brand-new order arrived with nothing staged, so it was
      // recorded raw but NOT bound to a SKU. Count once + show a visible warning so
      // this failure is never silent again (the July-3 incident).
      if (brandNewOrder && !hadStaged && (!boundSkus || boundSkus.length === 0)) {
        if (fresh) {
          // Genuine live sale, host didn't stage — keep the clear host warning.
          capturedOnlyCount++;
          renderCapturedOnlyWarning();
          persistCounter();
          dlog('order.captured_only', 'warn', 'FRESH order captured with nothing staged', { order: sale && sale.orderId, total: capturedOnlyCount });
          // Visible overlay warning above is the signal; console line gated to avoid live spam.
          if (SHOTS_DEBUG) console.warn('[LENSED][TT] captured-only order (no staged SKU):', sale.orderId, '— total this live:', capturedOnlyCount);
        } else {
          // Not fresh, but timestamp is missing/unreliable (reliable-old rows were already
          // skipped above). Could be a real fresh sale OR a replay — do NOT inflate the
          // scary captured-only host warning, but leave a diagnostic trail so a genuine
          // fresh sale is never silently lost.
          dlog('order.ambiguous_timestamp_no_staged', 'warn', 'order captured, nothing staged, no reliable timestamp', { order: sale && sale.orderId });
        }
      }

      // A bind just cleared staging — refocus so the host can scan the next item
      // immediately (guarded: won't steal focus from TikTok chat/host fields).
      if (boundSkus && boundSkus.length > 0) focusScanInput();
      } catch (err) {
        console.error('[LENSED][TT] sale handler error:', err);
      }
      return;
    }

    if (data.source === 'lensed-tiktok-room') {
      currentRoomId = data.roomId || currentRoomId; // scope persisted staged SKUs + host
      restoreHostByRoom(); // pre-first-sale reload: recover a host chosen for this room
      maybeRestorePreSession(); // pre-first-sale reload: recover staged SKUs + counter + host
      dlog('room.detected', 'info', 'room_id relayed to background', { room: data.roomId || null });
      try {
        chrome.runtime.sendMessage({ type: 'TIKTOK_ROOM', roomId: data.roomId }).catch(function () {});
      } catch (_) {}
      maybeSendChannelName(); // room now known → (re)send the DOM channel name scoped to it
      return;
    }

    if (data.source === 'lensed-tiktok-live-end') {
      // PRIMARY end signal — the host ended the live (Seller Center end POST). Forward to
      // background, which ends the matching room's session (idempotent + deduped there).
      dlog('live.end', 'info', 'live-end relayed to background', { room: data.roomId || null });
      try {
        chrome.runtime.sendMessage({ type: 'TIKTOK_LIVE_END', roomId: data.roomId }).catch(function () {});
      } catch (_) {}
      return;
    }

    if (data.source === 'lensed-tiktok-account') {
      // Detected CHANNEL/CREATOR identity (room owner/anchor) from the MAIN-world
      // injector. This is the streaming channel (e.g. "onlybids"), NOT the shop —
      // they differ by design. Label the overlay AND forward to the worker so it can
      // persist/log the channel for the eventual channel→store mapping.
      dlog('account.detected', 'info', 'account detected', { handle: (data.account && (data.account.handle || data.account.tag)) || null });
      renderAccount(data.account || null);
      if (data.account) {
        try {
          chrome.runtime.sendMessage({ type: 'TIKTOK_ACCOUNT', account: data.account, roomId: currentRoomId || null }, function () { void chrome.runtime.lastError; });
        } catch (_) {}
      }
      return;
    }
  });

  // ── Auth status display ─────────────────────────────────────────────

  function updateAuthStatus(authenticated, uid, queuedSales) {
    var wasConnected = authConnected;
    var prevUser = authUserId;
    authConnected = !!authenticated;
    authStatusReceived = true;
    authUserId = uid || null;
    // A different Lensed user must not inherit the previous user's pre-session state:
    // re-arm the one-shot restore guard so it re-evaluates (and rejects a mismatch).
    if (authUserId !== prevUser) preSessionRestoreDone = false;
    if (typeof queuedSales === 'number') queuedSalesCount = queuedSales;
    renderStatusLine();
    renderHostWarning();
    renderQueueWarning();
    // Load the host roster on (re)connect, or if we became connected without one yet.
    if (authConnected && (!wasConnected || hosts.length === 0)) fetchHosts();
    // If a room is already known, attempt a pre-session restore now that we have a user.
    maybeRestorePreSession();
  }

  // FAIL-LOUD: while signed OUT with queued sales, show an unmissable red banner. This is
  // the safety net — queue-and-flush only saves data if auth returns; if it never does
  // (app closed / token fully expired) this banner is what tells the host to act. Once
  // signed in the queue flushes and the banner clears (queuedSalesCount → 0).
  function renderQueueWarning() {
    if (!queueBannerEl) return;
    if (!authConnected && queuedSalesCount > 0) {
      queueBannerEl.textContent = '⚠ NOT SIGNED IN — ' + queuedSalesCount + ' sale'
        + (queuedSalesCount === 1 ? '' : 's') + ' queued, NOT yet saved. Sign in to Lensed to save them.';
    } else {
      queueBannerEl.textContent = '';
    }
  }

  // API-sourced host identity (from tiktok-inject.js / background). Authoritative \u2014
  // takes priority over the DOM label. Display only.
  function renderAccount(account) {
    currentAccount = account || null;
    renderStatusLine();
  }

  // The account to show, preferring the API identity over the visible-DOM label.
  function accountDisplay() {
    if (currentAccount && (currentAccount.handle || currentAccount.nickname || currentAccount.id)) {
      return {
        name: currentAccount.handle ? '@' + currentAccount.handle : (currentAccount.nickname || currentAccount.id),
        src: 'API',
        key: currentAccount.key || null,
      };
    }
    if (domAccountLabel) return { name: domAccountLabel, src: 'dashboard', key: null };
    return null;
  }

  // Compact combined status row: "Connected \u00b7 \u25cf name" / "Connected \u00b7 \u26a0 Account
  // unverified" / "Not connected \u2014 \u2026". The account name is small + muted; the green
  // dot is the only status cue. Display-only \u2014 nothing here changes session behavior.
  function renderStatusLine() {
    if (!sessionStatusEl) return;
    if (!authStatusReceived) return; // keep the initial "Connecting\u2026" until auth is known
    sessionStatusEl.textContent = '';
    if (!authConnected) {
      sessionStatusEl.className = 'lensed-session-status';
      sessionStatusEl.textContent = 'Not connected \u2014 open Lensed app to sign in';
      return;
    }
    sessionStatusEl.className = 'lensed-session-status active';
    sessionStatusEl.appendChild(document.createTextNode('Connected'));
    sessionStatusEl.appendChild(el('span', 'lensed-acct-sep', ' \u00b7 '));
    var acct = accountDisplay();
    if (acct) {
      sessionStatusEl.appendChild(el('span', 'lensed-acct-dot', '\u25cf'));
      var nm = el('span', 'lensed-acct-name', ' ' + acct.name);
      nm.title = 'Detected ' + acct.src + ' account: ' + acct.name + (acct.key ? ' (' + acct.key + ')' : '');
      sessionStatusEl.appendChild(nm);
    } else {
      sessionStatusEl.appendChild(el('span', 'lensed-acct-warn', '\u26a0 Account unverified'));
    }
  }

  // \u2500\u2500 Live host selector \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // Manual person running the show, sourced from Lensed's Team/Employees roster via the
  // background worker (Supabase/PostgREST with the operator's relayed JWT). Independent
  // of the auto-detected TikTok account above \u2014 never auto-filled from it.

  // Ask the worker for the active employee roster, then repaint the dropdown.
  function fetchHosts() {
    try {
      chrome.runtime.sendMessage({ type: 'FETCH_HOSTS' }, function (resp) {
        if (chrome.runtime.lastError) return;
        hosts = (resp && Array.isArray(resp.hosts)) ? resp.hosts : [];
        renderHostOptions();
      });
    } catch (_) {}
  }

  // (Re)build the dropdown: placeholder first, then employees (role='host' already
  // sorted first by the worker). A non-host role is labeled in parens so the operator
  // can tell them apart. Restores the current selection when still present.
  function renderHostOptions() {
    if (!hostSelectEl) return;
    hostSelectEl.textContent = '';
    var ph = el('option', null, 'Select host\u2026');
    ph.value = '';
    hostSelectEl.appendChild(ph);
    for (var i = 0; i < hosts.length; i++) {
      var h = hosts[i];
      if (!h || !h.id) continue;
      var label = h.name || '(unnamed)';
      if (h.role && h.role !== 'host') label += ' (' + h.role + ')';
      var opt = el('option', null, label);
      opt.value = h.id;
      hostSelectEl.appendChild(opt);
    }
    var stillPresent = selectedHostId && hosts.some(function (h) { return h && h.id === selectedHostId; });
    if (stillPresent) {
      hostSelectEl.value = selectedHostId;
    } else {
      // Previously-selected host is no longer active/returned \u2014 drop it so we don't
      // show a stale attribution, and surface the "no host" nudge.
      if (selectedHostId && hosts.length > 0) selectedHostId = null;
      hostSelectEl.value = '';
    }
    renderHostWarning();
  }

  // Subtle, non-blocking nudge when connected but no host is chosen. Capture is never
  // blocked; unselected simply reports as "Unassigned" downstream.
  function renderHostWarning() {
    if (!hostWarnEl) return;
    if (authConnected && !selectedHostId) {
      hostWarnEl.textContent = '\u26a0 No host selected';
      hostWarnEl.title = 'Select the person running this live so their hours and sales are tracked. Capture still works if left unset.';
    } else {
      hostWarnEl.textContent = '';
      hostWarnEl.title = '';
    }
  }

  // Operator changed the dropdown. Persist locally, tell the worker to attach it to the
  // live session, and \u2014 because V1 keeps ONE host per session \u2014 WARN (never silently)
  // when changing mid-live, since it re-attributes the whole live's orders.
  function onHostChange() {
    if (!hostSelectEl) return;
    var val = hostSelectEl.value || null;
    // Warn ONLY when a host was already selected for this live and the operator switches
    // to a DIFFERENT one — never on the first selection, and not when clearing to none.
    var changingMidLive = !!(selectedHostId && val && selectedHostId !== val);
    selectedHostId = val;
    persistSelectedHost();
    renderHostWarning();
    dlog('host.selected', 'info', 'host selection changed', { host: val ? 'set' : 'none', changingMidLive: changingMidLive });
    try {
      chrome.runtime.sendMessage(
        { type: 'SET_SESSION_HOST', hostId: selectedHostId, roomId: currentRoomId || null },
        function () { if (chrome.runtime.lastError) return; }
      );
    } catch (_) {}
    if (changingMidLive && resolvedLabelEl) {
      resolvedLabelEl.textContent = '\u26a0 Host changed \u2014 this live\u2019s orders now attribute to the new host.';
    }
    console.log('[LENSED][TT] host selected:', selectedHostId);
  }

  // Persist the selection scoped to the current session + room so a reload restores it.
  // Written even before a session exists (host can be picked pre-sale), so a
  // pre-first-sale reload still restores by room.
  function persistSelectedHost() {
    try {
      var rec = {};
      rec[LK_HOST] = { sessionId: counterSessionId || null, roomId: currentRoomId || null, hostId: selectedHostId || null };
      chrome.storage.local.set(rec);
    } catch (_) {}
    // Before a session exists, also fold the host into the user+room pre-session record
    // so it survives a reload/SW-restart even when the room id later differs.
    if (!counterSessionId) persistPreSession();
    console.log('[LENSED][TT] HOST persisted', { userPresent: !!authUserId, roomPresent: !!currentRoomId, sessionPresent: !!counterSessionId });
  }

  // Pre-first-sale reload path: no session yet, so adoptSession() won't fire. When the
  // room becomes known, restore a host previously chosen for THIS room (only if none is
  // currently selected) and re-assert it to the worker.
  function restoreHostByRoom() {
    if (selectedHostId || !currentRoomId) return;
    try {
      chrome.storage.local.get([LK_HOST], function (data) {
        if (chrome.runtime.lastError || !data) return;
        var hrec = data[LK_HOST];
        var found = !!(hrec && hrec.hostId);
        var roomMatches = !!(hrec && hrec.roomId && hrec.roomId === currentRoomId);
        var restored = false;
        if (found && roomMatches && !selectedHostId) {
          selectedHostId = hrec.hostId;
          renderHostOptions();
          try {
            chrome.runtime.sendMessage(
              { type: 'SET_SESSION_HOST', hostId: selectedHostId, roomId: currentRoomId },
              function () { if (chrome.runtime.lastError) return; }
            );
          } catch (_) {}
          restored = true;
        }
        // userMatches is null: LK_HOST is the legacy room-only fallback (the user+room
        // pre-session record carries user-scoped host); logged for runtime diagnosis.
        console.log('[LENSED][TT] HOST restore', { found: found, roomMatches: roomMatches, userMatches: null, restored: restored });
      });
    } catch (_) {}
  }

  // \u2500\u2500 Visible-dashboard account detection (detection-verification only) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // Reads the account shown in the TikTok Live Manager top-right, using ROBUST,
  // attribute/structure/position heuristics \u2014 NOT fragile TikTok class names. This
  // path is display + logging only; it is never forwarded to the background or used
  // for session scoping.
  var domDetectScanCap = 3000;

  // Common Live-Manager UI chrome that is handle-SHAPED (single word) but is NOT an
  // account \u2014 rejected so plain top-right text can't produce a false positive.
  var UI_STOPWORDS = /^(settings?|profile|account|accounts|notifications?|messages?|message|help|support|live|golive|go|end|start|logout|signout|signin|login|menu|search|home|dashboard|more|share|gift|gifts|wallet|studio|manage|manager|create|upload|explore|following|followers?|follower|inbox|activity|analytics|balance|coins|recharge|feedback|language|close|cancel|ok|okay|done|save|saved|back|next|prev|previous|skip|apply|submit|confirm|continue|got|mute|unmute|chat|edit|delete|remove|view|hide|show|retry|reload|refresh|yes|no|accept|decline|dismiss|expand|collapse)$/i;

  function looksLikeHandle(s) {
    if (!s) return false;
    var t = String(s).trim();
    // @handle or bare handle: no spaces, letters/digits/._, 2\u201324 chars.
    if (!/^@?[A-Za-z0-9][A-Za-z0-9._]{1,23}$/.test(t)) return false;
    if (UI_STOPWORDS.test(normHandle(t))) return false;
    return true;
  }

  function normHandle(s) { return String(s).trim().replace(/^@/, ''); }

  // Is the element in the top-right region of the viewport (where the account menu
  // lives), and actually rendered?
  function isTopRight(el) {
    try {
      var r = el.getBoundingClientRect();
      if (!r || r.width === 0 || r.height === 0) return false;
      return r.top < 140 && r.right > (window.innerWidth - 440) && r.width < 360;
    } catch (_) { return false; }
  }

  function directText(el) {
    var t = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3) t += el.childNodes[i].nodeValue;
    }
    return t.trim();
  }

  // Returns { label, why, scanned, topRightCount, samples } \u2014 label is null if nothing
  // confident was found. Our own overlay lives in a shadow root, so it is invisible to
  // these document queries and can never be picked up.
  function detectVisibleAccount() {
    var best = null;         // { text, score, why }
    var samples = [];        // rejected top-right texts, for the failure diagnostic
    var topRightCount = 0;
    var scanned = 0;

    function consider(text, score, why) {
      if (!text) return;
      var t = String(text).trim();
      if (t.length < 2 || t.length > 40) return;
      if (!looksLikeHandle(t)) {
        if (samples.length < 6 && t && !/^\s*$/.test(t)) samples.push(t.slice(0, 24));
        return;
      }
      if (!best || score > best.score) best = { text: normHandle(t), score: score, why: why };
    }

    // Strategy 1 \u2014 avatar alt text near the top (avatars usually carry the account name).
    try {
      var imgs = document.querySelectorAll('img[alt]');
      for (var i = 0; i < imgs.length && scanned < domDetectScanCap; i++) {
        scanned++;
        var alt = imgs[i].getAttribute('alt');
        if (alt && isTopRight(imgs[i])) { topRightCount++; consider(alt, 8, 'img[alt]@top-right'); }
      }
    } catch (_) {}

    // Strategy 2 \u2014 aria-label / title on account/profile controls in the top-right.
    try {
      var labelled = document.querySelectorAll('[aria-label],[title]');
      for (var j = 0; j < labelled.length && scanned < domDetectScanCap; j++) {
        scanned++;
        var el = labelled[j];
        if (!isTopRight(el)) continue;
        topRightCount++;
        var val = el.getAttribute('aria-label') || el.getAttribute('title') || '';
        if (looksLikeHandle(val)) { consider(val, 9, 'aria/title@top-right'); continue; }
        // "Account: onlybids", "onlybids profile", "@onlybids" \u2192 extract the handle.
        if (/account|profile|user|@|switch/i.test(val)) {
          var m = val.match(/@?[A-Za-z0-9][A-Za-z0-9._]{1,23}/);
          if (m) consider(m[0], 7, 'aria/title-extract');
        }
      }
    } catch (_) {}

    // Strategy 3 \u2014 short handle-like text sitting in the top-right corner.
    // GUARDRAIL 2: buttons are ACTIONS, never identities \u2014 a modal/dialog "Close" button
    // in this region was matching and overwriting the real handle (the v0.4.0 "Close" bug).
    // Exclude <button> and [role=button] entirely; only inert text nodes are considered.
    try {
      var nodes = document.querySelectorAll('a,span,div,p');
      for (var k = 0; k < nodes.length && scanned < domDetectScanCap; k++) {
        scanned++;
        var n = nodes[k];
        if (!isTopRight(n)) continue;
        if (n.tagName === 'BUTTON' || n.getAttribute('role') === 'button' || n.closest('button,[role="button"]')) continue;
        topRightCount++;
        var txt = directText(n);
        if (txt) consider(txt, 6, 'top-right-text');
      }
    } catch (_) {}

    return {
      label: best ? best.text : null,
      why: best ? best.why : null,
      score: best ? best.score : null,
      scanned: scanned,
      topRightCount: topRightCount,
      samples: samples,
    };
  }

  // Run one detection pass. Logs the required success line on a new/changed label and
  // updates the overlay; logs a redacted diagnostic on failure (only when asked, to
  // avoid console spam). Never touches session logic.
  // Half-2: forward the DOM-read channel name to the background so it can persist it on
  // the session (resolved by room, like the heartbeat) for the channel→store mapping.
  // Reuses the TIKTOK_ACCOUNT plumbing; source:'dom' distinguishes it from the (dead on
  // Seller Center) network path. Self-dedups by name|room so it isn't chatty.
  function maybeSendChannelName() {
    if (!domAccountLabel) return;
    var key = domAccountLabel + '|' + (currentRoomId || '');
    if (key === lastChannelNameSentKey) return;
    lastChannelNameSentKey = key;
    try {
      chrome.runtime.sendMessage({ type: 'TIKTOK_ACCOUNT', account: { handle: domAccountLabel, source: 'dom', strategy: lastDetectWhy || null, score: lastDetectScore || null }, roomId: currentRoomId || null }, function () { void chrome.runtime.lastError; });
    } catch (_) {}
  }

  function runAccountDomDetection(logFailure) {
    var res;
    try { res = detectVisibleAccount(); } catch (e) { return; }
    if (res.label) {
      // GUARDRAIL 2: a WEAK match (S3 direct-text, score <=6) must be corroborated across
      // two consecutive passes before we trust it — filters one-off transient garbage
      // (e.g. a modal label flashing through the scan region). S1/S2 (avatar alt / aria,
      // score >=7) are trusted immediately.
      var weak = (res.score != null && res.score <= 6);
      if (weak && res.label !== domAccountLabel) {
        if (res.label !== weakCandidateLabel) { weakCandidateLabel = res.label; return; } // stage; await 2nd sighting
      }
      weakCandidateLabel = null;
      if (res.label !== domAccountLabel) {
        domAccountLabel = res.label; lastDetectWhy = res.why; lastDetectScore = res.score;
        console.log('[LENSED][TT] visible account label detected:', res.label, '(via ' + res.why + ', score ' + res.score + ')');
        renderStatusLine();
      }
      maybeSendChannelName(); // self-dedups; sends on name or room change
      return;
    }
    if (logFailure && !domAccountLabel && !currentAccount) {
      console.log('[LENSED][TT] visible account label NOT detected \u2014 top-right elements inspected:',
        res.topRightCount, '/ nodes scanned:', res.scanned,
        '; non-handle candidate samples:', res.samples);
    }
  }

  // Burst of attempts (the Live Manager shell loads late / is a SPA), then a slow
  // re-check to catch an account switch. Only logs on a changed label / final failure.
  var ACCOUNT_DETECT_DELAYS = [600, 2000, 5000, 10000];
  function scheduleAccountDetection() {
    for (var i = 0; i < ACCOUNT_DETECT_DELAYS.length; i++) {
      (function (idx) {
        setTimeout(function () {
          runAccountDomDetection(idx === ACCOUNT_DETECT_DELAYS.length - 1);
        }, ACCOUNT_DETECT_DELAYS[idx]);
      })(i);
    }
    try { setInterval(function () { runAccountDomDetection(false); }, 12000); } catch (_) {}
  }

  // Listen for auth status broadcasts from background
  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'LENSED_AUTH_STATUS') {
      updateAuthStatus(message.authenticated, message.userId, message.queuedSales);
    } else if (message.type === 'LENSED_SESSION') {
      // Background resolved/changed the live session — scope our counter to it.
      // A null sessionId means the session was reset (room change / user switch),
      // so clear staged SKUs + counter for a clean next live. `reason` (when present)
      // explains why; older background builds omit it (backward compatible).
      if (message.sessionId) adoptSession(message.sessionId);
      else onSessionReset(message.reason || 'session_null');
    } else if (message.type === 'SHOT_STATUS') {
      // [SCREENSHOT] Background pushed updated counters after a store/clear.
      applyShotStatus(message.status);
    }
  });

  // ── [SCREENSHOT] Canvas video capture (safe, opt-in, lazy) ──────────
  // Design: OFF by default; no polling; no DOM observers; no work on load/catch-up.
  // Auto-start (DOM) is DISABLED — it fired before the video was ready (no_video).
  // Only manual "Test capture" and (when enabled) live-sale end capture run. Any
  // error self-disables the feature and leaves the rest of the extension untouched.
  var SHOT_MAX_W = 1024;
  var SHOT_QUALITY = 0.5;
  var SHOT_ADAPTIVE_BYTES = 200 * 1024;
  // Backlog gate: a real auction_end's order_create_time (→ sale.orderedAtMs) is ~now.
  // Catch-up/late-join replays a cumulative backlog of OLD orders; only screenshot a
  // genuinely recent sale. Missing/invalid timestamp → treated as NOT fresh (skip).
  var SHOT_FRESH_WINDOW_MS = 5 * 60 * 1000;
  function isFreshSale(sale) {
    var t = sale && sale.orderedAtMs;
    if (typeof t !== 'number' || !isFinite(t) || t <= 0) return false;
    var age = Date.now() - t;
    return age <= SHOT_FRESH_WINDOW_MS && age >= -SHOT_FRESH_WINDOW_MS; // recent; small future-skew guard
  }

  function shotDbg() { if (SHOTS_DEBUG) { try { console.log.apply(console, arguments); } catch (_) {} } }

  function stagedSnapshot() {
    return stagedSkus.map(function (s) { return { sku_number: s.sku_number, title: s.title, qty: s.qty || 1 }; });
  }

  function priceStrToCents(p) {
    if (p == null) return null;
    var c = String(p).replace(/[^0-9.]/g, '');
    if (c === '') return null;
    var n = parseFloat(c);
    return isFinite(n) ? Math.round(n * 100) : null;
  }

  function shotIsVisible(elm) {
    try {
      if (!elm) return false;
      var r = elm.getBoundingClientRect();
      if (r.width <= 2 || r.height <= 2) return false;
      var st = getComputedStyle(elm);
      if (st.visibility === 'hidden' || st.display === 'none' || parseFloat(st.opacity || '1') === 0) return false;
      return true;
    } catch (_) { return false; }
  }

  function videoUsable(v) { return v && v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0; }

  // Deep shadow-DOM walk — exact finder from the working canvas probe.
  function findLiveVideo() {
    var out = [];
    (function walk(root) {
      if (!root || !root.querySelectorAll) return;
      var v = root.querySelectorAll('video');
      for (var i = 0; i < v.length; i++) out.push(v[i]);
      var a = root.querySelectorAll('*');
      for (var j = 0; j < a.length; j++) { if (a[j].shadowRoot) walk(a[j].shadowRoot); }
    })(document);
    for (var k = 0; k < out.length; k++) { if (videoUsable(out[k]) && !out[k].paused) return out[k]; }
    for (var m = 0; m < out.length; m++) { if (videoUsable(out[m])) return out[m]; }
    return null;
  }

  // Cached resolver with short retries — fixes the no_video race (capture fired
  // before the video was decodable). Revalidates the cached ref each call.
  function resolveVideo(cb, attempt) {
    attempt = attempt || 0;
    if (videoUsable(cachedVideo)) { cb(cachedVideo); return; }
    var v = findLiveVideo();
    if (v) { cachedVideo = v; cb(v); return; }
    cachedVideo = null;
    var delays = [150, 300, 600];
    if (attempt < delays.length) { setTimeout(function () { resolveVideo(cb, attempt + 1); }, delays[attempt]); }
    else cb(null);
  }

  function drawFrame(v) {
    var sw = v.videoWidth, sh = v.videoHeight;
    var scale = Math.min(1, SHOT_MAX_W / sw);
    var w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d');
    try { ctx.drawImage(v, 0, 0, w, h); }
    catch (e) { return { ok: false, reason: 'drawimage_' + ((e && e.name) || 'err') }; }
    var dataUrl;
    try { dataUrl = canvas.toDataURL('image/jpeg', SHOT_QUALITY); }
    catch (e) { return { ok: false, reason: 'todataurl_' + ((e && e.name) || 'err') }; }
    var base64 = dataUrl.split(',')[1] || '';
    var bytes = Math.round(base64.length * 3 / 4);
    if (bytes > SHOT_ADAPTIVE_BYTES) {
      try {
        var d2 = canvas.toDataURL('image/jpeg', 0.4);
        var b2 = d2.split(',')[1] || '';
        if (b2 && b2.length < base64.length) { base64 = b2; bytes = Math.round(base64.length * 3 / 4); }
      } catch (_) {}
    }
    return { ok: true, base64: base64, srcW: sw, srcH: sh, w: w, h: h, bytes: bytes };
  }

  // Synthetic JPEG for manual_test ONLY, when no live video is on screen. Lets the
  // full upload path be exercised (Storage + metadata) without a live. Never used
  // for auction_start/auction_end — those still require the real video frame.
  function synthFrame() {
    try {
      var w = 512, h = 288;
      var canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#111318'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#4f8cff'; ctx.fillRect(0, 0, w, 6);
      ctx.fillStyle = '#ffffff'; ctx.font = 'bold 24px -apple-system, Segoe UI, sans-serif';
      ctx.fillText('Lensed screenshot test', 20, 62);
      ctx.fillStyle = '#c8c8d0'; ctx.font = '14px monospace';
      ctx.fillText(new Date().toISOString(), 20, 104);
      ctx.fillText('session: ' + (counterSessionId || 'nosession'), 20, 132);
      ctx.fillText('room: ' + (currentRoomId || '—'), 20, 158);
      ctx.fillStyle = '#8a8a92';
      ctx.fillText('synthetic (no live video)', 20, 190);
      var dataUrl = canvas.toDataURL('image/jpeg', 0.7);
      var base64 = dataUrl.split(',')[1] || '';
      return { ok: true, base64: base64, srcW: w, srcH: h, w: w, h: h, bytes: Math.round(base64.length * 3 / 4), synthetic: true };
    } catch (e) {
      return { ok: false, reason: 'synth_' + ((e && e.name) || 'err') };
    }
  }

  // Fire-and-forget capture → SW store. Guarded so it can never touch core flow.
  function captureShot(kind, extra) {
    if (!shotsEnabled) return;
    extra = extra || {};
    try {
      resolveVideo(function (v) {
        try {
          var frame = v ? drawFrame(v) : { ok: false, reason: 'no_video' };
          // manual_test fallback: no video → synthetic test image (auction_* never falls back).
          if (!frame.ok && kind === 'manual') {
            console.log('[LENSED][SHOT] manual_test fallback used:', frame.reason);
            frame = synthFrame();
          }
          var msg = {
            type: 'CAPTURE_STORE', kind: kind,
            screenshotType: kind === 'start' ? 'auction_start' : (kind === 'manual' ? 'manual_test' : 'auction_end'),
            attemptId: currentAuctionAttemptId,
            sessionId: counterSessionId || null,
            roomId: currentRoomId || null,
            stagedSnapshot: stagedSnapshot(),
            startTrigger: kind === 'start' ? 'dom' : null,
            ts: Date.now(),
          };
          for (var kk in extra) { if (Object.prototype.hasOwnProperty.call(extra, kk)) msg[kk] = extra[kk]; }
          if (!frame.ok) {
            msg.kind = 'failed'; msg.error = frame.reason;
            if (!shotFailLogged) { shotFailLogged = true; console.warn('[LENSED][SHOT] capture unavailable:', frame.reason); }
            else shotDbg('[LENSED][SHOT] capture unavailable:', frame.reason);
          } else {
            msg.base64 = frame.base64;
            msg.srcWidth = frame.srcW; msg.srcHeight = frame.srcH;
            msg.width = frame.w; msg.height = frame.h;
            msg.bytes = frame.bytes;
            console.log('[LENSED][SHOT] upload started', { type: msg.screenshotType, bytes: frame.bytes, synthetic: !!frame.synthetic });
          }
          // Snapshot counters before the round-trip so we can log the outcome by delta.
          var prev = shotStatus || { uploaded: 0, pending: 0, failed: 0, queued: 0 };
          chrome.runtime.sendMessage(msg, function (resp) {
            if (chrome.runtime.lastError) { console.warn('[LENSED][SHOT] upload failed (sendMessage):', chrome.runtime.lastError.message); return; }
            if (resp && resp.status) {
              var s = resp.status;
              if (s.uploaded > (prev.uploaded || 0)) console.log('[LENSED][SHOT] upload + metadata success');
              else if ((s.queued || s.pending || 0) > (prev.queued || prev.pending || 0)) console.warn('[LENSED][SHOT] upload pending — queued for retry (reason in SW console)');
              else if (s.failed > (prev.failed || 0)) console.warn('[LENSED][SHOT] upload failed (reason in SW console)');
              applyShotStatus(s);
            }
          });
          lastCaptureTs = Date.now();
        } catch (e) { shotDbg('[LENSED][SHOT] capture inner error:', e); }
      });
    } catch (e) { shotDbg('[LENSED][SHOT] capture error:', e); }
  }

  // Sale-driven end (authoritative). Attaches to the active attempt (none while
  // auto-start is disabled → unmatched end-only). Never pairs on staged SKUs.
  function endAuctionAttemptOnSale(sale) {
    captureShot('end', {
      orderId: sale.orderId || null,
      buyer: sale.buyerUsername || null,
      priceCents: priceStrToCents(sale.sellingPrice),
    });
    currentAuctionAttemptId = null;
    auctionSaleSeenForAttempt = false;
  }

  // ── Overlay UI (tiny) ───────────────────────────────────────────────
  function applyShotStatus(status) { if (status) shotStatus = status; renderShotStatus(); }
  function renderShotStatus() {
    if (shotStatusEl) {
      if (!shotsEnabled) { shotStatusEl.textContent = 'shots off'; }
      else {
        var s = shotStatus;
        shotStatusEl.textContent = s
          ? ('shots ↑' + s.uploaded + ' ⏳' + (s.queued != null ? s.queued : s.pending) + ' ✕' + s.failed)
          : 'shots on';
      }
    }
    if (shotWarnEl) {
      var w = '';
      if (shotsEnabled && shotStatus && (shotStatus.queued > 0 || shotStatus.pending > 0)) {
        w = (shotStatus.queued || shotStatus.pending) + ' pending upload — will retry.';
      }
      shotWarnEl.textContent = w ? ('⚠ ' + w) : '';
    }
  }

  // Reflect toggle state onto the (collapsed) debug row + header dot. No work when off.
  function applyShotsUi() {
    if (shotDotEl) shotDotEl.style.opacity = shotsEnabled ? '0.9' : '0.35';
    if (shotDebugEl) shotDebugEl.style.display = shotsEnabled ? 'block' : 'none';
    renderShotStatus();
    if (shotsEnabled && counterSessionId) {
      try {
        chrome.runtime.sendMessage({ type: 'GET_SHOT_STATUS', sessionId: counterSessionId, roomId: currentRoomId }, function (r) {
          if (chrome.runtime.lastError) return;
          if (r && r.status) applyShotStatus(r.status);
        });
      } catch (_) {}
    }
  }

  function setShotsEnabled(on) {
    shotsEnabled = !!on;
    try { chrome.storage.local.set({ lensed_shots_enabled: shotsEnabled }); } catch (_) {}
    if (shotsEnabled) shotsReady = true; // manual enable during a live is immediately ready
    applyShotsUi();
  }

  // Lazy init: read the persisted flag ONCE, well after load, so nothing screenshot-
  // related runs during the order-counter catch-up. Enables capture only past that.
  function initShotsLazy() {
    try {
      chrome.storage.local.get([LK_SHOTS], function (data) {
        if (chrome.runtime.lastError) { shotsEnabled = false; return; }
        shotsEnabled = !!(data && data[LK_SHOTS]);
        shotsReady = true; // past catch-up window regardless; capture still gated on shotsEnabled
        applyShotsUi();
      });
    } catch (_) { shotsEnabled = false; }
  }
  setTimeout(initShotsLazy, 6000);

  // ── DOM probe (dev, manual) — confirm auction selectors from a live ──
  window.__lensedDomProbe = function () {
    var report = { videos: [], keyworded: [], countdownLike: [] };
    try {
      var vids = document.querySelectorAll('video');
      report.videos = [].map.call(vids, function (v) { return { rs: v.readyState, w: v.videoWidth, h: v.videoHeight, paused: v.paused, visible: shotIsVisible(v) }; });
      var all = document.querySelectorAll('body *');
      var kw = /auction|bid|countdown|winner|timer/i;
      for (var i = 0; i < all.length && report.keyworded.length < 40; i++) {
        var e = all[i];
        var cls = (typeof e.className === 'string') ? e.className : '';
        if (kw.test(cls) || kw.test(e.id || '')) {
          report.keyworded.push({ tag: e.tagName.toLowerCase(), id: e.id || '', cls: cls.slice(0, 90), text: (e.textContent || '').trim().slice(0, 40), vis: shotIsVisible(e) });
        }
      }
      for (var j = 0; j < all.length && report.countdownLike.length < 25; j++) {
        var el2 = all[j];
        var t = (el2.childElementCount === 0) ? (el2.textContent || '').trim() : '';
        if (t && /^(\d{1,2}|\d?\d:\d\d)$/.test(t) && shotIsVisible(el2)) {
          report.countdownLike.push({ tag: el2.tagName.toLowerCase(), cls: ((typeof el2.className === 'string') ? el2.className : '').slice(0, 90), text: t });
        }
      }
    } catch (e) { report.error = String(e); }
    console.log('[LENSED][DOMPROBE]', report);
    return report;
  };

  console.log('[LENSED][TT] content bridge + overlay installed');
})();
