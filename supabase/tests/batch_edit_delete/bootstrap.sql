-- Batch edit/delete test harness — minimal but faithful base schema for migration
-- 072 (user-facing FIFO cost-layer edit + delete). Mirrors the org-scoped inventory +
-- FIFO sku_batches world AFTER 046 (qty_added present). No RLS (tests run as owner; the
-- RPCs' explicit org_id/user_id filters do the scoping, exactly as the idempotency
-- harness does). auth.uid() is stubbed from a GUC so we can act as different users.

create extension if not exists "uuid-ossp";

-- Supabase provides `authenticated` in prod; create it so 072's grants succeed.
do $$ begin
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
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

-- ── org-scoped inventory + FIFO batches (034/035b + 046 qty_added) ─────────────
create table if not exists public.inventory_skus (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  org_id uuid references public.organizations(id) on delete cascade,
  sku_number int, barcode text, title text,
  unit_cost_cents int, qty_on_hand int not null default 0,
  is_active boolean not null default true,
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
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(sku_id, sequence)
);

-- ── minimal sale-line table (only what the snapshot-immutability test reads) ───
-- Faithful to the columns 072 must NEVER touch. No auction FK needed for this test.
create table if not exists public.live_auction_item_skus (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  inventory_sku_id uuid not null references public.inventory_skus(id) on delete restrict,
  qty integer not null default 1,
  unit_cost_cents_snapshot integer,
  created_at timestamptz not null default now()
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
