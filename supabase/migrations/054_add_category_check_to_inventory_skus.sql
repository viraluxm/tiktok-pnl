-- 054_add_category_check_to_inventory_skus.sql
-- Constrain inventory_skus.category to a FIXED taxonomy for the Inventory tab.
-- The `category text` column already exists (created in 021); it was previously
-- free-text and unused by the UI. This migration only pins the allowed values.
--
-- Allowed: 'squish' | 'electronics' | NULL (untagged). Existing rows are all NULL
-- (the form never wrote category before), so validating the constraint against
-- current data is a no-op — no backfill, no rewrite.
--
-- Additive + idempotent: the column add is a guard for fresh `db reset`, and the
-- CHECK is wrapped so re-running the migration doesn't error on the existing
-- constraint. Inherits inventory_skus RLS (org-scoped via 035b); no policy change.

alter table public.inventory_skus
  add column if not exists category text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'inventory_skus_category_check'
  ) then
    alter table public.inventory_skus
      add constraint inventory_skus_category_check
      check (category in ('squish', 'electronics') or category is null);
  end if;
end $$;
