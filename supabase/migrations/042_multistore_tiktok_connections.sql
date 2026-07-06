-- 042_multistore_tiktok_connections.sql
-- Let one login hold MULTIPLE TikTok connections — one per store.
-- Replaces unique(user_id) with unique(user_id, store_id), and makes store_id
-- NOT NULL (fail-loud, matching 041's philosophy — a connection with no store is
-- the mismatch bug we just cleaned up).
--
-- CONSTRAINTS ONLY — no data writes. RLS is unchanged: keeping user_id in the key
-- means the existing `auth.uid() = user_id` policy still scopes reads correctly.
--
-- Safe to apply now: only ONE connection row exists (Abe's Snore, store_id non-null);
-- the team@viralux null-store connection was deleted during consolidation. The
-- callback change (migration C / code) sets store_id on every future insert, so
-- NOT NULL never trips a legitimate connect.
--
-- ⚠️ Deploy as a UNIT with the code changes (callback + store-scoped reads). Dropping
-- unique(user_id) means the `.single()` connection reads would error once a user has
-- 2 rows — which only happens at re-auth (Phase F), after the whole unit is live.

begin;

-- 1. store_id is required going forward (fail-loud on any store-less connection).
alter table public.tiktok_connections
  alter column store_id set not null;

-- 2. Swap uniqueness: one-per-user -> one-per-(user, store).
alter table public.tiktok_connections
  drop constraint if exists tiktok_connections_user_id_key;
alter table public.tiktok_connections
  add constraint tiktok_connections_user_id_store_id_key unique (user_id, store_id);

commit;
