# Session end signal — the precise-close path (capture-side, needs Abe)

Status: **spec, not built.** Build 2 (`POST /api/admin/sessions/auto-end`) is the
stopgap already implemented. This doc describes the real fix, which needs work in
the browser extension (the capture side).

Context: a live session should have `started_at` when the live begins and `ended_at`
when it ends. Today **7 of 8** `live_sessions` have `ended_at = NULL` — effectively
every session. Nothing ever closes them, because the extension has no end-of-live
detection. That NULL `ended_at` is what forces the coverage check (and the duration
endpoint) to guess the window end from "last capture," which is why an unended
session's window balloons.

---

## 1. The question for Abe

**Does the intercepted TikTok live data expose a reliable end-of-live event (host
ends the stream)?**

The extension already intercepts TikTok's own network traffic on
`shop.tiktok.com` / `streamer_desktop`. All interception happens in **one place** —
the `fetch` and `XHR` hooks in [`extension/tiktok-inject.js`](../extension/tiktok-inject.js):

- `window.fetch` wrapper — [tiktok-inject.js:348-370](../extension/tiktok-inject.js:348)
- `XMLHttpRequest.open/send` wrappers — [tiktok-inject.js:374-392](../extension/tiktok-inject.js:374)

Today those hooks act on exactly two URL markers:

```js
// tiktok-inject.js:355  (fetch)  and  :386 (xhr)
if (urlLower.includes('room_id=')) relayRoom(extractRoomIdFromUrl(url));   // live is ON / ongoing
...
const isSale = urlLower.includes(SALE_URL_MARKER);                         // a sale (auction_result/get)
```

An **end-of-live signal would land right here** — the same interceptor, a third
marker. When the host ends the stream, `streamer_desktop` almost certainly fires a
distinguishable request (an "end live room" / "stop stream" call, or a room-status
response flipping to ended). **Abe's task:** capture the streamer_desktop traffic at
the moment a host clicks "End LIVE" and identify the request path or the
response-field that reliably marks the end. If such a marker exists, wiring it is
small (see §3). If it does *not* exist in interceptable traffic, we fall back to the
timeout (§2) plus possibly a heartbeat-gap heuristic — and that limitation should be
recorded here.

Where the relay goes once detected (so Abe sees the whole path):

```
tiktok-inject.js  window.postMessage({ source: 'lensed-tiktok-room', ... })   // :90
   → tiktok-content.js  onWindowMessage → chrome.runtime.sendMessage({type:'TIKTOK_ROOM'})   // :1779
      → background.js  onMessage 'TIKTOK_ROOM' handler   // :851
```

Sales use the identical path (`lensed-tiktok-sale` → `TIKTOK_SALE` →
[background.js:884](../extension/background.js:884)). An end event would mirror it:
`lensed-tiktok-live-end` → `TIKTOK_LIVE_END` → a new background handler.

---

## 2. Why the timeout auto-ender (Build 2) is a stopgap, not the real fix

`POST /api/admin/sessions/auto-end` closes a session when its most recent capture is
older than `IDLE_THRESHOLD_MIN` (45m) and stamps `ended_at = last capture`. Useful,
but structurally limited:

- **It cannot distinguish "live ended" from "long pause / captures dropped."** A host
  who pauses 50 minutes mid-live, or a stretch with no sales, or the extension losing
  auth for a while, all look identical to "ended." The stamped `ended_at` would be
  the last sale before the lull, cutting the live short.
- **It is retroactive and coarse.** `ended_at` is the last *capture*, not the true
  end of the broadcast — anything after the final sale (wind-down, goodbyes) is lost.
- **It can't split a session that already merged two lives.** If two lives ever share
  one session row, stamping one `ended_at` is wrong for the first. (In current data
  this doesn't happen — see §4 — but the timeout has no defense if it ever does; it
  explicitly flags such rows for manual split instead of guessing.)
- **It needs a trigger.** Until wired to a cron it only runs on demand; a real end
  signal closes the session the instant the live ends, with no sweep.

The timeout is the right *safety net* (it bounds the damage of a missing signal). It
is not the *source of truth*.

---

## 3. What the extension would need to send, and what the web side does

**Extension (capture side):**
1. In the `tiktok-inject.js` interceptors, add an end-of-live marker alongside
   `room_id=` / `SALE_URL_MARKER` (the exact marker is Abe's §1 finding). On match,
   `relayLiveEnd(roomId)` → `window.postMessage({ source: 'lensed-tiktok-live-end', roomId, endedAt })`.
2. `tiktok-content.js` forwards it as `chrome.runtime.sendMessage({ type: 'TIKTOK_LIVE_END', roomId, endedAt })`
   (mirror the `lensed-tiktok-room` handler at [tiktok-content.js:1779](../extension/tiktok-content.js:1779)).
3. `background.js` adds a `TIKTOK_LIVE_END` handler (next to `TIKTOK_ROOM`,
   [background.js:851](../extension/background.js:851)) that resolves the session for
   that room and calls the web end endpoint, then **clears the in-memory session pin**
   (`currentSessionId = null; sessionRoomId = null;`) so the next live cannot reuse it.

**Web side:**
- Stamp `ended_at` **precisely** from the signal's timestamp. The endpoint already
  exists — [`POST /api/live/sessions/[id]/end`](../src/app/api/live/sessions/%5Bid%5D/end/route.ts) —
  though it currently sets `ended_at = now()`; it would take an explicit `ended_at`
  from the end event (the real stream-end time), not the request time.
- **Start a fresh session on the next live** rather than reusing. Once a session is
  ended, `getOrCreateSession` already won't reuse it (its DB lookup filters
  `status in (draft,live)` — [background.js:582](../extension/background.js:582)), so a
  clean end is exactly what guarantees the next live opens a new session.

Net effect: `ended_at` becomes trustworthy, the coverage check's "prefer sane
`ended_at`" path takes over (no more last-capture guessing), and every live is its
own bounded session.

---

## 4. The reused-session root cause — investigated

**Earlier belief:** one session (`64ee097c`) spanned ~10 lives over 16 days, implying
the extension reuses a session id across streams.

**Finding: that belief was WRONG — it was a measurement artifact.** With captures
correctly attributed to each session (bounded by the *next* session's `started_at`
for the same user+store), the data shows **one session per live**:

| session | captures | span | max internal gap | → |
|---|---|---|---|---|
| 64ee097c | 217 | 2.66h | 0.12h | single live (crosses PT midnight) |
| 8ceb55a9 | 177 | 2.99h | 0.06h | single live |
| 89f00c27 | 351 | 7.95h | 0.08h | single live |
| bbcc10c4 | 284 | 7.98h | 0.14h | single live |
| 30200412 | 295 | 7.87h | 0.24h | single live |
| 760d5ffd | 345 | 7.92h | 0.10h | single live |

No session has a large internal capture gap. `64ee097c` is a **single 2.66h live**,
not 10 lives. The "16 days / 10 lives" appearance came from the coverage endpoint
querying `capture_events` by `user_id` with **no upper bound** (`created_at >= started_at`
only), so an unended session's window absorbed every *later* session's captures.

**Session-creation path — is a new session created per live?** Yes, in practice.
[`getOrCreateSession(roomId)`](../extension/background.js:551):

- reuses the in-memory session only if `sessionRoomId === room` ([:557](../extension/background.js:557));
- else looks for a DB session for **this exact `room_id`**, `status in (draft,live)`,
  `source=extension`, `started_at >= now − 12h` ([:577-585](../extension/background.js:577));
- else **creates a new session** tagged with the room ([:597](../extension/background.js:597)).

Reuse is gated by `SESSION_REUSE_MAX_AGE_MS = 12h` ([background.js:67](../extension/background.js:67))
**and** the TikTok `room_id`, which is assigned per broadcast. Two different lives get
different room_ids → different sessions; and anything >12h apart forces a new session
even if a room_id recurred ([:65 comment](../extension/background.js:65),
restore-cutoff [:329](../extension/background.js:329)).

**So the actual root cause is NOT id-reuse across lives.** It is:

1. **Sessions never end** (no end signal) → they sit in `status='live'` forever, and
2. the **coverage/duration window logic guesses the end from last-capture unbounded by
   the next session**, so an unended session's window swells to "now."

The latent reuse risk that *does* exist: two lives **on the same `room_id` within
12h** while the first is still un-ended would merge into one session. It's rare
(room_id is per-broadcast) but the end signal (§3) removes it entirely by closing the
first session immediately.

**Two independent fixes fall out of this:**
- **End signal (this doc):** the correct, precise close — closes the session the
  instant the live ends, guarantees a fresh session next time.
- **Coverage window bounding (separate, web-side):** even without an end signal, the
  coverage endpoint should bound a session's capture window by the *next* session's
  `started_at` (as the analysis above does) instead of running open-ended to "now."
  Note that **once Build 2's auto-ender stamps `ended_at`**, the coverage endpoint's
  existing "prefer sane `ended_at`" path already yields the correct bounded window —
  so running Build 2 is also an immediate mitigation for the coverage inflation.
