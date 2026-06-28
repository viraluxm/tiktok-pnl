-- 026_reconcile_skus_to_inventory_skus.sql
--
-- Reconciliation: the redundant `skus` table (from the manually-applied 021)
-- is replaced by Abe's `inventory_skus`. Repoint the capture_events FK and
-- drop the old table. capture_events itself is untouched.
--
-- Defensive guards (added later): on a fresh rebuild neither `capture_events`
-- nor `skus` exists yet -- both were created out-of-band in production. The
-- guards make this migration a no-op on a clean DB so the rebuild can proceed;
-- `036_create_capture_events.sql` then creates capture_events in its final shape
-- (including this bound_sku_id FK). The intended historical end state is
-- unchanged: where the objects exist (production), the FK is repointed to
-- inventory_skus and the old `skus` table is dropped, exactly as before.

do $$ begin
  if exists (select 1 from pg_constraint where conname = 'capture_events_bound_sku_id_fkey') then
    alter table public.capture_events drop constraint capture_events_bound_sku_id_fkey;
  end if;
end $$;

do $$ begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'capture_events')
     and not exists (select 1 from pg_constraint where conname = 'capture_events_bound_sku_id_fkey') then
    alter table public.capture_events
      add constraint capture_events_bound_sku_id_fkey
      foreign key (bound_sku_id) references public.inventory_skus(id) on delete set null;
  end if;
end $$;

drop table if exists public.skus;
