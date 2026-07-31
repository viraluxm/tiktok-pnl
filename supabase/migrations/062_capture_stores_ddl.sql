-- 062_capture_stores_ddl.sql
--
-- Captures the DDL for public.stores and public.store_members. These two tables were
-- created OUT-OF-BAND directly in production and never had a CREATE TABLE in this repo,
-- so a fresh `supabase db reset` / migration replay would not reproduce them (the
-- multi-store connect flow, the switcher, and channel_store_map's FK all depend on them).
-- This migration exists purely so a clean replay recreates the tables exactly as they
-- live in prod.
--
-- ⚠️ NO-OP AGAINST CURRENT PROD. Every statement is `create table if not exists`, so on
-- the live DB (where both tables already exist) nothing runs — the tables, their columns,
-- constraints, and defaults are left exactly as they are. It only does real work on a
-- fresh database that has no stores/store_members yet.
--
-- Filename note: there is already a `062_synced_order_tracking_number.sql`; this reuses the
-- 062 number (the repo already double-numbers — see the two 066_* files and 035b). Order is
-- irrelevant here because the statements are idempotent and independent of that migration.
--
-- SCHEMA SOURCE: inspected live via the Management API on project dvucodtdojumvplmgjeu.
--   stores:        id, org_id (NOT NULL, FK organizations), name, slug, created_at, updated_at.
--                  PK(id); UNIQUE(org_id, name).
--   store_members: id, store_id (FK stores), user_id (FK auth.users), role (NOT NULL
--                  default 'operator', CHECK owner/operator/viewer), created_at.
--                  PK(id); UNIQUE(store_id, user_id).
--
-- RLS: observed DISABLED on BOTH tables in prod, with ZERO policies (row visibility is
-- enforced in the app layer via store_members + service-role writes, not by RLS — see the
-- deferred "RLS cutover" note). Reproducing prod faithfully therefore means NOT enabling
-- RLS and adding NO policies. The explicit `disable row level security` below is a true
-- no-op (tables are created RLS-off) that records the observed state unambiguously.

begin;

-- ── public.stores ──────────────────────────────────────────────────────────────────────
create table if not exists public.stores (
  id         uuid primary key default uuid_generate_v4(),
  org_id     uuid not null references public.organizations(id) on delete cascade,
  name       text not null,
  slug       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stores_org_id_name_key unique (org_id, name)
);

-- ── public.store_members ───────────────────────────────────────────────────────────────
create table if not exists public.store_members (
  id         uuid primary key default uuid_generate_v4(),
  store_id   uuid not null references public.stores(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'operator' check (role in ('owner', 'operator', 'viewer')),
  created_at timestamptz not null default now(),
  constraint store_members_store_id_user_id_key unique (store_id, user_id)
);

-- RLS OFF to match prod (both were observed with row security disabled and no policies).
-- Redundant on a freshly-created table (RLS defaults off) and a no-op on prod (already off);
-- present only to make the observed state explicit for a future reader.
alter table public.stores        disable row level security;
alter table public.store_members disable row level security;

commit;
