-- Add platform_fee column to entries for TikTok platform commission
alter table public.entries add column if not exists platform_fee numeric(12,2) default 0;
