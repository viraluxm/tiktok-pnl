-- 032: per-order true payout from the TikTok Finance API (v2 reconcile).
--
-- Keyed by (user_id, order_id) — covers BOTH bound orders (live_auction_items)
-- and unbound captured orders. The Reconcile pass upserts here: estimate first
-- (unsettled), replaced by the settled actual once TikTok settles. Read/display
-- only — no inventory writes. order_id is the exact join key to the board.
--
-- ⚠️ MULTI-TENANT TODO: org migration 030 is NOT live in prod yet, so this uses
-- user_id-only RLS to match the rest of the schema today. WHEN 030 IS APPLIED,
-- `order_payouts` MUST be added to 030's table list (add nullable org_id +
-- index, backfill org_id from the owner's rows, and replace these user_id
-- policies with the is_org_member(org_id) policies) — otherwise it gets orphaned
-- under org RLS.

create table if not exists public.order_payouts (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  order_id text not null,
  net_payout_cents integer,                 -- settlement_amount (settled) | est_settlement_amount (estimate)
  settled boolean not null default false,   -- true = actual settled, false = estimate
  fees jsonb,                               -- itemized breakdown (settled: platform_commission/transaction_fee/…; estimate: fee_tax_breakdown)
  currency text,
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, order_id)
);

create index if not exists idx_order_payouts_user on public.order_payouts(user_id);

create trigger order_payouts_set_updated_at
  before update on public.order_payouts
  for each row execute function public.set_updated_at();

alter table public.order_payouts enable row level security;

create policy "Users can view own order_payouts"
  on public.order_payouts for select using (auth.uid() = user_id);
create policy "Users can insert own order_payouts"
  on public.order_payouts for insert with check (auth.uid() = user_id);
create policy "Users can update own order_payouts"
  on public.order_payouts for update using (auth.uid() = user_id);
