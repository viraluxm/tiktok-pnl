-- 029: pick-verify status for the Shipping packing-station flow.
--
-- A "box" = all orders sharing an auto_combine_group_id (or a single order with
-- no group). When a picker scans every required item and confirms, we record the
-- verification here. This is the ONLY write the pick-verify flow makes; it does
-- not touch capture, the bind path, or lensed_log_auction.

create table if not exists public.shipment_verifications (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Box key: the auto_combine_group_id, or 'order:<order_id>' for a singleton.
  group_key text not null,
  -- The order_ids that made up the box at verification time (audit trail).
  order_ids text[] not null default '{}',
  verified_at timestamptz default now() not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  unique (user_id, group_key)
);

create index if not exists idx_shipment_verifications_user on public.shipment_verifications(user_id);

create trigger shipment_verifications_set_updated_at
  before update on public.shipment_verifications
  for each row execute function public.set_updated_at();

alter table public.shipment_verifications enable row level security;

create policy "Users can view own shipment_verifications"
  on public.shipment_verifications for select using (auth.uid() = user_id);
create policy "Users can insert own shipment_verifications"
  on public.shipment_verifications for insert with check (auth.uid() = user_id);
create policy "Users can update own shipment_verifications"
  on public.shipment_verifications for update using (auth.uid() = user_id);
