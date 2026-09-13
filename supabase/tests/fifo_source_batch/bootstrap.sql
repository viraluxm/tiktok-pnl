-- FIFO source-batch attribution harness — base schema for migrations 152 + 153.
--
-- Derived from supabase/tests/batch_edit_delete/bootstrap.sql (the org-scoped inventory +
-- FIFO world) and EXTENDED with the full live-auction chain, because 152/153 are the first
-- migrations whose behaviour spans BOTH sides of the seam: the batch RPCs AND the bind RPCs
-- that actually draw from a batch. The older harness stubs live_auction_item_skus down to
-- four columns, which cannot exercise a real draw.
--
-- Faithful to PRODUCTION as introspected on 2026-09-11, not merely to the repo: sku_batches
-- carries source/external_ref (045), live_auction_item_skus carries store_id (041),
-- short_at_bind (104) and both snapshot columns, and live_auction_items carries the
-- (user_id, client_idempotency_key) unique index that migration 043's replay path depends on.
--
-- No RLS (tests run as owner; the RPCs' explicit org_id/user_id filters do the scoping,
-- exactly as the idempotency harness does). auth.uid() is stubbed from a GUC so we can act
-- as different users.

create extension if not exists "uuid-ossp";

-- Supabase provides these roles in prod; create them so the migrations' GRANT and REVOKE
-- statements succeed under plain Postgres. `anon` and `service_role` are required as well
-- as `authenticated`: migration 105 revokes from anon, and 153 revokes the three
-- service-role-only twins from public/anon/authenticated.
do $$ begin
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;

create or replace function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- ── auth stub ────────────────────────────────────────────────────────────────
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.user_id', true), '')::uuid
$$;

-- ── org tables + current_user_org (035b) ───────────────────────────────────────
do $$ begin
  if not exists (select 1 from pg_type where typname='org_role') then
    create type public.org_role as enum ('owner','member');
  end if;
end $$;
create table if not exists public.organizations (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  owner_user_id uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create table if not exists public.organization_members (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.org_role not null default 'member',
  created_at timestamptz not null default now(),
  unique(org_id, user_id)
);
create or replace function public.current_user_org() returns uuid language sql stable as $$
  select m.org_id from public.organization_members m where m.user_id = auth.uid() order by m.created_at limit 1
$$;
-- 154's audit table declares org-scoped RLS policies, and a policy cannot be created
-- against a function that does not exist. Verbatim from production.
create or replace function public.is_org_member(p_org uuid) returns boolean
  language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from public.organization_members m where m.org_id = p_org and m.user_id = auth.uid());
$$;

-- ── org-scoped inventory + FIFO batches (034/035b + 046 qty_added) ─────────────
create table if not exists public.inventory_skus (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  org_id uuid references public.organizations(id) on delete cascade,
  sku_number int, barcode text, title text,
  unit_cost_cents int, qty_on_hand int not null default 0,
  is_active boolean not null default true,
  -- 038: pnl_by_sku names these in its RETURNS TABLE, so it will not compile without them.
  lead_time_days int, reorder_point int,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.sku_batches (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  org_id uuid references public.organizations(id) on delete cascade,
  sku_id uuid not null references public.inventory_skus(id) on delete cascade,
  qty_remaining int not null,
  qty_added int,                 -- 046: original inserted qty (NULL for legacy layers)
  unit_cost_cents int,
  sequence int not null,
  source text,                   -- 045: 'viewtrack' | 'unbind_restock' | NULL (hand-entered)
  external_ref text,             -- 045: integration idempotency key
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(sku_id, sequence)
);
create unique index if not exists uq_sku_batches_source_ref
  on public.sku_batches (org_id, source, external_ref) where source is not null;

-- ── the FULL live-auction chain (023 + 041 store_id + 104 short_at_bind) ───────
-- 153 replaces lensed_log_auction / _as / unbind / _as, so the harness needs the real
-- tables those functions read and write — not a stub.
create table if not exists public.live_sessions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  store_id uuid,
  status text not null default 'live',
  -- 022/050: pnl_by_show_as selects these; pnl_order_grain joins host_id.
  title text,
  started_at timestamptz default now(),
  ended_at timestamptz,
  host_id uuid,
  created_at timestamptz not null default now()
);
create table if not exists public.live_auction_items (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  store_id uuid,
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  sequence integer not null,
  status text not null default 'queued',
  is_bundle boolean not null default false,
  expected_price_cents integer,
  client_idempotency_key text,
  staged_at timestamptz not null default now(),
  activated_at timestamptz, closed_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(session_id, sequence)
);
-- 043: idempotency is keyed on (user_id, order_id) across ANY session. 105's
-- unique_violation replay handler names this index by name in its comment.
create unique index if not exists idx_live_auction_items_user_idem
  on public.live_auction_items (user_id, client_idempotency_key)
  where client_idempotency_key is not null;

create table if not exists public.live_auction_item_skus (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  store_id uuid,
  auction_item_id uuid references public.live_auction_items(id) on delete cascade,
  inventory_sku_id uuid not null references public.inventory_skus(id) on delete restrict,
  qty integer not null default 1,
  unit_cost_cents_snapshot integer,
  sku_number_snapshot integer,
  title_snapshot text,
  short_at_bind boolean,
  created_at timestamptz not null default now()
);

-- ── the two order-side tables the P&L surfaces read (036 / 005, minimal) ──────
-- capture_events is the ONLY extra dependency of migration 103's whole function family;
-- synced_order_ids is additionally needed by the prod-only pnl_order_grain view. Both are
-- cut down to the columns those definitions actually reference.
create table if not exists public.capture_events (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  store_id uuid,
  order_id text,
  selling_price_cents integer,
  ordered_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists public.synced_order_ids (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  store_id uuid,
  order_id text,
  gmv numeric,
  shipping numeric,
  status text,
  order_date date,
  order_created_at timestamptz
);

-- ── seed TWO users + orgs (cross-org tests need a real second org) ─────────────
insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),   -- user A (org 1 owner)
  ('33333333-3333-3333-3333-333333333333')    -- user B (org 2 owner)
  on conflict do nothing;
insert into public.organizations (id, name, owner_user_id) values
  ('22222222-2222-2222-2222-222222222222', 'Org One', '11111111-1111-1111-1111-111111111111'),
  ('44444444-4444-4444-4444-444444444444', 'Org Two', '33333333-3333-3333-3333-333333333333')
  on conflict do nothing;
insert into public.organization_members (org_id, user_id, role) values
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333', 'owner')
  on conflict do nothing;
