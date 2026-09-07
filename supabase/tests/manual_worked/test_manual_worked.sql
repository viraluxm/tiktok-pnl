-- DB proof for lensed_create_manual_worked_shift (migration 131).
--
-- The product rule under test: a manager may record worked time for someone who did not clock in,
-- but may NOT create worked time that overlaps worked time the person already has — while
-- legitimate SPLIT SHIFTS (two non-overlapping shifts in one day, which happen daily here) stay
-- perfectly legal. Runs as owner; the function's explicit auth.uid()/user_id filters do the
-- scoping, same convention as the timeclock harness. Any TEST_FAIL aborts under ON_ERROR_STOP=1.

\set U1  '11111111-1111-1111-1111-111111111111'
\set U2  '22222222-2222-2222-2222-222222222222'
\set E1  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
\set E2  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
\set EO  'dddddddd-dddd-dddd-dddd-dddddddddddd'
\set ER  'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
\set EF  'ffffffff-ffff-ffff-ffff-ffffffffffff'

insert into auth.users(id) values (:'U1'), (:'U2');
insert into public.employees(id, user_id, name, status) values
  (:'E1', :'U1', 'Elizabeth',        'active'),
  (:'E2', :'U1', 'Split-shift Sam',  'active'),
  (:'EO', :'U1', 'Overnight Nadia',  'active'),
  (:'ER', :'U1', 'Race Rosa',        'active'),
  (:'EF', :'U2', 'Other tenant Fay', 'active');

set test.user_id = '11111111-1111-1111-1111-111111111111';  -- act as U1

-- ── 1. Happy path: a legitimate manual payable shift, with no fabricated punch ───────────────
do $$ declare r public.shifts; begin
  r := public.lensed_create_manual_worked_shift(
         'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, '2026-09-06'::date,
         '17:00'::time, '01:00'::time, 0);
  if r.id is null then raise exception 'TEST_FAIL 1: no row returned'; end if;
  if r.source <> 'manual' then raise exception 'TEST_FAIL 1: source=% (expected manual)', r.source; end if;
  if r.source_rule_id is not null then raise exception 'TEST_FAIL 1: source_rule_id was set'; end if;
  if r.clock_in_at is not null or r.clock_out_at is not null then
    raise exception 'TEST_FAIL 1: FABRICATED PUNCH INSTANTS'; end if;
  if r.confirmed_at is not null or r.confirmed_by is not null then
    raise exception 'TEST_FAIL 1: confirmation was fabricated'; end if;
  if r.break_minutes <> 0 then raise exception 'TEST_FAIL 1: break=%', r.break_minutes; end if;
  if r.user_id <> '11111111-1111-1111-1111-111111111111'::uuid then
    raise exception 'TEST_FAIL 1: owner not derived from auth.uid()'; end if;
  raise notice 'PASS 1: creates a manual row with NO punch instants and NO confirmation';
end $$;

-- ── 2. The row is PAYABLE by the existing rule (isPayableShift's exact inputs) ───────────────
-- isPayableShift: not open (end_time not null), source_rule_id null, and not an unconfirmed
-- time_clock row. A manual row satisfies all three with confirmed_at NULL — the manager entering
-- it IS the approval. Asserted as the column shape pay reads, since pay itself is TS.
do $$ declare n int; begin
  select count(*) into n from public.shifts
   where employee_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
     and end_time is not null and source_rule_id is null
     and not (source = 'time_clock' and confirmed_at is null);
  if n <> 1 then raise exception 'TEST_FAIL 2: expected 1 payable-shaped row, got %', n; end if;
  raise notice 'PASS 2: the created row is payable under the existing rule, unconfirmed';
end $$;

-- ── 3. Raw clock history is untouched ───────────────────────────────────────────────────────
do $$ declare e int; b int; begin
  select count(*) into e from public.employee_time_entries;
  select count(*) into b from public.employee_time_breaks;
  if e <> 0 or b <> 0 then
    raise exception 'TEST_FAIL 3: fabricated raw punch rows (entries=%, breaks=%)', e, b; end if;
  raise notice 'PASS 3: no employee_time_entries / employee_time_breaks created';
end $$;

-- ── 4. An IDENTICAL interval is refused ─────────────────────────────────────────────────────
do $$ declare ok boolean := false; begin
  begin
    perform public.lensed_create_manual_worked_shift(
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, '2026-09-06'::date, '17:00'::time, '01:00'::time, 0);
  exception when others then ok := (sqlerrm = 'WORKED_TIME_OVERLAP');
    if not ok then raise exception 'TEST_FAIL 4: expected WORKED_TIME_OVERLAP, got %', sqlerrm; end if;
  end;
  if not ok then raise exception 'TEST_FAIL 4: duplicate worked time was ALLOWED'; end if;
  raise notice 'PASS 4: identical worked interval refused';
end $$;

-- ── 5. A PARTIAL overlap is refused (the 6a-2p vs 1p-5p case) ───────────────────────────────
do $$ declare ok boolean := false; r public.shifts; begin
  r := public.lensed_create_manual_worked_shift(
         'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, '2026-09-08'::date, '06:00'::time, '14:00'::time, 0);
  begin
    perform public.lensed_create_manual_worked_shift(
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, '2026-09-08'::date, '13:00'::time, '17:00'::time, 0);
  exception when others then ok := (sqlerrm = 'WORKED_TIME_OVERLAP');
  end;
  if not ok then raise exception 'TEST_FAIL 5: a one-hour overlap was ALLOWED'; end if;
  raise notice 'PASS 5: partial overlap refused';
end $$;

-- ── 6. A legitimate SPLIT SHIFT is ALLOWED — the whole reason this is not a same-day rule ────
do $$ declare r public.shifts; n int; begin
  r := public.lensed_create_manual_worked_shift(
         'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, '2026-09-08'::date, '16:00'::time, '20:00'::time, 0);
  if r.id is null then raise exception 'TEST_FAIL 6: split shift was refused'; end if;
  select count(*) into n from public.shifts
   where employee_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' and date='2026-09-08';
  if n <> 2 then raise exception 'TEST_FAIL 6: expected 2 same-day shifts, got %', n; end if;
  raise notice 'PASS 6: a non-overlapping split shift on the SAME DAY is allowed';
end $$;

-- ── 7. TOUCHING endpoints do not overlap (half-open '[)') ───────────────────────────────────
do $$ declare r public.shifts; begin
  perform public.lensed_create_manual_worked_shift(
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, '2026-09-09'::date, '06:00'::time, '10:00'::time, 0);
  r := public.lensed_create_manual_worked_shift(
         'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, '2026-09-09'::date, '10:00'::time, '14:00'::time, 0);
  if r.id is null then raise exception 'TEST_FAIL 7: back-to-back shifts were refused'; end if;
  raise notice 'PASS 7: 06:00-10:00 then 10:00-14:00 allowed (touching is not overlapping)';
end $$;

-- ── 8. OVERNIGHT: a shift stored on day D occupies part of D+1 ──────────────────────────────
do $$ declare ok boolean := false; begin
  perform public.lensed_create_manual_worked_shift(
    'dddddddd-dddd-dddd-dddd-dddddddddddd'::uuid, '2026-09-20'::date, '17:00'::time, '01:00'::time, 0);
  -- 00:00-08:00 the NEXT morning shares 00:00-01:00 with it. A day-scoped rule would miss this.
  begin
    perform public.lensed_create_manual_worked_shift(
      'dddddddd-dddd-dddd-dddd-dddddddddddd'::uuid, '2026-09-21'::date, '00:00'::time, '08:00'::time, 0);
  exception when others then ok := (sqlerrm = 'WORKED_TIME_OVERLAP');
  end;
  if not ok then raise exception 'TEST_FAIL 8: overnight spill into the next day was NOT detected'; end if;
  raise notice 'PASS 8: overnight overlap detected ACROSS calendar dates';
end $$;

-- ── 8b. …and a genuinely later shift the same next-day IS allowed ───────────────────────────
do $$ declare r public.shifts; begin
  r := public.lensed_create_manual_worked_shift(
         'dddddddd-dddd-dddd-dddd-dddddddddddd'::uuid, '2026-09-21'::date, '09:00'::time, '17:00'::time, 0);
  if r.id is null then raise exception 'TEST_FAIL 8b: a non-overlapping next-day shift was refused'; end if;
  raise notice 'PASS 8b: overnight guard does not over-block the following day';
end $$;

-- ── 9. An existing TIME_CLOCK punch blocks manual entry — the real production bug ────────────
-- The punch carries INSTANTS, so this also proves the instant branch of lensed_shift_wall_range:
-- 13:00Z-21:00Z is 06:00-14:00 America/Los_Angeles (PDT, UTC-7).
do $$ declare ok boolean := false; begin
  insert into public.shifts(user_id, employee_id, date, start_time, end_time, source,
                            clock_in_at, clock_out_at, confirmed_at)
  values ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          '2026-09-24', '06:00', '14:00', 'time_clock',
          '2026-09-24 13:00:00+00', '2026-09-24 21:00:00+00', null);
  begin
    perform public.lensed_create_manual_worked_shift(
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, '2026-09-24'::date, '06:00'::time, '14:00'::time, 0);
  exception when others then ok := (sqlerrm = 'WORKED_TIME_OVERLAP');
  end;
  if not ok then raise exception 'TEST_FAIL 9: manual row stacked on an UNCONFIRMED punch'; end if;
  raise notice 'PASS 9: an existing time_clock punch blocks manual worked time (unconfirmed too)';
end $$;

-- ── 10. A MATERIALIZED plan row must NOT block — it is the plan, never pay ───────────────────
do $$ declare rid uuid; r public.shifts; begin
  insert into public.shift_rules(user_id, employee_id, days_of_week, start_time, end_time, start_date)
  values ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          array[1]::smallint[], '06:00', '14:00', '2026-09-01') returning id into rid;
  insert into public.shifts(user_id, employee_id, date, start_time, end_time, source_rule_id)
  values ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          '2026-09-28', '06:00', '14:00', rid);
  r := public.lensed_create_manual_worked_shift(
         'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, '2026-09-28'::date, '06:00'::time, '14:00'::time, 0);
  if r.id is null then raise exception 'TEST_FAIL 10: a PLAN row blocked the correction'; end if;
  raise notice 'PASS 10: a materialized (source_rule_id) plan row does not block the correction';
end $$;

-- ── 11. An OPEN shift is unbounded and cannot be paved over ──────────────────────────────────
do $$ declare ok boolean := false; begin
  perform public.lensed_create_manual_worked_shift(
    'dddddddd-dddd-dddd-dddd-dddddddddddd'::uuid, '2026-10-01'::date, '06:00'::time, null, 0);
  begin
    perform public.lensed_create_manual_worked_shift(
      'dddddddd-dddd-dddd-dddd-dddddddddddd'::uuid, '2026-10-01'::date, '09:00'::time, '17:00'::time, 0);
  exception when others then ok := (sqlerrm in ('WORKED_TIME_OVERLAP'));
  end;
  if not ok then raise exception 'TEST_FAIL 11: worked time was written over an OPEN shift'; end if;
  raise notice 'PASS 11: an open (in-progress) shift blocks a later overlapping entry';
end $$;

-- ── 12. Break: 0 valid, 30 stored, >= span refused ──────────────────────────────────────────
do $$ declare r public.shifts; ok boolean := false; begin
  r := public.lensed_create_manual_worked_shift(
         'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid, '2026-09-15'::date, '06:00'::time, '14:00'::time, 30);
  if r.break_minutes <> 30 then raise exception 'TEST_FAIL 12: break stored as %', r.break_minutes; end if;
  if r.source <> 'manual' then raise exception 'TEST_FAIL 12: break path changed the source'; end if;
  begin
    perform public.lensed_create_manual_worked_shift(
      'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid, '2026-09-16'::date, '06:00'::time, '14:00'::time, 480);
  exception when others then ok := (sqlerrm = 'BREAK_TOO_LONG');
  end;
  if not ok then raise exception 'TEST_FAIL 12: a break equal to the span was accepted'; end if;
  raise notice 'PASS 12: break 0/30 accepted and stored; break >= span refused (BREAK_TOO_LONG)';
end $$;

-- ── 12b. A negative break is refused; the overnight span is measured wrapped ─────────────────
do $$ declare ok boolean := false; r public.shifts; begin
  begin
    perform public.lensed_create_manual_worked_shift(
      'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid, '2026-09-17'::date, '06:00'::time, '14:00'::time, -1);
  exception when others then ok := (sqlerrm = 'BREAK_INVALID');
  end;
  if not ok then raise exception 'TEST_FAIL 12b: a negative break was accepted'; end if;
  -- 17:00->01:00 is an 8h span, so a 470m break fits and a 480m one does not.
  r := public.lensed_create_manual_worked_shift(
         'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid, '2026-09-18'::date, '17:00'::time, '01:00'::time, 470);
  if r.break_minutes <> 470 then raise exception 'TEST_FAIL 12b: overnight break rejected wrongly'; end if;
  raise notice 'PASS 12b: negative break refused; overnight span measured with the wrap';
end $$;

-- ── 13. Tenancy: another owner''s employee is invisible ─────────────────────────────────────
do $$ declare ok boolean := false; begin
  begin
    perform public.lensed_create_manual_worked_shift(
      'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid, '2026-09-06'::date, '06:00'::time, '14:00'::time, 0);
  exception when others then ok := (sqlerrm = 'EMPLOYEE_NOT_FOUND');
  end;
  if not ok then raise exception 'TEST_FAIL 13: wrote a shift for ANOTHER TENANT''s employee'; end if;
  raise notice 'PASS 13: cross-tenant employee refused (EMPLOYEE_NOT_FOUND)';
end $$;

-- ── 14. No session → no write ───────────────────────────────────────────────────────────────
do $$ declare ok boolean := false; begin
  perform set_config('test.user_id', '', true);
  begin
    perform public.lensed_create_manual_worked_shift(
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, '2026-09-30'::date, '06:00'::time, '14:00'::time, 0);
  exception when others then ok := (sqlerrm = 'NOT_AUTHENTICATED');
  end;
  if not ok then raise exception 'TEST_FAIL 14: an unauthenticated call was allowed'; end if;
  perform set_config('test.user_id', '11111111-1111-1111-1111-111111111111', true);
  raise notice 'PASS 14: unauthenticated call refused';
end $$;

-- ── 15. A REFUSAL WRITES NOTHING (the refusals above must not have left partial rows) ────────
do $$ declare n int; begin
  select count(*) into n from public.shifts where date in ('2026-09-16','2026-09-17','2026-09-30');
  if n <> 0 then raise exception 'TEST_FAIL 15: a refused call left % row(s) behind', n; end if;
  raise notice 'PASS 15: every refusal is a clean no-write';
end $$;

-- ── 16. The scheduled PLAN survives the correction ──────────────────────────────────────────
-- The whole point: `shift_instances` is what was scheduled, the manual `shifts` row is what the
-- manager says happened. Recording one must never delete the other.
do $$ declare iid uuid; still int; r public.shifts; begin
  -- shift_instances stores INSTANTS (085) — 17:00-01:00 America/Los_Angeles on 2026-10-10 is
  -- 00:00Z-08:00Z on the 11th (PDT, UTC-7). The plan's own representation, not the guard's.
  insert into public.shift_instances(user_id, employee_id, shift_date, starts_at, ends_at, status, source)
  values ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          '2026-10-10', '2026-10-11 00:00:00+00', '2026-10-11 08:00:00+00',
          'scheduled', 'admin_open') returning id into iid;
  r := public.lensed_create_manual_worked_shift(
         'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, '2026-10-10'::date, '17:00'::time, '01:00'::time, 0);
  if r.id is null then raise exception 'TEST_FAIL 16: creation failed'; end if;
  select count(*) into still from public.shift_instances where id = iid and status = 'scheduled';
  if still <> 1 then raise exception 'TEST_FAIL 16: the scheduled instance was destroyed'; end if;
  raise notice 'PASS 16: the shift_instances plan row is untouched by the correction';
end $$;

-- ── 17. STATIC: the function body touches no punch/audit machinery ──────────────────────────
-- A behavioural test can only prove the tables it knows to look at. This proves the function
-- cannot touch them at all — and reports what it examined, so it cannot pass vacuously.
do $$ declare src text; raw text; begin
  select pg_get_functiondef(p.oid) into raw
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='lensed_create_manual_worked_shift';
  if raw is null then raise exception 'TEST_FAIL 17: function not found (vacuous check)'; end if;
  -- STRIP `--` COMMENTS FIRST. pg_get_functiondef returns the body verbatim, comments included,
  -- and this function EXPLAINS at length which punch tables it must not write. Matching the prose
  -- instead of the code would fail on the explanation and pass on a real write.
  src := regexp_replace(raw, '--[^' || chr(10) || ']*', '', 'g');
  -- READS of employee_time_entries are REQUIRED (see 22 — that is the raw-punch race guard).
  -- What must never appear is a WRITE. Checking for the table name alone used to be the assertion
  -- and is now wrong: it would forbid the very protection the feature depends on.
  if src ~* '(insert into|update|delete from)\s+public\.employee_time_entries' then
    raise exception 'TEST_FAIL 17: the RPC WRITES employee_time_entries'; end if;
  if src ~* '(insert into|update|delete from)\s+public\.employee_time_breaks' then
    raise exception 'TEST_FAIL 17: the RPC WRITES employee_time_breaks'; end if;
  if src ~* 'employee_time_breaks' then
    raise exception 'TEST_FAIL 17: the RPC references break rows at all'; end if;
  if src ~* 'clock_audit' then
    raise exception 'TEST_FAIL 17: the RPC references clock_audit'; end if;
  if src !~* 'from public\.employee_time_entries' then
    raise exception 'TEST_FAIL 17: the RPC does not READ employee_time_entries — the raw-punch race is unguarded'; end if;
  if src ~* 'confirmed_at|confirmed_by' then
    raise exception 'TEST_FAIL 17: the RPC references confirmation columns'; end if;
  if src ~* 'shift_instances' then
    raise exception 'TEST_FAIL 17: the RPC references the schedule'; end if;
  if src !~* 'pg_advisory_xact_lock' then
    raise exception 'TEST_FAIL 17: the RPC lost its serialization lock'; end if;
  raise notice 'PASS 17: % chars of CODE examined (% raw, comments stripped); punches READ not written, no break/audit/confirmation/schedule writes, lock present', length(src), length(raw);
end $$;

-- ── 18. Confirmation machinery is unchanged ─────────────────────────────────────────────────
do $$ declare n int; begin
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='public'
     and p.proname in ('lensed_confirm_time_clock_shift','lensed_unconfirm_time_clock_shift');
  if n <> 2 then raise exception 'TEST_FAIL 18: expected both confirm RPCs to still exist, found %', n; end if;
  raise notice 'PASS 18: both time-clock confirmation RPCs still present and untouched';
end $$;

-- ── 19. Grants: the app calls this from a user session ──────────────────────────────────────
do $$ declare ok boolean; begin
  select has_function_privilege('authenticated',
    'public.lensed_create_manual_worked_shift(uuid,date,time,time,integer)', 'EXECUTE') into ok;
  if not ok then raise exception 'TEST_FAIL 19: authenticated cannot EXECUTE the RPC'; end if;
  raise notice 'PASS 19: authenticated holds EXECUTE (CONVENTIONS.md rule)';
end $$;

-- ── 20. SECURITY INVOKER — no privilege escalation ──────────────────────────────────────────
do $$ declare sdef boolean; begin
  select p.prosecdef into sdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='lensed_create_manual_worked_shift';
  if sdef then raise exception 'TEST_FAIL 20: the RPC is SECURITY DEFINER (should be INVOKER)'; end if;
  raise notice 'PASS 20: SECURITY INVOKER — runs as the caller, RLS still applies';
end $$;

-- ── 21. Historical overlaps do not block the guard from existing ────────────────────────────
-- Production carries 12 overlapping pairs TODAY. An EXCLUDE constraint could not be created while
-- they exist; this design only constrains NEW writes, so prove a pre-existing overlap can sit in
-- the table without breaking anything.
do $$ declare r public.shifts; n int; begin
  insert into public.shifts(user_id, employee_id, date, start_time, end_time, source) values
    ('11111111-1111-1111-1111-111111111111','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','2026-11-02','06:00','14:00','manual'),
    ('11111111-1111-1111-1111-111111111111','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','2026-11-02','06:05','14:01','time_clock');
  select count(*) into n from public.shifts where employee_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' and date='2026-11-02';
  if n <> 2 then raise exception 'TEST_FAIL 21: could not seed a historical overlap'; end if;
  -- The guard still works normally on a DIFFERENT day for the same employee.
  r := public.lensed_create_manual_worked_shift(
         'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, '2026-11-03'::date, '06:00'::time, '14:00'::time, 0);
  if r.id is null then raise exception 'TEST_FAIL 21: pre-existing overlap broke later creation'; end if;
  raise notice 'PASS 21: pre-existing overlapping rows are tolerated (no cleanup required to deploy)';
end $$;

-- Clean up the race employee''s rows so run.sh''s two-session race starts from zero.
delete from public.shifts where employee_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

-- ── 22. RAW PUNCH RACE: an entry that has not become a shift yet must still block ────────────
--
-- A time_clock `shifts` row does not exist while someone is on the clock: every writer (071
-- clock_out, 072's reconciler, the 091/092/095/099 kiosk paths) builds it FROM an
-- employee_time_entries row. So scanning `shifts` alone leaves a window where a manual row can be
-- created into a gap a punch is about to fill:
--
--   06:00 clock in                  → entry OPEN, no shifts row
--   10:00 manager adds manual 06–14 → nothing to overlap, row created
--   14:00 clock out                 → time_clock 06–14 inserted → DOUBLE PAID
--
-- The exact test for "will become a shift" is shift_id IS NULL.
\set EP 'cccccccc-cccc-cccc-cccc-cccccccccccc'
insert into public.employees(id, user_id, name, status) values (:'EP', :'U1', 'Punchy Pete', 'active')
  on conflict (id) do nothing;

-- (a) OPEN entry (no clock-out yet, no shift). Treated as UNBOUNDED — we cannot know where the
--     punch will end, so anything finishing after it started may collide.
insert into public.employee_time_entries (user_id, employee_id, clocked_in_at, status)
values (:'U1', :'EP', '2026-10-20 06:00:00-07', 'open');

do $$ declare got text; begin
  begin
    perform public.lensed_create_manual_worked_shift(
      'cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid, '2026-10-20'::date, '06:00'::time, '14:00'::time, 0);
    got := 'NO ERROR';
  exception when others then got := sqlerrm;
  end;
  if got <> 'OPEN_PUNCH_CONFLICT' then
    raise exception 'TEST_FAIL 22a: expected OPEN_PUNCH_CONFLICT, got % (an OPEN punch did not block manual worked time)', got;
  end if;
  if exists (select 1 from public.shifts where employee_id='cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid) then
    raise exception 'TEST_FAIL 22a: a payable row was written anyway';
  end if;
  raise notice 'PASS 22a: an OPEN punch blocks manual worked time (OPEN_PUNCH_CONFLICT), zero rows written';
end $$;

-- ...and it blocks LATER intervals too, because an open punch has no known end.
do $$ declare got text; begin
  begin
    perform public.lensed_create_manual_worked_shift(
      'cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid, '2026-10-20'::date, '18:00'::time, '22:00'::time, 0);
    got := 'NO ERROR';
  exception when others then got := sqlerrm;
  end;
  if got <> 'OPEN_PUNCH_CONFLICT' then
    raise exception 'TEST_FAIL 22b: an interval AFTER an open punch was allowed (got %)', got; end if;
  raise notice 'PASS 22b: an open punch is unbounded — later intervals are blocked too';
end $$;

-- ...but an interval entirely BEFORE the punch started is genuinely fine.
do $$ declare r public.shifts; begin
  r := public.lensed_create_manual_worked_shift(
         'cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid, '2026-10-19'::date, '08:00'::time, '12:00'::time, 0);
  if r.id is null then raise exception 'TEST_FAIL 22c: a shift ending before the punch began was refused'; end if;
  raise notice 'PASS 22c: an interval finishing before the open punch started is still allowed';
end $$;

-- (b) CLOSED ORPHAN: clocked out, but shift_id still NULL. 072(b) will back-fill this into a
--     payable time_clock shift at exactly [clocked_in_at, clocked_out_at).
--
--     A SEPARATE employee, deliberately. Pete still carries the open punch from (a), and an open
--     punch is UNBOUNDED — it would block this interval too and mask which rule actually fired.
--     That masking is correct behaviour (22b asserts it); it just makes Pete useless as a fixture
--     for proving the orphan rule on its own.
\set EO2 'cccccccc-cccc-cccc-cccc-000000000002'
insert into public.employees(id, user_id, name, status) values (:'EO2', :'U1', 'Orphan Olive', 'active')
  on conflict (id) do nothing;
insert into public.employee_time_entries (user_id, employee_id, clocked_in_at, clocked_out_at, status)
values (:'U1', :'EO2', '2026-10-25 06:00:00-07', '2026-10-25 14:00:00-07', 'closed');

do $$ declare got text; begin
  begin
    perform public.lensed_create_manual_worked_shift(
      'cccccccc-cccc-cccc-cccc-000000000002'::uuid, '2026-10-25'::date, '13:00'::time, '17:00'::time, 0);
    got := 'NO ERROR';
  exception when others then got := sqlerrm;
  end;
  if got <> 'UNRECONCILED_PUNCH_OVERLAP' then
    raise exception 'TEST_FAIL 22d: expected UNRECONCILED_PUNCH_OVERLAP, got % (an orphaned punch did not block)', got;
  end if;
  if exists (select 1 from public.shifts where employee_id='cccccccc-cccc-cccc-cccc-000000000002'::uuid and date='2026-10-25') then
    raise exception 'TEST_FAIL 22d: a payable row was written anyway';
  end if;
  raise notice 'PASS 22d: a CLOSED-but-unreconciled punch blocks an overlapping manual row';
end $$;

-- ...and a non-overlapping split around it is still legal (the guard is overlap, never same-day).
do $$ declare r public.shifts; begin
  r := public.lensed_create_manual_worked_shift(
         'cccccccc-cccc-cccc-cccc-000000000002'::uuid, '2026-10-25'::date, '15:00'::time, '19:00'::time, 0);
  if r.id is null then raise exception 'TEST_FAIL 22e: a legitimate split around the punch was refused'; end if;
  raise notice 'PASS 22e: a non-overlapping split shift beside an unreconciled punch is allowed';
end $$;

-- (c) An entry that ALREADY produced its shift must not double-count: shift_id IS NOT NULL means
--     the shifts scan above owns it, and this scan must ignore it. Proven by the fact that the
--     refusal comes back as WORKED_TIME_OVERLAP (the shifts rule) rather than a punch rule.
do $$ declare v_shift uuid; got text; begin
  select id into v_shift from public.shifts
   where employee_id='cccccccc-cccc-cccc-cccc-000000000002'::uuid and date='2026-10-25' limit 1;
  insert into public.employee_time_entries (user_id, employee_id, clocked_in_at, clocked_out_at, status, shift_id)
  values ('11111111-1111-1111-1111-111111111111'::uuid, 'cccccccc-cccc-cccc-cccc-000000000002'::uuid,
          '2026-10-25 15:00:00-07', '2026-10-25 19:00:00-07', 'closed', v_shift);
  begin
    perform public.lensed_create_manual_worked_shift(
      'cccccccc-cccc-cccc-cccc-000000000002'::uuid, '2026-10-25'::date, '16:00'::time, '18:00'::time, 0);
    got := 'NO ERROR';
  exception when others then got := sqlerrm;
  end;
  if got <> 'WORKED_TIME_OVERLAP' then
    raise exception 'TEST_FAIL 22f: a RECONCILED entry was double-counted as a punch conflict (got %)', got; end if;
  raise notice 'PASS 22f: an entry with shift_id set is left to the shifts scan (WORKED_TIME_OVERLAP), not re-reported';
end $$;

-- (d) THE WHOLE POINT: raw punch tables are READ, never written.
do $$
declare
  n_entries int; n_breaks int; src text;
begin
  select count(*) into n_entries from public.employee_time_entries
   where employee_id in ('cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid,
                         'cccccccc-cccc-cccc-cccc-000000000002'::uuid);
  if n_entries <> 3 then
    raise exception 'TEST_FAIL 22g: entry count changed (%), the RPC wrote to employee_time_entries', n_entries; end if;
  select count(*) into n_breaks from public.employee_time_breaks;
  if n_breaks <> 0 then raise exception 'TEST_FAIL 22g: a break row was fabricated'; end if;

  select regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') into src
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='lensed_create_manual_worked_shift';
  if src ~* '(insert into|update|delete from)\s+public\.employee_time_entries' then
    raise exception 'TEST_FAIL 22g: the function WRITES employee_time_entries'; end if;
  if src ~* '(insert into|update|delete from)\s+public\.employee_time_breaks' then
    raise exception 'TEST_FAIL 22g: the function WRITES employee_time_breaks'; end if;
  if src ~* 'clock_audit' then
    raise exception 'TEST_FAIL 22g: the function references clock_audit'; end if;
  if src !~* 'from public\.employee_time_entries' then
    raise exception 'TEST_FAIL 22g: the function does NOT read employee_time_entries — the race is unguarded'; end if;
  raise notice 'PASS 22g: employee_time_entries is READ only; no punch/break/audit row was written or fabricated';
end $$;

-- ── 23. LONG-PUNCH REGRESSION: a shift can reach MORE than one day past its own date ─────────
--
-- This is the bug a ±1 day scan window would reintroduce, and it is reachable with real data:
-- production holds four time_clock punches over 24 hours, three of them 46–48h reaching TWO days
-- past their `date`. A time_clock range is built from INSTANTS and has no 24-hour ceiling — that
-- is deliberate (072: a 26-hour forgotten clock-out must read as 26 hours, not wrap to 2 and hide
-- a conflict). So the overlap scan must not bound candidates by date at all.
--
-- Clock in 2026-11-02 22:00, out 2026-11-04 21:45 (47.75h — the exact production shape). The row's
-- `date` is 2026-11-02, but it occupies 2026-11-04.
\set EL 'cccccccc-cccc-cccc-cccc-000000000003'
insert into public.employees(id, user_id, name, status) values (:'EL', :'U1', 'Long-punch Lars', 'active')
  on conflict (id) do nothing;

insert into public.shifts (user_id, employee_id, date, start_time, end_time, source,
                           clock_in_at, clock_out_at, break_minutes)
values (:'U1', :'EL', '2026-11-02', '22:00', '21:45', 'time_clock',
        '2026-11-02 22:00:00-07', '2026-11-04 21:45:00-08', 0);

do $$ declare got text; begin
  begin
    -- Two days after the punch's own date, squarely inside its real span.
    perform public.lensed_create_manual_worked_shift(
      'cccccccc-cccc-cccc-cccc-000000000003'::uuid, '2026-11-04'::date, '09:00'::time, '17:00'::time, 0);
    got := 'NO ERROR';
  exception when others then got := sqlerrm;
  end;
  if got <> 'WORKED_TIME_OVERLAP' then
    raise exception 'TEST_FAIL 23a: a 47.75h punch dated two days earlier did NOT block (got %) — the scan is date-bounded again', got;
  end if;
  if exists (select 1 from public.shifts
              where employee_id='cccccccc-cccc-cccc-cccc-000000000003'::uuid and date='2026-11-04') then
    raise exception 'TEST_FAIL 23a: a payable row was written anyway';
  end if;
  raise notice 'PASS 23a: a 47.75h punch blocks a manual create TWO days past its own date';
end $$;

-- ...and a create genuinely outside the long span is still allowed, so the fix did not become
-- "block everything for this employee".
do $$ declare r public.shifts; begin
  r := public.lensed_create_manual_worked_shift(
         'cccccccc-cccc-cccc-cccc-000000000003'::uuid, '2026-11-05'::date, '09:00'::time, '17:00'::time, 30);
  if r.id is null then raise exception 'TEST_FAIL 23b: a create clear of the long punch was refused'; end if;
  raise notice 'PASS 23b: a create clear of the long span is still allowed (not a blanket block)';
end $$;

-- And the boundary: the punch ends 21:45 on the 4th, so 21:45–23:00 on the 4th touches without
-- overlapping and must be legal (half-open ranges).
do $$ declare r public.shifts; begin
  r := public.lensed_create_manual_worked_shift(
         'cccccccc-cccc-cccc-cccc-000000000003'::uuid, '2026-11-04'::date, '21:45'::time, '23:00'::time, 0);
  if r.id is null then raise exception 'TEST_FAIL 23c: touching the long punch''s end was refused'; end if;
  raise notice 'PASS 23c: starting exactly when the long punch ends is allowed (half-open)';
end $$;

-- The scan must also be unbounded BACKWARD from an OPEN shift, which has no end at all.
\set EL2 'cccccccc-cccc-cccc-cccc-000000000004'
insert into public.employees(id, user_id, name, status) values (:'EL2', :'U1', 'Open-ended Oona', 'active')
  on conflict (id) do nothing;
insert into public.shifts (user_id, employee_id, date, start_time, end_time, source, break_minutes)
values (:'U1', :'EL2', '2026-11-01', '08:00', null, 'manual', 0);

do $$ declare got text; begin
  begin
    perform public.lensed_create_manual_worked_shift(
      'cccccccc-cccc-cccc-cccc-000000000004'::uuid, '2026-11-20'::date, '09:00'::time, '17:00'::time, 0);
    got := 'NO ERROR';
  exception when others then got := sqlerrm;
  end;
  if got not in ('WORKED_TIME_OVERLAP', 'OPEN_SHIFT') then
    raise exception 'TEST_FAIL 23d: an OPEN shift from weeks earlier did not block (got %)', got; end if;
  raise notice 'PASS 23d: an OPEN shift is unbounded — it blocks a create 19 days later (%)', got;
end $$;
