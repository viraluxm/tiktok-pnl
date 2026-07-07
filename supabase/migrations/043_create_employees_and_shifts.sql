-- 043_create_employees_and_shifts.sql
-- First-party team roster + timekeeping for the Employee tab.
--
-- These are RECORDS ONLY — no auth users, no logins. They belong to the account
-- that manages the team, so they are user_id-scoped with the same own-row RLS idiom
-- as entries / capture_events / shipment_verifications. (The org/store RLS cutover is
-- deferred; store_id is carried nullable + guarded FK for that future cutover, exactly
-- like 036_create_capture_events, but RLS stays user_id-based until then.)
--
-- PAY IS DERIVED, never stored: sum(shift hours) * hourly_rate over a period. There is
-- deliberately no pay table. Shifts are STANDALONE — the show->host attribution link
-- (host KPIs) is deferred until Live Data scope / extension host-stamping exists, so
-- shifts carry no session_id.

create extension if not exists "uuid-ossp";

-- Employees --------------------------------------------------------------------
create table if not exists public.employees (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  role text not null default 'host',        -- host / fulfillment / etc. (free text; UI offers presets)
  status text not null default 'active',    -- active / probation / former
  hourly_rate numeric(10,2) not null default 0,
  hire_date date,
  probation_end_date date,                  -- displayed only; no alerting
  store_id uuid,                            -- FK added below, guarded (out-of-band `stores`)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employees_status_check check (status in ('active', 'probation', 'former')),
  constraint employees_hourly_rate_nonneg check (hourly_rate >= 0)
);

create index if not exists idx_employees_user on public.employees(user_id);
create index if not exists idx_employees_store on public.employees(store_id);

-- Shifts -----------------------------------------------------------------------
-- Hours are COMPUTED from (start_time, end_time) at read time, never stored.
create table if not exists public.shifts (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  date date not null,
  start_time time not null,
  end_time time not null,
  store_id uuid,                            -- FK added below, guarded (out-of-band `stores`)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_shifts_user on public.shifts(user_id);
create index if not exists idx_shifts_employee on public.shifts(employee_id);
create index if not exists idx_shifts_date on public.shifts(date);

-- store_id FKs — only if the out-of-band `stores` table exists (tracked separately),
-- mirroring the guard in 036_create_capture_events.
do $$ begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'stores') then
    if not exists (select 1 from pg_constraint where conname = 'employees_store_id_fkey') then
      alter table public.employees
        add constraint employees_store_id_fkey foreign key (store_id) references public.stores(id);
    end if;
    if not exists (select 1 from pg_constraint where conname = 'shifts_store_id_fkey') then
      alter table public.shifts
        add constraint shifts_store_id_fkey foreign key (store_id) references public.stores(id);
    end if;
  end if;
end $$;

-- updated_at triggers (function public.set_updated_at, defined in 021). Guarded so a
-- re-run never creates a duplicate trigger.
do $$ begin
  if not exists (
    select 1 from pg_trigger where tgrelid = 'public.employees'::regclass
      and tgname = 'employees_set_updated_at' and not tgisinternal
  ) then
    create trigger employees_set_updated_at
      before update on public.employees
      for each row execute function public.set_updated_at();
  end if;
  if not exists (
    select 1 from pg_trigger where tgrelid = 'public.shifts'::regclass
      and tgname = 'shifts_set_updated_at' and not tgisinternal
  ) then
    create trigger shifts_set_updated_at
      before update on public.shifts
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- RLS: user_id-scoped own-row policies, matching entries / capture_events /
-- shipment_verifications. Guarded for idempotency (036 style).
alter table public.employees enable row level security;
alter table public.shifts enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'employees'
                 and policyname = 'Users can view own employees') then
    create policy "Users can view own employees"
      on public.employees for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'employees'
                 and policyname = 'Users can insert own employees') then
    create policy "Users can insert own employees"
      on public.employees for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'employees'
                 and policyname = 'Users can update own employees') then
    create policy "Users can update own employees"
      on public.employees for update using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'employees'
                 and policyname = 'Users can delete own employees') then
    create policy "Users can delete own employees"
      on public.employees for delete using (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies where tablename = 'shifts'
                 and policyname = 'Users can view own shifts') then
    create policy "Users can view own shifts"
      on public.shifts for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'shifts'
                 and policyname = 'Users can insert own shifts') then
    create policy "Users can insert own shifts"
      on public.shifts for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'shifts'
                 and policyname = 'Users can update own shifts') then
    create policy "Users can update own shifts"
      on public.shifts for update using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'shifts'
                 and policyname = 'Users can delete own shifts') then
    create policy "Users can delete own shifts"
      on public.shifts for delete using (auth.uid() = user_id);
  end if;
end $$;
