-- Add unique constraint for bulk product upsert on tiktok_product_id
create unique index if not exists idx_products_user_tiktok_id_unique
  on public.products(user_id, tiktok_product_id)
  where tiktok_product_id is not null;
