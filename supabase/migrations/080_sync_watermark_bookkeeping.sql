-- 080_sync_watermark_bookkeeping.sql
-- Bookkeeping for the incremental-watermark sync (item 1). Two nullable columns, metadata-only
-- (instant, no table rewrite, no lock of consequence — safe to apply mid-pack; touches nothing on
-- the pick-list / shipping / scan path).
--   sync_rescan_at  — when this store last COMPLETED a trailing-48h full re-scan. Gates the "slower
--                     beat": a re-scan runs at most once per RESCAN_INTERVAL.
--   sync_last_pages — order-search pages fetched on the last run. Pure observability: proves the
--                     waste is gone (incremental runs show a handful vs the old whole-day re-walk).
alter table public.tiktok_connections add column if not exists sync_rescan_at timestamptz;
alter table public.tiktok_connections add column if not exists sync_last_pages integer;
