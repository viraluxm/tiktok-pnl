-- TikTok Business API connections (separate from Shop connections)
create table if not exists public.tiktok_business_connections (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  access_token text not null,
  advertiser_id text,
  advertiser_name text,
  connected_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint tiktok_business_connections_user_unique unique (user_id)
);

alter table public.tiktok_business_connections enable row level security;
create policy "Users can view own business connection" on public.tiktok_business_connections for select using (auth.uid() = user_id);
create policy "Users can insert own business connection" on public.tiktok_business_connections for insert with check (auth.uid() = user_id);
create policy "Users can update own business connection" on public.tiktok_business_connections for update using (auth.uid() = user_id);

-- Ad spend data from TikTok Business API
create table if not exists public.ad_spend (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  spend_amount numeric(12,2) default 0,
  spend_currency text default 'USD',
  impressions integer default 0,
  clicks integer default 0,
  conversions integer default 0,
  synced_at timestamptz default now(),
  constraint ad_spend_user_date_unique unique (user_id, date)
);

create index if not exists idx_ad_spend_user_date on public.ad_spend(user_id, date);

alter table public.ad_spend enable row level security;
create policy "Users can view own ad spend" on public.ad_spend for select using (auth.uid() = user_id);
create policy "Users can insert own ad spend" on public.ad_spend for insert with check (auth.uid() = user_id);
create policy "Users can update own ad spend" on public.ad_spend for update using (auth.uid() = user_id);
