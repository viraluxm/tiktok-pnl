-- Rollback for 107_auction_host_id_snapshot.sql
--
-- Apply as a single transaction: psql -1 -v ON_ERROR_STOP=1 -f 107_rollback.sql
-- NOT placed under supabase/migrations/ so the migration runner never applies it.
--
-- SAME WRITE-SILENCE GATE AS THE FORWARD MIGRATION — this DROP takes an ACCESS EXCLUSIVE lock
-- on live_auction_items, a capture-path table. Do not run mid-show.
--
-- DATA CHECK before running: 107 leaves the column empty, but if a later phase has begun
-- stamping it, this DROP destroys those values.
--   select count(*) as total, count(host_id_snapshot) as stamped from public.live_auction_items;
-- A non-zero `stamped` means the extension is already writing it — stop and archive first.

begin;

alter table public.live_auction_items drop column if exists host_id_snapshot;

commit;
