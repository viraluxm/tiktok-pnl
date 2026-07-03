-- 040_fulfillment_attribution.sql — Identity/Auth phase, CHUNK 3: who-picked / who-packed.
-- Adds worker attribution to the fulfillment tables so per-person KPIs can be captured.
-- Additive only: new NULLABLE columns + partial indexes. No existing-column changes, no
-- data changes, no RLS changes (fulfillment_orders/_lines are already org-RLS from 037, so
-- the new columns inherit it). Transaction-wrapped + idempotent.
--
-- via_shift linkage (picked_via_shift / packed_via_shift) is DEFERRED to CHUNK 4, where
-- fulfillment_shifts is created — the columns + their FK land together there, so we never
-- add a column whose referenced table doesn't exist yet.
--
-- Reverse:
--   alter table public.fulfillment_lines  drop column if exists picked_by;
--   alter table public.fulfillment_orders drop column if exists picked_by, drop column if exists packed_by;

begin;

-- who scan-confirmed each line
alter table public.fulfillment_lines
  add column if not exists picked_by uuid references public.fulfillment_workers(id) on delete set null;

-- who completed the pick (assigned the cubicle) and who packed/handed off the box
alter table public.fulfillment_orders
  add column if not exists picked_by uuid references public.fulfillment_workers(id) on delete set null;
alter table public.fulfillment_orders
  add column if not exists packed_by uuid references public.fulfillment_workers(id) on delete set null;

-- Partial indexes (WHERE NOT NULL): most rows have no attribution until worked, so these
-- stay tiny and serve the KPI "group/filter by worker" queries (chunk 9).
create index if not exists idx_fl_picked_by on public.fulfillment_lines(picked_by)  where picked_by is not null;
create index if not exists idx_fo_picked_by on public.fulfillment_orders(picked_by) where picked_by is not null;
create index if not exists idx_fo_packed_by on public.fulfillment_orders(packed_by) where packed_by is not null;

commit;
