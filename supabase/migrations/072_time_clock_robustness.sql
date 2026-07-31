-- 072_time_clock_robustness.sql
-- Fix three punch bugs found before kiosk adoption (see src/lib/employees.ts paidShiftHours +
-- the reconcile cron). All additive/idempotent.
--
--   #2 REAL SPAN: clock-out stored only the clock-in DATE + local time-of-day, so pay derived
--      hours via shiftHours()'s midnight wrap — which UNDERCOUNTS any span > 24h (a 26h shift
--      computed as 2h). Store the actual instants and let pay use the true span.
--   #1 UNCLOSED PUNCH: a forgotten clock-out leaves an OPEN entry. We do NOT invent a clock-out
--      (any capped time is a guess — genuine shifts top out ~10.5h, so a stamped default would be
--      fabricated hours). Instead the reconciler FLAGS the entry needs_manual_close and leaves it
--      open: no shift row, excluded from pay, loud until a human closes it with the real time.
--      Deliberate auto-closes (a manager choosing to cap one) still exist and still set the shift
--      auto_closed flag → badge + confirm gate in the UI; the reconciler just never does it silently.
--   #3 ORPHANED CLOSED PUNCH: lensed_clock_out is the ONLY shift creator and is atomic — a punch
--      closed by any other path (or before that RPC shipped) orphans (shift_id NULL) and, with no
--      trigger/cron backstop, is lost forever. The reconciler backfills the missing shift.

-- ── #2: real span + the auto-close review flag ──────────────────────────────────────────────
alter table public.shifts
  add column if not exists clock_in_at  timestamptz,
  add column if not exists clock_out_at timestamptz,
  add column if not exists auto_closed  boolean not null default false;

-- ── #1: needs-manual-close flag on the raw punch (set by the reconciler, cleared on real close) ──
alter table public.employee_time_entries
  add column if not exists needs_manual_close boolean not null default false;

comment on column public.employee_time_entries.needs_manual_close is
  'reconciler flag: an open punch left past the plausible-shift cap. NOT auto-closed (would fabricate '
  'hours) — stays open + out of pay until a human clocks it out with the real time, which clears this.';

comment on column public.shifts.clock_in_at is
  'time_clock shifts: real clock-in instant — the source of truth for worked hours; start_time/end_time stay display-only local time';
comment on column public.shifts.clock_out_at is 'time_clock shifts: real clock-out instant';
comment on column public.shifts.auto_closed is
  'true when a forgotten/over-long open punch was auto-closed by the reconciler — FLAGGED for manager review';

-- ── #2: clock-out now records the real instants alongside the display times ──────────────────
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
    raise exception 'NOT_CLOCKED_IN';
  end if;

  if exists (
    select 1 from public.employee_time_breaks
    where time_entry_id = v_entry.id and ended_at is null
  ) then
    raise exception 'BREAK_OPEN';
  end if;

  select coalesce(sum(
           extract(epoch from (date_trunc('minute', ended_at) - date_trunc('minute', started_at))) / 60
         )::int, 0)
    into v_break_minutes
    from public.employee_time_breaks
   where time_entry_id = v_entry.id and ended_at is not null;

  -- Display-only wall-clock fields (unchanged). The AUTHORITATIVE span is the two instants below.
  v_date  := (v_entry.clocked_in_at at time zone v_tz)::date;
  v_start := date_trunc('minute', (v_entry.clocked_in_at at time zone v_tz))::time;
  v_end   := date_trunc('minute', (v_now at time zone v_tz))::time;

  insert into public.shifts (
    user_id, employee_id, date, start_time, end_time, break_minutes, source, confirmed_at,
    clock_in_at, clock_out_at
  ) values (
    v_user, v_entry.employee_id, v_date, v_start, v_end, v_break_minutes, 'time_clock', null,
    v_entry.clocked_in_at, v_now
  ) returning id into v_shift_id;

  update public.employee_time_entries
     set clocked_out_at = v_now, status = 'closed', shift_id = v_shift_id,
         needs_manual_close = false  -- a real close resolves any prior reconciler flag
   where id = v_entry.id;

  return jsonb_build_object('entry_id', v_entry.id, 'status', 'closed', 'shift_id', v_shift_id);
end;
$$;

-- ── #1 + #3: reconciler — auto-close stale open punches, backfill orphaned closed punches ─────
-- SECURITY DEFINER: runs from the cron with no auth.uid(); acts across all users. Idempotent.
-- Default cap 11h: genuine shifts top out at ~10.5h (max closed punch 10.52h; live_sessions p95
-- 9.94h). Past that an open punch is almost certainly a forgotten clock-out, not real work.
create or replace function public.lensed_reconcile_time_clock(p_max_open_hours int default 11)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tz constant text := 'America/Los_Angeles';
  v_now timestamptz := now();
  v_flagged int := 0;
  v_backfilled int := 0;
  r record;
  v_break int;
  v_shift_id uuid;
begin
  -- (a) FLAG, DON'T STAMP: an open punch past the cap gets needs_manual_close = true and is LEFT
  --     OPEN. No clock-out is invented (that would fabricate hours), no shift row is created, so it
  --     stays out of pay and loud in the kiosk until a human closes it with the real time. Only
  --     transition false→true so we never re-flag / thrash an entry already flagged.
  update public.employee_time_entries
     set needs_manual_close = true
   where clocked_out_at is null
     and needs_manual_close = false
     and clocked_in_at < v_now - make_interval(hours => p_max_open_hours);
  get diagnostics v_flagged = row_count;

  -- (b) BACKFILL closed punches with no shift → create the missing shift and link it.
  for r in
    select * from public.employee_time_entries
     where clocked_out_at is not null and shift_id is null
     for update skip locked
  loop
    select coalesce(sum(extract(epoch from (date_trunc('minute', ended_at) - date_trunc('minute', started_at))) / 60)::int, 0)
      into v_break from public.employee_time_breaks where time_entry_id = r.id and ended_at is not null;
    insert into public.shifts (
      user_id, employee_id, date, start_time, end_time, break_minutes, source, confirmed_at,
      clock_in_at, clock_out_at, auto_closed
    ) values (
      r.user_id, r.employee_id, (r.clocked_in_at at time zone v_tz)::date,
      date_trunc('minute', (r.clocked_in_at at time zone v_tz))::time,
      date_trunc('minute', (r.clocked_out_at at time zone v_tz))::time,
      v_break, 'time_clock', null, r.clocked_in_at, r.clocked_out_at, false
    ) returning id into v_shift_id;
    update public.employee_time_entries set shift_id = v_shift_id where id = r.id;
    v_backfilled := v_backfilled + 1;
  end loop;

  return jsonb_build_object('flagged', v_flagged, 'backfilled', v_backfilled);
end;
$$;
