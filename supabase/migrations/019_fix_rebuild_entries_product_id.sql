-- Fix rebuild_entries: join synced_order_ids with products to get a valid product_id
-- Previously inserted null for product_id which violates the NOT NULL constraint,
-- causing all TikTok entries to silently fail insertion.

-- First, allow product_id to be nullable so orders without a matched product still appear
ALTER TABLE public.entries ALTER COLUMN product_id DROP NOT NULL;

-- Now fix the function to look up the real product_id via tiktok_product_id
CREATE OR REPLACE FUNCTION rebuild_entries(p_user_id uuid)
RETURNS integer AS $$
DECLARE
  row_count integer;
BEGIN
  DELETE FROM entries WHERE user_id = p_user_id AND source = 'tiktok';

  INSERT INTO entries (user_id, product_id, date, gmv, shipping, affiliate, ads, videos_posted, views, units_sold, source, created_at, updated_at)
  SELECT
    o.user_id,
    p.id,
    o.order_date,
    COALESCE(SUM(o.gmv), 0),
    COALESCE(SUM(o.shipping), 0),
    COALESCE(SUM(o.affiliate), 0),
    0, 0,
    COUNT(*),
    COALESCE(SUM(o.units), 0),
    'tiktok',
    now(),
    now()
  FROM synced_order_ids o
  LEFT JOIN products p ON p.user_id = o.user_id AND p.tiktok_product_id = o.tiktok_product_id
  WHERE o.user_id = p_user_id
  GROUP BY o.user_id, p.id, o.order_date;

  GET DIAGNOSTICS row_count = ROW_COUNT;
  RETURN row_count;
END;
$$ LANGUAGE plpgsql;
