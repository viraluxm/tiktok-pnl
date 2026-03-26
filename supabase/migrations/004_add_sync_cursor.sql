-- Add sync cursor columns to track incremental sync progress
alter table public.tiktok_connections add column if not exists sync_cursor text;
alter table public.tiktok_connections add column if not exists sync_page_cursor text;
