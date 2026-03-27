-- Add TikTok product fields to products table
alter table public.products add column if not exists tiktok_product_id text;
alter table public.products add column if not exists image_url text;
alter table public.products add column if not exists sku text;

-- Index for fast lookup by tiktok_product_id
create index if not exists idx_products_tiktok_id on public.products(user_id, tiktok_product_id);

-- Add tiktok_product_id to synced_order_ids for per-product aggregation
alter table public.synced_order_ids add column if not exists tiktok_product_id text;
