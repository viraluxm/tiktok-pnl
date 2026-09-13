-- 157_rollback.sql — reverse 157_schedule_capacity_write_guard.sql.
--
-- ⚠️ NOT APPLIED (157 itself is not applied either). Lives OUTSIDE supabase/migrations/ so it can
--    never be picked up as a migration, the same placement as 150_rollback.sql / 156_rollback.sql.
--
-- SAFE: 157 created two functions and nothing else. No table, column, constraint, index or row was
-- touched, so dropping them restores the pre-157 catalog exactly.
--
-- THE APP KEEPS WORKING AFTER THIS RUNS. bulkSchedule.ts, claim.ts and adminShifts.ts all detect a
-- missing function (SQLSTATE 42883 / PostgREST PGRST202) and fall back to the pre-157 statement
-- sequence, which is what they do today before 157 is applied. The only thing lost is the capacity
-- guard on those write paths — which is exactly the pre-157 state.

begin;
set local lock_timeout = '3s';

drop function if exists public.lensed_apply_schedule_batch(uuid, jsonb, uuid[], uuid[], jsonb);
drop function if exists public.lensed_assign_released_shift(uuid, uuid, uuid, smallint);

commit;
