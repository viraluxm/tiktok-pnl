# Lensed — Architecture Review (Bind-Gap & Data Integrity)

**Branch:** `feat/shows-store-name`
**HEAD commit:** `f68ca49ff8e7ed95093c0e8ba4a1018c659cde9a`
**Divergence from `main`:** 4 ahead, 0 behind. Branch-unique migration: `050_live_session_host.sql` only.
**Scope:** Read-only analysis. No code was changed. Findings quote the code as it is today.

> Note on the loaded `CLAUDE.md`: the project-instructions file describes "Tabrys Device Firmware" (a Raspberry Pi wearable). It does not describe this repo (Lensed, a Next.js + Supabase app) and was disregarded as stale/misrouted.

---

## Executive summary

The bind step is the only source of real SKU identity, and the review confirms the design treats a *captured-but-unbound* order as recoverable — reconcile Part B surfaces those. **But the system has no mechanism that reconciles against the authoritative order set (`synced_order_ids`).** Reconcile enumerates the extension's own `capture_events`, not the TikTok-synced orders. So the failure mode that produces "30 missing orders" — orders that TikTok has but the *extension never captured* — is invisible to reconcile by construction, and only partially visible at the pack station. This is the central risk and it is Critical.

---

## 1. The bind-gap failure (highest priority)

### 1.1 Full path from a TikTok order to SKUs at the pack station

There are **three independent writers** and they do not cross-check each other:

| Row | Written by | Trigger |
|---|---|---|
| `synced_order_ids` (one row per TikTok order_id) | `POST /api/tiktok/sync` → `admin.from('synced_order_ids').upsert(...)` — [sync/route.ts:203](src/app/api/tiktok/sync/route.ts:203) | TikTok Order API poll (authoritative order list) |
| `capture_events` (one row per order the extension *saw*) | extension `upsertCaptureEvent()` — [background.js:670](extension/background.js:670) | DOM scrape of `auction_result/get` during the live |
| `live_auction_items` + `live_auction_item_skus` (the bind) | `lensed_log_auction` RPC — [background.js:635](extension/background.js:635) | only when staged SKUs + a room-scoped session both exist |

The pack station ([pick-list/route.ts:26-102](src/app/api/shipping/pick-list/route.ts)) walks: scanned `order_id` → `synced_order_ids.auto_combine_group_id` → sibling order_ids → `live_auction_items` (by `client_idempotency_key = order_id`) → `live_auction_item_skus` → `inventory_skus`. SKUs appear at the pack station **only if a `live_auction_item` exists for that order**.

### 1.2 When the host forgets to bind a win, what exists and what doesn't

The extension **always** writes `capture_events`, even on a missed bind — [background.js:766-767](extension/background.js:766) (`// Always upsert to capture_events` runs after every branch). The bind only happens on the "fresh bind" branch, which requires staged SKUs *and* a resolvable session ([background.js:717-755](extension/background.js:717)). The "no staged SKUs" branch explicitly logs *captured only, NOT bound* — [background.js:758-764](extension/background.js:764).

So there are **two distinct bind-gap shapes**, and they are not equally recoverable:

- **(A) Captured-but-unbound** — host saw the sale but tagged no SKU. Rows: `capture_events` ✅, `synced_order_ids` ✅ (after sync), `live_auction_items` ❌. **Recoverable** — reconcile Part B finds it.
- **(B) Synced-but-never-captured** — the extension never recorded the sale (worker asleep, auth lapsed, DOM missed the order, extension not running, order arrived outside the scrape). Rows: `synced_order_ids` ✅, `capture_events` ❌, `live_auction_items` ❌. **NOT recoverable by reconcile** — see 1.3. This is the "30 missing orders" shape.

### 1.3 Does the reconcile flow enumerate ALL synced orders, or only captured ones?

**Only captured ones.** Reconcile never queries `synced_order_ids`. Its unbound-detection set is built from `capture_events` filtered by the session time window — [reconcile/route.ts:90-111](src/app/api/live/sessions/[id]/reconcile/route.ts:90):

```ts
let capQ = supabase
  .from('capture_events')
  .select('order_id, buyer_username, selling_price_cents')
  .eq('user_id', user.id)
  .gte('created_at', session.started_at);
if (session.ended_at) capQ = capQ.lte('created_at', session.ended_at);
const { data: caps } = await capQ;
...
const unboundCaps = (caps ?? []).filter((c) => {
  const o = String(c.order_id);
  if (o === '0' || boundSet.has(o) || seen.has(o)) return false;   // <- source = caps, not synced_order_ids
  seen.add(o); return true;
});
```

**Risk:** An order in `synced_order_ids` with no `capture_events` row is structurally invisible to reconcile. Reconcile compares "what the extension captured" against "what got bound" — it never asks "did every real TikTok order get a SKU?" against the authoritative list. **Severity: Critical.**

Secondary: the window is a time filter on `capture_events.created_at` vs the session's `started_at`/`ended_at`. A capture whose `created_at` falls outside the session window (clock skew, late upsert, session times off) is also excluded even if it belongs to the show. **Severity: Medium.**

### 1.4 Does pack-station box resolution silently undercount?

**Yes, when a box-mate has a NULL or mismatched `auto_combine_group_id`.** Box membership is resolved purely from group id — [pick-list/route.ts:37-50](src/app/api/shipping/pick-list/route.ts:37):

```ts
const groupId: string | null = scanned.auto_combine_group_id ?? null;
const groupKey = groupId ? groupId : `order:${orderId}`;
let orderIds: string[] = [orderId];
if (groupId) {
  const { data: siblings } = await supabase
    .from('synced_order_ids')
    .select('order_id')
    .eq('user_id', user.id)
    .eq('auto_combine_group_id', groupId);   // <- box = exact group-id match only
  const ids = (siblings ?? []).map((s) => String(s.order_id)).filter(Boolean);
  if (ids.length) orderIds = [...new Set(ids)];
}
```

- If the **scanned** order has NULL group id → treated as a singleton (`order:${orderId}`); every true box-mate is silently dropped from the box.
- If a **sibling** order has NULL or a different group id → the `.eq('auto_combine_group_id', groupId)` filter never returns it, so it is neither packed nor listed.

The endpoint does compute `missing_order_ids` — [pick-list/route.ts:60-62](src/app/api/shipping/pick-list/route.ts:60) — but only over orders it *already resolved into the box*:

```ts
const orderIdsWithItems = new Set(itemRows.map((i) => String(i.client_idempotency_key)));
const missingOrderIds = orderIds.filter((id) => !orderIdsWithItems.has(id));
```

So `missing_order_ids` catches "in the box but never bound" (good — this is the one place a missed bind surfaces to a human), but it **cannot** catch "should be in the box but its group id is NULL/wrong" — that order is never in `orderIds` to begin with. The undercount is silent. **Severity: High.**

---

## 2. Reconcile + payouts

### 2.1 Reconcile — [reconcile/route.ts](src/app/api/live/sessions/[id]/reconcile/route.ts)

What it does (POST, manual action):
- **Part A** ([:77-87](src/app/api/live/sessions/[id]/reconcile/route.ts:77)): for **bound** items in `not_sold` whose TikTok order is now paid, calls `lensed_log_auction` with `PLACEHOLDER_SKUS` to flip `not_sold → sold` (027 transition path ignores `p_skus`). Exactly-once via the RPC's idempotency.
- **Capture-based revenue** ([:89-101, :127-137](src/app/api/live/sessions/[id]/reconcile/route.ts:127)): sums `capture_events.selling_price_cents` over paid wins. Re-computed fresh each run (read, not accumulated) → re-run safe.
- **Part B** ([:103-125](src/app/api/live/sessions/[id]/reconcile/route.ts:103)): unbound = `capture_events` in-window, minus junk `'0'`, minus already-bound, that TikTok confirms PAID. Returned as `unbound[]` for manual SKU assignment.

Operates over: **bound `live_auction_items` for this session** ∪ **`capture_events` in the session window**. It calls TikTok `getOrderById` only to check paid status of orders it already knows about.

**What it cannot catch by construction:** any order absent from `capture_events` (shape B in §1.2). It also scopes `live_auction_items` by `session_id` ([:66-69](src/app/api/live/sessions/[id]/reconcile/route.ts:66)); a bind recorded under a *different* session for the same order (the 043 duplicate-session scenario) would not be counted as bound for *this* session, though 043's DB-level de-dup mitigates the duplicate-row half of that. **Severity: Critical** (the `synced_order_ids` blind spot).

### 2.2 Refresh payouts — [payouts/route.ts](src/app/api/live/sessions/[id]/payouts/route.ts)

Deliberately split out of reconcile because it is slow ([:8-16](src/app/api/live/sessions/[id]/payouts/route.ts:8)). Order set to price = bound items ∪ in-window captures, minus `'0'` — [:58-61](src/app/api/live/sessions/[id]/payouts/route.ts:58). Pages the shop unsettled list (cap 100 pages), preferring SETTLED actual, else UNSETTLED estimate, else no row. Upserts `order_payouts` on `(user_id, order_id)` — exactly-once, estimate→settled flips update in place ([:106-107](src/app/api/live/sessions/[id]/payouts/route.ts:106)). Read-only against inventory.

**Same blind spot:** its order set is `items ∪ caps`, again never `synced_order_ids`, so a synced-but-uncaptured order gets no payout row. The 100-page cap ([:68](src/app/api/live/sessions/[id]/payouts/route.ts:68)) silently truncates estimate lookup for very large unsettled lists; over-cap orders fall through to the per-order settled probe, but unsettled-and-over-cap orders would get no estimate. **Severity: Medium.**

### 2.3 Why unbound orders may be invisible to reconcile

Because reconcile's universe is the *extension's capture log*, not the *order ledger*. The one system that holds every real order (`synced_order_ids`, written by the TikTok sync) is never consulted by either reconcile or payouts. Nothing computes `synced_order_ids − (bound ∪ captured)`.

---

## 3. Sync integrity (`synced_order_ids` writer)

Writer: `syncConnection()` in [sync/route.ts:98-271](src/app/api/tiktok/sync/route.ts:98).

### 3.1 How orders + `auto_combine_group_id` get written
- Orders parsed by `parseOrder()` ([:312-359](src/app/api/tiktok/sync/route.ts:312)), deduped by order_id within a page ([:192-197](src/app/api/tiktok/sync/route.ts:192)), bulk-upserted `onConflict: 'user_id,order_id'` with `store_id` stamped from the connection being synced ([:202-203](src/app/api/tiktok/sync/route.ts:202)). Per-store tagging is correct **as long as the connection has a non-NULL `store_id`** (guaranteed post-042, which made `tiktok_connections.store_id` NOT NULL).
- `auto_combine_group_id` — [:321](src/app/api/tiktok/sync/route.ts:321):
  ```ts
  const autoCombineGroupId = o.auto_combine_group_id != null ? String(o.auto_combine_group_id) || null : null;
  ```

### 3.2 Can an order land with a missing/wrong group id? — **Yes.**
If TikTok's order payload omits `auto_combine_group_id` (non-combined orders, or the field simply not returned on the `/order/202309/orders/search` shape), it is stored NULL. This is expected/additive per [028_add_auto_combine_group_id.sql:14-15](supabase/migrations/028_add_auto_combine_group_id.sql:14) ("Non-combined orders simply leave it null"). The integrity concern is **downstream**, not here: a NULL group id feeds the silent pack-station undercount in §1.4. If TikTok assigns/changes the combine group *after* the order was first synced, a later re-sync upsert would correct it — but only if that day is re-fetched (see cursor behavior below). **Severity: High** (because of the §1.4 consequence).

### 3.3 order_id="0" junk — **confirmed it can land.**
`parseOrder` sets `orderId = String(o.id || '')` ([:313](src/app/api/tiktok/sync/route.ts:313)) and the writer keeps any truthy id — `if (oid) rows.set(oid, parsed)` ([:195-196](src/app/api/tiktok/sync/route.ts:195)). The string `"0"` is truthy, so a junk `order_id="0"` row is upserted into `synced_order_ids`. Downstream consumers defensively filter it (reconcile [:109](src/app/api/live/sessions/[id]/reconcile/route.ts:109), payouts [:61](src/app/api/live/sessions/[id]/payouts/route.ts:61)), but the pack-station and any raw count over `synced_order_ids` do not. **Severity: Medium.**

### 3.4 Cursor / re-sync behavior
The current writer uses a **1-day chunk loop** with in-day `page_token` pagination, max 500 pages/day ([:173-232](src/app/api/tiktok/sync/route.ts:173)), and a 50s time budget. `fetchOrdersPage` ([client.ts:219-256](src/lib/tiktok/client.ts:219)) is a plain single-page cursor fetch — the **recursive binary-split** logic described in the review brief is **not present in the current code** (either removed or never on this branch). Notable behaviors:
- **Always re-syncs today**: cursor is clamped so it never skips past today ([:155-158](src/app/api/tiktok/sync/route.ts:155)), and `isCaughtUp` only when `currentDay > todayStr`. Good for late-arriving same-day orders; means today's group-id corrections get picked up, but **prior days are not re-fetched once the cursor passes them** — a group id assigned to an old order after its day was synced will not be corrected until a full backfill.
- **Progress saved every 10 days** ([:240-246](src/app/api/tiktok/sync/route.ts:240)); on an exception the lock is cleared but the cursor is not rolled forward ([:60-65](src/app/api/tiktok/sync/route.ts:60)), so a mid-day failure re-processes that day (idempotent via upsert — no double count).
- The "localhost re-sync regression" named in the brief is a deployment/runtime concern not visible in this file; no code path here reproduces it, but the always-re-sync-today + 365-day backfill window ([:9](src/app/api/tiktok/sync/route.ts:9)) means a fresh environment will re-page a large history. **Severity: Low-Medium** (no double-count risk found; the risk is coverage/latency, not duplication).

**Double-count:** not found. Upsert on `(user_id, order_id)` plus in-page dedup makes re-runs safe. **Missing-order:** possible via the 500-pages/day and 50s-budget caps if a single day exceeds 25,000 orders or the budget expires mid-day — the day is resumed next run only because the cursor isn't advanced past an unfinished day within the same batch, but a partially-paged day whose cursor *does* advance (every 10 days it saves `currentDay`) could leave a gap. **Severity: Medium.**

---

## 4. Store scoping

### 4.1 Does the extension pass `store_id` on session creation? — **No.**
[background.js:597-607](extension/background.js:597) creates the session with `store_id` intentionally omitted:
```js
var created = await supabasePost('live_sessions', {
  user_id: userId, title: 'TikTok Live', status: 'live',
  started_at: ..., source: 'extension', tiktok_live_id: room,
  // store_id intentionally omitted — it is not known client-side. Production
  // populates it out-of-band (DB default/trigger)...
});
```
The web endpoint *accepts* `store_id` and validates membership if sent ([sessions/route.ts:71-90](src/app/api/live/sessions/route.ts:71)), but the extension never sends it.

### 4.2 What happens under a multi-store account
`live_sessions` is on the **deferred** trigger set — it still uses the old `set_store_id_from_user()` limit-1 backstop, **not** the fail-loud guard ([041 header:12-20](supabase/migrations/041_store_scoped_writes.sql:12)). So an extension-created session gets a store_id **guessed** by `limit 1` over the user's `store_members`. Under the consolidated single-login-owns-two-stores account (Alvaro owns "lots of steals" + "Snore"), that guess is arbitrary. This is explicitly called out as a known deferred follow-up — [docs/consolidation-2026-07.md:64-71](docs/consolidation-2026-07.md:66):

> The browser extension still creates `live_sessions` / `capture_events` without a `store_id` (they land NULL under the backstop, since the host's `store_members` now resolves ambiguously under one login).

Propagation of the wrong store: `lensed_log_auction` stamps the child rows' `store_id` from the **session** — [041:195, :231-238](supabase/migrations/041_store_scoped_writes.sql:231):
```sql
select s.id, s.status, s.store_id into v_session from public.live_sessions s where ...
insert into public.live_auction_items (user_id, store_id, ...) values (v_user, v_session.store_id, ...)
insert into public.live_auction_item_skus (user_id, store_id, ...) select v_user, v_session.store_id, ...
```
So a session that was mis-tagged (or NULL, then backstop-guessed) propagates that store to every bound auction item and SKU line for the whole show. `capture_events` derives its store from the linked auction ([041:66-88](supabase/migrations/041_store_scoped_writes.sql:66)), inheriting the same guess. **Severity: High** for multi-store correctness (P&L-by-store, per-store payouts). Single-store accounts are unaffected.

### 4.3 Places order tagging assumes a single store
- `shipping/confirm` derives box store from "the first synced order's `store_id`" ([confirm/route.ts:25-35](src/app/api/shipping/confirm/route.ts:25)) — assumes all orders in a box share one store (reasonable, but unvalidated).
- `entries` daily aggregates remain keyed `(user_id, date, source)` with **no store dimension** — [consolidation:72-74](docs/consolidation-2026-07.md:72) — so daily P&L mixes both stores under one login. **Severity: Medium** (documented, deferred).

---

## 5. State of the branch

- **Branch:** `feat/shows-store-name` @ `f68ca49f`. **4 commits ahead of `main`, 0 behind.** The 4 commits are all extension-side (live host selector, macro-pad hotkeys, hotkey debug gating, merge #23).
- **Working tree (uncommitted):** modified `src/app/api/live/sessions/route.ts`, `src/components/shows/ShowsTab.tsx`, `src/hooks/useLiveSessions.ts` (the `store_name` join feature this branch is named for); untracked `.claude/`, `post-live-deploy-checklist.md`.
- **Migrations carried vs main:** only `050_live_session_host.sql` is branch-unique (`git diff main..HEAD -- supabase/`). It pairs with the extension host-selector commits.
- **Conflict with 041/042/043?** **None.** `050` only `ALTER TABLE live_sessions ADD COLUMN host_id` (additive, nullable) and adds the `set_session_host` RPC ([050:14-48](supabase/migrations/050_live_session_host.sql:14)). It does not touch `synced_order_ids`, `tiktok_connections`, or `lensed_log_auction`, so it cannot collide with 041 (store scoping), 042 (multistore connections), or 043 (idempotency). Applied out-of-band via RPC, never via the session INSERT, so it can't break session creation ([050:10-12](supabase/migrations/050_live_session_host.sql:10)).
- **Migration numbering gaps:** no `030`, `048`, `049` in the tree (029→031, 047→050). Per [consolidation:61-62](docs/consolidation-2026-07.md:61) the 038–040 P&L files were numbered around a prior gap; all of 001–047 are on `main` (only 050 diverges), so the doc's "038–040 gap on main" note is now stale. **No action; just be aware the sequence is non-contiguous.**

---

## 6. Destructive-op safety

Overall: the irreversible inventory paths are **well-guarded** — via idempotency + advisory locks rather than dry-run/fingerprint, plus explicit-confirm gating for the one path that can go negative.

- **Live decrement (`lensed_log_auction`)** — [041:139, :199-201](supabase/migrations/041_store_scoped_writes.sql:199): `pg_advisory_xact_lock` on the session, plus per-SKU sorted advisory locks before drawing stock; idempotency on `(user_id, client_idempotency_key)` after 043 ([043:11-21](supabase/migrations/043_live_order_idempotency.sql:11)). A replay returns the canonical row with `replayed=true` and does **not** decrement again. Exactly-once decrement confirmed. No dry-run, but idempotency makes re-fire safe.
- **Negative decrement** — gated behind `p_allow_negative`, default `false` — [033 header:9-27](supabase/migrations/033_allow_negative_bind.sql:9). Only an explicit user-confirmed manual bind sets it ([bind/route.ts:18-21](src/app/api/live/sessions/[id]/bind/route.ts:18)); the live auto-bind path never does, so OUT_OF_STOCK still raises there. Good separation.
- **Manual retroactive bind** — double-bind guarded twice: a friendly pre-check ([bind/route.ts:43-48](src/app/api/live/sessions/[id]/bind/route.ts:43)) and the authoritative RPC idempotency ([bind/route.ts:55-60](src/app/api/live/sessions/[id]/bind/route.ts:55)). Manual-on-ended-session bypass is scoped to `p_manual` only.
- **ViewTrack void** — [046 header:1-19](supabase/migrations/046_viewtrack_void_batch.sql:1): refuses unless `qty_remaining = qty_added` (the layer is completely untouched by a sale), restoring `qty_on_hand` in lockstep. This is the fingerprint-style guard for the void path — it will not reverse a batch any stock has been drawn from.
- **043 one-time dedup repair** — restores inventory only when the batch is unambiguous and **aborts the whole migration** (`DEDUP_NEEDS_MANUAL_REVIEW`) on any ambiguity, with a durable audit table ([043:31-66](supabase/migrations/043_live_order_idempotency.sql:31)). Conservative by design.

**Gap:** there is no dry-run/preview before the *live* decrement — it relies wholly on idempotency. Given exactly-once semantics that is acceptable, but a mis-staged SKU (wrong SKU tagged) decrements the wrong inventory irreversibly with no confirmation step, and correction requires a manual counter-adjust. **Severity: Low-Medium.**

---

## Bind-gap recoverability

**Today, how would an operator discover a "30 missing orders" situation?**

1. It would **not** appear during the live: the board API ([board/route.ts:22-27](src/app/api/live/sessions/[id]/board/route.ts:22)) lists only `live_auction_items` (bound rows). An uncaptured/unbound win is simply not a row — there is no "unbound captures" panel.
2. Ending the session does nothing: `end` only flips status + `ended_at` ([end/route.ts:30-36](src/app/api/live/sessions/[id]/end/route.ts:30)); it does not run reconcile.
3. Running **Reconcile** (a manual post-show action) surfaces **only shape-A** gaps (captured-but-unbound), because its universe is `capture_events` (§1.3). The 30 orders in **shape B** (synced-but-never-captured) do not appear in `unbound[]`.
4. Therefore the operator most plausibly discovers shape-B orders **one at a time at the pack station** — scanning a slip whose order isn't in `synced_order_ids` returns 404 ([pick-list/route.ts:33-35](src/app/api/shipping/pick-list/route.ts:33)), or a scanned box shows SKUs missing for a sibling via `missing_order_ids` ([pick-list/route.ts:60-62](src/app/api/shipping/pick-list/route.ts:60)) — and only when those orders happen to be reachable through a shared group id. Orders with NULL group ids surface only when their own slip is scanned. In the worst case, the gap is discovered days later, order-by-order, during fulfillment — exactly when the SKU identity is hardest to reconstruct.

**How early could the system have surfaced it?**

The authoritative signal — `synced_order_ids` — is usually available within the sync cadence (minutes to a few hours after each order, since sync always re-pulls *today*). The gap set `synced_order_ids(window) − (bound ∪ captured)` is computable the moment sync has caught up, i.e. **during or immediately after the live**, not at pack time.

**Recommended detection point (recommendation only — no implementation here):**

- **Primary — a post-live "order coverage" check** that runs (or is one click) right after the session ends, computing, for the session's store + time window: every `synced_order_ids` row **minus** those with a bind **minus** those with a capture. This is the missing third leg reconcile never had. It turns shape-B from "discovered at pack time" into "surfaced before the boxes are touched." It belongs next to reconcile (same session context, same store scoping) but must enumerate `synced_order_ids`, not `capture_events`.
- **Secondary — a live indicator** on the board: a running count of `capture_events` in the window with no `live_auction_item`, so the host sees the unbound tally climb *during* the show and can bind before memory fades. This catches shape A in real time; it does not need TikTok sync.
- **Pack-station hardening** (defense in depth): when box resolution starts from an order, also look up orders that *should* share the group but don't (e.g. same buyer/window) and warn, so a NULL/mismatched `auto_combine_group_id` stops causing a silent undercount.

The two detectors are complementary: the live board indicator catches "host forgot to tag a SKU" (shape A) as it happens; the post-live coverage check is the only thing that catches "the order exists but we never even saw it" (shape B), which is the unrecoverable-by-default case.

---

## Prioritized findings

| # | Severity | Finding | Anchor |
|---|---|---|---|
| 1 | **Critical** | Reconcile & payouts enumerate `capture_events`, never `synced_order_ids`; synced-but-uncaptured orders (shape B) are invisible to reconcile by construction. No component computes `synced − (bound ∪ captured)`. | [reconcile:90-111](src/app/api/live/sessions/[id]/reconcile/route.ts:90), [payouts:58-61](src/app/api/live/sessions/[id]/payouts/route.ts:58) |
| 2 | **High** | Nothing surfaces the gap during or right after the live: board lists only bound items; `end` doesn't reconcile; reconcile is manual and shape-A only. Discovery falls to the pack station, order-by-order. | [board:22-27](src/app/api/live/sessions/[id]/board/route.ts:22), [end:30-36](src/app/api/live/sessions/[id]/end/route.ts:30) |
| 3 | **High** | Pack-station box resolution silently undercounts when a box-mate has NULL/mismatched `auto_combine_group_id` — such orders are never in `orderIds`, so never in `missing_order_ids` either. | [pick-list:37-62](src/app/api/shipping/pick-list/route.ts:37) |
| 4 | **High** | Extension omits `store_id` on session creation; `live_sessions` still uses the limit-1 backstop, so under a multi-store login the store is guessed and propagated to all bound items/SKUs/captures for the show. | [background.js:597-607](extension/background.js:597), [041:231-238](supabase/migrations/041_store_scoped_writes.sql:231), [consolidation:66-71](docs/consolidation-2026-07.md:66) |
| 5 | **Medium** | `auto_combine_group_id` legitimately lands NULL from `parseOrder`; harmless at write time but is the input to finding #3. Late group-id assignment isn't re-fetched for past days. | [sync:321](src/app/api/tiktok/sync/route.ts:321), [028:14-15](supabase/migrations/028_add_auto_combine_group_id.sql:14) |
| 6 | **Medium** | `order_id="0"` junk is upserted into `synced_order_ids` (truthy-string check). Downstream reconcile/payouts filter it; pack-station and raw counts do not. | [sync:195-196](src/app/api/tiktok/sync/route.ts:195) |
| 7 | **Medium** | Reconcile/payouts window is a time filter on `capture_events.created_at`; captures outside the session window are excluded even if they belong to the show. Payouts also truncate estimate lookup at 100 pages. | [reconcile:90-95](src/app/api/live/sessions/[id]/reconcile/route.ts:90), [payouts:68](src/app/api/live/sessions/[id]/payouts/route.ts:68) |
| 8 | **Medium** | Sync coverage caps (500 pages/day, 50s budget) with a cursor that saves every 10 days could leave a gap on a very high-volume day. No double-count (idempotent upsert). `entries` has no store dimension. | [sync:183-184, :240-246](src/app/api/tiktok/sync/route.ts:183), [consolidation:72-74](docs/consolidation-2026-07.md:72) |
| 9 | **Low-Medium** | Live decrement has no dry-run/preview; a mis-staged SKU decrements the wrong inventory irreversibly (idempotency prevents *re-fire*, not *wrong-target*). Correction is manual. | [041:203-225](supabase/migrations/041_store_scoped_writes.sql:203) |
| 10 | **Low** | Migration sequence is non-contiguous (missing 030/048/049); the consolidation doc's "038–040 gap on main" note is now stale (only 050 diverges from main). Informational. | [consolidation:61-62](docs/consolidation-2026-07.md:61) |

**Destructive-op safety verdict:** the inventory-mutating paths (live decrement, negative bind, retroactive bind, ViewTrack void, 043 dedup) are guarded with advisory locks, idempotency, explicit-confirm gating, and untouched-layer / fingerprint / abort-on-ambiguity checks. This area is the strongest in the system; the only residual is the absence of a wrong-target preview on the live decrement (#9).
