-- 028: store TikTok's auto_combine_group_id on per-order records.
--
-- Each auction win is its own TikTok order (synced_order_ids.order_id). TikTok
-- combines a buyer's wins into one shipment via `auto_combine_group_id`, assigned
-- at order time (present before fulfillment) and returned by the Order API. We
-- persist it so the pick-verify flow can resolve "which orders ship together"
-- from our DB ("all orders with group id = X") instead of live API calls.
--
-- Additive + nullable: existing rows/sync behavior are unaffected. Non-combined
-- orders simply leave it null.

alter table public.synced_order_ids
  add column if not exists auto_combine_group_id text;

-- The pick-verify query is "all orders in group X for this user". Partial index
-- keeps it small (only combined orders carry a group id).
create index if not exists idx_synced_order_ids_combine_group
  on public.synced_order_ids(user_id, auto_combine_group_id)
  where auto_combine_group_id is not null;
