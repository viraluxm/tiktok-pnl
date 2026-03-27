-- Add status column to track order status for filtering cancelled/refunded
alter table public.synced_order_ids add column if not exists status text;
