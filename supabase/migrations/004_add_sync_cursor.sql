-- Add sync_cursor column to track incremental sync progress
alter table public.tiktok_connections add column if not exists sync_cursor text;
