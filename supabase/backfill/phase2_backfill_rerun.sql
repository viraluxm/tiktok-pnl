-- phase2_backfill_rerun.sql
--
-- Section D of migration 106, verbatim. ONE idempotent statement.
--
-- WHY IT EXISTS SEPARATELY: 106's backfill was a one-shot INSERT that ran at
-- 2026-08-19 23:11:32Z. Every hosted session created since then has a host_id and NO segment,
-- and the gap grows with every show. This is the copy to run in the Phase 2 distribution
-- window — after the last pre-Phase-2 show, before the first Phase-2 show — so nobody has to
-- compose SQL at that moment.
--
-- SAFE TO RE-RUN, any number of times. The NOT EXISTS guard is per-session, so a session that
-- already has a segment (backfill_legacy OR extension-written) is skipped. It can never give a
-- session both.
--
-- NO begin/commit here, deliberately: run it with psql -1 so the caller owns the transaction.
--   psql "$LENSED_DB_URL" -1 -v ON_ERROR_STOP=1 -f supabase/backfill/phase2_backfill_rerun.sql
--
-- Expected: INSERT 0 <n>.  Verify afterwards that this returns 0:
--   select count(*) from public.live_sessions ls
--    where ls.host_id is not null and ls.started_at is not null
--      and not exists (select 1 from public.live_session_host_segments s where s.session_id=ls.id);

insert into public.live_session_host_segments
  (user_id, session_id, host_id, started_at, ended_at, source, ended_source)
select
  ls.user_id,
  ls.id,
  ls.host_id,
  ls.started_at,
  case
    when ls.ended_at is null then null   -- leave open — the read path bounds it
    else public.lensed_session_activity_end(ls.id)
  end,
  'backfill_legacy',
  case when ls.ended_at is null then null else 'backfill_legacy' end
from public.live_sessions ls
where ls.host_id is not null
  and ls.started_at is not null
  and not exists (
    select 1 from public.live_session_host_segments s where s.session_id = ls.id
  );
