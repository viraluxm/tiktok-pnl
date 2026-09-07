-- 130 — Atomic, overlap-guarded creation of a MANUAL WORKED shift.
--
-- WHY THIS EXISTS
-- ---------------
-- `shifts` had NO protection against creating a second payable row over time an employee is
-- already paid for. Production already carries 12 overlapping employee/day pairs, every one of
-- them a `manual` row sitting on top of a `time_clock` punch at exact pattern times (06:00–14:00,
-- 16:00–02:00) — the signature of a manager hand-entering "worked" time from the schedule for a
-- day that already had a punch. Putting that same action behind a one-click "Add Worked Time"
-- button on the day card would industrialise the bug, so the button does not ship without a guard.
--
-- WHY NOT A UNIQUE INDEX, AND WHY NOT AN EXCLUSION CONSTRAINT
-- -----------------------------------------------------------
--   * UNIQUE (employee_id, date) — cannot be created (26 live groups already violate it) and is
--     the WRONG PREDICATE anyway: split shifts are legitimate and daily here (05:56–14:00 plus
--     16:55–01:00 is one person, two shifts, no double pay). The correct predicate is OVERLAP.
--   * EXCLUDE USING gist (... WITH &&) — the right predicate, but it needs the `btree_gist`
--     extension (verified NOT INSTALLED) and, decisively, a table-level constraint is validated
--     against EXISTING ROWS: it could not be created at all until the 12 historical overlaps were
--     resolved, which is a payroll decision about hours already paid, not a deploy step. This
--     migration is deliberately deployable while those rows still exist — it constrains only NEW
--     writes and reads history without judging it.
--
-- So the guard is an atomic creation function instead. It is race-safe because the overlap read
-- and the INSERT happen in ONE transaction under a per-employee advisory lock; PostgREST runs
-- each request in a single transaction, so the lock is held for the whole call and released on
-- commit. Two managers saving simultaneously serialize: one inserts, the other re-reads the row
-- the first just wrote and is refused.
--
-- SCOPE OF THE GUARANTEE (stated honestly): this protects every path in the app, because
-- useShifts.addShift — the ONLY client-side INSERT into `shifts` — now goes through it, which
-- covers both the new card button and the older Advanced "Worked / Missed Punch" lane. It is NOT
-- a table-level constraint: RLS still permits an owner to POST a row straight to /rest/v1/shifts.
-- Closing that would require the EXCLUDE constraint above, and therefore the historical-overlap
-- cleanup first.
--
-- WHAT THIS DOES NOT DO
-- ---------------------
-- No fabricated punch: clock_in_at / clock_out_at stay NULL, `source` takes the column default
-- 'manual', and employee_time_entries / employee_time_breaks / clock_audit are never touched.
-- confirmed_at / confirmed_by are never written (070's BEFORE UPDATE guard still owns them, and a
-- manual row is payable with confirmed_at NULL — the manager entering it IS the approval).
-- Scheduled shifts are untouched: they live in `shift_instances` and do not come through here.

begin;

-- The interval a shift OCCUPIES, in LA wall-clock space, as a half-open range.
--
-- HALF-OPEN '[)' IS THE PRODUCT RULE: 06:00–10:00 followed by 10:00–14:00 is a legitimate split
-- shift and must stay allowed, so touching endpoints do NOT overlap. 06:00–14:00 against
-- 13:00–17:00 shares an hour and DOES.
--
-- The two branches mirror paidShiftHours() (src/lib/employees.ts) exactly rather than inventing a
-- second interval model:
--   * time_clock WITH instants → the instants, which are what pay reads. Converting with
--     `at time zone` yields the LA-local naive timestamp, directly comparable with the wall-clock
--     branch, and unlike start_time/end_time it has no 24-hour ceiling — a 26-hour forgotten
--     clock-out reads as 26 hours here instead of wrapping to 2 and hiding a real conflict.
--   * everything else (manual rows, and any punch missing instants) → date + time-of-day, with
--     `end <= start` rolling into the next day. That is the same overnight rule as shiftHours()
--     and isOvernight().
-- A NULL upper bound is UNBOUNDED, which is what an OPEN shift (no clock-out yet) means: it
-- conflicts with anything starting after it, and cannot be quietly paved over.
-- LEAST/GREATEST normalises an inverted instant pair defensively — bad data must not raise
-- "range lower bound must be less than or equal to range upper bound" inside a payroll write.
create or replace function public.lensed_shift_wall_range(
  p_source text,
  p_date date,
  p_start_time time,
  p_end_time time,
  p_clock_in_at timestamptz,
  p_clock_out_at timestamptz
) returns tsrange
language sql
immutable
set search_path = public
as $$
  with b as (
    select
      case
        when p_source = 'time_clock' and p_clock_in_at is not null and p_clock_out_at is not null
          then (p_clock_in_at at time zone 'America/Los_Angeles')
        else p_date::timestamp + p_start_time
      end as lo,
      case
        when p_end_time is null then null::timestamp
        when p_source = 'time_clock' and p_clock_in_at is not null and p_clock_out_at is not null
          then (p_clock_out_at at time zone 'America/Los_Angeles')
        else p_date::timestamp + p_end_time
             + (case when p_end_time <= p_start_time then interval '1 day' else interval '0' end)
      end as up
  )
  select case
           when b.up is null then tsrange(b.lo, null, '[)')
           else tsrange(least(b.lo, b.up), greatest(b.lo, b.up), '[)')
         end
  from b;
$$;

comment on function public.lensed_shift_wall_range(text, date, time, time, timestamptz, timestamptz)
  is 'The LA wall-clock interval a shift occupies, half-open so split shifts do not collide. '
     'Mirrors paidShiftHours() branch-for-branch; NULL upper = open shift = unbounded.';

-- Create ONE manual, payable worked shift — refusing to create worked time that overlaps worked
-- time the employee already has.
--
-- SECURITY INVOKER (the convention every user-session RPC here uses, e.g. 071's confirm RPCs):
-- the function runs as the caller, so RLS on `shifts` applies to its reads and its INSERT, and
-- `auth.uid()` is the owner. Nothing is escalated. Ownership is ALSO asserted explicitly on every
-- statement rather than left to RLS alone.
create or replace function public.lensed_create_manual_worked_shift(
  p_employee_id uuid,
  p_date date,
  p_start_time time,
  p_end_time time default null,
  p_break_minutes integer default 0
) returns public.shifts
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_owner      uuid := auth.uid();
  v_break      integer := coalesce(p_break_minutes, 0);
  v_new        tsrange;
  v_span_min   numeric;
  v_conflict   uuid;
  v_row        public.shifts;
begin
  if v_owner is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '28000';
  end if;
  if p_employee_id is null or p_date is null or p_start_time is null then
    raise exception 'MISSING_REQUIRED_FIELD' using errcode = '22023';
  end if;

  -- Same invariant as the merged break editor (buildShiftEditPatch): a whole number of minutes,
  -- 0 or more. The upper bound is checked below, once the span is known.
  if v_break < 0 then
    raise exception 'BREAK_INVALID' using errcode = '22023';
  end if;

  -- The employee must be one of the caller's own.
  if not exists (
    select 1 from public.employees e
    where e.id = p_employee_id and e.user_id = v_owner
  ) then
    raise exception 'EMPLOYEE_NOT_FOUND' using errcode = '42501';
  end if;

  -- SERIALIZE on the EMPLOYEE, not on (employee, date). An overnight shift occupies two calendar
  -- dates, so a day-scoped lock would let a 17:00–01:00 create on Monday and a 00:00–08:00 create
  -- on Tuesday take different locks and both pass while genuinely overlapping. Transaction-scoped:
  -- released at commit or rollback, never leaked. Contention is a manager typing, not a workload.
  perform pg_advisory_xact_lock(hashtextextended(p_employee_id::text, 0));

  -- The interval being created. A manual row never carries instants, so it always takes the
  -- wall-clock branch — passing NULLs is not a shortcut, it is the truth about the row.
  v_new := public.lensed_shift_wall_range('manual', p_date, p_start_time, p_end_time, null, null);

  if not upper_inf(v_new) then
    v_span_min := extract(epoch from (upper(v_new) - lower(v_new))) / 60.0;
    -- A break equal to the span pays zero, and longer pays zero too (paidShiftHours floors at 0),
    -- so both are refused here rather than silently creating an unpaid shift.
    if v_break >= v_span_min then
      raise exception 'BREAK_TOO_LONG' using errcode = '22023';
    end if;
  end if;

  -- Does this overlap worked time the employee already has?
  --
  -- source_rule_id IS NOT NULL rows are excluded because they are the frozen PLAN, never payable
  -- (isPayableShift drops them for the same reason) — blocking against a plan row would refuse
  -- exactly the correction this feature exists to make.
  --
  -- Unconfirmed time_clock rows ARE included. An unconfirmed punch is still real worked time and
  -- becomes payable the moment a manager confirms it; refusing to let a manual row be stacked on
  -- top of one is the entire point.
  --
  -- The ±1 day window is what makes overnight correct: a shift stored on p_date − 1 that runs past
  -- midnight occupies part of p_date, and one stored on p_date + 1 cannot, but is scanned anyway
  -- so the predicate — not the date arithmetic — decides.
  select c.id into v_conflict
  from (
    select s.id,
           public.lensed_shift_wall_range(
             s.source, s.date, s.start_time, s.end_time, s.clock_in_at, s.clock_out_at
           ) as rng
    from public.shifts s
    where s.user_id = v_owner
      and s.employee_id = p_employee_id
      and s.source_rule_id is null
      and s.date between (p_date - 1) and (p_date + 1)
  ) c
  where c.rng && v_new
  limit 1;

  if v_conflict is not null then
    raise exception 'WORKED_TIME_OVERLAP' using errcode = '23P01';
  end if;

  -- `source` is left to the column default ('manual'), and the instants are left NULL: this row
  -- records what the manager says happened, not a punch that never occurred.
  insert into public.shifts (user_id, employee_id, date, start_time, end_time, break_minutes)
  values (v_owner, p_employee_id, p_date, p_start_time, p_end_time, v_break)
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.lensed_create_manual_worked_shift(uuid, date, time, time, integer)
  is 'Atomically create a manual payable worked shift, refusing overlap with existing worked '
     'time for that employee. Per-employee advisory lock makes concurrent creates serialize.';

-- Called from a user session (useShifts.addShift) — CONVENTIONS.md requires the explicit grant.
grant execute on function public.lensed_create_manual_worked_shift(uuid, date, time, time, integer)
  to authenticated;
grant execute on function public.lensed_shift_wall_range(text, date, time, time, timestamptz, timestamptz)
  to authenticated;

commit;
