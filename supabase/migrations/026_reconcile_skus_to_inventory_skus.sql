-- 026_reconcile_skus_to_inventory_skus.sql
--
-- Reconciliation: the redundant `skus` table (from the manually-applied 021)
-- is replaced by Abe's `inventory_skus`. Repoint the capture_events FK and
-- drop the old table. capture_events itself is untouched.

alter table public.capture_events
  drop constraint capture_events_bound_sku_id_fkey;

alter table public.capture_events
  add constraint capture_events_bound_sku_id_fkey
  foreign key (bound_sku_id) references public.inventory_skus(id) on delete set null;

drop table public.skus;
