-- 057_widen_live_session_end_source.sql
--
-- Widen the allowed values for live_sessions.end_source. The original CHECK only
-- permitted 'webcast','sweeper','manual', which REJECTS the values the session-
-- attribution work writes:
--   * 'cleanup_backfill' — the one-time cleanup of orphaned 'live' sessions
--   * 'auto_ender'       — the timeout auto-ender (src/lib/sessions/autoEnd.ts)
--   * 'tab_closed'       — the extension's best-effort close on live-tab close
-- Without this, those writes fail with 23514 (check_violation).
--
-- Safe / additive: the value list only grows, and every existing row has
-- end_source = NULL, so the re-added CHECK validates instantly. Single transaction.

begin;

alter table public.live_sessions drop constraint if exists live_sessions_end_source_check;

alter table public.live_sessions add constraint live_sessions_end_source_check
  check (
    end_source is null
    or end_source = any (array['webcast', 'sweeper', 'manual', 'cleanup_backfill', 'auto_ender', 'tab_closed'])
  );

commit;
