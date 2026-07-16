-- 058_live_session_channel_identity.sql
--
-- Persist the STREAMING CHANNEL / creator identity the extension detects (room
-- owner/anchor) onto live_sessions. The channel (e.g. "onlybids") is NOT the shop
-- (e.g. "Snore") — many channels can sell for one shop — so this is deliberately
-- separate from store_id. These columns seed the future channel→store mapping;
-- channel_sec_uid is the stable join key.
--
-- ⚠️ NOT YET APPLIED — prepared to run AFTER the live. All columns are additive and
-- NULLABLE, so the extension's session INSERT (which never lists them) keeps working
-- untouched: adding nullable columns is a metadata-only change (no table rewrite, no
-- blocking lock on a small table), but we defer it out of an abundance of caution
-- while a live is imminent. The extension (v0.2.27) writes these best-effort and
-- no-ops until they exist, so applying this migration activates DB persistence with
-- no extension rebuild.

begin;

alter table public.live_sessions
  add column if not exists channel_sec_uid    text,
  add column if not exists channel_handle     text,
  add column if not exists channel_nickname   text,
  add column if not exists channel_account_id text;

-- Lookup key for the eventual channel→store mapping.
create index if not exists idx_live_sessions_channel_sec_uid
  on public.live_sessions (channel_sec_uid);

commit;
