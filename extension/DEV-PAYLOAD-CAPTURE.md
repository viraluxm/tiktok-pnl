# Dev-only Payload Capture — spec (DO NOT release)

**Status:** spec only — not built. This describes a throwaway, dev-only build of
`tiktok-inject.js` that dumps identity/lifecycle response bodies from **one** live so we can
answer three questions we cannot answer by guessing. It is **never** published — no
`gh release`, ever. Load unpacked on ONE trusted machine for ONE live, then remove it.

## Why (three questions, one capture)

1. **Owner identity — where does the channel handle actually live?**
   0 of 70 sessions ever received a payload identity (`channel_sec_uid` / `channel_nickname` /
   `channel_account_id` are all NULL). The fields the injector currently guesses
   (`owner`/`anchor` on `room/status`, `room/info`, `room/enter`) are **wrong** — they never
   land. This is the **primary** fix for channel detection. The shipped **v0.6.4 backstop only
   stops corruption** (it refuses to write UI text like "10s"/"English"/"Close"); it does
   **not** lift coverage — only ~34/70 sessions get any handle, and the 36 nulls stay null.
   Finding the real owner field is what lifts coverage past ~50%.

2. **Auction-close event — does TikTok emit a per-auction close/winner-declared event BEFORE
   `auction_result/get`?**
   If **yes**, the "closing…" transitional overlay state becomes **payload-sourced and robust**
   (grey the staged pills on the close event; clear only when the order lands — never
   decoupled). If **no**, the only cue is the fragile DOM countdown, which is **grey-only at
   best**. Today we intercept only `auction_result/get` (the order, ~5.3s post-win), room-id
   relays, and `LIVE_END` (whole-stream). There is **no per-auction close event** in what we
   observe — this capture is how we find out if one exists.

3. **Anything else identity- or auction-lifecycle-shaped worth knowing.**
   We capture once, so capture broadly **within the privacy limits below** — every allowed
   endpoint's shape, so we're not back here a third time.

## PRIVACY — non-negotiable (this is why it is never released)

- **Allow only identity/lifecycle-shaped endpoints:** path contains
  `room` / `live` / `anchor` / `user` / `creator` / `auction` / `host`.
- **Deny buyer-PII endpoints even if they match allow:** anything with
  `auction_result` / `order` / `pay` / `checkout` / `address` / `buyer` / `receiver` /
  `settle` / `fulfil` / `shipping` / `logistics` / `message`. **`auction_result/get` is the
  order snapshot — it carries buyer names and addresses. It is DENIED.**
- **Never log Authorization headers or tokens.** We read **response bodies only** (never
  request headers), and a redactor masks any `access_token`/`refresh_token`/`authorization`/
  `cookie`/`session_key`/`token` values that appear inside a body. Identity fields
  (`sec_uid`, `unique_id`, `display_id`, `nickname`) are kept — they're the target.
- **Query strings are stripped** from the logged URL (path only) — query params can carry ids.
- **Bounded:** ≤ 40 KB body per dump, ≤ 200 dumps per live, **off by default** behind an
  explicit flag.
- **One machine, one live, unpacked only. No GitHub Release. Remove after.**

---

## Implementation (for whoever builds it — reference, not yet applied)

All changes are in **`extension/tiktok-inject.js`** (MAIN world). Additive and **observe-only**
— it does not modify any response, and it does not touch the sale/identity/room relays that
already exist. Build as a clearly-marked dev version (e.g. manifest `version` `0.6.4-capture`)
so it can never be confused with a release.

### 1) A dedicated capture flag (separate from `isDev`/`isDevRaw`)

```js
// DEV-ONLY payload capture — NEVER released. Off unless explicitly enabled.
function isCapture() {
  try {
    return window.__LENSED_CAPTURE__ === true ||
      (window.localStorage && window.localStorage.getItem('lensed_capture') === '1');
  } catch (_) { return false; }
}
```

### 2) Allow/deny + redaction + the dumper

```js
// Identity/lifecycle endpoints ONLY. DENY wins over ALLOW so a buyer-PII endpoint that
// also matches "auction" (i.e. auction_result/get) is never dumped.
var CAP_ALLOW = /\/(room|live|anchor|user|creator|auction|host)\b/i;
var CAP_DENY  = /(auction_result|order|pay|checkout|address|buyer|receiver|settle|fulfil|shipping|logistics|message)/i;
var CAP_BODY_CAP = 40 * 1024;  // bytes per body
var CAP_MAX_DUMPS = 200;       // hard stop so one live can't flood the console
var capCount = 0;

// Defense-in-depth: mask auth secrets that appear inside a RESPONSE body. Keeps
// sec_uid/unique_id/nickname/display_id (the capture target) intact.
function capRedact(s) {
  try {
    return s.replace(
      /"(access_token|refresh_token|authorization|cookie|session_key|token)"\s*:\s*"[^"]*"/gi,
      '"$1":"[REDACTED]"');
  } catch (_) { return s; }
}

function capMaybeDump(url, status, text) {
  if (!isCapture() || capCount >= CAP_MAX_DUMPS) return;
  var path;
  try { path = new URL(url, window.location.origin).pathname; }
  catch (_) { path = String(url).split('?')[0]; }
  if (!CAP_ALLOW.test(path) || CAP_DENY.test(path)) return;   // deny wins
  capCount++;
  var body = (typeof text === 'string') ? text.slice(0, CAP_BODY_CAP) : '';
  var sketch = null; try { sketch = sketchKeys(JSON.parse(text)); } catch (_) {}  // sketchKeys already exists
  console.log('[LENSED][CAPTURE] #' + capCount + ' ' + (status || '?') + ' ' + path
    + (sketch ? ('  keys=' + JSON.stringify(sketch)) : ''));
  console.log('[LENSED][CAPTURE] #' + capCount + ' BODY:', capRedact(body));
}
```

### 3) Two call sites (both observe-only, additive)

**fetch interceptor** — add *before* the existing `if (!isSale && !idTag) return p;` early
return (currently `tiktok-inject.js:418`), so capture runs even for endpoints that aren't a
sale or a guessed-identity URL:

```js
if (isCapture()) {
  p.then(function (res) {
    try { res.clone().text().then(function (t) { capMaybeDump(url, res.status, t); }).catch(function () {}); }
    catch (_) {}
  }).catch(function () {});
}
```

**XHR `send`** — add alongside the existing identity/sale load listeners:

```js
if (isCapture()) {
  this.addEventListener('load', function () {
    try { capMaybeDump(String(url), this.status, this.responseText); } catch (_) {}
  });
}
```

Nothing else changes. The existing sale/identity/room handling is untouched — capture is a
parallel, read-only tap.

---

## Running it (host instructions)

**Prep (once, on the ONE trusted machine — yours or a lead host's):**
1. Build the dev variant (manifest `version` = `0.6.4-capture`). Do **not** zip or release it.
2. `chrome://extensions` → Developer mode → **Load unpacked** → select the dev `dist/`
   (or source) folder. Confirm it loads as `0.6.4-capture`.
3. Open DevTools on the shop.tiktok.com tab → **Console** → turn **Preserve log ON**
   (gear icon or the "Preserve log" checkbox) so a page navigation doesn't wipe the capture.

**Enable + run (during a real live):**
4. In the shop.tiktok.com Console, run: `localStorage.setItem('lensed_capture','1')`
   (or set `window.__LENSED_CAPTURE__ = true`).
5. **Re-enter the live** — reload the live page / navigate into it fresh — so the join
   lifecycle endpoints (`room/enter`, `room/info`, etc.) fire **with the flag on**. (If you
   enable mid-live you'll miss the enter/join calls.)
6. Run for **~3–5 minutes covering at least 3–5 full auctions**, and make sure at least one
   auction goes **countdown → close → winner → order** while you're capturing, so the
   close-vs-order ordering (question 2) is visible.
7. When done: `localStorage.removeItem('lensed_capture')` to stop.

**Export the console output:**
8. In the Console, type `[LENSED][CAPTURE]` in the filter box to isolate the capture lines.
9. Right-click anywhere in the Console → **Save as…** → save the `.log` text file. (Or select
   all filtered lines and copy.) Send me that file.

**Teardown:**
10. `chrome://extensions` → **Remove** the unpacked `0.6.4-capture` build → reload the normal
    released extension. The dev build must not linger.

---

## What I look for in the export

1. **Owner identity (Q1):** `grep` the saved log for a **known channel handle** — e.g.
   `onlybidss` (or whichever channel that live ran). Whichever endpoint + JSON path contains
   it **is** the real owner field. I wire `extractAccountIdentity()` (and the
   `SECUID_KEYS`/`HANDLE_KEYS`/`NICK_KEYS` paths) to that endpoint's actual shape, and the
   payload becomes the **primary** channel source (strong identity — can even auto-map new
   channels). Also note the accompanying `sec_uid` / `display_id` / `nickname` on the same
   object.
2. **Auction-close event (Q2):** scan chronologically for an endpoint that fires **at auction
   close, before** that item's `auction_result/get` — something with winner / result / bid /
   final-price fields but **no** buyer/order body. If it exists → "closing…" is payload-sourced
   (grey on the close event, clear on the order). If nothing fires before the order snapshot →
   the only cue is the DOM countdown (grey-only).
3. **Anything else (Q3):** catalogue the identity fields and their endpoints, and any auction
   lifecycle events (start / activate / close / settle) — so we know the full shape from this
   one capture.

---

## For the record — settled, do not re-investigate

**The ~5.3s "item lingers after the win" lag is TikTok's poll cadence, not a defect.**
Measured across **2,310 captures / 12 lives / multiple hosts and days** (`capture_events.created_at
− ordered_at`): median **5.31s**, IQR **4.82–5.86s** (~1s wide), **97% within 3–10s**, and every
one of 12 separate lives has a median of **4.96–5.63s** (per-live stddev 1.1–2.5s). That
cross-live tightness is a **fixed upstream poll interval**, not our-side variability. The
overlay already clears **optimistically on detection** (`clearStaged()` runs synchronously on
`AUTO_BIND` dispatch, not on the write returning), and a failed write raises a persistent
fail-loud banner + auto-retries. **There is no write-path change that reduces this lag** — the
delay is entirely TikTok's delivery of the order to its own page, which we observe passively.
Do not re-open this. (The only lever on the *cosmetic* lag is the "closing…" transitional
state above, gated on Q2.)
