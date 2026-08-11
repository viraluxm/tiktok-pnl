-- 079_synced_order_ids_open_indexes.sql
-- Supporting indexes for the tracking/status sweeps (sync-tracking, refresh-status, and the
-- upcoming 30-min top-up cron). Applied to prod ad-hoc via the Management API on 2026-08-01,
-- each CREATE INDEX CONCURRENTLY (lock-light, ran safely mid-live). Recorded here for parity.
--
-- Context: the sweeps keyset by order_id over an open-status set, store-scoped. Without a
-- supporting index the plan rode the order_id-ONLY btree and filter-discarded ~56k rows to
-- return 1,000 — a ~185 MB / ~200 ms buffer walk PER PAGE (the resolve-channels seq-scan class).
--
--   idx_synced_order_ids_store_open_order  → the sweep query's index. Partial on the open-status
--     set, ordered (store_id, order_id): a single scan in native order_id order over only the
--     target rows. The button query dropped 23,661→731 blocks (185 MB→5.7 MB), 0 rows filtered.
--     NOTE the predicate hardcodes the open-status list — keep it in sync with TARGET_STATUSES /
--     CORE_OPEN. A composite (store_id, status, order_id) was tried first and the planner REFUSED
--     it (ORDER BY order_id + status IN would need a MergeAppend it costed higher) — hence partial.
--
--   idx_synced_order_ids_missing_tracking  → partial on tracking_number IS NULL, for a future
--     null-only fill cron / IS NULL coverage query. NOT used by the current button sweep (which
--     pulls null AND non-null rows to detect stale re-label corrections). Cheap (only null rows).

create index concurrently if not exists idx_synced_order_ids_store_open_order
  on public.synced_order_ids (store_id, order_id)
  where status in ('AWAITING_COLLECTION','AWAITING_SHIPMENT','ON_HOLD','PARTIALLY_SHIPPING');

create index concurrently if not exists idx_synced_order_ids_missing_tracking
  on public.synced_order_ids (store_id, order_id)
  where tracking_number is null;
