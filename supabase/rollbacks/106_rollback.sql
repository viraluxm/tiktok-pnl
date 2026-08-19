-- Rollback for 106_live_session_host_segments.sql — SCHEMA + the migration's own backfill.
--
-- Apply as a single transaction: psql -1 -v ON_ERROR_STOP=1 -f 106_rollback.sql
-- NOT placed under supabase/migrations/ so the migration runner never applies it.
--
-- NO capture-path lock and no write-silence gate: 106 creates only new objects. (The gated
-- half is 107; its rollback is separate and DOES carry the gate.)
--
-- 106 is purely additive — it alters no existing object — so this is a clean drop, with ONE
-- data caveat.
--
-- ── DATA CAVEAT — READ BEFORE RUNNING ────────────────────────────────────────────────
-- Dropping live_session_host_segments DESTROYS every segment in it. The 194 backfill_legacy
-- rows are reconstructable at any time (derived wholly from live_sessions + capture_events).
-- Segments written by the extension AFTER 106 ships are NOT — they are the only record that a
-- mid-show switch happened, which is exactly the fact the schema has no other home for.
--
--   * Rolling back BEFORE the extension calls open_session_host_segment: safe.
--   * Rolling back AFTER: archive first, or accept permanent loss of every recorded switch.
--
-- ARCHIVE FIRST (recommended once the extension is live):
--   create table public.live_session_host_segments_archive_106 as
--     select * from public.live_session_host_segments;
--
-- Note the table blocks row DELETEs by trigger, but DROP TABLE does not fire row triggers —
-- so this rollback is not obstructed by the append-only guard. That is intentional: the guard
-- protects against accidental row erasure, not against a deliberate, reviewed rollback.
-- ─────────────────────────────────────────────────────────────────────────────────────
--
-- live_sessions.host_id is NOT touched. 106 keeps that scalar in sync rather than replacing
-- it, so every pre-106 consumer keeps working during and after a rollback with no restore step.

begin;

-- 1. Read functions.
drop function if exists public.pnl_show_hourly_by_host(uuid, text);
drop function if exists public.pnl_show_host_segments(uuid, text);

-- 2. Write RPCs.
drop function if exists public.open_session_host_segment(uuid, uuid, timestamptz, text);
drop function if exists public.close_session_host_segment(uuid, timestamptz, text);

-- 3. Trigger, then its function (the function is still referenced until the trigger is gone).
drop trigger if exists trg_lshs_append_only on public.live_session_host_segments;
drop function if exists public.lensed_guard_host_segment_append_only();

-- 4. The table. CASCADE is NOT used: the only inbound reference is the self-FK
--    (superseded_by), which goes with it. If this DROP errors on an unexpected dependency,
--    STOP and investigate rather than reaching for CASCADE — an unexpected dependent means
--    something started reading segments and the rollback needs review. Policies and indexes
--    drop with the table. Dropping the table also removes its ON DELETE RESTRICT reference to
--    live_sessions, restoring pre-106 delete behaviour there.
drop table if exists public.live_session_host_segments;

-- 5. Session-end helpers LAST — the read functions and the backfill referenced them.
--    NOTE: if any later migration or app code has started calling lensed_sane_session_end
--    (it is the single shared definition of a session end, so it is designed to be reused),
--    these DROPs will fail. That failure is correct — resolve the dependency deliberately
--    rather than dropping a definition something else now relies on.
drop function if exists public.lensed_session_effective_end(uuid);
drop function if exists public.lensed_session_activity(uuid);
drop function if exists public.lensed_sane_session_end(timestamptz, timestamptz, timestamptz, timestamptz, timestamptz);

commit;
