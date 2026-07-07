-- Idempotency test harness — base schema mirroring the PRE-043 / POST-041 prod world.
-- Minimal but faithful: org-scoped inventory + FIFO sku_batches + live auction tables
-- + the OLD per-session idempotency index + the store_id columns 041 added (nullable
-- here; the RPC stamps v_session.store_id which is null in this harness — allowed, and
-- matches 041's "session store still null" backstop edge). No RLS (tests run as owner;
-- the function's explicit org_id/user_id filters do the scoping). auth.uid() stubbed from a GUC.

create extension if not exists "uuid-ossp";

-- Supabase provides the `authenticated` role in prod; create it here so the
-- migration's `grant execute ... to authenticated` succeeds under plain Postgres.
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

-- ── org tables + helpers (035b) ───────────────────────────────────────────────
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

-- ── org-scoped inventory + FIFO batches ───────────────────────────────────────
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
  qty_remaining int not null, unit_cost_cents int, sequence int not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(sku_id, sequence)
);

-- ── live sessions + auction items (022/023) + OLD per-session idem index ───────
create table if not exists public.live_sessions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  store_id uuid,                          -- 041: nullable; RPC reads this to stamp children
  title text not null default 'Live session',
  status text not null default 'live' check (status in ('draft','live','ended','reconciled')),
  started_at timestamptz, ended_at timestamptz, tiktok_live_id text,
  source text not null default 'manual',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.live_auction_items (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  store_id uuid,                          -- 041: stamped from the session
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  sequence integer not null,
  status text not null default 'queued'
    check (status in ('queued','active','sold','not_sold','canceled','manual')),
  is_bundle boolean not null default false,
  expected_price_cents integer, sold_price_cents integer, buyer_handle text,
  client_idempotency_key text,
  staged_at timestamptz default now() not null, activated_at timestamptz, closed_at timestamptz,
  created_at timestamptz default now() not null, updated_at timestamptz default now() not null,
  unique(session_id, sequence)
);
create unique index if not exists idx_live_auction_items_idem
  on public.live_auction_items(session_id, client_idempotency_key)
  where client_idempotency_key is not null;
create table if not exists public.live_auction_item_skus (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  store_id uuid,                          -- 041: stamped from the session
  auction_item_id uuid not null references public.live_auction_items(id) on delete cascade,
  inventory_sku_id uuid not null references public.inventory_skus(id) on delete restrict,
  qty integer not null default 1, unit_cost_cents_snapshot integer,
  sku_number_snapshot integer, title_snapshot text,
  created_at timestamptz default now() not null
);

-- ── seed one user + org + membership (fixed ids used by all test files) ────────
insert into auth.users (id) values ('11111111-1111-1111-1111-111111111111') on conflict do nothing;
insert into public.organizations (id, name, owner_user_id)
  values ('22222222-2222-2222-2222-222222222222', 'Test Org', '11111111-1111-1111-1111-111111111111')
  on conflict do nothing;
insert into public.organization_members (org_id, user_id, role)
  values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'owner')
  on conflict do nothing;
