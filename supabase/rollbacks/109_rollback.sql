-- Rollback for 109_pnl_host_performance.sql
--
-- Apply as a single transaction: psql -1 -v ON_ERROR_STOP=1 -f 109_rollback.sql
-- NOT placed under supabase/migrations/ so the migration runner never applies it.
--
-- No data, no capture-path lock, no write-silence gate — 109 creates one function.
--
-- BEFORE RUNNING: revert /api/live/host-performance to its pre-109 PostgREST implementation
-- FIRST, or the roster badges 500 on a missing function. The route change is a separate commit
-- precisely so it can be reverted independently of this DDL.

begin;

drop function if exists public.pnl_host_performance(integer, integer, numeric, timestamptz);

commit;
