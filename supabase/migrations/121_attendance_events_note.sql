-- 121_attendance_events_note.sql
-- A free-text note on an attendance event. Written today by the RELEASE flow, which now requires
-- the worker to say why they cannot work the shift.
--
-- ⚠️ MIGRATION LEDGER: this database has NO ledger. Migrations are applied BY HAND and this file
--    is the ONLY record that it ran. Prefix 121 sits above the highest claimed prefix (120,
--    time_off_requests — applied to prod 2026-09-01).
--    ➜ BEFORE APPLYING: confirm attendance_events has no `note` column already.
--
-- LOCK FOOTPRINT: CLASS A. ADD COLUMN, nullable, NO default and NO volatile expression, so Postgres
-- records it in the catalog without rewriting the table. It takes a brief ACCESS EXCLUSIVE lock to
-- update the catalog entry only — apply with `set local lock_timeout = '3s'` so a contended lock
-- ABORTS rather than queueing in front of readers. attendance_events is not in the capture or
-- order-sync path.
--
-- Deliberately nullable with no backfill: releases recorded before this migration genuinely have
-- no reason, and inventing one would be a lie in the payroll trail. The NOT-NULL requirement is
-- enforced in application code for NEW releases (src/lib/schedule/release.ts), not by a constraint
-- that would retroactively invalidate honest history.

alter table public.attendance_events add column if not exists note text;

comment on column public.attendance_events.note is
  'Worker-supplied free text. Required by the release flow (why they cannot work the shift); NULL on releases recorded before migration 121 and on event types that do not collect one.';
