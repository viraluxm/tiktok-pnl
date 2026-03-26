-- Track individual TikTok order IDs to prevent double-counting
create table if not exists public.synced_order_ids (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  order_id text not null,
  order_date date not null,
  gmv numeric(12,2) default 0,
  shipping numeric(12,2) default 0,
  affiliate numeric(12,2) default 0,
  platform_fee numeric(12,2) default 0,
  created_at timestamptz default now() not null,
  unique(user_id, order_id)
);

create index idx_synced_order_ids_user on public.synced_order_ids(user_id);
create index idx_synced_order_ids_order on public.synced_order_ids(user_id, order_id);

alter table public.synced_order_ids enable row level security;

create policy "Users can view own synced orders"
  on public.synced_order_ids for select using (auth.uid() = user_id);
create policy "Users can insert own synced orders"
  on public.synced_order_ids for insert with check (auth.uid() = user_id);
create policy "Users can update own synced orders"
  on public.synced_order_ids for update using (auth.uid() = user_id);
