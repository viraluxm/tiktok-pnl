-- 038_add_reorder_planning_to_inventory_skus.sql
-- Lead-time-aware reorder planning fields per SKU. Surfaced in the Add/Edit SKU
-- form now; the actual reorder logic + alerts come later.
-- All nullable, no defaults => fast metadata-only add (no table rewrite, no
-- backfill of existing rows). Additive + idempotent.
-- Inherits inventory_skus RLS (org-scoped in prod via 035b); no policy change.

alter table public.inventory_skus
  add column if not exists lead_time_days integer,   -- days from reorder to arrival
  add column if not exists supplier text,            -- freeform: supplier name or reorder URL
  add column if not exists reorder_point integer;    -- optional manual floor; NULL = auto-compute later
