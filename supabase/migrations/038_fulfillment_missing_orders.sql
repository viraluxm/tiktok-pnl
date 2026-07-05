-- 038_fulfillment_missing_orders.sql
-- Persist which orders in a box had NO live binding (no live_auction_item_skus) so the
-- unbound flag survives to the picker. Must be PERSISTED (not recomputed downstream):
-- the box's live_auction_items are owner-private, so a cross-store picker/packer can't
-- recompute it under org RLS. Written at buy-labels (owner context). Additive only.

begin;
alter table public.fulfillment_orders
  add column if not exists missing_order_ids text[] not null default '{}';
commit;
