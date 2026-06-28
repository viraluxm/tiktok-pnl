-- 036_pickpack_fulfillment.sql
-- Pick/Pack fulfillment module. ADDITIVE ONLY — new tables; no change to existing
-- order/inventory tables' meaning. Operator-scoped tables use owner_user_id RLS now
-- (matching the rest of the app; store-RLS cutover is a separate pending phase) and
-- carry store_id/org_id for that future cutover. Cubicles + sections are ORG-SHARED.
--
-- Wrapped in a single transaction so it either fully applies or fully rolls back
-- (no partial-commit like the §1 incident). Fully idempotent — safe to re-run.

begin;

-- ========== pick_sections (ORG-SHARED) — one physical shelf section <-> one SKU ==========
create table if not exists public.pick_sections (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  section_barcode text not null,
  inventory_sku_id uuid not null references public.inventory_skus(id) on delete restrict,
  label text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, section_barcode)
);
create index if not exists idx_pick_sections_org on public.pick_sections(org_id);
create index if not exists idx_pick_sections_sku on public.pick_sections(inventory_sku_id);
-- strict 1:1: a SKU maps to exactly ONE active section within the org
create unique index if not exists uniq_pick_section_sku_active
  on public.pick_sections(org_id, inventory_sku_id) where is_active;
drop trigger if exists pick_sections_set_updated_at on public.pick_sections;
create trigger pick_sections_set_updated_at before update on public.pick_sections
  for each row execute function public.set_updated_at();
alter table public.pick_sections enable row level security;
drop policy if exists "org read pick_sections"   on public.pick_sections;
drop policy if exists "org insert pick_sections"  on public.pick_sections;
drop policy if exists "org update pick_sections"  on public.pick_sections;
drop policy if exists "org delete pick_sections"  on public.pick_sections;
create policy "org read pick_sections"   on public.pick_sections for select using (public.is_org_member(org_id));
create policy "org insert pick_sections"  on public.pick_sections for insert with check (public.is_org_member(org_id));
create policy "org update pick_sections"  on public.pick_sections for update using (public.is_org_member(org_id));
create policy "org delete pick_sections"  on public.pick_sections for delete using (public.is_org_member(org_id));

-- ========== cubicles (ORG-SHARED — shared carts/racks) ==========
create table if not exists public.cubicles (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  cubicle_number integer not null,
  cubicle_barcode text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, cubicle_number),
  unique (org_id, cubicle_barcode)
);
create index if not exists idx_cubicles_org on public.cubicles(org_id);
drop trigger if exists cubicles_set_updated_at on public.cubicles;
create trigger cubicles_set_updated_at before update on public.cubicles
  for each row execute function public.set_updated_at();
alter table public.cubicles enable row level security;
drop policy if exists "org read cubicles"   on public.cubicles;
drop policy if exists "org insert cubicles"  on public.cubicles;
drop policy if exists "org update cubicles"  on public.cubicles;
drop policy if exists "org delete cubicles"  on public.cubicles;
create policy "org read cubicles"   on public.cubicles for select using (public.is_org_member(org_id));
create policy "org insert cubicles"  on public.cubicles for insert with check (public.is_org_member(org_id));
create policy "org update cubicles"  on public.cubicles for update using (public.is_org_member(org_id));
create policy "org delete cubicles"  on public.cubicles for delete using (public.is_org_member(org_id));

-- ========== fulfillment_orders (OPERATOR-SCOPED; box-level) ==========
create table if not exists public.fulfillment_orders (
  id uuid primary key default uuid_generate_v4(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  store_id uuid references public.stores(id),            -- carried for future store-RLS cutover
  group_key text not null,                               -- auto_combine_group_id | 'order:<id>'
  order_ids text[] not null default '{}',
  status text not null default 'unpicked'
    check (status in ('unpicked','picking','fully_picked','assigned','packing','shipped','exception')),
  cubicle_id uuid references public.cubicles(id) on delete set null,
  exception_reason text,                                 -- escape hatch (picking -> exception)
  assigned_at timestamptz, packed_at timestamptz, shipped_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_user_id, group_key)
);
create index if not exists idx_fo_owner  on public.fulfillment_orders(owner_user_id);
create index if not exists idx_fo_status on public.fulfillment_orders(owner_user_id, status);
-- CROSS-OPERATOR cubicle lock: at most ONE active box per cubicle, regardless of owner.
-- Unique indexes see ALL rows (RLS does not weaken them) → blocks Abe from cubicle 7
-- while it holds my order, even though RLS hides my order from him.
create unique index if not exists uniq_cubicle_active
  on public.fulfillment_orders(cubicle_id)
  where cubicle_id is not null and status in ('assigned','packing');
drop trigger if exists fulfillment_orders_set_updated_at on public.fulfillment_orders;
create trigger fulfillment_orders_set_updated_at before update on public.fulfillment_orders
  for each row execute function public.set_updated_at();
alter table public.fulfillment_orders enable row level security;
drop policy if exists "owner read fo"   on public.fulfillment_orders;
drop policy if exists "owner insert fo"  on public.fulfillment_orders;
drop policy if exists "owner update fo"  on public.fulfillment_orders;
drop policy if exists "owner delete fo"  on public.fulfillment_orders;
create policy "owner read fo"   on public.fulfillment_orders for select using (auth.uid() = owner_user_id);
create policy "owner insert fo"  on public.fulfillment_orders for insert with check (auth.uid() = owner_user_id);
create policy "owner update fo"  on public.fulfillment_orders for update using (auth.uid() = owner_user_id);
create policy "owner delete fo"  on public.fulfillment_orders for delete using (auth.uid() = owner_user_id);

-- ========== fulfillment_lines ==========
create table if not exists public.fulfillment_lines (
  id uuid primary key default uuid_generate_v4(),
  fulfillment_order_id uuid not null references public.fulfillment_orders(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,  -- denormalized for RLS; always = parent order owner
  inventory_sku_id uuid not null references public.inventory_skus(id) on delete restrict,
  expected_section_id uuid references public.pick_sections(id) on delete set null,
  required_qty integer not null default 1,
  picked boolean not null default false,
  picked_qty integer not null default 0,                 -- supports qty>1 stepper
  picked_at timestamptz,
  picked_via_section_id uuid references public.pick_sections(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_fl_order on public.fulfillment_lines(fulfillment_order_id);
create index if not exists idx_fl_owner on public.fulfillment_lines(owner_user_id);
alter table public.fulfillment_lines enable row level security;
drop policy if exists "owner read fl"   on public.fulfillment_lines;
drop policy if exists "owner insert fl"  on public.fulfillment_lines;
drop policy if exists "owner update fl"  on public.fulfillment_lines;
drop policy if exists "owner delete fl"  on public.fulfillment_lines;
create policy "owner read fl"   on public.fulfillment_lines for select using (auth.uid() = owner_user_id);
create policy "owner insert fl"  on public.fulfillment_lines for insert with check (auth.uid() = owner_user_id);
create policy "owner update fl"  on public.fulfillment_lines for update using (auth.uid() = owner_user_id);
create policy "owner delete fl"  on public.fulfillment_lines for delete using (auth.uid() = owner_user_id);

-- ========== cross-operator cubicle occupancy (no-leak helper) ==========
-- Returns the cubicle's state WITHOUT exposing another operator's order.
-- SECURITY DEFINER: sees all owners' rows, but returns ONLY a label.
-- DO NOT extend this to return order-specific data without revisiting execute grants.
create or replace function public.cubicle_state(p_cubicle uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare owner_id uuid;
begin
  select owner_user_id into owner_id from public.fulfillment_orders
   where cubicle_id = p_cubicle and status in ('assigned','packing') limit 1;
  if owner_id is null then return 'free'; end if;
  if owner_id = auth.uid() then return 'mine'; end if;
  return 'occupied_by_other';
end $$;

commit;
