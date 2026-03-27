-- Add SKU fields to synced_order_ids for per-SKU aggregation
alter table public.synced_order_ids add column if not exists sku_id text;
alter table public.synced_order_ids add column if not exists sku_name text;
