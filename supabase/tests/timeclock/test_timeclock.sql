-- End-to-end DB proof for the time clock: the real RPCs (071) + the partial unique index
-- guards (070) enforce the attendance state machine and produce exactly one unconfirmed
-- shift at clock-out. Runs as owner; the RPCs' explicit auth.uid()/user_id filters do the
-- scoping (same convention as the idempotency harness). Any TEST_FAIL aborts under
-- ON_ERROR_STOP=1. now() is transaction-stable, so durations are ~0 here — exact break/
-- hours math is proven in src/lib/*.test.mjs; this file proves structure + guards.

\set U1  '11111111-1111-1111-1111-111111111111'
\set U2  '22222222-2222-2222-2222-222222222222'
\set E1  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
\set E3f 'cccccccc-cccc-cccc-cccc-cccccccccccc'
\set E_ON 'dddddddd-dddd-dddd-dddd-dddddddddddd'

insert into auth.users(id) values (:'U1'), (:'U2');
insert into public.employees(id, user_id, name, status)
  values (:'E1', :'U1', 'Maria', 'active'),
         (:'E3f', :'U1', 'Sam (former)', 'former'),
         (:'E_ON', :'U1', 'Nadia (overnight)', 'active');

set test.user_id = '11111111-1111-1111-1111-111111111111';  -- act as U1

-- 1. Clock in.
do $$ declare n int; begin
  perform public.lensed_clock_in('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  select count(*) into n from public.employee_time_entries
    where employee_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and clocked_out_at is null;
  if n <> 1 then raise exception 'TEST_FAIL 1: expected 1 open entry, got %', n; end if;
  raise notice 'PASS 1: clock in creates one open session';
end $$;

-- 2. Duplicate clock-in rejected (RPC pre-check).
do $$ declare ok boolean := false; begin
  begin perform public.lensed_clock_in('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  exception when others then ok := (sqlerrm = 'ALREADY_CLOCKED_IN');
    if not ok then raise exception 'TEST_FAIL 2: expected ALREADY_CLOCKED_IN, got %', sqlerrm; end if;
  end;
  if not ok then raise exception 'TEST_FAIL 2: duplicate clock-in did not raise'; end if;
  raise notice 'PASS 2: duplicate clock-in rejected (ALREADY_CLOCKED_IN)';
end $$;

-- 2b. DB backstop: the partial unique index blocks a 2nd open entry even via a raw insert.
do $$ declare ok boolean := false; begin
  begin
    insert into public.employee_time_entries(user_id, employee_id, status)
      values ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'open');
  exception when unique_violation then ok := true;
  end;
  if not ok then raise exception 'TEST_FAIL 2b: a 2nd open entry was NOT blocked by the unique index'; end if;
  raise notice 'PASS 2b: partial unique index blocks a 2nd open entry';
end $$;

-- 3. Clock in an inactive (former) employee rejected.
do $$ declare ok boolean := false; begin
  begin perform public.lensed_clock_in('cccccccc-cccc-cccc-cccc-cccccccccccc');
  exception when others then ok := (sqlerrm = 'EMPLOYEE_NOT_FOUND');
    if not ok then raise exception 'TEST_FAIL 3: expected EMPLOYEE_NOT_FOUND, got %', sqlerrm; end if;
  end;
  if not ok then raise exception 'TEST_FAIL 3: former-employee clock-in did not raise'; end if;
  raise notice 'PASS 3: clock in for an inactive employee rejected (EMPLOYEE_NOT_FOUND)';
end $$;

-- 4. Start break.
do $$ declare st text; begin
  perform public.lensed_start_break('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  select status into st from public.employee_time_entries
    where employee_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and clocked_out_at is null;
  if st <> 'on_break' then raise exception 'TEST_FAIL 4: expected on_break, got %', st; end if;
  raise notice 'PASS 4: start break sets status on_break';
end $$;

-- 5. Second simultaneous break rejected (RPC pre-check).
do $$ declare ok boolean := false; begin
  begin perform public.lensed_start_break('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  exception when others then ok := (sqlerrm = 'ALREADY_ON_BREAK');
    if not ok then raise exception 'TEST_FAIL 5: expected ALREADY_ON_BREAK, got %', sqlerrm; end if;
  end;
  if not ok then raise exception 'TEST_FAIL 5: second break did not raise'; end if;
  raise notice 'PASS 5: second simultaneous break rejected (ALREADY_ON_BREAK)';
end $$;

-- 5b. DB backstop: the partial unique index blocks a 2nd open break.
do $$ declare ok boolean := false; eid uuid; begin
  select id into eid from public.employee_time_entries
    where employee_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and clocked_out_at is null;
  begin
    insert into public.employee_time_breaks(user_id, employee_id, time_entry_id, started_at)
      values ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', eid, now());
  exception when unique_violation then ok := true;
  end;
  if not ok then raise exception 'TEST_FAIL 5b: a 2nd open break was NOT blocked by the unique index'; end if;
  raise notice 'PASS 5b: partial unique index blocks a 2nd open break';
end $$;

-- 6. Clock out while a break is open rejected.
do $$ declare ok boolean := false; begin
  begin perform public.lensed_clock_out('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  exception when others then ok := (sqlerrm = 'BREAK_OPEN');
    if not ok then raise exception 'TEST_FAIL 6: expected BREAK_OPEN, got %', sqlerrm; end if;
  end;
  if not ok then raise exception 'TEST_FAIL 6: clock-out on break did not raise'; end if;
  raise notice 'PASS 6: clock-out blocked while on break (BREAK_OPEN)';
end $$;

-- 7. End break.
do $$ declare st text; nb int; begin
  perform public.lensed_end_break('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  select status into st from public.employee_time_entries
    where employee_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and clocked_out_at is null;
  if st <> 'open' then raise exception 'TEST_FAIL 7: expected open, got %', st; end if;
  select count(*) into nb from public.employee_time_breaks b
    join public.employee_time_entries e on e.id=b.time_entry_id
    where e.employee_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and b.ended_at is null;
  if nb <> 0 then raise exception 'TEST_FAIL 7: break still open (%)', nb; end if;
  raise notice 'PASS 7: end break returns to working, break closed';
end $$;

-- 8. Ending a nonexistent break rejected.
do $$ declare ok boolean := false; begin
  begin perform public.lensed_end_break('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  exception when others then ok := (sqlerrm = 'NO_ACTIVE_BREAK');
    if not ok then raise exception 'TEST_FAIL 8: expected NO_ACTIVE_BREAK, got %', sqlerrm; end if;
  end;
  if not ok then raise exception 'TEST_FAIL 8: ending a nonexistent break did not raise'; end if;
  raise notice 'PASS 8: ending a nonexistent break rejected (NO_ACTIVE_BREAK)';
end $$;

-- 9. Clock out creates EXACTLY ONE unconfirmed time_clock shift for the right employee.
do $$ declare res jsonb; n int; sid uuid; src text; conf timestamptz; endt time; emp uuid; begin
  select public.lensed_clock_out('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') into res;
  sid := (res->>'shift_id')::uuid;
  if sid is null then raise exception 'TEST_FAIL 9: clock-out returned no shift_id'; end if;
  select count(*) into n from public.shifts where employee_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  if n <> 1 then raise exception 'TEST_FAIL 9: expected exactly 1 shift, got %', n; end if;
  select source, confirmed_at, end_time, employee_id into src, conf, endt, emp from public.shifts where id=sid;
  if src <> 'time_clock' then raise exception 'TEST_FAIL 9: source is % (want time_clock)', src; end if;
  if conf is not null then raise exception 'TEST_FAIL 9: shift should be UNCONFIRMED (confirmed_at null)'; end if;
  if endt is null then raise exception 'TEST_FAIL 9: shift end_time is null (not an open shift)'; end if;
  if emp <> 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' then raise exception 'TEST_FAIL 9: wrong employee'; end if;
  select count(*) into n from public.employee_time_entries
    where employee_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and shift_id=sid and status='closed' and clocked_out_at is not null;
  if n <> 1 then raise exception 'TEST_FAIL 9: entry not closed+linked to the shift'; end if;
  raise notice 'PASS 9: clock-out created exactly one unconfirmed time_clock shift, linked to the closed entry';
end $$;

-- 10. Retried clock-out is rejected and creates NO second shift.
do $$ declare ok boolean := false; n int; begin
  begin perform public.lensed_clock_out('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  exception when others then ok := (sqlerrm = 'NOT_CLOCKED_IN');
    if not ok then raise exception 'TEST_FAIL 10: expected NOT_CLOCKED_IN, got %', sqlerrm; end if;
  end;
  if not ok then raise exception 'TEST_FAIL 10: retried clock-out did not raise'; end if;
  select count(*) into n from public.shifts where employee_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  if n <> 1 then raise exception 'TEST_FAIL 10: retry created a duplicate shift (% total)', n; end if;
  raise notice 'PASS 10: retried clock-out rejected, still exactly one shift (idempotent)';
end $$;

-- 11. Cross-account: U2 cannot clock in U1's employee.
set test.user_id = '22222222-2222-2222-2222-222222222222';  -- act as U2
do $$ declare ok boolean := false; begin
  begin perform public.lensed_clock_in('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  exception when others then ok := (sqlerrm = 'EMPLOYEE_NOT_FOUND');
    if not ok then raise exception 'TEST_FAIL 11: expected EMPLOYEE_NOT_FOUND, got %', sqlerrm; end if;
  end;
  if not ok then raise exception 'TEST_FAIL 11: cross-account clock-in did not raise'; end if;
  raise notice 'PASS 11: cross-account clock-in rejected (EMPLOYEE_NOT_FOUND)';
end $$;

set test.user_id = '11111111-1111-1111-1111-111111111111';  -- back to U1

-- 12. OVERNIGHT: a session whose clock-in is the evening before keeps the CLOCK-IN date, and
--     the start time is truncated to the whole minute. We seed the open entry with a FIXED
--     clock-in instant (explicit -08 offset) so the date/start are deterministic; clock-out
--     uses now() for the end (asserted non-null only).
do $$ declare res jsonb; sid uuid; d date; st time; et time; src text; conf timestamptz; n int; begin
  insert into public.employee_time_entries(user_id, employee_id, clocked_in_at, status)
    values ('11111111-1111-1111-1111-111111111111', 'dddddddd-dddd-dddd-dddd-dddddddddddd',
            timestamptz '2026-01-15 23:30:40-08', 'open');            -- 11:30:40 PM PST, :40s
  select public.lensed_clock_out('dddddddd-dddd-dddd-dddd-dddddddddddd') into res;
  sid := (res->>'shift_id')::uuid;
  select count(*) into n from public.shifts where employee_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  if n <> 1 then raise exception 'TEST_FAIL 12: expected exactly 1 overnight shift, got %', n; end if;
  select date, start_time, end_time, source, confirmed_at into d, st, et, src, conf
    from public.shifts where id = sid;
  if d <> date '2026-01-15' then raise exception 'TEST_FAIL 12: shift date % (want clock-in day 2026-01-15)', d; end if;
  if st <> time '23:30:00' then raise exception 'TEST_FAIL 12: start % (want 23:30:00 — :40s truncated)', st; end if;
  if et is null then raise exception 'TEST_FAIL 12: end_time is null'; end if;
  if src <> 'time_clock' or conf is not null then raise exception 'TEST_FAIL 12: not an unconfirmed time_clock shift'; end if;
  raise notice 'PASS 12: overnight shift keeps the clock-in date + start truncated to the minute, one row';
end $$;

-- 13. CONFIRM (server-authoritative): confirmed_at set to now() and confirmed_by = the caller.
do $$ declare sid uuid; res jsonb; conf timestamptz; v_by uuid; begin
  select id into sid from public.shifts
    where employee_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and source = 'time_clock' limit 1;
  select public.lensed_confirm_time_clock_shift(sid) into res;
  select confirmed_at, confirmed_by into conf, v_by from public.shifts where id = sid;
  if conf is null then raise exception 'TEST_FAIL 13: confirmed_at not set by RPC'; end if;
  if v_by <> '11111111-1111-1111-1111-111111111111' then raise exception 'TEST_FAIL 13: confirmed_by % (want U1)', v_by; end if;
  raise notice 'PASS 13: confirm RPC set confirmed_at + confirmed_by server-side';
end $$;

-- 14. CONFIRM is idempotent: a duplicate request does not change the stamp and does not error.
do $$ declare sid uuid; c1 timestamptz; c2 timestamptz; begin
  select id into sid from public.shifts
    where employee_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and source = 'time_clock' limit 1;
  select confirmed_at into c1 from public.shifts where id = sid;
  perform public.lensed_confirm_time_clock_shift(sid);       -- again
  select confirmed_at into c2 from public.shifts where id = sid;
  if c1 is distinct from c2 then raise exception 'TEST_FAIL 14: re-confirm changed confirmed_at'; end if;
  raise notice 'PASS 14: confirm is idempotent (duplicate request is a no-op)';
end $$;

-- 15. GUARD: a DIRECT update of confirmed_at (no RPC context) is rejected; editing times is allowed.
do $$ declare sid uuid; ok boolean := false; begin
  select id into sid from public.shifts
    where employee_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and source = 'time_clock' limit 1;
  begin
    update public.shifts set confirmed_at = now() where id = sid;     -- bypass attempt
  exception when others then ok := (sqlerrm = 'CONFIRMATION_IS_SERVER_ONLY');
    if not ok then raise exception 'TEST_FAIL 15: wrong error on direct confirm write: %', sqlerrm; end if;
  end;
  if not ok then raise exception 'TEST_FAIL 15: direct confirmed_at write was NOT blocked'; end if;
  update public.shifts set start_time = '08:00:00' where id = sid;   -- editor-style edit still works
  raise notice 'PASS 15: direct confirmation write blocked (server-only); time edit still allowed';
end $$;

-- 16. UNCONFIRM (server-authoritative): clears confirmed_at + confirmed_by.
do $$ declare sid uuid; conf timestamptz; v_by uuid; begin
  select id into sid from public.shifts
    where employee_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and source = 'time_clock' limit 1;
  perform public.lensed_unconfirm_time_clock_shift(sid);
  select confirmed_at, confirmed_by into conf, v_by from public.shifts where id = sid;
  if conf is not null or v_by is not null then raise exception 'TEST_FAIL 16: unconfirm did not clear both columns'; end if;
  raise notice 'PASS 16: unconfirm cleared confirmed_at + confirmed_by';
end $$;

-- 17. CONFIRM rejects a NON-time_clock (manual) shift.
do $$ declare mid uuid; ok boolean := false; begin
  insert into public.shifts(user_id, employee_id, date, start_time, end_time, source)
    values ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            '2026-07-01', '09:00', '17:00', 'manual')
    returning id into mid;
  begin perform public.lensed_confirm_time_clock_shift(mid);
  exception when others then ok := (sqlerrm = 'SHIFT_NOT_TIME_CLOCK');
    if not ok then raise exception 'TEST_FAIL 17: wrong error: %', sqlerrm; end if;
  end;
  if not ok then raise exception 'TEST_FAIL 17: confirming a manual shift was not rejected'; end if;
  raise notice 'PASS 17: confirm rejects a non-time_clock shift (SHIFT_NOT_TIME_CLOCK)';
end $$;

\echo 'ALL SQL TIME-CLOCK ASSERTIONS PASSED'
