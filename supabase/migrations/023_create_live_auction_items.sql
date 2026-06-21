-- Live auction items + per-item SKU lines.
-- Data model only in this phase; the host logging engine (scan/queue/quick-close,
-- idempotency replay, cost snapshot, inventory decrement, CSV) arrives next phase.
-- These columns are shaped so the next phase needs no schema change.

create table public.live_auction_items (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  sequence integer not null,
  status text not null default 'queued'
    check (status in ('queued', 'active', 'sold', 'not_sold', 'canceled', 'manual')),
  is_bundle boolean not null default false,
  expected_price_cents integer,
  sold_price_cents integer,
  buyer_handle text,
  client_idempotency_key text,
  staged_at timestamptz default now() not null,
  activated_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  unique(session_id, sequence)
);

create index idx_live_auction_items_user_id on public.live_auction_items(user_id);
create index idx_live_auction_items_session on public.live_auction_items(session_id);

-- Idempotency: one row per (session, client key) when a key is present.
create unique index idx_live_auction_items_idem
  on public.live_auction_items(session_id, client_idempotency_key)
  where client_idempotency_key is not null;

create trigger live_auction_items_set_updated_at
  before update on public.live_auction_items
  for each row execute function public.set_updated_at();

-- Per-item SKU lines (bundle junction). unit_cost_cents_snapshot + the *_snapshot
-- columns freeze the sold-log values so they don't drift if inventory is edited later.
create table public.live_auction_item_skus (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  auction_item_id uuid not null references public.live_auction_items(id) on delete cascade,
  inventory_sku_id uuid not null references public.inventory_skus(id) on delete restrict,
  qty integer not null default 1,
  unit_cost_cents_snapshot integer,
  sku_number_snapshot integer,
  title_snapshot text,
  created_at timestamptz default now() not null
);

create index idx_live_auction_item_skus_item on public.live_auction_item_skus(auction_item_id);
create index idx_live_auction_item_skus_sku on public.live_auction_item_skus(inventory_sku_id);
create index idx_live_auction_item_skus_user_id on public.live_auction_item_skus(user_id);

alter table public.live_auction_items enable row level security;
alter table public.live_auction_item_skus enable row level security;

create policy "Users can view own live_auction_items"
  on public.live_auction_items for select using (auth.uid() = user_id);
create policy "Users can insert own live_auction_items"
  on public.live_auction_items for insert with check (auth.uid() = user_id);
create policy "Users can update own live_auction_items"
  on public.live_auction_items for update using (auth.uid() = user_id);
create policy "Users can delete own live_auction_items"
  on public.live_auction_items for delete using (auth.uid() = user_id);

create policy "Users can view own live_auction_item_skus"
  on public.live_auction_item_skus for select using (auth.uid() = user_id);
create policy "Users can insert own live_auction_item_skus"
  on public.live_auction_item_skus for insert with check (auth.uid() = user_id);
create policy "Users can update own live_auction_item_skus"
  on public.live_auction_item_skus for update using (auth.uid() = user_id);
create policy "Users can delete own live_auction_item_skus"
  on public.live_auction_item_skus for delete using (auth.uid() = user_id);
