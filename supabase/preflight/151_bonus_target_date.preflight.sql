-- PREFLIGHT for 151_bonus_target_date.sql — READ ONLY. Run before applying; re-run section 4 after.
-- Every "nothing bad exists" check reports the cardinality it examined (CONVENTIONS.md).

\echo '── 1. the column and the three constraint names are free ────────────────────'
select
  count(*) filter (where column_name = 'target_date')                         as target_date_exists,
  count(*)                                                                    as columns_examined
from information_schema.columns
where table_schema = 'public' and table_name = 'employee_pay_adjustments';
select
  count(*) filter (where conname = 'employee_pay_adjustments_flat_no_target_date')        as c1,
  count(*) filter (where conname = 'employee_pay_adjustments_hourly_needs_target_date')   as c2,
  count(*) filter (where conname = 'employee_pay_adjustments_target_date_in_period')      as c3,
  count(*)                                                                                as constraints_examined
from pg_constraint where conrelid = 'public.employee_pay_adjustments'::regclass;
-- EXPECT target_date_exists = 0 and c1 = c2 = c3 = 0, with both *_examined above zero.

\echo '── 2. THE GATE: no hourly rows may exist to be reinterpreted ────────────────'
select count(*) filter (where calculation_type = 'hourly') as hourly_rows,
       count(*) filter (where calculation_type = 'flat')   as flat_rows,
       count(*)                                            as rows_examined
from public.employee_pay_adjustments;
-- EXPECT hourly_rows = 0. ANY hourly row means STOP: migration 150's hourly bonus meant "the whole
-- pay period", and this migration makes hourly mean "one day". Those are different amounts of money
-- and the change must not silently reinterpret one as the other.

\echo '── 3. every existing row will pass the new constraints ──────────────────────'
select count(*)                                                                as rows_examined,
       count(*) filter (where calculation_type = 'flat')                       as flat_rows_ok,
       count(*) filter (where calculation_type = 'hourly')                     as hourly_rows_needing_a_date
from public.employee_pay_adjustments;
-- Flat rows have no target_date column yet, so they will validate as NULL — which is exactly what
-- employee_pay_adjustments_flat_no_target_date requires. hourly_rows_needing_a_date must be 0, or
-- the ADD CONSTRAINT itself will refuse (which is the correct outcome, not a workaround).

\echo '── 4. Class A evidence — capture path liveness (run BEFORE and AFTER) ───────'
select max(created_at) as latest_capture_event,
       count(*) filter (where created_at > now() - interval '15 minutes') as events_last_15m
from public.capture_events;
select max(last_seen_at) as latest_live_seen,
       count(*) filter (where status = 'live') as sessions_marked_live
from public.live_sessions;

\echo '── 5. payroll fingerprints (must be identical after) ────────────────────────'
select (select count(*) from public.employees) as employees,
       (select count(*) from public.shifts)    as shifts,
       (select md5(string_agg(id::text || coalesce(clock_in_at::text,'') || coalesce(clock_out_at::text,'')
                              || break_minutes::text || coalesce(approved_minutes::text,'')
                              || coalesce(confirmed_at::text,''), ',' order by id))
        from public.shifts)                    as shifts_fingerprint,
       (select md5(string_agg(id::text || hourly_rate::text, ',' order by id))
        from public.employees)                 as rates_fingerprint,
       (select md5(string_agg(id::text || calculation_type || coalesce(amount_cents::text,'')
                              || coalesce(rate_cents_per_hour::text,''), ',' order by id))
        from public.employee_pay_adjustments)  as bonus_fingerprint;

\echo '── POST-APPLY VERIFICATION ──────────────────────────────────────────────────'
-- 6. The column landed, nullable, with no default.
-- select column_name, data_type, is_nullable, column_default from information_schema.columns
-- where table_schema='public' and table_name='employee_pay_adjustments' and column_name='target_date';
-- EXPECT target_date / date / YES / (null).
--
-- 7. All three constraints landed, alongside 150's untouched nine.
-- select conname, pg_get_constraintdef(oid) from pg_constraint
-- where conrelid = 'public.employee_pay_adjustments'::regclass order by conname;
-- EXPECT 14 (150's 11 + these 3).
--
-- 8. The existing flat row survived validation and is UNCHANGED.
-- select id, calculation_type, amount_cents, rate_cents_per_hour, target_date, description
-- from public.employee_pay_adjustments;
-- EXPECT the pre-existing flat row, amount intact, target_date NULL.
--
-- 9. Still NO persisted calculated total.
-- select count(*) as forbidden_columns from information_schema.columns
-- where table_schema='public' and table_name='employee_pay_adjustments'
--   and column_name ~* 'calculated|_total|bonus_cents';   -- EXPECT 0
