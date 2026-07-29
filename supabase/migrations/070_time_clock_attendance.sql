-- 070_time_clock_attendance.sql
-- Employee time-clock KIOSK — raw attendance storage + the shift columns the kiosk needs.
--
-- WHY THIS EXISTS: the Employee tab (044) turns SHIFTS into pay, but there was no way for
-- an employee to punch in/out. This adds the RAW punch trail (auditable, server-stamped)
-- and the three shift columns needed to (a) distinguish a time-clock shift from a manual
-- one, (b) hold a MANAGER CONFIRMATION gate before it counts toward pay, and (c) carry the
-- unpaid break minutes so derived pay is correct. The 4 transactional RPCs that actually
-- write these live in 071_time_clock_rpcs.sql.
--
-- DESIGN NOTES
--   * Raw punches are timestamptz (server now()), NEVER wall-clock and NEVER client-set —
--     they are the source of truth and stay untouched if a manager later edits the shift.
--   * The generated `shifts` row keeps the EXISTING wall-clock model (date + time). The
--     conversion (instant -> wall clock) happens in the clock-out RPC.
--   * Same own-row RLS idiom as 044 (auth.uid() = user_id). store_id is carried nullable +
--     guarded FK for the deferred org/store cutover, exactly like 044 — never RLS-load-bearing.
--   * Fully idempotent (create ... if not exists + guarded do-blocks), so a re-run or a fresh
--     `db reset` re-applies harmlessly, matching every other migration here.

create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------------
-- 1. Shift columns the time clock populates.
-- ---------------------------------------------------------------------------
-- source: 'manual' (hand-entered or materialized-recurring — behaves EXACTLY as before)
--         vs 'time_clock' (produced by the kiosk). Default 'manual' backfills every
--         existing row, so nothing changes for shifts that already exist.
-- confirmed_at: the MANAGER CONFIRMATION gate. NULL = not yet confirmed. Only time_clock
--         shifts are gated on it in pay (see src/lib/employees.ts computePay); manual
--         shifts ignore it and stay payable as today, so no backfill is needed.
-- break_minutes: total UNPAID break time to subtract from derived pay. Default 0 -> every
--         existing shift keeps its current hours exactly.
alter table public.shifts
  add column if not exists source text not null default 'manual';
alter table public.shifts
  add column if not exists confirmed_at timestamptz;
-- confirmed_by: WHO confirmed it (the manager's auth.uid() at confirm time). Set together
-- with confirmed_at by lensed_confirm_time_clock_shift (071) — an audit trail for the
-- pay-affecting approval. Both columns are server-only (see the guard trigger below).
alter table public.shifts
  add column if not exists confirmed_by uuid references auth.users(id);
alter table public.shifts
  add column if not exists break_minutes integer not null default 0;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'shifts_source_check') then
    alter table public.shifts
      add constraint shifts_source_check check (source in ('manual', 'time_clock'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'shifts_break_minutes_nonneg') then
    alter table public.shifts
      add constraint shifts_break_minutes_nonneg check (break_minutes >= 0);
  end if;
end $$;

-- Find "which time-clock shifts still need confirmation" fast (small table, but keeps the
-- ShiftsView badge query cheap and intent explicit).
create index if not exists idx_shifts_needs_confirmation
  on public.shifts (user_id)
  where source = 'time_clock' and confirmed_at is null;

-- GUARD: confirmed_at / confirmed_by are pay-affecting and must be SERVER-authoritative.
-- This BEFORE UPDATE trigger rejects any change to them UNLESS the caller is inside a confirm
-- RPC, which sets the transaction-local GUC `lensed.confirm_ctx = 'on'` right before updating.
-- An ordinary shift update (the editor's start/end change, or a direct client/PostgREST write)
-- never sets that GUC, so it may still edit times freely but can NEVER flip confirmation — the
-- only way to change confirmation is lensed_confirm/unconfirm_time_clock_shift. Rows where the
-- columns are unchanged pass untouched (so the existing shift editor is unaffected); INSERTs
-- are not covered (clock-out writes confirmed_at = NULL directly).
create or replace function public.shifts_guard_confirmation()
returns trigger
language plpgsql
as $$
begin
  if (new.confirmed_at is distinct from old.confirmed_at
      or new.confirmed_by is distinct from old.confirmed_by)
     and coalesce(current_setting('lensed.confirm_ctx', true), '') <> 'on' then
    raise exception 'CONFIRMATION_IS_SERVER_ONLY'
      using hint = 'Change confirmation via lensed_confirm_time_clock_shift / lensed_unconfirm_time_clock_shift';
  end if;
  return new;
end;
$$;

do $$ begin
  if not exists (
    select 1 from pg_trigger where tgrelid = 'public.shifts'::regclass
      and tgname = 'shifts_guard_confirmation' and not tgisinternal
  ) then
    create trigger shifts_guard_confirmation
      before update on public.shifts
      for each row execute function public.shifts_guard_confirmation();
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. employee_time_entries — ONE row per work session (clock-in -> clock-out).
-- ---------------------------------------------------------------------------
-- status mirrors the state machine: 'open' (working), 'on_break', 'closed' (clocked out).
-- clocked_out_at IS NULL is the authoritative "session is active" test used by the guard
-- index below and by the RPCs (status is a convenience mirror kept in sync transactionally).
-- shift_id is set at clock-out and links to the ONE generated shift (ON DELETE SET NULL so
-- deleting the shift never destroys the raw punch trail).
create table if not exists public.employee_time_entries (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  store_id uuid,                              -- FK added below, guarded (out-of-band `stores`)
  shift_id uuid references public.shifts(id) on delete set null,
  clocked_in_at timestamptz not null default now(),
  clocked_out_at timestamptz,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint time_entries_status_check check (status in ('open', 'on_break', 'closed')),
  -- A closed session must have an end instant, and an active one must not — keeps status
  -- and clocked_out_at from ever disagreeing even under a bad direct write.
  constraint time_entries_closed_has_out check (
    (status = 'closed') = (clocked_out_at is not null)
  )
);

create index if not exists idx_time_entries_user on public.employee_time_entries(user_id);
create index if not exists idx_time_entries_employee on public.employee_time_entries(employee_id);
create index if not exists idx_time_entries_shift on public.employee_time_entries(shift_id);

-- GUARD (server-side, not UI-only): at most ONE active session per employee. A racing or
-- UI-bypassing second clock-in raises unique_violation. Mirrors idx_shifts_one_open_per_employee.
create unique index if not exists idx_time_entries_one_open_per_employee
  on public.employee_time_entries (employee_id) where clocked_out_at is null;

-- ---------------------------------------------------------------------------
-- 3. employee_time_breaks — ONE row per break (multiple breaks = multiple rows).
-- ---------------------------------------------------------------------------
-- ended_at IS NULL = break in progress. employee_id is denormalized from the parent entry
-- so RLS + per-employee queries stay simple and match the other tables.
create table if not exists public.employee_time_breaks (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  time_entry_id uuid not null references public.employee_time_entries(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_time_breaks_user on public.employee_time_breaks(user_id);
create index if not exists idx_time_breaks_employee on public.employee_time_breaks(employee_id);
create index if not exists idx_time_breaks_entry on public.employee_time_breaks(time_entry_id);

-- GUARD: at most ONE open break per work session (so per employee too, given one active
-- session). A racing/second Start-Break raises unique_violation.
create unique index if not exists idx_time_breaks_one_open_per_entry
  on public.employee_time_breaks (time_entry_id) where ended_at is null;

-- ---------------------------------------------------------------------------
-- 4. store_id FKs — only if the out-of-band `stores` table exists (044 idiom).
-- ---------------------------------------------------------------------------
do $$ begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'stores') then
    if not exists (select 1 from pg_constraint where conname = 'time_entries_store_id_fkey') then
      alter table public.employee_time_entries
        add constraint time_entries_store_id_fkey foreign key (store_id) references public.stores(id);
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. updated_at triggers (public.set_updated_at, defined in 021). Guarded.
-- ---------------------------------------------------------------------------
do $$ begin
  if not exists (
    select 1 from pg_trigger where tgrelid = 'public.employee_time_entries'::regclass
      and tgname = 'time_entries_set_updated_at' and not tgisinternal
  ) then
    create trigger time_entries_set_updated_at
      before update on public.employee_time_entries
      for each row execute function public.set_updated_at();
  end if;
  if not exists (
    select 1 from pg_trigger where tgrelid = 'public.employee_time_breaks'::regclass
      and tgname = 'time_breaks_set_updated_at' and not tgisinternal
  ) then
    create trigger time_breaks_set_updated_at
      before update on public.employee_time_breaks
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. RLS — user_id-scoped own-row policies (044 idiom). Guarded for idempotency.
-- ---------------------------------------------------------------------------
alter table public.employee_time_entries enable row level security;
alter table public.employee_time_breaks enable row level security;

do $$ begin
  -- employee_time_entries
  if not exists (select 1 from pg_policies where tablename = 'employee_time_entries'
                 and policyname = 'Users can view own time entries') then
    create policy "Users can view own time entries"
      on public.employee_time_entries for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'employee_time_entries'
                 and policyname = 'Users can insert own time entries') then
    create policy "Users can insert own time entries"
      on public.employee_time_entries for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'employee_time_entries'
                 and policyname = 'Users can update own time entries') then
    create policy "Users can update own time entries"
      on public.employee_time_entries for update using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'employee_time_entries'
                 and policyname = 'Users can delete own time entries') then
    create policy "Users can delete own time entries"
      on public.employee_time_entries for delete using (auth.uid() = user_id);
  end if;

  -- employee_time_breaks
  if not exists (select 1 from pg_policies where tablename = 'employee_time_breaks'
                 and policyname = 'Users can view own time breaks') then
    create policy "Users can view own time breaks"
      on public.employee_time_breaks for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'employee_time_breaks'
                 and policyname = 'Users can insert own time breaks') then
    create policy "Users can insert own time breaks"
      on public.employee_time_breaks for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'employee_time_breaks'
                 and policyname = 'Users can update own time breaks') then
    create policy "Users can update own time breaks"
      on public.employee_time_breaks for update using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'employee_time_breaks'
                 and policyname = 'Users can delete own time breaks') then
    create policy "Users can delete own time breaks"
      on public.employee_time_breaks for delete using (auth.uid() = user_id);
  end if;
end $$;
