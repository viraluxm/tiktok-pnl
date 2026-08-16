-- 102: picker-reported "can't find it on the shelf" flags, per inventory SKU.
--
-- WHY A NEW TABLE, NOT A COLUMN ON inventory_skus:
--   inventory_skus is a capture-path table — the bind RPCs update qty_on_hand row-level
--   during live shows (see 033_allow_negative_bind.sql). Putting a picker-tapped flag on
--   that row adds a new hot write path contending for rows the bind path locks. This table
--   is read/written ONLY by the fulfillment pick flow; nothing in capture or order-sync
--   touches it, so it is additive with zero blast radius on the live path.
--
-- SCOPE — one row per (owner, inventory_sku_id). The flag describes the SHELF, not a box:
--   a picker who can't find SKU #52 tells every later picker of #52, in any box. Catalog
--   orders have no inventory_sku_id and are intentionally NOT representable here.
--
-- STATE MODEL — current-state, not an event log. unique (user_id, inventory_sku_id) means a
--   re-report of an already-cleared SKU UPDATEs the same row (fresh reported_at, cleared_at
--   back to null). Mirrors shipment_verifications (029): a fulfillment-side fact in its own
--   table, keyed by (user_id, <thing>).
--
-- CLEARING — two paths, both application-side. There is deliberately NO restock trigger:
--   1. 'grabbed' (primary) — the picker later grabs the SKU, written by the confirm path.
--      A successful grab is stronger evidence than a stock number: the unit was in a hand.
--   2. 'undo' (secondary) — the picker taps the band off.
--   Flags also stop RENDERING once reported_at falls outside the read window
--   (SHELF_FLAG_WINDOW_HOURS in src/lib/shipping/shelfFlags.ts, default 24h). Staleness is a
--   READ concern only — this table never expires rows, so the history stays intact.

create table if not exists public.sku_shelf_flags (
  id uuid primary key default uuid_generate_v4(),
  -- The SKU OWNER's user_id (never the station account, which owns no data).
  user_id uuid not null references auth.users(id) on delete cascade,
  inventory_sku_id uuid not null references public.inventory_skus(id) on delete cascade,

  -- Report. reported_at is what the read window is measured against.
  reported_at timestamptz not null default now(),
  -- Attribution is the fulfillment PICKER (employees.id), not the auth caller: on the station
  -- the caller is a shared appliance account. ON DELETE SET NULL so removing an employee never
  -- deletes an operational flag (mirrors 066's picker_employee_id).
  reported_by_employee_id uuid references public.employees(id) on delete set null,
  -- Name at report time, so the display survives an employee rename/delete.
  reported_by_name text,

  -- Clear (null = live, subject to the read window).
  cleared_at timestamptz,
  cleared_by_employee_id uuid references public.employees(id) on delete set null,
  cleared_reason text check (cleared_reason in ('grabbed', 'undo')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One current-state row per SKU per owner; also the index serving the pick-path read
  -- (user_id = owner AND inventory_sku_id IN (...)).
  unique (user_id, inventory_sku_id)
);

create trigger sku_shelf_flags_set_updated_at
  before update on public.sku_shelf_flags
  for each row execute function public.set_updated_at();

alter table public.sku_shelf_flags enable row level security;

-- Owner-scoped own-row RLS, matching inventory_skus (021). The station and any other
-- service-role reader bypasses RLS and scopes by user_id explicitly in the query.
create policy "Users can view own sku_shelf_flags"
  on public.sku_shelf_flags for select using (auth.uid() = user_id);
create policy "Users can insert own sku_shelf_flags"
  on public.sku_shelf_flags for insert with check (auth.uid() = user_id);
create policy "Users can update own sku_shelf_flags"
  on public.sku_shelf_flags for update using (auth.uid() = user_id);
create policy "Users can delete own sku_shelf_flags"
  on public.sku_shelf_flags for delete using (auth.uid() = user_id);
