-- 092_kiosk_clock_out_drop_shift_punch_method.sql
-- Reconciliation on top of 091 (which is ALREADY fully applied to live in its original form).
--
-- WHAT THIS CHANGES: the badge clock-out RPC stops writing punch_method onto the shift row it
-- materializes. A NULL shifts.punch_method is ambiguous — it can't be told apart from a
-- manual/scheduled shift, a tap-surface punch, or a badge-in closed by the admin kiosk. The honest
-- label lives on employee_time_entries.punch_method (the raw entry, NOT NULL default 'tap'), which
-- is the source of truth; read punch method by joining the shift's originating entry
-- (employee_time_entries.shift_id = shifts.id), never off the shift row.
--
-- SCOPE: create-or-replace of the three lensed_kiosk_* RPCs only. lensed_kiosk_scan and
-- lensed_kiosk_start_break bodies are UNCHANGED from 091/live (reproduced verbatim so this file is a
-- complete, self-contained statement of the current RPC set); lensed_kiosk_clock_out drops the
-- punch_method column + value from its INSERT into shifts. Grants re-asserted service_role ONLY.
--
-- ORPHANED, LEFT IN PLACE PENDING A SEPARATE DECISION (NOT touched here):
--   * shifts.punch_method column (nullable) + shifts_punch_method_check constraint — as of this
--     migration all 187 shifts rows are NULL; nothing reads the column. No DROP COLUMN on a payroll
--     table without separate approval.
--   * idx_employee_badges_active_code / idx_kiosk_tokens_active_token — partial UNIQUE(code|token)
--     WHERE active. Redundant with the global UNIQUE(code|token) already on each table (codes/tokens
--     are revoked, never reused), but harmless; left for a later cleanup decision.
-- These four objects remain on live exactly as 091 created them.
--
-- Idempotent: create-or-replace + revoke/grant are safe to re-run. Not wrapped in a txn (parity with
-- 091's function DDL style).

-- SCAN — unchanged from 091. Single-scan entrypoint; can clock IN and END A BREAK, never clocks out.
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

-- START BREAK — unchanged from 091. Requires an open session not already on break.
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

-- CLOCK OUT — CHANGED. Closes the session and materializes ONE unconfirmed time_clock shift.
-- punch_method is NO LONGER written to the shift row; it stays on the source time entry (see header).
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

  -- punch_method intentionally OMITTED from this INSERT (see header). It remains on v_entry.
  insert into public.shifts (
    user_id, employee_id, date, start_time, end_time, break_minutes, source, confirmed_at
  ) values (
    v_owner, v_entry.employee_id, v_date, v_start, v_end, v_break_minutes, 'time_clock', null
  ) returning id into v_shift_id;

  update public.employee_time_entries
     set clocked_out_at = v_now, status = 'closed', shift_id = v_shift_id
   where id = v_entry.id;

  return jsonb_build_object('result', 'clocked_out', 'state', 'clocked_out',
    'employee_name', v_name, 'at', v_now, 'shift_id', v_shift_id);
end;
$$;

-- GRANTS — service_role ONLY, re-asserted (parity with 091).
revoke execute on function public.lensed_kiosk_scan(text, text)        from public, anon, authenticated;
revoke execute on function public.lensed_kiosk_start_break(text, text) from public, anon, authenticated;
revoke execute on function public.lensed_kiosk_clock_out(text, text)   from public, anon, authenticated;

grant execute on function public.lensed_kiosk_scan(text, text)        to service_role;
grant execute on function public.lensed_kiosk_start_break(text, text) to service_role;
grant execute on function public.lensed_kiosk_clock_out(text, text)   to service_role;

-- Mark the orphaned column deprecated in-schema (it is retained, NOT dropped — see header).
comment on column public.shifts.punch_method is
  'DEPRECATED - never written. Orphaned by migration 092. NULL on all rows
     and carries no meaning; do not read it. Punch method lives on
     employee_time_entries.punch_method. Column retained rather than dropped
     to avoid a destructive DDL on a payroll table.';
