-- 085_scheduling_v1_schema.sql
-- Scheduling v1 — DEPLOY A (SCHEMA ONLY). Nothing reads or writes these objects yet;
-- the forward materializer, public token routes, release/claim, and the payroll-adjacent
-- past-materializer deferral ship in later, separate deploys (B and C).
--
-- ⚠️ MIGRATION LEDGER: this database has NO migration ledger. Migrations are applied BY HAND
--    and the repo file is the ONLY record of what has run. A duplicated/reused prefix is a real
--    skip / double-apply hazard here, not cosmetic (see 075's header for prior collisions).
--    Prefix 085 was chosen to clear a SUSPECTED in-flight 084 (`rate_cents_snapshot` payroll
--    work that is not present in any branch reachable from this repo, so it cannot be confirmed
--    or ruled out). 069/077 gaps were deliberately NOT backfilled — reusing a low gap on a
--    hand-applied DB is exactly the hazard above.
--    ➜ BEFORE HAND-APPLYING: inspect the LIVE schema. DB state is UNVERIFIED against this repo.
--      In particular confirm that public.shift_templates / shift_instances / shift_claims /
--      employee_access_tokens / attendance_events do NOT already exist, that shift_rules has no
--      `template_id` column, and that employees has no `phone` column, before running this.
--
-- CONVENTIONS (match the existing employees subsystem — 044/047/070):
--   * Every NEW table carries user_id uuid NOT NULL -> auth.users, with own-row RLS
--     (auth.uid() = user_id) for select/insert/update/delete. Employees themselves never log in;
--     `user_id` is the MANAGING account that owns the roster (same meaning as employees.user_id).
--     The public /s/* token routes read/write via the service-role client (bypasses RLS), scoped
--     explicitly by employee_id in every query — RLS here is for the admin UI (manager session).
--   * store_id is carried nullable with a guarded FK for the deferred org/store RLS cutover,
--     exactly like 044/047/070 — never RLS-load-bearing.
--   * Fully idempotent: create ... if not exists + guarded do-blocks, so a re-run / fresh
--     `db reset` re-applies harmlessly, matching every other migration here.
--   * Single business timezone (America/Los_Angeles) is a server-fixed CONSTANT in app code
--     (see 071 / the PnL RPCs) — deliberately NOT a stores.timezone column. shift_instances
--     stores starts_at/ends_at as timestamptz computed in that zone by the forward materializer.

create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------------
-- 1. employees.phone — contact column for the Phase 6 SMS broadcast. Nullable;
--    no backfill. Nothing depends on it in Deploy A.
-- ---------------------------------------------------------------------------
alter table public.employees add column if not exists phone text;

-- ---------------------------------------------------------------------------
-- 2. shift_templates — the SLOT-WITH-CAPACITY definition that shift_rules lacks.
--    A template is ONE (day_of_week, start_time, end_time, role) slot with a capacity ceiling.
--    Capacity is a ceiling for the onboarding picker ONLY — it is NEVER surfaced as claimable
--    on the employee board (the board shows released instances, not unfilled template slots).
-- ---------------------------------------------------------------------------
create table if not exists public.shift_templates (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  store_id uuid,                              -- FK added below, guarded (out-of-band `stores`)
  day_of_week smallint not null,              -- getUTCDay() numbers: 0=Sun … 6=Sat
  start_time time not null,
  end_time time not null,
  role text not null,                         -- constrained to the two pay-role classes below
  capacity smallint not null default 8,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shift_templates_dow_valid check (day_of_week between 0 and 6),
  constraint shift_templates_role_check check (role in ('host', 'fulfillment')),
  constraint shift_templates_capacity_positive check (capacity > 0)
);

create index if not exists idx_shift_templates_user on public.shift_templates(user_id);
create index if not exists idx_shift_templates_store on public.shift_templates(store_id);
create index if not exists idx_shift_templates_active on public.shift_templates(user_id) where active;

-- updated_at trigger (public.set_updated_at, defined in 021) — templates are CRUD-edited in the
-- Phase 7 admin page, so they carry updated_at like shift_rules (047). Guarded for idempotency.
do $$ begin
  if not exists (
    select 1 from pg_trigger where tgrelid = 'public.shift_templates'::regclass
      and tgname = 'shift_templates_set_updated_at' and not tgisinternal
  ) then
    create trigger shift_templates_set_updated_at
      before update on public.shift_templates
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. shift_rules.template_id — links a recurring rule to the template slot it fills.
--    A shift_rules row WITH template_id set == an employee assigned to that slot.
--
--    ⚠️ TYPE MISMATCH IS INTENTIONAL: shift_templates.day_of_week is a scalar smallint, but
--    shift_rules.days_of_week is a smallint[] (047). The onboarding picker MUST create a
--    template-linked rule with days_of_week = ARRAY[template.day_of_week] — a single-element
--    array. Verified single-element arrays are handled by generateRecurringShifts()
--    (src/lib/employees.ts), the past-materializer, and daysLabel() in the admin UI. Do NOT
--    "fix" this by making shift_rules.days_of_week scalar — the recurring subsystem needs the array.
--
--    ON DELETE SET NULL: deleting a template UNLINKS its assignment rules (they revert to plain
--    recurring rules) rather than destroying an employee's schedule. In practice a template with
--    materialized instances cannot be deleted anyway (shift_instances.template_id is RESTRICT below);
--    deactivate (active=false) instead of deleting.
alter table public.shift_rules add column if not exists template_id uuid;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'shift_rules_template_id_fkey') then
    alter table public.shift_rules
      add constraint shift_rules_template_id_fkey
      foreign key (template_id) references public.shift_templates(id) on delete set null;
  end if;
end $$;

create index if not exists idx_shift_rules_template on public.shift_rules(template_id);

-- FILL-COUNT NOTE (implemented in the Phase 7 admin page, not here): a template's fill on a
-- given date is
--     count(shift_rules where template_id = T and days_of_week @> ARRAY[T.day_of_week]
--           and active and start_date <= <date>)
-- NOT a bare template_id match. A template-linked rule whose days_of_week NO LONGER contains its
-- template's day_of_week is a DATA INCONSISTENCY — the admin schedule page surfaces it as a
-- warning row rather than silently excluding it.

-- ---------------------------------------------------------------------------
-- 4. shift_instances — a materialized, dated occurrence of a template slot for one employee.
--    Written FORWARD (shift_date > today) by the new forward materializer (Deploy B); the
--    payroll past-materializer never writes here. Payroll (isPayableShift/shifts) never reads here.
-- ---------------------------------------------------------------------------
create table if not exists public.shift_instances (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  template_id uuid not null references public.shift_templates(id) on delete restrict,
  -- employee_id is NULLED on release (the slot is up for grabs) and re-set to the claimer on claim.
  employee_id uuid references public.employees(id) on delete cascade,
  store_id uuid,                              -- FK added below, guarded (out-of-band `stores`)
  shift_date date not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'scheduled',
  source text not null default 'pattern',
  released_at timestamptz,
  released_by uuid references public.employees(id) on delete set null,   -- the employee who released it
  excused boolean not null default false,
  excused_by uuid references auth.users(id),                             -- manager action (auth user)
  excused_note text,
  created_at timestamptz not null default now(),
  constraint shift_instances_status_check
    check (status in ('scheduled', 'released', 'claimed', 'worked', 'missed', 'cancelled')),
  constraint shift_instances_source_check check (source in ('pattern', 'claim')),
  -- ⚠️ NULL-DISTINCTNESS CAVEAT: employee_id is nullable and Postgres treats NULLs as DISTINCT in a
  -- UNIQUE constraint, so this does NOT block multiple released (employee_id = NULL) rows for the
  -- same (template, date), and it does NOT block re-materializing the RELEASER's slot after release
  -- (their (template,date,employee) row became (template,date,NULL)). It is retained to make the
  -- common (unreleased) case idempotent.
  --
  -- REGENERATION-OF-A-RELEASED-SLOT is NOT closable by a unique index on this single mutating row:
  -- a regenerated instance is a FRESH insert with released_by NULL, so it slips past a
  -- released_by-partial index; and it doesn't trip the constraint below either, because the
  -- released row's employee_id is NULL and NULLs are distinct — both constraints miss it. A
  -- re-release also OVERWRITES released_by, so the row can only ever remember ONE releaser. The
  -- durable guard therefore lives in Deploy B against the append-only attendance_events table
  -- (denormalized template_id + shift_date): the forward materializer skips regenerating
  -- (employee, template, date) when a 'released'/'missed_unfilled' event exists for it. That trail
  -- remembers EVERY releaser, which no single-row constraint here can.
  constraint shift_instances_template_date_employee_unique unique (template_id, shift_date, employee_id)
);

create index if not exists idx_shift_instances_user on public.shift_instances(user_id);
create index if not exists idx_shift_instances_date_status on public.shift_instances(shift_date, status);
create index if not exists idx_shift_instances_employee on public.shift_instances(employee_id);
create index if not exists idx_shift_instances_template on public.shift_instances(template_id);

-- ---------------------------------------------------------------------------
-- 5. shift_claims — one row per claim attempt on a released instance.
--    'auto_approved' (projected week < 40h) / 'pending' (would cross 40h → manager approval) /
--    'approved' / 'rejected'. projected_week_hours is a SNAPSHOT taken at claim time.
-- ---------------------------------------------------------------------------
create table if not exists public.shift_claims (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  shift_instance_id uuid not null references public.shift_instances(id) on delete cascade,
  claimed_by uuid not null references public.employees(id) on delete cascade,
  claimed_at timestamptz not null default now(),
  status text not null,
  projected_week_hours numeric,               -- snapshot at claim time (scheduled + claimed span)
  approved_by uuid references auth.users(id), -- manager action (auth user)
  approved_at timestamptz,
  constraint shift_claims_status_check
    check (status in ('auto_approved', 'pending', 'approved', 'rejected'))
);

create index if not exists idx_shift_claims_user on public.shift_claims(user_id);
create index if not exists idx_shift_claims_instance on public.shift_claims(shift_instance_id);
create index if not exists idx_shift_claims_claimed_by on public.shift_claims(claimed_by);
-- Fast "pending OT claims" queue for the admin approval page.
create index if not exists idx_shift_claims_pending on public.shift_claims(user_id) where status = 'pending';

-- ---------------------------------------------------------------------------
-- 6. employee_access_tokens — the permanent tokenized URL identity for one employee.
--    `token` = 32 random bytes, base64url — generated in APP CODE, never in the DB.
--    Employees never establish a Supabase auth session; the /s/[token] routes resolve the
--    employee via this table (service-role) and scope every query by that employee_id.
-- ---------------------------------------------------------------------------
create table if not exists public.employee_access_tokens (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  token text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint employee_access_tokens_token_key unique (token)
);

create index if not exists idx_employee_access_tokens_user on public.employee_access_tokens(user_id);
create index if not exists idx_employee_access_tokens_employee on public.employee_access_tokens(employee_id);
-- Token lookup hits only ACTIVE tokens (revoked/inactive are 404 with no detail leaked).
create index if not exists idx_employee_access_tokens_active on public.employee_access_tokens(token) where active;

-- ---------------------------------------------------------------------------
-- 7. attendance_events — the append-only trail from which DROP COUNTS are DERIVED at read time.
--    There is deliberately NO stored ledger/counter table (drops = releases − claims per period).
--    shift_instance_id is nullable + ON DELETE SET NULL so the historical event survives deletion
--    of its instance (same "raw trail outlives the derived row" idiom as employee_time_entries.
--    shift_id in 070).
--
--    template_id + shift_date are DENORMALIZED here ON PURPOSE. They are the durable guard the
--    Deploy B forward materializer reads to avoid regenerating a released slot (a fresh insert has
--    released_by NULL and so slips past both unique constraints on shift_instances — see there).
--    Because shift_instance_id is SET NULL on instance deletion, the event must be self-sufficient
--    WITHOUT the instance: these two columns let the guard resolve (employee, template, date)
--    with no join, and outlive the instance exactly as the drop trail does. Hence NOT NULL.
--    template_id is ON DELETE RESTRICT so a template with attendance history cannot be dropped
--    out from under the guard (deactivate instead) — matching shift_instances.template_id.
-- ---------------------------------------------------------------------------
create table if not exists public.attendance_events (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  shift_instance_id uuid references public.shift_instances(id) on delete set null,
  template_id uuid not null references public.shift_templates(id) on delete restrict,
  shift_date date not null,
  event_type text not null,
  pay_period_start date not null,             -- the period this event falls in (biweekly; PAY_ANCHOR)
  created_at timestamptz not null default now(),
  constraint attendance_events_type_check
    check (event_type in ('released', 'claimed', 'missed_unfilled', 'excused'))
);

create index if not exists idx_attendance_events_user on public.attendance_events(user_id);
create index if not exists idx_attendance_events_employee_period
  on public.attendance_events(employee_id, pay_period_start);
-- The Deploy B regeneration guard: NOT EXISTS (employee_id, template_id, shift_date,
-- event_type in ('released','missed_unfilled')). Covered by this composite index.
create index if not exists idx_attendance_events_guard
  on public.attendance_events(employee_id, template_id, shift_date);

-- ---------------------------------------------------------------------------
-- 8. store_id FKs — only if the out-of-band `stores` table exists (044/047/070 idiom).
-- ---------------------------------------------------------------------------
do $$ begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'stores') then
    if not exists (select 1 from pg_constraint where conname = 'shift_templates_store_id_fkey') then
      alter table public.shift_templates
        add constraint shift_templates_store_id_fkey foreign key (store_id) references public.stores(id);
    end if;
    if not exists (select 1 from pg_constraint where conname = 'shift_instances_store_id_fkey') then
      alter table public.shift_instances
        add constraint shift_instances_store_id_fkey foreign key (store_id) references public.stores(id);
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 9. RLS — user_id-scoped own-row policies on all five new tables (044 idiom). Guarded.
-- ---------------------------------------------------------------------------
alter table public.shift_templates       enable row level security;
alter table public.shift_instances       enable row level security;
alter table public.shift_claims          enable row level security;
alter table public.employee_access_tokens enable row level security;
alter table public.attendance_events     enable row level security;

do $$
declare
  t text;
  tables text[] := array[
    'shift_templates', 'shift_instances', 'shift_claims',
    'employee_access_tokens', 'attendance_events'
  ];
begin
  foreach t in array tables loop
    if not exists (select 1 from pg_policies where tablename = t
                   and policyname = 'Users can view own ' || t) then
      execute format(
        'create policy "Users can view own %1$s" on public.%1$I for select using (auth.uid() = user_id)', t);
    end if;
    if not exists (select 1 from pg_policies where tablename = t
                   and policyname = 'Users can insert own ' || t) then
      execute format(
        'create policy "Users can insert own %1$s" on public.%1$I for insert with check (auth.uid() = user_id)', t);
    end if;
    if not exists (select 1 from pg_policies where tablename = t
                   and policyname = 'Users can update own ' || t) then
      execute format(
        'create policy "Users can update own %1$s" on public.%1$I for update using (auth.uid() = user_id)', t);
    end if;
    if not exists (select 1 from pg_policies where tablename = t
                   and policyname = 'Users can delete own ' || t) then
      execute format(
        'create policy "Users can delete own %1$s" on public.%1$I for delete using (auth.uid() = user_id)', t);
    end if;
  end loop;
end $$;
