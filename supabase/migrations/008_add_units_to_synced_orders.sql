-- Add units column to track line item count per order
alter table public.synced_order_ids add column if not exists units integer default 1;
