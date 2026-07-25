-- 064_stores_tiktok_shop_id.sql
--
-- ⚠️ STAGED — NOT YET APPLIED. Apply gated (quiet window) after review. This
-- project has no supabase_migrations ledger (migrations applied via the
-- Management API); verify live schema before applying — `stores` is an
-- out-of-band table (not declared in any migration), confirmed live to have:
--   id, org_id (not null), name, slug, created_at, updated_at
-- and NO tiktok_shop_id / logo_url column as of 2026-07-24.
--
-- Purpose: give `stores` a STABLE TikTok shop identity so the OAuth-store-creation
-- path (onboarding first-shop AND add-Nth-shop) can DEDUP — re-connecting an
-- already-connected shop reuses its store instead of creating a duplicate.
-- shop_cipher is NOT stable (it rotates on re-auth), so we key on TikTok's shop id.

begin;

alter table public.stores add column if not exists tiktok_shop_id text;
alter table public.stores add column if not exists logo_url text;

-- Dedup key: one store per (org, TikTok shop). Partial so pre-existing rows with
-- a NULL tiktok_shop_id (Snore, lots of steals — created before this column) do
-- not collide with each other or block the migration.
create unique index if not exists stores_org_tiktok_shop_uidx
  on public.stores (org_id, tiktok_shop_id)
  where tiktok_shop_id is not null;

commit;
