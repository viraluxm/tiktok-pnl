-- 042_fulfillment_via_shift.sql — Identity/Auth phase, CHUNK 5 (part a): shift linkage cols.
-- The deferred *_via_shift columns (from chunk 3), now that fulfillment_shifts exists (041).
-- Ties each attributed pick/pack to the shift it happened in, so KPI math can subtract that
-- shift's break time (break-aware active-time throughput, chunk 9).
-- Additive, nullable, on delete set null (a deleted shift never orphans the line/order).
-- Transaction-wrapped + idempotent. Same style as 039–041.
--
-- Reverse:
--   alter table public.fulfillment_lines  drop column if exists picked_via_shift;
--   alter table public.fulfillment_orders drop column if exists picked_via_shift, drop column if exists packed_via_shift;

begin;

alter table public.fulfillment_lines
  add column if not exists picked_via_shift uuid references public.fulfillment_shifts(id) on delete set null;
alter table public.fulfillment_orders
  add column if not exists picked_via_shift uuid references public.fulfillment_shifts(id) on delete set null;
alter table public.fulfillment_orders
  add column if not exists packed_via_shift uuid references public.fulfillment_shifts(id) on delete set null;

-- Partial indexes (tiny until work is attributed) — KPI joins lines/orders → shift for
-- break-aware active-time.
create index if not exists idx_fl_picked_via_shift on public.fulfillment_lines(picked_via_shift)  where picked_via_shift is not null;
create index if not exists idx_fo_picked_via_shift on public.fulfillment_orders(picked_via_shift) where picked_via_shift is not null;
create index if not exists idx_fo_packed_via_shift on public.fulfillment_orders(packed_via_shift) where packed_via_shift is not null;

commit;
