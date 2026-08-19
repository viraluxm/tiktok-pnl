-- 107_auction_host_id_snapshot.sql
--
-- Forensic per-auction host snapshot.  NOT APPLIED — authored only.
--
-- Split out of 106 deliberately: 106 creates only new objects and can be applied any time,
-- whereas THIS migration touches live_auction_items and therefore carries a capture-path lock.
-- Keeping them together would have forced the whole feature to wait on a silence window.
--
-- ═══════════════════════════ WRITE-SILENCE GATE — REQUIRED ═══════════════════════════
-- live_auction_items is ON THE CAPTURE PATH. Per CLAUDE.md this migration may only be applied
-- during write-activity silence: BOTH of the following more than ~15 minutes stale, checked
-- and reported immediately before applying.
--
--   select now() as checked_at,
--          (select max(created_at)   from public.capture_events) as latest_capture_write,
--          (select max(last_seen_at) from public.live_sessions)  as latest_heartbeat,
--          (select count(*) from public.live_sessions
--            where ended_at is null and started_at >= now() - interval '1 day') as open_sessions;
--
-- At authoring time the gate was WIDE OPEN — a show was live:
--   checked_at 2026-08-19 01:13:35Z | capture idle 0.1 min | heartbeat idle 0.2 min | 7 open sessions
--
-- ADD COLUMN with no default and no backfill is a catalog-only change in PG11+, so the
-- ACCESS EXCLUSIVE lock is brief — but "brief" still means every concurrent bind blocks behind
-- it, and the extension's bind path has no retry for a lock timeout. Do not apply mid-show.
-- ═════════════════════════════════════════════════════════════════════════════════════
--
-- Depends on 106 only for narrative, not structurally: the FK targets employees, so 107 will
-- apply cleanly on its own. Apply 106 first anyway so the column's meaning exists.

begin;

-- Nullable, unpopulated, no default, no backfill, no index. The extension will stamp it in a
-- LATER phase. This is a CROSS-CHECK against the segment log, never the canonical fact —
-- live_session_host_segments is canonical. Nothing reads this column yet.
alter table public.live_auction_items
  add column if not exists host_id_snapshot uuid references public.employees(id) on delete set null;

comment on column public.live_auction_items.host_id_snapshot is
  'Forensic cross-check only. Host believed live at auction-write time, stamped by the '
  'extension in a later phase. NOT canonical — live_session_host_segments is. Disagreement '
  'between this and the segment log is a signal to investigate, not a tiebreak.';

commit;
