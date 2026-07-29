-- 071_time_clock_rpcs.sql
-- The transactional server mutations behind the time-clock kiosk: four attendance actions
-- (clock in / start break / end break / clock out) plus the two manager confirmation gates
-- (confirm / unconfirm). These are the ONLY sanctioned write path — the browser never inserts
-- punches, never sends a timestamp or timezone, and never sets source/confirmed_at/confirmed_by.
-- Each attendance function:
--   1. authenticates (auth.uid()); 2. serializes per-employee via an advisory xact lock;
--   3. validates the employee is the caller's (and active, for clock-in);
--   4. row-locks the employee's OPEN session; 5. enforces the state machine;
--   6. stamps time on the SERVER (now()); 7. acts atomically; 8. returns the new state.
--
-- SECURITY INVOKER (default) — NOT definer: every row touched is the caller's own, so the
-- existing user_id RLS (044 + 070) already confines these to the caller's data. We keep
-- explicit `user_id = v_user` filters too (defense-in-depth), matching 064_lensed_unbind.
--
-- Errors are raised as STABLE TOKENS; the client composes the friendly, name-personalized
-- message (mirrors how useShifts maps 23505 -> a human string). The partial unique indexes
-- from 070 are the ultimate backstop for races (they surface as 23505 / unique_violation,
-- which we catch and re-raise as the matching token).
--
-- TIME MODEL: raw punches stay timestamptz. At clock-out the wall-clock shift row is derived
-- through the business timezone (America/Los_Angeles, SERVER-FIXED — the same zone the PnL
-- RPCs in 039/040 use), so a Vercel (UTC) server produces the correct local shift date + times.
-- The timezone is NOT a parameter: it is never client-supplied. Idempotent; safe to re-run.
--
-- ROUNDING: every punch is truncated to the whole minute (seconds dropped) before any duration
-- is computed — clock-in, clock-out, and each break endpoint alike — so seconds can never be
-- discarded inconsistently between start/end and breaks. This matches shiftHours()/parseTime.

-- ---------------------------------------------------------------------------
-- CLOCK IN — start a new work session. Requires: no open session; active employee.
-- ---------------------------------------------------------------------------
create or replace function public.lensed_clock_in(p_employee_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_entry public.employee_time_entries;
  v_new_id uuid;
begin
  if v_user is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '28000';
  end if;

  -- Serialize all clock actions for this employee within the transaction.
  perform pg_advisory_xact_lock(hashtextextended(p_employee_id::text, 0));

  -- Employee must exist, be owned by the caller, and be ACTIVE to clock in.
  if not exists (
    select 1 from public.employees e
    where e.id = p_employee_id and e.user_id = v_user and e.status = 'active'
  ) then
    raise exception 'EMPLOYEE_NOT_FOUND';
  end if;

  -- Already has an OPEN session? (lock it so a concurrent action can't slip through)
  select * into v_entry
    from public.employee_time_entries
   where employee_id = p_employee_id and user_id = v_user and clocked_out_at is null
   for update;
  if found then
    raise exception 'ALREADY_CLOCKED_IN';
  end if;

  begin
    insert into public.employee_time_entries (user_id, employee_id, clocked_in_at, status)
      values (v_user, p_employee_id, now(), 'open')
      returning id into v_new_id;
  exception when unique_violation then
    -- Lost a race: the one-open-session-per-employee guard index rejected this insert.
    raise exception 'ALREADY_CLOCKED_IN';
  end;

  return jsonb_build_object('entry_id', v_new_id, 'status', 'open', 'shift_id', null);
end;
$$;

-- ---------------------------------------------------------------------------
-- START BREAK — requires an open session that is NOT already on break.
-- ---------------------------------------------------------------------------
create or replace function public.lensed_start_break(p_employee_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_entry public.employee_time_entries;
  v_break_id uuid;
begin
  if v_user is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '28000';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_employee_id::text, 0));

  select * into v_entry
    from public.employee_time_entries
   where employee_id = p_employee_id and user_id = v_user and clocked_out_at is null
   for update;
  if not found then
    raise exception 'NOT_CLOCKED_IN';
  end if;

  if exists (
    select 1 from public.employee_time_breaks
    where time_entry_id = v_entry.id and ended_at is null
  ) then
    raise exception 'ALREADY_ON_BREAK';
  end if;

  begin
    insert into public.employee_time_breaks (user_id, employee_id, time_entry_id, started_at)
      values (v_user, p_employee_id, v_entry.id, now())
      returning id into v_break_id;
  exception when unique_violation then
    raise exception 'ALREADY_ON_BREAK';
  end;

  update public.employee_time_entries set status = 'on_break' where id = v_entry.id;

  return jsonb_build_object('entry_id', v_entry.id, 'status', 'on_break', 'shift_id', null);
end;
$$;

-- ---------------------------------------------------------------------------
-- END BREAK — requires an open session with an active (unfinished) break.
-- ---------------------------------------------------------------------------
create or replace function public.lensed_end_break(p_employee_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_entry public.employee_time_entries;
  v_break_id uuid;
begin
  if v_user is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '28000';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_employee_id::text, 0));

  select * into v_entry
    from public.employee_time_entries
   where employee_id = p_employee_id and user_id = v_user and clocked_out_at is null
   for update;
  if not found then
    raise exception 'NOT_CLOCKED_IN';
  end if;

  -- Lock the open break (there is at most one, per the guard index).
  select id into v_break_id
    from public.employee_time_breaks
   where time_entry_id = v_entry.id and ended_at is null
   for update;
  if not found then
    raise exception 'NO_ACTIVE_BREAK';
  end if;

  update public.employee_time_breaks set ended_at = now() where id = v_break_id;
  update public.employee_time_entries set status = 'open' where id = v_entry.id;

  return jsonb_build_object('entry_id', v_entry.id, 'status', 'open', 'shift_id', null);
end;
$$;

-- ---------------------------------------------------------------------------
-- CLOCK OUT — close the session AND create exactly one unconfirmed time_clock shift.
-- Requires an open session with NO active break (the employee must end the break first).
-- ---------------------------------------------------------------------------
create or replace function public.lensed_clock_out(p_employee_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_entry public.employee_time_entries;
  v_now timestamptz := now();
  -- Business timezone is SERVER-FIXED, never client-supplied. The whole app derives local
  -- dates/times through America/Los_Angeles (finance/PnL RPCs 039/040 use the same zone).
  v_tz constant text := 'America/Los_Angeles';
  v_break_minutes integer;
  v_date date;
  v_start time;
  v_end time;
  v_shift_id uuid;
begin
  if v_user is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '28000';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_employee_id::text, 0));

  select * into v_entry
    from public.employee_time_entries
   where employee_id = p_employee_id and user_id = v_user and clocked_out_at is null
   for update;
  if not found then
    -- No open session: nothing to close. A duplicate/retried clock-out lands here and
    -- (crucially) creates NO second shift. The client refreshes state and shows "already
    -- recorded" rather than an error.
    raise exception 'NOT_CLOCKED_IN';
  end if;

  -- Must not leave an open break dangling.
  if exists (
    select 1 from public.employee_time_breaks
    where time_entry_id = v_entry.id and ended_at is null
  ) then
    raise exception 'BREAK_OPEN';
  end if;

  -- Total unpaid break minutes. ONE rounding rule everywhere: truncate each punch to the
  -- whole minute (date_trunc) BEFORE differencing, so seconds are dropped identically on
  -- break starts, break ends, clock-in and clock-out — never a differential over/underpay.
  -- All breaks are closed here (open ones were rejected above).
  select coalesce(sum(
           extract(epoch from (date_trunc('minute', ended_at) - date_trunc('minute', started_at))) / 60
         )::int, 0)
    into v_break_minutes
    from public.employee_time_breaks
   where time_entry_id = v_entry.id and ended_at is not null;

  -- Derive the wall-clock shift row through the business timezone, truncated to the minute
  -- (same rule as the breaks). The INSTANT is the server's; the timezone only decides which
  -- local date/time it maps to. Date follows the CLOCK-IN day (overnight shifts keep it).
  v_date  := (v_entry.clocked_in_at at time zone v_tz)::date;
  v_start := date_trunc('minute', (v_entry.clocked_in_at at time zone v_tz))::time;
  v_end   := date_trunc('minute', (v_now at time zone v_tz))::time;

  -- Exactly one shift, always with an end_time (never an "open" shift), source=time_clock,
  -- and UNCONFIRMED (confirmed_at NULL) so pay excludes it until a manager confirms.
  insert into public.shifts (
    user_id, employee_id, date, start_time, end_time, break_minutes, source, confirmed_at
  ) values (
    v_user, v_entry.employee_id, v_date, v_start, v_end, v_break_minutes, 'time_clock', null
  ) returning id into v_shift_id;

  update public.employee_time_entries
     set clocked_out_at = v_now, status = 'closed', shift_id = v_shift_id
   where id = v_entry.id;

  return jsonb_build_object('entry_id', v_entry.id, 'status', 'closed', 'shift_id', v_shift_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- CONFIRM — the MANAGER approval gate for a time-clock shift. Server-authoritative: the
-- browser sends only the shift id; confirmed_at (now()) and confirmed_by (auth.uid()) are
-- set here, never by the client. The BEFORE UPDATE guard on shifts (migration 070) rejects
-- any OTHER path that tries to change those columns, so these RPCs are the only way in.
-- ---------------------------------------------------------------------------
create or replace function public.lensed_confirm_time_clock_shift(p_shift_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_shift public.shifts;
  v_entry public.employee_time_entries;
begin
  if v_user is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '28000';
  end if;

  -- Own the shift; it must be a COMPLETED time-clock shift.
  select * into v_shift from public.shifts
    where id = p_shift_id and user_id = v_user
    for update;
  if not found then raise exception 'SHIFT_NOT_FOUND'; end if;
  if v_shift.source <> 'time_clock' then raise exception 'SHIFT_NOT_TIME_CLOCK'; end if;
  if v_shift.end_time is null then raise exception 'SHIFT_NOT_CLOSED'; end if;

  -- The linked raw time entry must be CLOSED with no dangling break.
  select * into v_entry from public.employee_time_entries
    where shift_id = p_shift_id and user_id = v_user
    for update;
  if not found then raise exception 'TIME_ENTRY_NOT_FOUND'; end if;
  if v_entry.clocked_out_at is null or v_entry.status <> 'closed' then
    raise exception 'TIME_ENTRY_NOT_CLOSED';
  end if;
  if exists (
    select 1 from public.employee_time_breaks
    where time_entry_id = v_entry.id and ended_at is null
  ) then
    raise exception 'BREAK_OPEN';
  end if;

  -- Idempotent: confirming an already-confirmed shift is a no-op returning current state
  -- (safe against duplicate requests / double taps). Only the first confirm stamps the time.
  if v_shift.confirmed_at is null then
    perform set_config('lensed.confirm_ctx', 'on', true); -- unlock the guarded columns for THIS txn only
    update public.shifts set confirmed_at = now(), confirmed_by = v_user where id = p_shift_id;
    select * into v_shift from public.shifts where id = p_shift_id;
  end if;

  return jsonb_build_object(
    'id', v_shift.id, 'source', v_shift.source,
    'confirmed_at', v_shift.confirmed_at, 'confirmed_by', v_shift.confirmed_by
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- UNCONFIRM — clear the gate (also server-authoritative + guard-protected). Idempotent.
-- ---------------------------------------------------------------------------
create or replace function public.lensed_unconfirm_time_clock_shift(p_shift_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_shift public.shifts;
begin
  if v_user is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '28000';
  end if;

  select * into v_shift from public.shifts
    where id = p_shift_id and user_id = v_user
    for update;
  if not found then raise exception 'SHIFT_NOT_FOUND'; end if;
  if v_shift.source <> 'time_clock' then raise exception 'SHIFT_NOT_TIME_CLOCK'; end if;

  if v_shift.confirmed_at is not null or v_shift.confirmed_by is not null then
    perform set_config('lensed.confirm_ctx', 'on', true);
    update public.shifts set confirmed_at = null, confirmed_by = null where id = p_shift_id;
    select * into v_shift from public.shifts where id = p_shift_id;
  end if;

  return jsonb_build_object(
    'id', v_shift.id, 'source', v_shift.source,
    'confirmed_at', v_shift.confirmed_at, 'confirmed_by', v_shift.confirmed_by
  );
end;
$$;

-- Only authenticated sessions may call these (anon has no auth.uid() and is rejected).
grant execute on function public.lensed_clock_in(uuid)                    to authenticated;
grant execute on function public.lensed_start_break(uuid)                 to authenticated;
grant execute on function public.lensed_end_break(uuid)                   to authenticated;
grant execute on function public.lensed_clock_out(uuid)                   to authenticated;
grant execute on function public.lensed_confirm_time_clock_shift(uuid)    to authenticated;
grant execute on function public.lensed_unconfirm_time_clock_shift(uuid)  to authenticated;
