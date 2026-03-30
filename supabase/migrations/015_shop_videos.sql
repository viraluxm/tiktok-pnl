-- Shop videos table for TikTok video performance analytics
create table if not exists public.shop_videos (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  tiktok_video_id text not null,
  title text,
  username text,
  video_post_time timestamptz,
  duration integer default 0,
  hash_tags text[] default '{}',
  gmv_amount numeric(12,2) default 0,
  gmv_currency text default 'USD',
  gpm_amount numeric(12,2) default 0,
  gpm_currency text default 'USD',
  avg_customers integer default 0,
  sku_orders integer default 0,
  items_sold integer default 0,
  views integer default 0,
  click_through_rate numeric(8,4) default 0,
  products jsonb default '[]'::jsonb,
  synced_at timestamptz default now(),
  created_at timestamptz default now()
);

-- Unique constraint: one row per user per video
alter table public.shop_videos add constraint shop_videos_user_video_unique unique (user_id, tiktok_video_id);

-- Indexes
create index if not exists idx_shop_videos_user_id on public.shop_videos(user_id);
create index if not exists idx_shop_videos_post_time on public.shop_videos(user_id, video_post_time);

-- RLS
alter table public.shop_videos enable row level security;

create policy "Users can view own videos"
  on public.shop_videos for select using (auth.uid() = user_id);
create policy "Users can insert own videos"
  on public.shop_videos for insert with check (auth.uid() = user_id);
create policy "Users can update own videos"
  on public.shop_videos for update using (auth.uid() = user_id);
