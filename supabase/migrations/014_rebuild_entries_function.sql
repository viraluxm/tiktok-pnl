CREATE OR REPLACE FUNCTION rebuild_entries(p_user_id uuid)
RETURNS integer AS $$
DECLARE
  row_count integer;
BEGIN
  DELETE FROM entries WHERE user_id = p_user_id AND source = 'tiktok';

  -- TikTok's GMV definition: "doesn't subtract cancellations or refunds"
  -- So we include ALL orders in GMV and order count
  INSERT INTO entries (user_id, product_id, date, gmv, shipping, affiliate, ads, videos_posted, views, source, created_at, updated_at)
  SELECT
    p_user_id,
    null,
    order_date,
    COALESCE(SUM(gmv), 0),
    COALESCE(SUM(shipping), 0),
    COALESCE(SUM(affiliate), 0),
    0, 0,
    COUNT(*),
    'tiktok',
    now(),
    now()
  FROM synced_order_ids
  WHERE user_id = p_user_id
  GROUP BY order_date;

  GET DIAGNOSTICS row_count = ROW_COUNT;
  RETURN row_count;
END;
$$ LANGUAGE plpgsql;
