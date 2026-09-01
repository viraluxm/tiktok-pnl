-- 120_time_off_requests.sql
-- Time-off requests: a worker asks for days off BEFORE the schedule for that pay period is built.
--
-- ⚠️ MIGRATION LEDGER: this database has NO ledger. Migrations are applied BY HAND and this file
--    is the ONLY record that it ran. Prefix 120 was chosen above the highest prefix claimed on any
--    branch or worktree (119, team_schedule_tokens — verified applied in prod on 2026-09-01).
--    ➜ BEFORE APPLYING: confirm public.time_off_requests does NOT already exist.
--
-- LOCK FOOTPRINT (see CLAUDE.md "classify by LOCK FOOTPRINT"): CLASS A. One brand-new table plus
-- its own indexes and policies. No existing table is read, rewritten, or locked, so this takes no
-- lock any live-show reader or the capture path can queue behind. Apply with
-- `set local lock_timeout = '3s'` per the Class A recipe.
--
-- DISTINCT FROM "drops" (release/claim). A drop hands back a shift that ALREADY EXISTS and is
-- counted against a per-period allowance in src/lib/schedule/drops.ts. A time-off request is made
-- BEFORE the shift exists and must NOT consume that allowance — asking for a day off in advance is
-- the behaviour we want, and charging it the same as bailing on an assigned shift would punish it.
-- These deliberately share no counter and no table.
--
-- NOT A PAY INPUT. Nothing here is payable and nothing reads it during a live show. Pay continues
-- to come only from real `shifts` rows via isPayableShift() (punches are truth, Deploy C).

create extension if not exists "uuid-ossp";

create table if not exists public.time_off_requests (
  id uuid primary key default uuid_generate_v4(),
  -- The MANAGING account that owns the roster (same meaning as employees.user_id), for own-row RLS.
  user_id uuid not null references auth.users(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  -- Inclusive calendar dates in America/Los_Angeles. A single day sets start = end.
  start_date date not null,
  end_date date not null,
  reason text,
  status text not null default 'pending',
  -- Decision trail. decided_by is an auth.users id (the manager), NOT an employees id.
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  decision_note text,
  -- Carried nullable with a guarded FK for the deferred org/store RLS cutover, as in 044/047/070.
  -- Never RLS-load-bearing.
  store_id uuid,
  created_at timestamptz not null default now(),
  constraint time_off_requests_range_ck check (end_date >= start_date),
  constraint time_off_requests_status_ck check (status in ('pending', 'approved', 'denied', 'withdrawn'))
);

-- store_id FK added separately and guarded: public.stores may not exist on every environment.
do $$
begin
  if to_regclass('public.stores') is not null
     and not exists (select 1 from pg_constraint where conname = 'time_off_requests_store_id_fkey')
  then
    alter table public.time_off_requests
      add constraint time_off_requests_store_id_fkey
      foreign key (store_id) references public.stores(id) on delete set null;
  end if;
end $$;

-- The manager queue: pending first, newest first, scoped to the owner.
create index if not exists time_off_requests_user_status_idx
  on public.time_off_requests (user_id, status, start_date);

-- "Is this person off on date D?" while building a schedule, and the worker's own list.
create index if not exists time_off_requests_employee_range_idx
  on public.time_off_requests (employee_id, start_date, end_date);

-- One PENDING request per employee per start_date: a double-tapped form cannot open two queue
-- items for the same day. Partial, so a denied request can be re-submitted for that same date.
create unique index if not exists time_off_requests_one_pending_per_day_idx
  on public.time_off_requests (employee_id, start_date)
  where status = 'pending';

alter table public.time_off_requests enable row level security;

-- Own-row RLS for the ADMIN UI (the manager's own session). The public /s/* token route writes
-- via the service-role client, which bypasses RLS and is scoped explicitly by employee_id in every
-- query — the token plus that explicit filter is the boundary there, never RLS.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'time_off_requests' and policyname = 'time_off_requests_own_rows'
  ) then
    create policy time_off_requests_own_rows on public.time_off_requests
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

comment on table public.time_off_requests is
  'Worker time-off requests, submitted before the pay period is scheduled. Not payable; not read during a live show. Separate from release/claim "drops" and shares no allowance with them.';
