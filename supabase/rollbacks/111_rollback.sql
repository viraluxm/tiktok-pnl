-- Rollback for 111_pnl_host_performance_as.sql
--
-- Apply as a single transaction: psql -1 -v ON_ERROR_STOP=1 -f 111_rollback.sql
-- NOT placed under supabase/migrations/ so the migration runner never applies it.
-- No data, no capture-path lock, no write-silence gate.
--
-- BEFORE RUNNING: revert /api/member/team/host-performance to its pre-111 PostgREST
-- implementation FIRST, or the station Team page 500s on a missing function. The route change is
-- a separate commit precisely so it can be reverted independently of this DDL.
--
-- Note the consequence of reverting only the route and keeping 109: the station Team page goes
-- back to the OLD closed_at numbers while the owner Roster keeps the corrected ones. That
-- two-page disagreement is exactly what 111 exists to remove, so prefer reverting 109's route
-- too rather than living with the split.
--
-- Also drop 'pnl_host_performance_as' from SERVICE_ROLE_ONLY in scripts/check-rpc-grants.mjs,
-- or CI will fail asserting a function that no longer exists.

begin;

drop function if exists public.pnl_host_performance_as(uuid[], integer, integer, numeric, timestamptz);

commit;
