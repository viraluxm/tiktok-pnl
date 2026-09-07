-- 131_manual_worked_shift_rpc.sql — Atomic, overlap-guarded creation of a MANUAL WORKED shift.
--
-- ⚠️ NOT APPLIED. This DB has NO migration ledger — migrations are applied BY HAND and the repo
--    file is the only record, so a reused prefix is a real skip/double-apply hazard here.
--    ➜ RE-INSPECT THE LIVE SCHEMA BEFORE APPLYING.
--
--    RENUMBERED 130 → 131. Prefix 130 was taken by the separate Phase 2 scheduling migration
--    `130_schedule_phase2_attendance_and_cancel.sql`, which is ALREADY APPLIED TO PRODUCTION
--    (verified live: lensed_cancel_shift_offer exists). 129 is likewise live. 131 was free across
--    origin/main, every local and remote branch, and every worktree on disk at renumbering time.
--    Nothing about the SQL below changed with the rename.
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
-- No fabricated punch: clock_in_at / clock_out_at stay NULL and `source` takes the column default
-- 'manual'. employee_time_breaks and clock_audit are never referenced at all;
-- employee_time_entries is READ — and only read — because a punch that has not become a shift yet
-- is invisible in `shifts` and would otherwise be paved over (see the RAW PUNCH RACE block below).
-- Nothing here INSERTs, UPDATEs or DELETEs any punch row: raw punches are the auditable trail and
-- are never rewritten to make a correction fit.
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
  v_conflict_open boolean;
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
  -- NO DATE WINDOW. The range predicate alone decides which rows are candidates.
  --
  -- An earlier draft narrowed the scan to `s.date between p_date - 1 and p_date + 1`, reasoning
  -- that an overnight shift reaches at most one day past its own date. That is PROVABLE for
  -- wall-clock rows — `end <= start` adds exactly one day, so a row on D can never extend past
  -- D+2 00:00 — but it is FALSE for time_clock rows, and the difference is live data, not theory:
  --
  --   * a time_clock row's range comes from its INSTANTS, which have no 24-hour ceiling (that is
  --     deliberate — see 072: a 26-hour forgotten clock-out must read as 26 hours, not wrap to 2
  --     and hide a real conflict). Production currently holds FOUR punches over 24 hours, three of
  --     them 46–48 hours reaching TWO days past their own `date`. A shift dated 2026-08-24 with a
  --     47.75h span occupies 2026-08-26; a manual create for the 26th would never have scanned the
  --     24th, and the guard would have missed exactly the double-pay it exists to prevent.
  --   * an OPEN shift (end_time NULL) is unbounded by construction, so no finite window is right
  --     for it either.
  --
  -- Widening to ±2 or ±3 would just move the cliff. There is no product rule capping punch length,
  -- so the honest bound is "no bound" — filter by the employee and let `&&` answer. The cost is
  -- nil: this is already a per-employee scan (lensed_shift_wall_range is IMMUTABLE, not indexable),
  -- idx_shifts_employee serves the filter, and the worst-case employee in production has 46 rows.
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
  ) c
  where c.rng && v_new
  limit 1;

  if v_conflict is not null then
    raise exception 'WORKED_TIME_OVERLAP' using errcode = '23P01';
  end if;

  -- ── RAW PUNCH RACE. Scanning `shifts` alone is NOT sufficient. ─────────────────────────────
  --
  -- A time_clock `shifts` row does not exist while someone is on the clock — every writer
  -- (071 lensed_clock_out, 072's reconciler, 091/092/095/099's kiosk paths) creates it FROM an
  -- employee_time_entries row, derived from clocked_in_at/clocked_out_at. So an entry that has
  -- not produced its shift yet is invisible to the scan above, and the manual row would be
  -- created into a gap that a punch is about to fill:
  --
  --   06:00 employee clocks in            → entry OPEN, no shifts row exists
  --   10:00 manager adds manual 06–14     → overlap scan sees nothing, row created
  --   14:00 employee clocks out           → clock_out inserts time_clock 06–14 → DOUBLE PAID
  --
  -- The exact test for "will become a shift" is `shift_id IS NULL`. 071 sets shift_id at
  -- clock-out and 072(b) back-fills `clocked_out_at is not null and shift_id is null`, so:
  --   * shift_id NOT NULL → the shift already exists and the scan above already caught it;
  --   * shift_id NULL, still open      → becomes a shift at clock-out, end time UNKNOWABLE;
  --   * shift_id NULL, already closed  → an ORPHAN the reconciler will back-fill on its next run,
  --                                      at exactly [clocked_in_at, clocked_out_at).
  -- This is not hypothetical: production currently holds 21 such entries (5 open, 16 orphaned).
  --
  -- An OPEN entry is treated as UNBOUNDED — the same convention the range helper already uses for
  -- an open shift. We genuinely cannot know where the punch will end, so anything finishing after
  -- it started may collide. The refusal names the punch so the manager's next step is obvious:
  -- close it with the real time (the kiosk/manual-punch path), then record any correction.
  --
  -- READ-ONLY, BY CONSTRUCTION. This block only SELECTs. Nothing in this function inserts,
  -- updates or deletes employee_time_entries, employee_time_breaks or clock_audit — raw punches
  -- are the auditable trail and are never rewritten to make a correction fit.
  --
  -- Cheap: filtered by (user_id, employee_id, shift_id is null), which idx_time_entries_employee
  -- serves and which is at most a handful of rows per person (worst case 3 in production today).
  select e.id, (e.clocked_out_at is null)
    into v_conflict, v_conflict_open
  from public.employee_time_entries e
  where e.user_id = v_owner
    and e.employee_id = p_employee_id
    and e.shift_id is null
    and (
      case
        when e.clocked_out_at is null
          then tsrange((e.clocked_in_at at time zone 'America/Los_Angeles'), null, '[)')
        else tsrange(
               least(   (e.clocked_in_at  at time zone 'America/Los_Angeles'),
                        (e.clocked_out_at at time zone 'America/Los_Angeles')),
               greatest((e.clocked_in_at  at time zone 'America/Los_Angeles'),
                        (e.clocked_out_at at time zone 'America/Los_Angeles')), '[)')
      end
    ) && v_new
  limit 1;

  if v_conflict is not null then
    if v_conflict_open then
      -- Someone is on the clock right now over this interval.
      raise exception 'OPEN_PUNCH_CONFLICT' using errcode = '23P01';
    else
      -- A closed punch with no shift yet: the reconciler will turn it into payable time.
      raise exception 'UNRECONCILED_PUNCH_OVERLAP' using errcode = '23P01';
    end if;
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
