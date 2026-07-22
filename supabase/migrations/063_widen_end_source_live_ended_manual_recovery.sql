-- 063: widen live_sessions.end_source CHECK
--
-- Adds two allowed values:
--   'live_ended'      — PRIMARY real-time end signal from the extension (the
--                       shop.tiktok.com .../streamer_desktop/live/end POST). Distinct from
--                       the backstops so end-source telemetry can show primary vs backstop.
--   'manual_recovery' — operator-initiated end during incident/orphan cleanup.
--
-- Verified against the LIVE constraint (NOT repo 057 — the ledger has drifted; live also
-- allows 'webcast','sweeper','manual' which 057 did not). This preserves EVERY currently
-- allowed value and appends the two new ones, so validating existing rows cannot fail.
--
-- Apply on a quiet window BEFORE distributing extension v0.6.0: an end-write with
-- end_source='live_ended' violates the current CHECK, so the extension must not ship first.

alter table public.live_sessions
  drop constraint if exists live_sessions_end_source_check;

alter table public.live_sessions
  add constraint live_sessions_end_source_check
  check (
    end_source is null
    or end_source = any (array[
      'webcast',
      'sweeper',
      'manual',
      'cleanup_backfill',
      'auto_ender',
      'tab_closed',
      'live_ended',
      'manual_recovery'
    ]::text[])
  );
