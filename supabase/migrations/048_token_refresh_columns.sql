-- 048_token_refresh_columns.sql — TikTok token-refresh fix (columns only; additive).
-- Supports: correct refresh-token expiry tracking, a single-flight refresh lock, and a
-- surfaced sync error state (fail-loud instead of fake "caught up"). All nullable/additive —
-- safe on every connection; no data touched here. The one-time 2082-expiry reset is a
-- SEPARATE reviewed UPDATE (scoped to lots-of-steals this pass), not part of this migration.
-- Reverse: alter table public.tiktok_connections
--   drop column if exists refresh_token_expires_at, drop column if exists token_refresh_lock_at,
--   drop column if exists sync_error, drop column if exists sync_error_at;

begin;

alter table public.tiktok_connections
  add column if not exists refresh_token_expires_at timestamptz,
  add column if not exists token_refresh_lock_at    timestamptz,
  add column if not exists sync_error               text,
  add column if not exists sync_error_at            timestamptz;

commit;
