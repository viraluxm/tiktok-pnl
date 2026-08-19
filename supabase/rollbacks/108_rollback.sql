-- Rollback for 108_close_session_host_segment_as.sql
--
-- Apply as a single transaction: psql -1 -v ON_ERROR_STOP=1 -f 108_rollback.sql
-- NOT placed under supabase/migrations/ so the migration runner never applies it.
--
-- No data, no capture-path lock, no write-silence gate — 108 creates one function.
--
-- BEFORE RUNNING: confirm src/lib/sessions/autoEnd.ts is not calling it, or the auto-ender
-- starts logging a failed best-effort close on every session it ends. That failure is
-- non-fatal by design (sessions still end), but it is noise you did not intend.
-- Also drop 'close_session_host_segment_as' from SERVICE_ROLE_ONLY in
-- scripts/check-rpc-grants.mjs, or CI will fail asserting a function that no longer exists.

begin;

drop function if exists public.close_session_host_segment_as(uuid, uuid, timestamptz, text);

commit;
