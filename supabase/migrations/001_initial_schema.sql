-- Enable UUID generation
create extension if not exists "uuid-ossp";

-- ============ PROFILES ============
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  avatar_url text,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, display_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data->>'avatar_url'
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============ PRODUCTS ============
create table public.products (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz default now() not null,
  unique(user_id, name)
);

create index idx_products_user_id on public.products(user_id);

-- ============ ENTRIES ============
create table public.entries (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  date date not null,
  gmv numeric(12,2) default 0,
  videos_posted integer default 0,
  views integer default 0,
  shipping numeric(12,2) default 0,
  affiliate numeric(12,2) default 0,
  ads numeric(12,2) default 0,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

create index idx_entries_user_id on public.entries(user_id);
create index idx_entries_product_id on public.entries(product_id);
create index idx_entries_date on public.entries(date);
create index idx_entries_user_date on public.entries(user_id, date);

-- ============ ROW LEVEL SECURITY ============
alter table public.profiles enable row level security;
alter table public.products enable row level security;
alter table public.entries enable row level security;

-- Profiles
create policy "Users can view own profile"
  on public.profiles for select using (auth.uid() = id);
create policy "Users can update own profile"
  on public.profiles for update using (auth.uid() = id);

-- Products
create policy "Users can view own products"
  on public.products for select using (auth.uid() = user_id);
create policy "Users can insert own products"
  on public.products for insert with check (auth.uid() = user_id);
create policy "Users can update own products"
  on public.products for update using (auth.uid() = user_id);
create policy "Users can delete own products"
  on public.products for delete using (auth.uid() = user_id);

-- Entries
create policy "Users can view own entries"
  on public.entries for select using (auth.uid() = user_id);
create policy "Users can insert own entries"
  on public.entries for insert with check (auth.uid() = user_id);
create policy "Users can update own entries"
  on public.entries for update using (auth.uid() = user_id);
create policy "Users can delete own entries"
  on public.entries for delete using (auth.uid() = user_id);

-- ============ FUTURE: TIKTOK API INTEGRATION ============
-- Uncomment when TikTok OAuth is ready
-- create table public.tiktok_connections (
--   id uuid primary key default uuid_generate_v4(),
--   user_id uuid not null references auth.users(id) on delete cascade unique,
--   tiktok_user_id text,
--   access_token text,
--   refresh_token text,
--   token_expires_at timestamptz,
--   shop_id text,
--   connected_at timestamptz default now(),
--   last_synced_at timestamptz
-- );
