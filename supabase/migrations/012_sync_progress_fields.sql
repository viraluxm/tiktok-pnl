-- Add sync progress tracking fields
alter table public.tiktok_connections add column if not exists sync_started_at timestamptz;
alter table public.tiktok_connections add column if not exists sync_progress_orders integer default 0;
alter table public.tiktok_connections add column if not exists sync_progress_day text;
