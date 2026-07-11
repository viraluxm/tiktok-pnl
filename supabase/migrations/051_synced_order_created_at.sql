-- 051_synced_order_created_at.sql
-- Persist TikTok's real order create_time as a true timestamp on synced_order_ids,
-- so live-window scoping (the order-coverage check) can stop relying on the
-- date-granularity order_date, which rounds a short live window up to whole
-- calendar days and sweeps in every non-live order those days.
--
-- Additive + nullable ONLY:
--   * order_date is NOT touched — every existing read/rebuild that depends on it
--     keeps working unchanged. This column is purely supplemental.
--   * Pre-existing rows get order_created_at = NULL until a bounded backfill
--     re-fetches create_time from TikTok (it was never persisted before — the sync
--     writer derived order_date from create_time and discarded the timestamp).
--   * Consumers MUST fall back to order_date when order_created_at is null.
--
-- Index on (store_id, order_created_at): the coverage/window queries filter by the
-- session's store_id and a [started_at, ended_at] timestamp window. Partial (only
-- backfilled/new rows carry a value) keeps it small.

alter table public.synced_order_ids
  add column if not exists order_created_at timestamptz;

create index if not exists idx_synced_order_ids_store_created_at
  on public.synced_order_ids (store_id, order_created_at)
  where order_created_at is not null;
