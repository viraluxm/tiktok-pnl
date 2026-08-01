-- 077_rebuild_entries_scoped.sql
-- rebuild_entries did a full DELETE + INSERT…SELECT over the user's ENTIRE tiktok history on
-- EVERY sync — even a caught-up 5-minute poll that only re-touched today rebuilt all 365 days.
-- Add an optional date floor so the caller can rebuild only the dates a batch actually changed.
--
--   p_since NULL  → full rebuild (unchanged behaviour; safe default, backward-compatible with
--                   the old 1-arg signature and any other caller).
--   p_since set   → rebuild ONLY entries on/after that date. The sync loop walks forward from its
--                   cursor and re-syncs today, so the earliest date it can have changed is its
--                   starting cursor day → the caller passes that. Orders older than the window are
--                   untouched this batch, so their entries stay correct and are left alone.
--
-- Signature changes (adds a defaulted 2nd arg), so DROP the old 1-arg then CREATE. Calls with a
-- single uuid still resolve to the new function via the default.

drop function if exists public.rebuild_entries(uuid);

create or replace function public.rebuild_entries(p_user_id uuid, p_since date default null)
returns integer as $$
declare
  row_count integer;
begin
  delete from entries
   where user_id = p_user_id and source = 'tiktok'
     and (p_since is null or date >= p_since);

  insert into entries (user_id, product_id, date, gmv, shipping, affiliate, ads, videos_posted, views, units_sold, source, created_at, updated_at)
  select
    o.user_id,
    p.id,
    o.order_date,
    coalesce(sum(o.gmv), 0),
    coalesce(sum(o.shipping), 0),
    coalesce(sum(o.affiliate), 0),
    0, 0,
    count(*),
    coalesce(sum(o.units), 0),
    'tiktok',
    now(),
    now()
  from synced_order_ids o
  left join products p on p.user_id = o.user_id and p.tiktok_product_id = o.tiktok_product_id
  where o.user_id = p_user_id
    and (p_since is null or o.order_date >= p_since)
  group by o.user_id, p.id, o.order_date;

  get diagnostics row_count = row_count;
  return row_count;
end;
$$ language plpgsql;
