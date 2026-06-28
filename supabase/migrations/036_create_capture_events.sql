-- 036_create_capture_events.sql
-- Formalize public.capture_events: created out-of-band in production, absent from
-- version control (only 026 ever ALTERs it). Idempotent -- a no-op against
-- production, a full create on a fresh rebuild. Mirrors the production schema
-- introspected 2026-06-28 (columns, indexes, FKs, RLS, policies, trigger).

create extension if not exists "uuid-ossp";

create table if not exists public.capture_events (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  room_id text,
  order_id text not null,
  buyer_username text,
  selling_price_cents integer,
  product_name text,
  platform_sku_ref text,
  tiktok_sku_id text,
  tiktok_product_id text,
  item_image_url text,
  ordered_at timestamptz,
  is_payment_successful boolean,
  order_status integer,
  bound_sku_id uuid references public.inventory_skus(id) on delete set null,
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  store_id uuid                       -- FK added below, guarded (out-of-band `stores`)
);

-- Reconcile columns if a production table predates any of them (no-op when present).
alter table public.capture_events add column if not exists store_id uuid;
alter table public.capture_events add column if not exists raw_payload jsonb;

-- Indexes (names match production). The unique (user_id, order_id) index is what the
-- extension's merge-duplicates upsert relies on to dedupe captures by order.
create unique index if not exists idx_capture_events_user_order
  on public.capture_events (user_id, order_id);
create index if not exists idx_capture_events_order_id on public.capture_events (order_id);
create index if not exists idx_capture_events_user_id  on public.capture_events (user_id);
create index if not exists idx_capture_events_store    on public.capture_events (store_id);

-- bound_sku_id FK (name must match production / migration 026).
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'capture_events_bound_sku_id_fkey') then
    alter table public.capture_events
      add constraint capture_events_bound_sku_id_fkey
      foreign key (bound_sku_id) references public.inventory_skus(id) on delete set null;
  end if;
end $$;

-- store_id FK -- only if the out-of-band `stores` table exists (tracked separately).
do $$ begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'stores')
     and not exists (select 1 from pg_constraint where conname = 'capture_events_store_id_fkey') then
    alter table public.capture_events
      add constraint capture_events_store_id_fkey
      foreign key (store_id) references public.stores(id);
  end if;
end $$;

-- updated_at trigger. Production uses the name `set_capture_events_updated_at`
-- (function public.set_updated_at, defined in 021). Guard on the EXACT production
-- name so this never creates a second/duplicate trigger on production.
do $$ begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.capture_events'::regclass
      and tgname  = 'set_capture_events_updated_at'
      and not tgisinternal
  ) then
    create trigger set_capture_events_updated_at
      before update on public.capture_events
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- RLS: enabled, four own-row policies (role public), matching production exactly.
alter table public.capture_events enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='capture_events'
                 and policyname='Users can view own capture_events') then
    create policy "Users can view own capture_events"
      on public.capture_events for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='capture_events'
                 and policyname='Users can insert own capture_events') then
    create policy "Users can insert own capture_events"
      on public.capture_events for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='capture_events'
                 and policyname='Users can update own capture_events') then
    create policy "Users can update own capture_events"
      on public.capture_events for update using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='capture_events'
                 and policyname='Users can delete own capture_events') then
    create policy "Users can delete own capture_events"
      on public.capture_events for delete using (auth.uid() = user_id);
  end if;
end $$;
