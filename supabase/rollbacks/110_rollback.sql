-- Rollback for 110_segment_source_vocabulary.sql
--
-- Apply as a single transaction: psql -1 -v ON_ERROR_STOP=1 -f 110_rollback.sql
-- NOT placed under supabase/migrations/ so the migration runner never applies it.
-- No capture-path lock, no write-silence gate.
--
-- ── DATA CHECK FIRST — THIS ROLLBACK NARROWS THE VOCABULARY ──────────────────────────
-- 110 added 'user_change_close' and 'tab_closed'. Restoring the pre-110 CHECK will FAIL if any
-- row already uses them (which is correct — it refuses to leave rows in violation). Check:
--
--   select source, ended_source, count(*) from public.live_session_host_segments
--    where source in ('user_change_close','tab_closed')
--       or ended_source in ('user_change_close','tab_closed')
--    group by 1,2;
--
-- If that returns rows, the Phase 2 writer has already used the new vocabulary. Do NOT force it:
-- either keep 110 (the values are harmless) or decide deliberately what those segments should
-- have been and rewrite them via supersede-and-replace before rolling back.
-- ─────────────────────────────────────────────────────────────────────────────────────
--
-- The three RPC bodies are NOT reverted. 110 changed exactly one line in each (an inline IN
-- list became a function call) and left every other statement identical, so leaving them
-- pointing at lensed_is_valid_segment_source is harmless — which is why the function is dropped
-- LAST and only if nothing references it.

begin;

-- 1. Restore the literal CHECK constraints from 106 (pre-110 vocabulary).
alter table public.live_session_host_segments
  drop constraint if exists live_session_host_segments_source_check;
alter table public.live_session_host_segments
  add constraint live_session_host_segments_source_check
  check (source in ('extension_switch','session_create','session_reuse',
                    'room_change_close','session_end','backfill_legacy','manual_correction'));

alter table public.live_session_host_segments
  drop constraint if exists live_session_host_segments_ended_source_check;
alter table public.live_session_host_segments
  add constraint live_session_host_segments_ended_source_check
  check (ended_source is null or ended_source in (
    'extension_switch','session_create','session_reuse',
    'room_change_close','session_end','backfill_legacy','manual_correction'));

-- 2. The shared vocabulary function. This DROP will FAIL while the three RPCs still call it —
--    that failure is CORRECT. Either leave the function in place (harmless: nothing else
--    depends on it and the constraints no longer reference it), or restore the 106/108 RPC
--    bodies with their inline IN lists first and then drop it.
-- drop function if exists public.lensed_is_valid_segment_source(text);

commit;
