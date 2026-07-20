-- 062_synced_order_tracking_number.sql
--
-- Persist TikTok's shipping tracking_number on synced_order_ids so a scanned
-- shipping label (USPS IMpb barcode) can resolve to its order_id in the packing
-- station. The value is already returned by both the order-search and order-detail
-- endpoints (top-level `tracking_number`); the sync writer simply discarded it.
--
-- Additive + nullable ONLY:
--   * No existing column is touched — every read/write/upsert keeps working unchanged.
--   * Pre-existing rows get tracking_number = NULL until the sync re-walks the window
--     (search carries tracking_number, so no extra API calls) or a bounded backfill
--     re-syncs the outage/history window (idempotent upsert, same as the Snore backfill).
--   * Consumers must treat NULL as "not yet captured" (unshipped or pre-backfill).
--
-- Index on (user_id, tracking_number): the scan lookup filters by the authenticated
-- user + exact tracking. Partial (only shipped/backfilled rows carry a value) keeps
-- it small; tracking_number is near-unique so the lookup is a point read.

alter table public.synced_order_ids
  add column if not exists tracking_number text;

create index if not exists idx_synced_order_ids_user_tracking
  on public.synced_order_ids (user_id, tracking_number)
  where tracking_number is not null;
