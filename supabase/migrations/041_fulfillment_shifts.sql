-- 041_fulfillment_shifts.sql — Identity/Auth phase, CHUNK 4: shift / break model.
-- Two new tables supporting the working ⇄ on_break, working|on_break → ended state machine
-- (enforced in app layer, chunk 7) and break-aware active-time KPI math.
-- Additive only, transaction-wrapped, idempotent. Same style as 039/040.
--
-- FORWARD-DEP NOTE: device_id (→ fulfillment_devices) is intentionally OMITTED here; that
-- table is built in chunk 6, and shifts aren't created until chunk 7. The device_id column
-- + its FK are added in chunk 6 (self-contained, full integrity, zero rows to backfill).
--
-- end_reason includes 'break_timeout' per rev-3 Q4 (a never-resumed break auto-caps at 60m
-- and ends the shift) — added now so we don't ALTER the CHECK later.
--
-- Reverse:
--   drop table if exists public.fulfillment_shift_breaks;
--   drop table if exists public.fulfillment_shifts;

begin;

-- ===== fulfillment_shifts =====
create table if not exists public.fulfillment_shifts (
  id          uuid primary key default uuid_generate_v4(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  worker_id   uuid not null references public.fulfillment_workers(id) on delete restrict,  -- protect KPI history; soft-deactivate is the path, never hard-delete a worker with shifts
  mode        text not null check (mode in ('picker','packer')),                            -- = device kind for this shift
  state       text not null default 'working' check (state in ('working','on_break','ended')),
  started_at  timestamptz not null default now(),
  ended_at    timestamptz null,
  end_reason  text null check (end_reason in ('manual','idle','break_timeout')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_fs_worker    on public.fulfillment_shifts(worker_id);
create index if not exists idx_fs_org_state  on public.fulfillment_shifts(org_id, state);          -- "active shifts" lookups
create index if not exists idx_fs_worker_started on public.fulfillment_shifts(worker_id, started_at); -- per-worker KPI over time

drop trigger if exists fulfillment_shifts_set_updated_at on public.fulfillment_shifts;
create trigger fulfillment_shifts_set_updated_at before update on public.fulfillment_shifts
  for each row execute function public.set_updated_at();

alter table public.fulfillment_shifts enable row level security;
drop policy if exists "fs org read"   on public.fulfillment_shifts;
drop policy if exists "fs org insert" on public.fulfillment_shifts;
drop policy if exists "fs org update" on public.fulfillment_shifts;
drop policy if exists "fs org delete" on public.fulfillment_shifts;
-- read + write = any org member (the shared fulfillment device account opens/updates shifts;
-- owners may also work the floor). NOT store-owner-only — the device account isn't a store owner.
create policy "fs org read"   on public.fulfillment_shifts for select using (public.is_org_member(org_id));
create policy "fs org insert" on public.fulfillment_shifts for insert with check (public.is_org_member(org_id));
create policy "fs org update" on public.fulfillment_shifts for update using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
create policy "fs org delete" on public.fulfillment_shifts for delete using (public.is_org_member(org_id));

-- ===== fulfillment_shift_breaks =====
-- One row per break interval. ended_at NULL = currently on break. Multiple rows per shift.
-- Active-time = (coalesce(shift.ended_at, now()) - shift.started_at)
--               - Σ (coalesce(break.ended_at, now()) - break.started_at)
-- → fully computable from these interval rows (open break counts up to now).
create table if not exists public.fulfillment_shift_breaks (
  id         uuid primary key default uuid_generate_v4(),
  shift_id   uuid not null references public.fulfillment_shifts(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at   timestamptz null
);
create index if not exists idx_fsb_shift on public.fulfillment_shift_breaks(shift_id);

alter table public.fulfillment_shift_breaks enable row level security;
drop policy if exists "fsb org read"   on public.fulfillment_shift_breaks;
drop policy if exists "fsb org insert" on public.fulfillment_shift_breaks;
drop policy if exists "fsb org update" on public.fulfillment_shift_breaks;
drop policy if exists "fsb org delete" on public.fulfillment_shift_breaks;
-- inherit org scoping via the parent shift (breaks have no org_id column)
create policy "fsb org read"   on public.fulfillment_shift_breaks for select
  using (exists (select 1 from public.fulfillment_shifts s where s.id = fulfillment_shift_breaks.shift_id and public.is_org_member(s.org_id)));
create policy "fsb org insert" on public.fulfillment_shift_breaks for insert
  with check (exists (select 1 from public.fulfillment_shifts s where s.id = fulfillment_shift_breaks.shift_id and public.is_org_member(s.org_id)));
create policy "fsb org update" on public.fulfillment_shift_breaks for update
  using (exists (select 1 from public.fulfillment_shifts s where s.id = fulfillment_shift_breaks.shift_id and public.is_org_member(s.org_id)));
create policy "fsb org delete" on public.fulfillment_shift_breaks for delete
  using (exists (select 1 from public.fulfillment_shifts s where s.id = fulfillment_shift_breaks.shift_id and public.is_org_member(s.org_id)));

commit;
