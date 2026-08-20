-- Rollback for 113_segment_head_of_show.sql
--
-- Apply as a single transaction: psql -1 -v ON_ERROR_STOP=1 -f 113_rollback.sql
-- NOT placed under supabase/migrations/ so the migration runner never applies it.
-- No data, no capture-path lock, no write-silence gate — function bodies only.
--
-- EFFECT OF ROLLING BACK: the ~236 head-of-show sales 113 reclaimed return to 'Unattributed',
-- and roughly 2.15 hours of measured show time across 202 sessions disappears from the first
-- host of each show. Nothing is corrupted either way — this is a READ-path definition, so it
-- changes what the functions report, never what is stored.
--
-- To restore the pre-113 read functions, re-apply 106's section E bodies (which 112 did not
-- touch) — they are the versions that floor eff_start at ses.started_at with no reach-back and
-- no rn/ranked CTE. Do that BEFORE dropping the helper below, or the drop will fail on the
-- dependency, which is the correct order of operations.

begin;

-- Restoring the read-function bodies is a copy of 106 section E; not inlined here to avoid a
-- second divergent copy of them living in the repo. Take them from
-- supabase/migrations/106_live_session_host_segments.sql, section E, verbatim.

-- Then, and only then:
drop function if exists public.lensed_session_activity_start(uuid);

commit;
