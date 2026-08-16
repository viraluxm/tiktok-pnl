-- 091_badge_kiosk.sql
-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- AS-APPLIED RECORD — the VERIFIED as-applied state of migration 091, confirmed against live in
-- this session (2026-08-10), committed UNMODIFIED. It is intentionally NOT edited to match *current*
-- live, because current live = this file applied, THEN 092 applied on top.
--
--   • Applied to live approximately 2026-08-10 18:00 PT via the Supabase Management API.
--   • Applied by an unattributed automated session in git worktree Lensed-mig091, which then
--     committed a NON-MATCHING, leaner version as cf06de65 on branch chore/commit-091-badge-kiosk.
--     That branch and worktree were deleted 2026-08-10; cf06de65 never reached main.
--   • This (fuller) version is the as-applied truth: it still creates shifts.punch_method, the two
--     partial-UNIQUE indexes (idx_employee_badges_active_code / idx_kiosk_tokens_active_token), and
--     a lensed_kiosk_clock_out that writes punch_method into the shifts INSERT — all present on live.
--   • SUPERSEDED IN PART BY 092, which removed the punch_method write from the shifts INSERT in
--     lensed_kiosk_clock_out (create-or-replace). Replaying 091 THEN 092 in order reproduces current
--     live for all kiosk objects.
--   • MUST NOT BE REPLAYED — every object below already exists on live; this records applied state.
--     (The idempotent guards make a replay harmless, but that must not be relied upon.)
-- ═══════════════════════════════════════════════════════════════════════════════════════════
--
-- Badge-scan time clock — a NEW public kiosk surface (/k/[kiosk_token]) beside the existing
-- admin tap kiosk (/dashboard/time-clock), which is untouched and stays as the fallback.
--
-- TRUST MODEL (read before editing): the /k route runs SERVICE-ROLE only and NEVER establishes
-- a Supabase auth session (same rule as /s/[token]; see CLAUDE.md auth-session section). So the
-- write RPCs below are SECURITY DEFINER and must NOT call auth.uid() — there is no session. Owner
-- scoping is anchored ENTIRELY in data: a kiosk_tokens row resolves the owner (user_id), and an
-- employee_badges row resolves the employee, and the employee MUST belong to the same owner. A
-- leaked badge code alone is not a punch — it also needs a valid kiosk token (in the URL path).
--
-- These RPCs are granted to service_role ONLY (never anon/authenticated). They are called only
-- via createAdminClient().rpc(); register them in scripts/check-rpc-grants.mjs SERVICE_ROLE_ONLY.
--
-- TIME MODEL / ROUNDING: identical to 071 — raw punches are server-stamped timestamptz; the
-- shift row is derived through America/Los_Angeles (SERVER-FIXED); every punch is truncated to
-- the whole minute before differencing. Idempotent (create ... if not exists + guarded do-blocks).
--
-- SCAN STATE MACHINE (server-derived from current employee_time_entries state):
--   clocked_out -> clock in immediately            (write; punch_method='badge')
--   working     -> return 'prompt', NO write       (client shows Start break / Clock out buttons)
--   on_break    -> end break immediately           (write)
--   rescan of the same badge within 60s            -> return 'status' only, NO write
-- A single scan can NEVER clock someone out — clock-out is an explicit button (lensed_kiosk_clock_out).

create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------------
-- 1. employee_badges — scannable Code-128 credential (reprintable + revocable).
--    Separate table (not a column on employees) precisely because badges get
--    reissued: revoke the old row (active=false), insert a new one.
-- ---------------------------------------------------------------------------
create table if not exists public.employee_badges (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  code text not null unique,                 -- random 10-char A–Z2–9 (0/O,1/I/L excluded); global-unique
  active boolean not null default true,
  issued_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists idx_employee_badges_user on public.employee_badges(user_id);
create index if not exists idx_employee_badges_employee on public.employee_badges(employee_id);
-- Hot path: resolve an ACTIVE badge by code. The global UNIQUE(code) above already guarantees
-- active uniqueness (codes are random and never reused), so this partial index is the covering
-- lookup for the resolve query `where code = ? and active` per the approved spec.
create unique index if not exists idx_employee_badges_active_code
  on public.employee_badges (code) where active;

-- ---------------------------------------------------------------------------
-- 2. kiosk_tokens — gates the /k/[kiosk_token] route. Owner + optional store.
--    Mirrors the employee_access_tokens shape (no updated_at); NOT reused because
--    that table's employee_id is NOT NULL and means per-employee schedule access.
-- ---------------------------------------------------------------------------
create table if not exists public.kiosk_tokens (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  store_id uuid,                             -- guarded FK below (out-of-band `stores`, 070 idiom)
  token text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists idx_kiosk_tokens_user on public.kiosk_tokens(user_id);
create unique index if not exists idx_kiosk_tokens_active_token
  on public.kiosk_tokens (token) where active;

do $$ begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'stores') then
    if not exists (select 1 from pg_constraint where conname = 'kiosk_tokens_store_id_fkey') then
      alter table public.kiosk_tokens
        add constraint kiosk_tokens_store_id_fkey foreign key (store_id) references public.stores(id);
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. employees.pin_hash — column ONLY. No PIN flow is built or enforced here;
--    enforcement lands later behind a flag. Nullable so every existing row is unaffected.
-- ---------------------------------------------------------------------------
alter table public.employees
  add column if not exists pin_hash text;

-- ---------------------------------------------------------------------------
-- 4. punch_method — how a punch was made, surfaced from the raw entry onto the shift.
--    employee_time_entries.punch_method: NOT NULL DEFAULT 'tap' so the EXISTING (untouched)
--    lensed_clock_in auto-labels 'tap' with no RPC change; the badge RPC writes 'badge'.
--    shifts.punch_method: NULLABLE — the badge clock-out copies the entry's value onto the
--    shift; the existing tap clock-out is intentionally NOT modified, so tap-surface and
--    manual/scheduled shifts stay NULL. (Read it only alongside source='time_clock'.)
-- ---------------------------------------------------------------------------
alter table public.employee_time_entries
  add column if not exists punch_method text not null default 'tap';
alter table public.shifts
  add column if not exists punch_method text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'time_entries_punch_method_check') then
    alter table public.employee_time_entries
      add constraint time_entries_punch_method_check check (punch_method in ('tap', 'badge'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'shifts_punch_method_check') then
    alter table public.shifts
      add constraint shifts_punch_method_check check (punch_method is null or punch_method in ('tap', 'badge'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. RLS — own-row (auth.uid() = user_id), 070/044 idiom. This governs OWNER management of
--    badges/tokens from the dashboard (a user session). The /k route uses service-role, which
--    bypasses RLS entirely — its confinement is the in-function owner join, not these policies.
-- ---------------------------------------------------------------------------
alter table public.employee_badges enable row level security;
alter table public.kiosk_tokens enable row level security;

do $$ begin
  -- employee_badges
  if not exists (select 1 from pg_policies where tablename='employee_badges' and policyname='Users can view own employee_badges') then
    create policy "Users can view own employee_badges" on public.employee_badges for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='employee_badges' and policyname='Users can insert own employee_badges') then
    create policy "Users can insert own employee_badges" on public.employee_badges for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='employee_badges' and policyname='Users can update own employee_badges') then
    create policy "Users can update own employee_badges" on public.employee_badges for update using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='employee_badges' and policyname='Users can delete own employee_badges') then
    create policy "Users can delete own employee_badges" on public.employee_badges for delete using (auth.uid() = user_id);
  end if;

  -- kiosk_tokens
  if not exists (select 1 from pg_policies where tablename='kiosk_tokens' and policyname='Users can view own kiosk_tokens') then
    create policy "Users can view own kiosk_tokens" on public.kiosk_tokens for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='kiosk_tokens' and policyname='Users can insert own kiosk_tokens') then
    create policy "Users can insert own kiosk_tokens" on public.kiosk_tokens for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='kiosk_tokens' and policyname='Users can update own kiosk_tokens') then
    create policy "Users can update own kiosk_tokens" on public.kiosk_tokens for update using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='kiosk_tokens' and policyname='Users can delete own kiosk_tokens') then
    create policy "Users can delete own kiosk_tokens" on public.kiosk_tokens for delete using (auth.uid() = user_id);
  end if;
end $$;

-- ===========================================================================
-- 6. RPCs — SECURITY DEFINER, service_role ONLY. NO auth.uid() anywhere in this path.
--    Owner (v_owner) is resolved from kiosk_tokens; the employee must belong to that owner.
--    Error tokens mirror 071 so the /k client can compose friendly messages.
-- ===========================================================================

-- SCAN — the single-scan entrypoint. Derives state and acts per the state machine. It can
-- clock IN and END A BREAK, but NEVER clocks out (that is an explicit button below).
create or replace function public.lensed_kiosk_scan(p_kiosk_token text, p_badge text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_store uuid;
  v_emp uuid;
  v_name text;
  v_entry public.employee_time_entries;
  v_has_open boolean;
  v_on_break boolean := false;
  v_now timestamptz := now();
  v_last timestamptz;
  v_new_id uuid;
begin
  -- 1. kiosk token → owner (+ store). Active only. (NO auth.uid().)
  select kt.user_id, kt.store_id into v_owner, v_store
    from public.kiosk_tokens kt where kt.token = p_kiosk_token and kt.active;
  if v_owner is null then raise exception 'INVALID_KIOSK' using errcode = '28000'; end if;

  -- 2. badge → employee, scoped to the SAME owner; badge active + employee active.
  select b.employee_id, e.name into v_emp, v_name
    from public.employee_badges b
    join public.employees e on e.id = b.employee_id
   where b.code = p_badge and b.active and b.user_id = v_owner
     and e.user_id = v_owner and e.status = 'active';
  if v_emp is null then raise exception 'BADGE_NOT_FOUND'; end if;

  -- 3. serialize all actions for this employee within the transaction.
  perform pg_advisory_xact_lock(hashtextextended(v_emp::text, 0));

  -- 4. current open session (lock it so a concurrent scan can't slip through).
  select * into v_entry
    from public.employee_time_entries
   where employee_id = v_emp and user_id = v_owner and clocked_out_at is null
   for update;
  v_has_open := found;
  if v_has_open then
    v_on_break := exists (
      select 1 from public.employee_time_breaks
      where time_entry_id = v_entry.id and ended_at is null);
  end if;

  -- 5. rescan guard: any punch activity within 60s → status only, NO write. Protects against
  --    an accidental double scan turning into a second action (or exposing the clock-out button
  --    the instant after a clock-in).
  select greatest(
           coalesce(max(te.clocked_in_at),  '-infinity'::timestamptz),
           coalesce(max(te.clocked_out_at), '-infinity'::timestamptz),
           coalesce(max(bk.started_at),     '-infinity'::timestamptz),
           coalesce(max(bk.ended_at),       '-infinity'::timestamptz))
    into v_last
    from public.employee_time_entries te
    left join public.employee_time_breaks bk on bk.time_entry_id = te.id
   where te.employee_id = v_emp and te.user_id = v_owner;

  if v_last > v_now - interval '60 seconds' then
    return jsonb_build_object(
      'result', 'status', 'rescan', true, 'employee_name', v_name,
      'state', case when not v_has_open then 'clocked_out'
                    when v_on_break then 'on_break' else 'working' end);
  end if;

  -- 6. act by state.
  if not v_has_open then
    -- clocked_out → clock IN immediately.
    begin
      insert into public.employee_time_entries (user_id, employee_id, clocked_in_at, status, store_id, punch_method)
        values (v_owner, v_emp, v_now, 'open', v_store, 'badge')
        returning id into v_new_id;
    exception when unique_violation then
      raise exception 'ALREADY_CLOCKED_IN';
    end;
    return jsonb_build_object('result', 'clocked_in', 'state', 'working',
      'employee_name', v_name, 'at', v_now, 'entry_id', v_new_id);

  elsif v_on_break then
    -- on_break → END break immediately.
    update public.employee_time_breaks set ended_at = v_now
      where time_entry_id = v_entry.id and ended_at is null;
    update public.employee_time_entries set status = 'open' where id = v_entry.id;
    return jsonb_build_object('result', 'break_ended', 'state', 'working',
      'employee_name', v_name, 'at', v_now);

  else
    -- working → PROMPT only, NO write. Client renders Start break / Clock out.
    return jsonb_build_object('result', 'prompt', 'state', 'working', 'employee_name', v_name);
  end if;
end;
$$;

-- START BREAK — explicit button. Requires an open session not already on break.
create or replace function public.lensed_kiosk_start_break(p_kiosk_token text, p_badge text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid; v_emp uuid; v_name text; v_entry public.employee_time_entries; v_now timestamptz := now();
begin
  select kt.user_id into v_owner from public.kiosk_tokens kt where kt.token = p_kiosk_token and kt.active;
  if v_owner is null then raise exception 'INVALID_KIOSK' using errcode = '28000'; end if;

  select b.employee_id, e.name into v_emp, v_name
    from public.employee_badges b join public.employees e on e.id = b.employee_id
   where b.code = p_badge and b.active and b.user_id = v_owner and e.user_id = v_owner and e.status = 'active';
  if v_emp is null then raise exception 'BADGE_NOT_FOUND'; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_emp::text, 0));

  select * into v_entry from public.employee_time_entries
   where employee_id = v_emp and user_id = v_owner and clocked_out_at is null for update;
  if not found then raise exception 'NOT_CLOCKED_IN'; end if;

  if exists (select 1 from public.employee_time_breaks where time_entry_id = v_entry.id and ended_at is null) then
    raise exception 'ALREADY_ON_BREAK';
  end if;

  begin
    insert into public.employee_time_breaks (user_id, employee_id, time_entry_id, started_at)
      values (v_owner, v_emp, v_entry.id, v_now);
  exception when unique_violation then
    raise exception 'ALREADY_ON_BREAK';
  end;
  update public.employee_time_entries set status = 'on_break' where id = v_entry.id;

  return jsonb_build_object('result', 'break_started', 'state', 'on_break', 'employee_name', v_name, 'at', v_now);
end;
$$;

-- CLOCK OUT — explicit button. Closes the session and materializes ONE unconfirmed time_clock
-- shift, carrying the entry's punch_method ('badge') onto the shift row.
create or replace function public.lensed_kiosk_clock_out(p_kiosk_token text, p_badge text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid; v_emp uuid; v_name text; v_entry public.employee_time_entries;
  v_now timestamptz := now();
  v_tz constant text := 'America/Los_Angeles';
  v_break_minutes integer; v_date date; v_start time; v_end time; v_shift_id uuid;
begin
  select kt.user_id into v_owner from public.kiosk_tokens kt where kt.token = p_kiosk_token and kt.active;
  if v_owner is null then raise exception 'INVALID_KIOSK' using errcode = '28000'; end if;

  select b.employee_id, e.name into v_emp, v_name
    from public.employee_badges b join public.employees e on e.id = b.employee_id
   where b.code = p_badge and b.active and b.user_id = v_owner and e.user_id = v_owner and e.status = 'active';
  if v_emp is null then raise exception 'BADGE_NOT_FOUND'; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_emp::text, 0));

  select * into v_entry from public.employee_time_entries
   where employee_id = v_emp and user_id = v_owner and clocked_out_at is null for update;
  if not found then raise exception 'NOT_CLOCKED_IN'; end if;

  if exists (select 1 from public.employee_time_breaks where time_entry_id = v_entry.id and ended_at is null) then
    raise exception 'BREAK_OPEN';
  end if;

  select coalesce(sum(
           extract(epoch from (date_trunc('minute', ended_at) - date_trunc('minute', started_at))) / 60)::int, 0)
    into v_break_minutes
    from public.employee_time_breaks where time_entry_id = v_entry.id and ended_at is not null;

  v_date  := (v_entry.clocked_in_at at time zone v_tz)::date;
  v_start := date_trunc('minute', (v_entry.clocked_in_at at time zone v_tz))::time;
  v_end   := date_trunc('minute', (v_now at time zone v_tz))::time;

  insert into public.shifts (
    user_id, employee_id, date, start_time, end_time, break_minutes, source, confirmed_at, punch_method
  ) values (
    v_owner, v_entry.employee_id, v_date, v_start, v_end, v_break_minutes, 'time_clock', null, v_entry.punch_method
  ) returning id into v_shift_id;

  update public.employee_time_entries
     set clocked_out_at = v_now, status = 'closed', shift_id = v_shift_id
   where id = v_entry.id;

  return jsonb_build_object('result', 'clocked_out', 'state', 'clocked_out',
    'employee_name', v_name, 'at', v_now, 'shift_id', v_shift_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. GRANTS — service_role ONLY. These are called exclusively via createAdminClient().rpc();
--    anon/authenticated are explicitly revoked so a leaked kiosk URL cannot call them directly.
--    (Register all three in scripts/check-rpc-grants.mjs SERVICE_ROLE_ONLY — see CONVENTIONS.md.)
-- ---------------------------------------------------------------------------
revoke execute on function public.lensed_kiosk_scan(text, text)        from public, anon, authenticated;
revoke execute on function public.lensed_kiosk_start_break(text, text) from public, anon, authenticated;
revoke execute on function public.lensed_kiosk_clock_out(text, text)   from public, anon, authenticated;

grant execute on function public.lensed_kiosk_scan(text, text)        to service_role;
grant execute on function public.lensed_kiosk_start_break(text, text) to service_role;
grant execute on function public.lensed_kiosk_clock_out(text, text)   to service_role;
