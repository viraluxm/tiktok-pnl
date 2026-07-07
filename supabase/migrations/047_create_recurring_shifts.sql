-- 047_create_recurring_shifts.sql
-- Recurring shifts for the Employee tab: a RULE that recurs on chosen weekdays,
-- plus per-date EXCEPTIONS (skip / modified). Recurring shift instances are
-- COMPUTED from (rule − exceptions) at read time — never materialized — exactly
-- like shift hours and pay are derived, never stored (see 044).
--
-- The existing one-off `shifts` table (044) is untouched: one-off shifts and
-- generated recurring instances are summed by the app for hours/pay.
--
-- Deleting a rule cascades its exceptions and stops FUTURE generation. It does
-- NOT touch the `shifts` table (past one-off shifts / worked history stand); and
-- because instances are computed, "past pay already calculated" simply isn't
-- re-derived retroactively — deletion only stops forward generation.
--
-- RLS: user_id-scoped own-row policies, matching employees / shifts (044).
-- store_id is carried nullable with a guarded FK for the deferred org/store
-- cutover, same idiom as 044/036.

create extension if not exists "uuid-ossp";

-- Recurring rules --------------------------------------------------------------
create table if not exists public.shift_rules (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  -- Weekdays the rule recurs on, as getUTCDay() numbers (0=Sun … 6=Sat).
  days_of_week smallint[] not null default '{}',
  start_time time not null,
  end_time time not null,
  start_date date not null,                 -- generation begins on/after this date
  active boolean not null default true,
  store_id uuid,                            -- FK added below, guarded (out-of-band `stores`)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shift_rules_days_valid check (days_of_week <@ array[0,1,2,3,4,5,6]::smallint[])
);

create index if not exists idx_shift_rules_user on public.shift_rules(user_id);
create index if not exists idx_shift_rules_employee on public.shift_rules(employee_id);

-- Per-date exceptions to a rule ------------------------------------------------
-- 'skip'     → no instance is generated for that date.
-- 'modified' → an instance is generated using modified_start/modified_end
--              (a null side falls back to the rule's time in the app).
create table if not exists public.shift_exceptions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  rule_id uuid not null references public.shift_rules(id) on delete cascade,
  date date not null,
  type text not null,
  modified_start time,
  modified_end time,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shift_exceptions_type_check check (type in ('skip', 'modified')),
  -- One exception per rule per date (a date is either skipped or modified, not both).
  constraint shift_exceptions_rule_date_unique unique (rule_id, date)
);

create index if not exists idx_shift_exceptions_user on public.shift_exceptions(user_id);
create index if not exists idx_shift_exceptions_rule on public.shift_exceptions(rule_id);
create index if not exists idx_shift_exceptions_date on public.shift_exceptions(date);

-- store_id FK — only if the out-of-band `stores` table exists, mirroring 044/036.
do $$ begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'stores') then
    if not exists (select 1 from pg_constraint where conname = 'shift_rules_store_id_fkey') then
      alter table public.shift_rules
        add constraint shift_rules_store_id_fkey foreign key (store_id) references public.stores(id);
    end if;
  end if;
end $$;

-- updated_at triggers (function public.set_updated_at, defined in 021). Guarded.
do $$ begin
  if not exists (
    select 1 from pg_trigger where tgrelid = 'public.shift_rules'::regclass
      and tgname = 'shift_rules_set_updated_at' and not tgisinternal
  ) then
    create trigger shift_rules_set_updated_at
      before update on public.shift_rules
      for each row execute function public.set_updated_at();
  end if;
  if not exists (
    select 1 from pg_trigger where tgrelid = 'public.shift_exceptions'::regclass
      and tgname = 'shift_exceptions_set_updated_at' and not tgisinternal
  ) then
    create trigger shift_exceptions_set_updated_at
      before update on public.shift_exceptions
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- RLS: user_id-scoped own-row policies, matching employees / shifts. Guarded.
alter table public.shift_rules enable row level security;
alter table public.shift_exceptions enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'shift_rules'
                 and policyname = 'Users can view own shift_rules') then
    create policy "Users can view own shift_rules"
      on public.shift_rules for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'shift_rules'
                 and policyname = 'Users can insert own shift_rules') then
    create policy "Users can insert own shift_rules"
      on public.shift_rules for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'shift_rules'
                 and policyname = 'Users can update own shift_rules') then
    create policy "Users can update own shift_rules"
      on public.shift_rules for update using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'shift_rules'
                 and policyname = 'Users can delete own shift_rules') then
    create policy "Users can delete own shift_rules"
      on public.shift_rules for delete using (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies where tablename = 'shift_exceptions'
                 and policyname = 'Users can view own shift_exceptions') then
    create policy "Users can view own shift_exceptions"
      on public.shift_exceptions for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'shift_exceptions'
                 and policyname = 'Users can insert own shift_exceptions') then
    create policy "Users can insert own shift_exceptions"
      on public.shift_exceptions for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'shift_exceptions'
                 and policyname = 'Users can update own shift_exceptions') then
    create policy "Users can update own shift_exceptions"
      on public.shift_exceptions for update using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'shift_exceptions'
                 and policyname = 'Users can delete own shift_exceptions') then
    create policy "Users can delete own shift_exceptions"
      on public.shift_exceptions for delete using (auth.uid() = user_id);
  end if;
end $$;
