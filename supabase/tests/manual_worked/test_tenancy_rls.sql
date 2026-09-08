-- TENANT ISOLATION for lensed_create_manual_worked_shift, under the REAL production posture.
--
-- WHY THIS FILE EXISTS SEPARATELY FROM test_manual_worked.sql.
-- That file (assertion 13) already proves a cross-tenant employee is refused, but it runs as the
-- TABLE OWNER with RLS switched off, so it can only exercise the function's own explicit
-- `e.user_id = auth.uid()` check. In production the caller is the `authenticated` role, RLS is
-- ENABLED on both tables, and — verified against live — `authenticated` holds full
-- SELECT/INSERT/UPDATE/DELETE on `employees` and `shifts`. RLS is therefore the ONLY table-level
-- boundary between tenants, so it has to be tested as itself rather than assumed.
--
-- This file rebuilds that posture: the real policies, the real role, no owner privileges. It runs
-- LAST because enabling RLS changes the world for everything after it.
--
-- The function stays SECURITY INVOKER, which is what makes this work: every statement inside it
-- runs as the caller and is filtered by the caller's policies. A SECURITY DEFINER version would
-- bypass RLS and would have to re-implement all of this by hand — strictly worse.

\set U1  '11111111-1111-1111-1111-111111111111'
\set U2  '22222222-2222-2222-2222-222222222222'
\set EF  'ffffffff-ffff-ffff-ffff-ffffffffffff'
\set E1  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

-- ── Recreate production's grants + RLS exactly ──────────────────────────────────────────────
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.employees to authenticated;
grant select, insert, update, delete on public.shifts    to authenticated;
-- The RPC now READS employee_time_entries (the raw-punch race guard), so the caller needs SELECT
-- on it or the whole function fails with "permission denied" instead of exercising the rule.
-- Production grants authenticated full DML here and has RLS with auth.uid() = user_id; mirror both.
grant select, insert, update, delete on public.employee_time_entries to authenticated;
-- USAGE on `auth` is required or auth.uid() itself raises "permission denied for schema auth",
-- which would make every assertion below fail for the wrong reason. Real Supabase grants this.
grant usage on schema auth to authenticated;
grant select on auth.users to authenticated;
grant execute on function auth.uid() to authenticated;

alter table public.employees             enable row level security;
alter table public.shifts                enable row level security;
alter table public.employee_time_entries enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='employees' and policyname='rls_emp_sel') then
    create policy rls_emp_sel on public.employees for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='shifts' and policyname='rls_sh_sel') then
    create policy rls_sh_sel on public.shifts for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='shifts' and policyname='rls_sh_ins') then
    create policy rls_sh_ins on public.shifts for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='employee_time_entries' and policyname='rls_te_sel') then
    create policy rls_te_sel on public.employee_time_entries for select using (auth.uid() = user_id);
  end if;
end $$;

-- Baseline, captured as the owner BEFORE dropping privileges (RLS would hide U2's rows from U1).
create temp table t_baseline as
  select (select count(*) from public.shifts)                                as all_shifts,
         (select count(*) from public.shifts where employee_id = :'EF')      as foreign_emp_shifts,
         (select count(*) from public.shifts where user_id = :'U2')          as u2_shifts;

-- ── Become a real tenant-A end user ─────────────────────────────────────────────────────────
set test.user_id = '11111111-1111-1111-1111-111111111111';   -- Owner A is "logged in"
set role authenticated;                                       -- and is NOT the table owner

-- 1. RLS must hide tenant B's employee from tenant A entirely.
do $$ declare n int; begin
  select count(*) into n from public.employees
   where id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid;
  if n <> 0 then raise exception 'TEST_FAIL T1: RLS let owner A SEE owner B''s employee (n=%)', n; end if;
  raise notice 'PASS T1: owner B''s employee is invisible to owner A under RLS';
end $$;

-- 2. THE REGRESSION THE GATE ASKED FOR.
--    Owner A, authenticated, calls the RPC with owner B's employee_id. It must be REFUSED.
do $$ declare ok boolean := false; msg text; begin
  begin
    perform public.lensed_create_manual_worked_shift(
      'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid, '2026-11-11'::date, '06:00'::time, '14:00'::time, 0);
  exception when others then msg := sqlerrm; ok := (sqlerrm = 'EMPLOYEE_NOT_FOUND');
  end;
  if not ok then
    raise exception 'TEST_FAIL T2: foreign-employee call was NOT refused as EMPLOYEE_NOT_FOUND (got: %)',
      coalesce(msg, 'NO ERROR AT ALL — A SHIFT MAY HAVE BEEN WRITTEN');
  end if;
  raise notice 'PASS T2: authenticated owner A calling with owner B''s employee_id → EMPLOYEE_NOT_FOUND';
end $$;

-- 3. ...and it wrote ZERO rows. Asserting the error message alone is not enough: the whole point
--    is that no payable row exists, so count it. Checked as the owner so RLS cannot hide a row
--    that WAS written under owner B's id.
reset role;
do $$ declare b record; a record; begin
  select * into b from t_baseline;
  select (select count(*) from public.shifts)                                           as all_shifts,
         (select count(*) from public.shifts
           where employee_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)            as foreign_emp_shifts,
         (select count(*) from public.shifts
           where user_id = '22222222-2222-2222-2222-222222222222'::uuid)                as u2_shifts
    into a;
  if a.foreign_emp_shifts <> b.foreign_emp_shifts then
    raise exception 'TEST_FAIL T3: % payable row(s) created for the FOREIGN employee', a.foreign_emp_shifts - b.foreign_emp_shifts;
  end if;
  if a.u2_shifts <> b.u2_shifts then
    raise exception 'TEST_FAIL T3: % row(s) created under the foreign OWNER', a.u2_shifts - b.u2_shifts;
  end if;
  if a.all_shifts <> b.all_shifts then
    raise exception 'TEST_FAIL T3: shifts total moved (% → %) — something was written', b.all_shifts, a.all_shifts;
  end if;
  raise notice 'PASS T3: ZERO rows created anywhere — foreign employee, foreign owner, and total all unchanged';
end $$;

-- 4. A caller cannot smuggle the foreign owner in via the insert either. `user_id` is taken from
--    auth.uid() and is not a parameter, and the RLS INSERT policy would reject a mismatch anyway.
--    Prove the belt still works with the braces removed: force a direct insert as tenant A using
--    tenant B's user_id and confirm RLS refuses it.
set role authenticated;
do $$ declare ok boolean := false; begin
  begin
    insert into public.shifts (user_id, employee_id, date, start_time, end_time, break_minutes)
    values ('22222222-2222-2222-2222-222222222222'::uuid,
            'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid, '2026-11-12', '06:00', '14:00', 0);
  exception when others then ok := true;
  end;
  if not ok then raise exception 'TEST_FAIL T4: RLS allowed a shift stamped to ANOTHER owner'; end if;
  raise notice 'PASS T4: a direct insert stamped to the foreign owner is refused by the RLS INSERT policy';
end $$;

-- 5. Owner A's own employee still works — the isolation is not just "everything fails".
--    Without this, T1–T4 would all pass against a function that refuses unconditionally.
do $$ declare r public.shifts; begin
  r := public.lensed_create_manual_worked_shift(
         'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, '2026-11-20'::date, '09:00'::time, '17:00'::time, 30);
  if r.id is null then raise exception 'TEST_FAIL T5: owner A could not create for their OWN employee'; end if;
  if r.user_id <> '11111111-1111-1111-1111-111111111111'::uuid then
    raise exception 'TEST_FAIL T5: row stamped to % not the caller', r.user_id; end if;
  if r.confirmed_at is not null then raise exception 'TEST_FAIL T5: fabricated confirmation'; end if;
  raise notice 'PASS T5: owner A CAN create for their own employee, stamped to owner A, unconfirmed';
end $$;

reset role;
