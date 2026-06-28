-- 037_add_live_seller_notes_to_inventory_skus.sql
-- Live seller talking points per SKU: short bullets the host can read on-air.
-- Surfaced in the TikTok LIVE Capture extension overlay when a SKU is staged.
-- Additive + idempotent; constant default => fast metadata-only add (no rewrite).
-- Inherits inventory_skus RLS (org-scoped in prod via 035b); no policy change.

alter table public.inventory_skus
  add column if not exists live_seller_notes text[] not null default '{}'::text[];
