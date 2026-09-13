-- PREFLIGHT for 150_employee_pay_adjustments.sql — READ ONLY. Run before applying, and run
-- sections 5/6 again AFTER, per CLAUDE.md's Class A recipe.
--
--   psql -v ON_ERROR_STOP=1 -f 150_employee_pay_adjustments.preflight.sql
--   (or paste each block into the Management API query endpoint — it is all SELECTs)
--
-- Every "nothing bad exists" check reports the CARDINALITY of the set it examined, per
-- CONVENTIONS.md: a pass with rows_examined = 0 is not a pass, it is an inconclusive check.
-- Nothing here writes. Nothing here takes a lock beyond a catalog read.

\echo '── 1. the new names are all free ────────────────────────────────────────────'
select
  not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relname = 'employee_pay_adjustments')  as table_name_free,
  not exists (select 1 from pg_class where relname = 'uq_employees_id_user')          as uq_index_free,
  not exists (select 1 from pg_class where relname = 'idx_epa_owner_period')          as idx1_free,
  not exists (select 1 from pg_class where relname = 'idx_epa_employee_period')       as idx2_free,
  not exists (select 1 from pg_policies where tablename = 'employee_pay_adjustments') as policy_free,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public')                                                        as rows_examined;

\echo '── 2. no existing bonus/adjustment concept anywhere (the audit, re-run) ─────'
select
  (select count(*) from information_schema.tables
   where table_schema = 'public'
     and (table_name ~* 'bonus|adjust|incentive|reimburs'))                           as matching_tables,
  (select count(*) from information_schema.columns
   where table_schema = 'public'
     and (column_name ~* 'bonus|adjust|incentive|reimburs'))                          as matching_columns,
  (select count(*) from information_schema.tables where table_schema = 'public')      as tables_examined,
  (select count(*) from information_schema.columns where table_schema = 'public')     as columns_examined;
-- EXPECT matching_tables = 0 and matching_columns = 0, with both *_examined well above zero.

\echo '── 3. employees still has the shape the FK + the app assume ────────────────'
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'employees'
  and column_name in ('id', 'user_id', 'hourly_rate')
order by column_name;
-- EXPECT exactly three rows: id/uuid/NO, user_id/uuid/NO, hourly_rate/numeric/NO.

\echo '── 4. POSITIVE assertion — the trigger fn this migration attaches exists ───'
select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'set_updated_at';
-- EXPECT exactly one row. Zero rows means section 2's trigger will fail.

\echo '── 5. Class A evidence: capture path liveness (run BEFORE and AFTER) ───────'
select max(created_at)                                                        as latest_capture_event,
       count(*) filter (where created_at > now() - interval '15 minutes')     as events_last_15m
from public.capture_events;
select max(last_seen_at)                                                      as latest_live_seen,
       count(*) filter (where status = 'live')                                as sessions_marked_live
from public.live_sessions;
-- `live_sessions.status` is NOT an interlock (CLAUDE.md) — this is evidence for the record only.

\echo '── 6. function-body fingerprints (run BEFORE and AFTER — must be identical) ─'
select p.proname, md5(p.prosrc) as body_md5
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosrc like '%employees%'
order by p.proname, body_md5;
-- This migration creates and replaces NO function, so every row must be byte-identical after.

\echo '── 7. the canonical-period literal still matches the app (sanity, by hand) ──'
-- src/lib/employees.ts: PAY_ANCHOR = 2026-07-17; payPeriodFor(p) = {end: p-5, start: end-13}.
select date '2026-07-17' - 5                                   as derived_period_end,
       date '2026-07-17' - 5 - 13                              as derived_period_start,
       (date '2026-07-17' - 5 - 13) = date '2026-06-29'        as matches_migration_literal;
-- EXPECT matches_migration_literal = true. src/lib/pay/bonus.test.mjs asserts the same thing in CI
-- against the real helper, so this is a second pair of eyes, not the only check.

\echo '── 8. the two shape constraints, evaluated on THIS engine before they are created ──'
-- The predicates below are the CHECK bodies from migration 150, character for character, run as a
-- plain SELECT over a truth table. Nothing is created and nothing is written — this is the real
-- Postgres deciding whether the constraints admit exactly the rows they are meant to.
select ct, amt, rate, should_pass,
       (ct <> 'flat'   or (amt  is not null and amt  > 0 and rate is null)) as flat_shape_ok,
       (ct <> 'hourly' or (rate is not null and rate > 0 and amt  is null)) as hourly_shape_ok,
       ((ct <> 'flat'   or (amt  is not null and amt  > 0 and rate is null))
        and (ct <> 'hourly' or (rate is not null and rate > 0 and amt  is null))) = should_pass
                                                                            as matches_expectation
from (values
  ('flat',   10000, null,  true ),   -- a $100.00 flat bonus
  ('flat',   null,  null,  false),   -- flat with no amount
  ('flat',   0,     null,  false),   -- flat, zero
  ('flat',   -1,    null,  false),   -- flat, negative
  ('flat',   10000, 200,   false),   -- flat carrying a rate as well
  ('hourly', null,  200,   true ),   -- a $2.00/hr incentive
  ('hourly', null,  null,  false),   -- hourly with no rate
  ('hourly', null,  0,     false),   -- hourly, zero
  ('hourly', 10000, 200,   false),   -- hourly carrying an amount as well
  ('hourly', 10000, null,  false)    -- hourly with only an amount
) as t(ct, amt, rate, should_pass)
order by ct, amt nulls first, rate nulls first;
-- EXPECT matches_expectation = true on ALL TEN rows. Five should_pass=false rows and two
-- should_pass=true rows means the check is not vacuous in either direction.

\echo '── 9. the sanity ceilings, same treatment ──'
select amt, rate, should_pass,
       ((amt  is null or amt  <= 100000000) and (rate is null or rate <= 100000)) = should_pass
         as matches_expectation
from (values
  (100000000, null,   true ),   -- $1,000,000.00 flat — allowed
  (100000001, null,   false),   -- a dollar over
  (null,      100000, true ),   -- $1,000.00/hr — allowed
  (null,      100001, false)    -- a cent over
) as t(amt, rate, should_pass);
-- EXPECT matches_expectation = true on all four.

\echo '── POST-APPLY VERIFICATION (run only after sections 1-3 have been applied) ──'
-- 10. The constraints actually landed — EXPECT nine, including BOTH shape checks.
-- select conname, pg_get_constraintdef(oid) from pg_constraint
-- where conrelid = 'public.employee_pay_adjustments'::regclass order by conname;
--
-- 10b. And the two money columns are NULLABLE — the shape checks, not NOT NULL, are what police
--      them, and a stray NOT NULL would make one of the two types unwritable.
-- select column_name, is_nullable from information_schema.columns
-- where table_schema = 'public' and table_name = 'employee_pay_adjustments'
--   and column_name in ('amount_cents', 'rate_cents_per_hour', 'calculation_type');
-- EXPECT amount_cents YES, rate_cents_per_hour YES, calculation_type NO.
--
-- 10c. There is NO stored total. If a column matching /calculated|total/ ever appears on this
--      table, an hourly bonus has been frozen and will go stale — that is a bug, not a feature.
-- select count(*) as forbidden_columns,
--        (select count(*) from information_schema.columns
--         where table_schema = 'public' and table_name = 'employee_pay_adjustments') as rows_examined
-- from information_schema.columns
-- where table_schema = 'public' and table_name = 'employee_pay_adjustments'
--   and column_name ~* 'calculated|total';
--
-- 11. RLS is ON and the policy is the own-row one.
-- select relrowsecurity from pg_class where oid = 'public.employee_pay_adjustments'::regclass;
-- select policyname, cmd, qual, with_check from pg_policies
-- where tablename = 'employee_pay_adjustments';
--
-- 12. `authenticated` can actually use it (the CONVENTIONS.md failure mode).
-- select privilege_type from information_schema.role_table_grants
-- where table_name = 'employee_pay_adjustments' and grantee = 'authenticated' order by 1;
-- EXPECT DELETE, INSERT, SELECT, UPDATE.
--
-- 13. The table is empty and stays empty until a manager enters a bonus. No backfill exists.
-- select count(*) as bonus_rows from public.employee_pay_adjustments;   -- EXPECT 0
