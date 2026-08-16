-- 099_qr_clock_in.sql
-- Rotating-QR clock-in on main's payroll model. A worker on the /s/[token] schedule page requests a
-- server-issued single-use nonce; the station scanner reads it and it punches through the SAME
-- employee_time_entries stream as the badge kiosk (punch_method='qr'). Badge stays as the logged
-- fallback. This migration is the DB layer only (endpoints/client separate). Additive; touches
-- employee_time_entries (constraint widen), shift_instances (FK), kiosk_tokens (FK), and two new
-- tables — no capture/order-sync tables (not gated).

begin;

-- 1. punch_method: allow 'qr' (widen; existing 'tap'/'badge' rows stay valid).
alter table public.employee_time_entries drop constraint if exists time_entries_punch_method_check;
alter table public.employee_time_entries
  add constraint time_entries_punch_method_check check (punch_method in ('tap','badge','qr'));

-- 2. purpose enum.
do $$ begin
  if not exists (select 1 from pg_type where typname='clock_purpose' and typnamespace='public'::regnamespace) then
    create type public.clock_purpose as enum ('clock_in','clock_out','break_start','break_end');
  end if;
end $$;

-- 3. clock_codes — one LIVE code per (worker, shift, intent). Rotation = upsert on the PK. user_id is
--    set by a BEFORE-INSERT trigger from employee_id (061 idiom), never passed by the caller.
create table if not exists public.clock_codes (
  user_id             uuid not null references auth.users(id) on delete cascade,
  employee_id         uuid not null references public.employees(id) on delete cascade,
  shift_instance_id   uuid not null references public.shift_instances(id) on delete cascade,
  purpose             public.clock_purpose not null,
  code                text not null,
  expires_at          timestamptz not null,
  consumed_at         timestamptz,
  consumed_station_id uuid references public.kiosk_tokens(id),
  created_at          timestamptz not null default now(),
  primary key (employee_id, shift_instance_id, purpose)
);
create unique index if not exists clock_codes_code_key on public.clock_codes (code);
create index if not exists clock_codes_expiry_idx on public.clock_codes (expires_at) where consumed_at is null;

create or replace function public.clock_codes_set_user_id()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  -- Derive the owner from the employee — never trust a caller-supplied user_id (061 idiom).
  NEW.user_id := (select e.user_id from public.employees e where e.id = NEW.employee_id);
  return NEW;
end $fn$;
drop trigger if exists trg_clock_codes_set_user_id on public.clock_codes;
create trigger trg_clock_codes_set_user_id
  before insert or update of employee_id on public.clock_codes
  for each row execute function public.clock_codes_set_user_id();

alter table public.clock_codes enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='clock_codes' and policyname='Owners view own clock_codes') then
    create policy "Owners view own clock_codes" on public.clock_codes for select using (auth.uid() = user_id);
  end if;
end $$;

-- 4. clock_audit — every issue + scan attempt. FK-FREE on employee_id/shift_instance_id ON PURPOSE.
create table if not exists public.clock_audit (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid,
  employee_id       uuid,
  shift_instance_id uuid,
  purpose           public.clock_purpose,
  code              text,
  station_id        uuid,
  event             text not null check (event in ('issue','scan')),
  outcome           text not null,     -- 'ok' | 'rejected'
  reason            text,              -- 'unknown' | 'already_used' | 'expired' | 'out_of_window' | ...
  created_at        timestamptz not null default now()
);
comment on column public.clock_audit.employee_id is
  'No FK by design: audit rows MUST survive employee deletion. This is a payroll time record (Nevada) retained >= 3 years; the expired-clock_codes cleanup job must NEVER touch this table.';
comment on column public.clock_audit.shift_instance_id is
  'No FK by design: must survive shift_instance deletion (see employee_id comment).';
create index if not exists clock_audit_created_idx on public.clock_audit (created_at desc);
alter table public.clock_audit enable row level security; -- service-role writes only; no policies.

-- 5. lensed_kiosk_manual_punch_as gains p_punch_method (default 'tap'; QR passes 'qr'). Rebuilt from
--    live prosrc — the ONLY body delta is the clock_in insert writing p_punch_method (see commit diff).
--    Drop the 3-arg and create the 4-arg-with-default so existing 3-arg callers still resolve.
drop function if exists public.lensed_kiosk_manual_punch_as(uuid, uuid, text);
create or replace function public.lensed_kiosk_manual_punch_as(
  p_owner uuid, p_employee_id uuid, p_action text, p_punch_method text default 'tap')
returns jsonb
language plpgsql
security definer
set search_path = public
as $body$
declare
  v_name text;
  v_entry public.employee_time_entries;
  v_has_open boolean;
  v_on_break boolean := false;
  v_now timestamptz := now();
  v_tz constant text := 'America/Los_Angeles';
  v_break_minutes integer; v_date date; v_start time; v_end time;
  v_new_id uuid; v_shift_id uuid;
begin
  if p_owner is null then raise exception 'INVALID_OWNER'; end if;

  -- Employee must belong to this owner and be active. p_owner is the owner resolved server-side
  -- from the kiosk actor's app_metadata — never client input.
  select e.name into v_name
    from public.employees e
   where e.id = p_employee_id and e.user_id = p_owner and e.status = 'active';
  if v_name is null then raise exception 'EMPLOYEE_NOT_FOUND'; end if;

  -- Same advisory-lock key as the badge path — serialize all actions for this employee.
  perform pg_advisory_xact_lock(hashtextextended(p_employee_id::text, 0));

  -- Current open session (locked so a concurrent punch can't slip through).
  select * into v_entry
    from public.employee_time_entries
   where employee_id = p_employee_id and user_id = p_owner and clocked_out_at is null
   for update;
  v_has_open := found;
  if v_has_open then
    v_on_break := exists (select 1 from public.employee_time_breaks
                          where time_entry_id = v_entry.id and ended_at is null);
  end if;

  if p_action = 'clock_in' then
    if v_has_open then raise exception 'ALREADY_CLOCKED_IN'; end if;
    begin
      insert into public.employee_time_entries (user_id, employee_id, clocked_in_at, status, punch_method)
        values (p_owner, p_employee_id, v_now, 'open', p_punch_method)
        returning id into v_new_id;
    exception when unique_violation then          -- one-open-per-employee guard
      raise exception 'ALREADY_CLOCKED_IN';
    end;
    return jsonb_build_object('result', 'clocked_in', 'state', 'working',
      'employee_name', v_name, 'at', v_now, 'entry_id', v_new_id);

  elsif p_action = 'start_break' then
    if not v_has_open then raise exception 'NOT_CLOCKED_IN'; end if;
    if v_on_break then raise exception 'ALREADY_ON_BREAK'; end if;
    begin
      insert into public.employee_time_breaks (user_id, employee_id, time_entry_id, started_at)
        values (p_owner, p_employee_id, v_entry.id, v_now);
    exception when unique_violation then          -- one-open-break-per-entry guard
      raise exception 'ALREADY_ON_BREAK';
    end;
    update public.employee_time_entries set status = 'on_break' where id = v_entry.id;
    return jsonb_build_object('result', 'break_started', 'state', 'on_break',
      'employee_name', v_name, 'at', v_now);

  elsif p_action = 'end_break' then
    if not v_has_open then raise exception 'NOT_CLOCKED_IN'; end if;
    if not v_on_break then raise exception 'NOT_ON_BREAK'; end if;
    update public.employee_time_breaks set ended_at = v_now
      where time_entry_id = v_entry.id and ended_at is null;
    update public.employee_time_entries set status = 'open' where id = v_entry.id;
    return jsonb_build_object('result', 'break_ended', 'state', 'working',
      'employee_name', v_name, 'at', v_now);

  elsif p_action = 'clock_out' then
    if not v_has_open then raise exception 'NOT_CLOCKED_IN'; end if;
    if v_on_break then raise exception 'BREAK_OPEN'; end if;

    select coalesce(sum(
             extract(epoch from (date_trunc('minute', ended_at) - date_trunc('minute', started_at))) / 60)::int, 0)
      into v_break_minutes
      from public.employee_time_breaks where time_entry_id = v_entry.id and ended_at is not null;

    v_date  := (v_entry.clocked_in_at at time zone v_tz)::date;
    v_start := date_trunc('minute', (v_entry.clocked_in_at at time zone v_tz))::time;
    v_end   := date_trunc('minute', (v_now at time zone v_tz))::time;

    -- punch_method is NOT written onto the shift (parity with 092); it stays on the entry.
    insert into public.shifts (
      user_id, employee_id, date, start_time, end_time, break_minutes, source, confirmed_at,
      clock_in_at, clock_out_at
    ) values (
      p_owner, v_entry.employee_id, v_date, v_start, v_end, v_break_minutes, 'time_clock', null,
      v_entry.clocked_in_at, v_now
    ) returning id into v_shift_id;

    update public.employee_time_entries
       set clocked_out_at = v_now, status = 'closed', shift_id = v_shift_id
     where id = v_entry.id;

    return jsonb_build_object('result', 'clocked_out', 'state', 'clocked_out',
      'employee_name', v_name, 'at', v_now, 'shift_id', v_shift_id);

  else
    raise exception 'INVALID_ACTION';
  end if;
end;
$body$;

revoke execute on function public.lensed_kiosk_manual_punch_as(uuid, uuid, text, text) from public, anon, authenticated;
grant  execute on function public.lensed_kiosk_manual_punch_as(uuid, uuid, text, text) to service_role;

commit;
