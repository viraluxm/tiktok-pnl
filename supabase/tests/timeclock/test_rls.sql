-- RLS ISOLATION proof for the attendance tables. Unlike test_timeclock.sql (which runs as
-- the table owner and therefore BYPASSES RLS, proving only the RPCs' explicit filters), this
-- file exercises the ACTUAL row-level-security policies under two distinct authenticated
-- identities.
--
-- HOW IDENTITY IS SIMULATED (documented per the task):
--   * The bootstrap stubs auth.uid() to read the GUC `test.user_id` (set per user here).
--   * We `SET LOCAL ROLE authenticated` inside each transaction so queries run as the plain
--     `authenticated` role — NOT the table owner — so Postgres enforces RLS (the owner and
--     superusers bypass it). This mirrors how a Supabase JWT presents: role=authenticated,
--     auth.uid()=<the signed-in user>. We grant `authenticated` the same table privileges
--     Supabase grants, so a blocked read returns 0 rows via RLS (not a privilege error).
--
-- Users: A and B, each owning one employee (EA / EB). A is seeded with a full session
-- (in→break→out) + shift; B with a shorter one. Then every cross-identity access is asserted
-- to be denied, and each user's own access allowed.

\set A  'aa000000-0000-0000-0000-000000000001'
\set B  'bb000000-0000-0000-0000-000000000001'
\set EA 'aa000000-0000-0000-0000-0000000000e1'
\set EB 'bb000000-0000-0000-0000-0000000000e1'

-- Match Supabase's grants so RLS (not a missing GRANT) is what gates access as `authenticated`.
grant usage on schema public to authenticated;
grant usage on schema auth to authenticated;                 -- so RLS policies can call auth.uid()
grant execute on function auth.uid() to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

insert into auth.users(id) values (:'A'), (:'B');
insert into public.employees(id, user_id, name, status)
  values (:'EA', :'A', 'Ann', 'active'),
         (:'EB', :'B', 'Bob', 'active');

-- Seed A's attendance UNDER RLS as authenticated A (also proves the clock RPCs work under RLS).
begin;
  set local role authenticated;
  select set_config('test.user_id', :'A', true);
  select public.lensed_clock_in(:'EA');
  select public.lensed_start_break(:'EA');
  select public.lensed_end_break(:'EA');
  select public.lensed_clock_out(:'EA');
commit;

-- Seed B's attendance UNDER RLS as authenticated B.
begin;
  set local role authenticated;
  select set_config('test.user_id', :'B', true);
  select public.lensed_clock_in(:'EB');
  select public.lensed_clock_out(:'EB');
commit;

-- Capture B's shift id (as owner) into a session GUC so the A-context tests can reference it.
select set_config('test.eb_shift', (select id::text from public.shifts where employee_id = :'EB' limit 1), false);

-- ── A's view: sees own, denied all of B's (read + write) ──
begin;
  set local role authenticated;
  select set_config('test.user_id', :'A', true);
  do $$ declare n int; inserted boolean := false; begin
    -- A CAN read its own attendance + breaks.
    select count(*) into n from public.employee_time_entries;
    if n < 1 then raise exception 'RLS_FAIL: A cannot read its own entries'; end if;
    select count(*) into n from public.employee_time_breaks;
    if n < 1 then raise exception 'RLS_FAIL: A cannot read its own breaks'; end if;

    -- A CANNOT read any of B's rows.
    select count(*) into n from public.employee_time_entries where employee_id = 'bb000000-0000-0000-0000-0000000000e1';
    if n <> 0 then raise exception 'RLS_FAIL: A can see B entries (%)', n; end if;
    select count(*) into n from public.employee_time_breaks where employee_id = 'bb000000-0000-0000-0000-0000000000e1';
    if n <> 0 then raise exception 'RLS_FAIL: A can see B breaks (%)', n; end if;
    select count(*) into n from public.shifts where employee_id = 'bb000000-0000-0000-0000-0000000000e1';
    if n <> 0 then raise exception 'RLS_FAIL: A can see B shifts (%)', n; end if;

    -- A CANNOT update or delete B's rows (RLS USING hides them → 0 rows affected).
    update public.employee_time_entries set status = 'open' where employee_id = 'bb000000-0000-0000-0000-0000000000e1';
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'RLS_FAIL: A updated % of B''s entries', n; end if;
    delete from public.employee_time_breaks where employee_id = 'bb000000-0000-0000-0000-0000000000e1';
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'RLS_FAIL: A deleted % of B''s breaks', n; end if;

    -- A CANNOT insert a row owned by B (RLS WITH CHECK rejects it → any error = blocked).
    begin
      insert into public.employee_time_entries(user_id, employee_id, status)
        values ('bb000000-0000-0000-0000-000000000001', 'bb000000-0000-0000-0000-0000000000e1', 'open');
      inserted := true;
    exception when others then inserted := false;
    end;
    if inserted then raise exception 'RLS_FAIL: A inserted a row owned by B'; end if;

    raise notice 'PASS RLS-1: A reads only its own; cannot read/update/delete/insert B''s rows';
  end $$;
rollback;

-- ── A cannot act on B via the RPCs (clock / confirm) ──
begin;
  set local role authenticated;
  select set_config('test.user_id', :'A', true);
  do $$ declare ok boolean; begin
    ok := false;
    begin perform public.lensed_clock_in('bb000000-0000-0000-0000-0000000000e1');   -- B's employee
    exception when others then ok := (sqlerrm = 'EMPLOYEE_NOT_FOUND'); end;
    if not ok then raise exception 'RLS_FAIL: A could clock B''s employee'; end if;

    ok := false;
    begin perform public.lensed_confirm_time_clock_shift(current_setting('test.eb_shift')::uuid); -- B's shift
    exception when others then ok := (sqlerrm = 'SHIFT_NOT_FOUND'); end;
    if not ok then raise exception 'RLS_FAIL: A could confirm B''s shift'; end if;

    raise notice 'PASS RLS-2: A cannot clock B''s employee or confirm B''s shift';
  end $$;
rollback;

-- ── B's view: cannot see A's records (symmetry) ──
begin;
  set local role authenticated;
  select set_config('test.user_id', :'B', true);
  do $$ declare n int; begin
    select count(*) into n from public.employee_time_entries where employee_id = 'aa000000-0000-0000-0000-0000000000e1';
    if n <> 0 then raise exception 'RLS_FAIL: B can see A entries (%)', n; end if;
    select count(*) into n from public.shifts where employee_id = 'aa000000-0000-0000-0000-0000000000e1';
    if n <> 0 then raise exception 'RLS_FAIL: B can see A shifts (%)', n; end if;
    -- B still reads its OWN.
    select count(*) into n from public.employee_time_entries;
    if n < 1 then raise exception 'RLS_FAIL: B cannot read its own entries'; end if;
    raise notice 'PASS RLS-3: B cannot access A''s records but reads its own';
  end $$;
rollback;

\echo 'ALL SQL RLS ISOLATION ASSERTIONS PASSED'
