-- ============ TIKTOK CONNECTIONS ============
create table public.tiktok_connections (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade unique,
  access_token text not null,
  refresh_token text,
  token_expires_at timestamptz,
  advertiser_ids jsonb default '[]'::jsonb,
  shop_cipher text,
  shop_name text,
  connected_at timestamptz default now() not null,
  last_synced_at timestamptz
);

create index idx_tiktok_connections_user_id on public.tiktok_connections(user_id);

-- ============ ADD SOURCE COLUMN TO ENTRIES ============
alter table public.entries add column if not exists source text default 'manual';

-- Add unique constraint for upsert on synced entries
create unique index if not exists idx_entries_upsert
  on public.entries(user_id, product_id, date, source)
  where source = 'tiktok';

-- ============ SYNC LOGS ============
create table public.sync_logs (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  sync_type text not null default 'full',
  status text not null default 'pending',
  entries_created integer default 0,
  entries_updated integer default 0,
  error_message text,
  started_at timestamptz default now() not null,
  completed_at timestamptz
);

create index idx_sync_logs_user_id on public.sync_logs(user_id);
create index idx_sync_logs_started_at on public.sync_logs(started_at desc);

-- ============ RLS FOR TIKTOK CONNECTIONS ============
alter table public.tiktok_connections enable row level security;

create policy "Users can view own tiktok connection"
  on public.tiktok_connections for select using (auth.uid() = user_id);
create policy "Users can insert own tiktok connection"
  on public.tiktok_connections for insert with check (auth.uid() = user_id);
create policy "Users can update own tiktok connection"
  on public.tiktok_connections for update using (auth.uid() = user_id);
create policy "Users can delete own tiktok connection"
  on public.tiktok_connections for delete using (auth.uid() = user_id);

-- Service role can bypass RLS, but we also allow the admin client to manage connections
-- by using service_role key directly

-- ============ RLS FOR SYNC LOGS ============
alter table public.sync_logs enable row level security;

create policy "Users can view own sync logs"
  on public.sync_logs for select using (auth.uid() = user_id);
create policy "Users can insert own sync logs"
  on public.sync_logs for insert with check (auth.uid() = user_id);
create policy "Users can update own sync logs"
  on public.sync_logs for update using (auth.uid() = user_id);
