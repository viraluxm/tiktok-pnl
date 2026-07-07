# Account consolidation — July 2026

Internal record. Consolidated two Lensed logins into one, so a single login owns both
stores, each with its own per-store TikTok connection.

## What was done

- **Merged** login `abraham@viralux.media` (`30c4f280-d12c-4120-99a5-67d857647e34`, "Abe")
  into `alvarojr300@gmail.com` (`f5885f7d-5841-457c-b66f-a5aa2916db46`, "Alvaro").
- Alvaro now **owns both stores** — **lots of steals** (`afd1c76e…`) and **Snore**
  (`1d71a4c9…`) — each with its **own** TikTok connection.
- A third stray login, `team@viralux.media` (`df7d28b7…`), was deleted (duplicate Snore
  connection + orphaned orders).

Both stores live under one org, **"Lensed"** (`6deb8558…`).

## Sequence executed (in order)

1. **Migration 041** — store-scoping foundation. Fail-loud `enforce_store_id` INSERT guard
   on `synced_order_ids`, `shop_videos`, `order_payouts`, `shipment_verifications`;
   `capture_events` derivation (store from linked auction) + backfill; `lensed_log_auction`
   stamps `store_id` from the session. Replaced the old `set_store_id_from_user()` `limit 1`
   guess on the guarded tables; `live_sessions` / auction tables / `entries` kept on the old
   backstop (deferred — see below).
2. **Deleted `team@viralux`** — cascaded its ~20,470 orphaned (NULL-store) orders + duplicate
   Snore connection. Cleared the 041 precondition (no NULL-store connections remained).
3. **Reassignment #1 (Abe → Alvaro)** — repointed Abe's `user_id` to Alvaro across the clean
   data tables (synced_order_ids, capture_events, live_auction_items/_skus, order_payouts,
   inventory_skus, sku_batches, live_sessions) + Snore `store_members` ownership. Renamed 2
   colliding products (" (Snore)") then reassigned all 5. `entries` left to regenerate via
   `rebuild_entries`. Guarded by a before/after fingerprint; store tags preserved.
4. **Migration 042** — per-store connection model. Dropped `unique(user_id)` on
   `tiktok_connections`, added **`unique(user_id, store_id)`**, made `store_id` **NOT NULL**.
   Plus app changes: per-store OAuth connect (`/api/tiktok/auth?store_id`, `onConflict
   (user_id,store_id)`), an active-store cookie (`lensed_active_store` via
   `POST /api/stores/active`), store-scoped connection reads/writes, and a store switcher
   (with "All stores" + Connect for owned-unconnected stores).
5. **Re-authed both shops under Alvaro** — connected lots of steals, then Snore; each got a
   correct `(Alvaro, store)` connection. Snore fully backfilled (cursor caught up to today).
6. **Reassignment #2 / cleanup** — a later Snore training session run under Abe's login
   (disposable, no real sales) plus 104 duplicate orders were left to cascade.
7. **Deleted Abe's login** — guarded delete (fingerprint abort if Alvaro's counts changed
   or Abe wasn't fully removed). Committed clean.

## Final verified state

- **Connections:** exactly 2, both Alvaro's, correctly matched (no mismatch):
  - lots of steals (`afd1c76e…`) → shop `lotsofsteals`
  - Snore (`1d71a4c9…`) → shop `Snore.`
- **Orders by store** (`synced_order_ids`): Snore **30,182** · lots of steals **386** ·
  NULL **0**. Only the two correct stores; no re-tagging.
- **Store ownership:** Alvaro is sole owner of both stores.
- **Org membership:** `alvarojr300` (owner) + fulfillment internal only. Abe's membership gone.
- **Abe:** fully removed from `auth.users` and every table (0 rows).
- Alvaro core-table fingerprint unchanged through the Abe delete (34,271).

## Migrations added

- **041** `store_scoped_writes.sql` — on `main`, applied to prod.
- **042** `multistore_tiktok_connections.sql` — on `main`, applied to prod.
- Note: `main` has a **038–040 gap** — those belong to the still-unmerged `feat/sku-pnl-reorder`
  (P&L) branch and will fill in when it merges. 042 was numbered to avoid collision.

## Deferred follow-ups (by design, not regressions)

1. **Extension `store_id`.** The browser extension still creates `live_sessions` /
   `capture_events` without a `store_id` (they land NULL under the backstop, since the
   host's `store_members` now resolves ambiguously under one login). Once the extension
   authenticates as the store's login and passes `store_id`, `live_sessions` and the auction
   tables (`live_auction_items`, `live_auction_item_skus`) can be flipped from the backstop
   to the fail-loud `enforce_store_id` guard.
2. **`entries` store-scoping.** `entries` is still keyed `(user_id, date, source)` with no
   store dimension, so daily aggregates mix both stores under one login. Needs its own
   rework (schema + `rebuild_entries`) if per-store daily P&L is required.
