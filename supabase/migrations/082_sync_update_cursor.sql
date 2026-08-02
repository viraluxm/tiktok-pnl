-- Incremental change-feed watermark for the order sync.
-- Once a store's history is backfilled (sync_cursor >= today), the sync stops re-walking
-- create_time and instead pulls only orders whose update_time >= this cursor (probe-verified
-- 2026-08-02: /order/202309/orders/search filters + sorts by update_time, returns
-- created-earlier-but-changed orders, and update_time_ge is INCLUSIVE). Cost then scales with
-- real order activity (new + changed) rather than with accumulated backlog size.
--
-- NULL = store has not switched to incremental yet; the first incremental run seeds the cursor
-- from (now - 48h) as a one-time catch-up, then advances it to max(update_time) ingested.
alter table public.tiktok_connections
  add column if not exists sync_update_cursor bigint;

comment on column public.tiktok_connections.sync_update_cursor is
  'Incremental sync watermark: max order update_time (epoch seconds) ingested for a caught-up store. Caught-up stores query update_time_ge = this (INCLUSIVE; boundary re-dedups via order_id upsert) instead of re-walking create_time. NULL = not yet on incremental (seeds from now-48h on first incremental run).';
