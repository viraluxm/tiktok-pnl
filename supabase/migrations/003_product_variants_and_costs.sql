-- ============ ADD units_sold TO ENTRIES ============
alter table public.entries add column if not exists units_sold integer default 0;
alter table public.entries add column if not exists variant_id text;

-- ============ PRODUCT VARIANTS (JSONB on products) ============
-- Variants stored as JSONB array: [{ "id": "...", "name": "1 Pack", "sku": "RL-10-1PK" }, ...]
alter table public.products add column if not exists variants jsonb default '[]'::jsonb;

-- ============ PRODUCT COSTS TABLE ============
-- Stores cost per unit for each product or product variant.
-- key = product_id (for products without variants) or product_id + variant_id (for variants).
create table if not exists public.product_costs (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  variant_id text,  -- null for non-variant products, variant.id for variant-level cost
  cost_per_unit numeric(12,2) default 0,
  updated_at timestamptz default now() not null,
  unique(user_id, product_id, variant_id)
);

create index idx_product_costs_user_product on public.product_costs(user_id, product_id);

-- ============ RLS FOR PRODUCT_COSTS ============
alter table public.product_costs enable row level security;

create policy "Users can view own product costs"
  on public.product_costs for select using (auth.uid() = user_id);
create policy "Users can insert own product costs"
  on public.product_costs for insert with check (auth.uid() = user_id);
create policy "Users can update own product costs"
  on public.product_costs for update using (auth.uid() = user_id);
create policy "Users can delete own product costs"
  on public.product_costs for delete using (auth.uid() = user_id);
