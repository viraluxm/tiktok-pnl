-- Inventory SKUs: the host's own physical catalog for live auctions.
-- Lensed-owned and intentionally separate from TikTok-synced `products`;
-- later reconciliation maps TikTok seller SKUs back to these rows.

create extension if not exists "uuid-ossp";

-- Shared trigger function to keep updated_at current (first use in the schema).
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql security invoker;

create table public.inventory_skus (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  sku_number integer not null,
  barcode text not null,
  title text not null default '',
  shortcut_letter text,
  unit_cost_cents integer,
  qty_on_hand integer not null default 0,
  weight_oz numeric(10,2),
  length_in numeric(10,2),
  width_in numeric(10,2),
  height_in numeric(10,2),
  category text,
  is_active boolean not null default true,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  unique(user_id, sku_number),
  unique(user_id, barcode)
);

create index idx_inventory_skus_user_id on public.inventory_skus(user_id);

-- One shortcut letter per seller; partial index keeps multiple NULLs allowed.
create unique index idx_inventory_skus_user_shortcut
  on public.inventory_skus(user_id, shortcut_letter)
  where shortcut_letter is not null;

create trigger inventory_skus_set_updated_at
  before update on public.inventory_skus
  for each row execute function public.set_updated_at();

alter table public.inventory_skus enable row level security;

create policy "Users can view own inventory_skus"
  on public.inventory_skus for select using (auth.uid() = user_id);
create policy "Users can insert own inventory_skus"
  on public.inventory_skus for insert with check (auth.uid() = user_id);
create policy "Users can update own inventory_skus"
  on public.inventory_skus for update using (auth.uid() = user_id);
create policy "Users can delete own inventory_skus"
  on public.inventory_skus for delete using (auth.uid() = user_id);
