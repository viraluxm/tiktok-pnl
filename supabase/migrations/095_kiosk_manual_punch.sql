-- 095_kiosk_manual_punch.sql
-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- AS-APPLIED RECORD — applied to live 2026-08-13 via the Supabase Management API. Additive:
-- creates ONE function and its grants; touches NO capture or order-sync tables, so the
-- write-silence gate does not apply (same reasoning as 092). Grants verified by direct
-- pg_proc/information_schema query after apply. DO NOT REPLAY — create-or-replace makes a
-- re-run harmless, but this file records applied state.
-- ═══════════════════════════════════════════════════════════════════════════════════════════
--
-- lensed_kiosk_manual_punch_as(p_owner, p_employee_id, p_action) — SUPERVISOR-OVERRIDE punch for
-- the badge kiosk when an employee's badge is lost/unusable (a lost badge must not make someone
-- unclockable). Writes punch_method='tap' — a supervisor override is NOT a badge scan, and
-- punch_method is the ONLY attribution that matters here (there is a single actor class, the kiosk
-- account; badge vs tap is the distinction we keep). No separate audit table.
--
-- WHY _as / service_role: the badge kiosk runs as a dedicated login account, not the owner, so the
-- owner cannot come from auth.uid(). It is passed explicitly (p_owner), resolved server-side in the
-- route from the actor's app_metadata — NEVER from client input. SECURITY DEFINER + service_role
-- ONLY (never anon, never authenticated), same as the 091/092 lensed_kiosk_* RPCs.
--
-- WHY duplicated in SQL (not a call into the badge RPCs, not TS): the live lensed_kiosk_* RPCs are
-- keyed on (kiosk_token, badge) — a manual override has neither. This function therefore reuses the
-- SAME MECHANISMS in-database — the same advisory-lock key (hashtextextended(employee_id,0)), the
-- same one-open-per-employee guard (the idx_time_entries_one_open_per_employee unique index, caught
-- as ALREADY_CLOCKED_IN), the same one-open-break guard (idx_time_breaks_one_open_per_entry), and
-- the same America/Los_Angeles minute-truncated shift materialization as the 092 clock_out (which
-- does NOT write punch_method onto the shift). The punch state machine is NEVER reimplemented in
-- application code.
--
-- No 60s rescan guard: a manual punch is a deliberate supervisor action, not a scan.
-- p_action in ('clock_in','start_break','end_break','clock_out'). Error tokens mirror 071/091 so the
-- kiosk client can compose friendly messages. A single manual action never chains (no auto clock-in
-- on an end_break, etc.) — the supervisor picks exactly one action.

create or replace function public.lensed_kiosk_manual_punch_as(
  p_owner uuid, p_employee_id uuid, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
        values (p_owner, p_employee_id, v_now, 'open', 'tap')
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
      user_id, employee_id, date, start_time, end_time, break_minutes, source, confirmed_at
    ) values (
      p_owner, v_entry.employee_id, v_date, v_start, v_end, v_break_minutes, 'time_clock', null
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
$$;

-- GRANTS — service_role ONLY (called exclusively via createAdminClient().rpc()). anon/authenticated
-- explicitly revoked so a leaked route or session cannot call it directly.
revoke execute on function public.lensed_kiosk_manual_punch_as(uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.lensed_kiosk_manual_punch_as(uuid, uuid, text) to service_role;
