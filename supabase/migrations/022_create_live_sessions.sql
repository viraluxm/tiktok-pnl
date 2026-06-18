-- Live Sessions: host-created live auction sessions (parent of live_auction_items).
-- Created manually by the host (no TikTok dependency). `tiktok_live_id` is
-- reserved for later reconciliation against TikTok shop_lives analytics.

create table public.live_sessions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'Live session',
  status text not null default 'live' check (status in ('draft', 'live', 'ended', 'reconciled')),
  started_at timestamptz,
  ended_at timestamptz,
  tiktok_live_id text,
  source text not null default 'manual',
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

create index idx_live_sessions_user_id on public.live_sessions(user_id);
create index idx_live_sessions_user_status on public.live_sessions(user_id, status);
create index idx_live_sessions_started_at on public.live_sessions(started_at desc);

create trigger live_sessions_set_updated_at
  before update on public.live_sessions
  for each row execute function public.set_updated_at();

alter table public.live_sessions enable row level security;

create policy "Users can view own live_sessions"
  on public.live_sessions for select using (auth.uid() = user_id);
create policy "Users can insert own live_sessions"
  on public.live_sessions for insert with check (auth.uid() = user_id);
create policy "Users can update own live_sessions"
  on public.live_sessions for update using (auth.uid() = user_id);
create policy "Users can delete own live_sessions"
  on public.live_sessions for delete using (auth.uid() = user_id);
