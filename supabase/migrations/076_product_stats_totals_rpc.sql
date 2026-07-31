-- 076_product_stats_totals_rpc.sql
--
-- Server-side aggregation for the dashboard's top-line totals, replacing the JS path in
-- /api/tiktok/product-stats that pulled ALL of a user's synced_order_ids (~71k rows) into the
-- function via ~72 sequential paginated round-trips and summed them in JS. That unscoped fetch
-- (a) returned ORG-WIDE totals under any single store because there was no store filter, and
-- (b) intermittently failed on volume, surfacing as a masked $0. This function does the same
-- arithmetic in ONE round-trip, parameterized by user + store + date.
--
-- Numbering: 076 — next free above everything in supabase/migrations (highest is 075; the only
-- untracked file is a concurrent 072). NOT applied to prod by this change — apply after review.
--
-- SEMANTICS: byte-for-byte matches the JS top-line loop it replaces:
--   • A row is a RETURN when upper(status) matches CANCEL|REVERSE|REFUND|RETURN. Return rows are
--     EXCLUDED from the GMV totals and instead counted as returnsCount / summed as returnsAmount.
--   • totalGMV/Shipping/Affiliate/PlatformFee/Units = SUM over non-return rows; totalOrders =
--     COUNT of non-return rows (which includes $0 sample orders, matching JS).
--   • samplesCount = non-return rows with gmv = 0 and status in COMPLETED/DELIVERED/IN_TRANSIT/''.
--   • byDate = per order_date (non-null) gmv/shipping/affiliate/platformFee over non-return rows.
--   • NULL numeric columns coalesce to 0 (JS `Number(x) || 0`).
-- Store scoping: p_store_id NULL = aggregate across all the user's stores ('all'); otherwise the
-- single store. This is the fix for org-wide-under-one-store.
--
-- SECURITY DEFINER + pinned search_path: the route calls it with the service-role client (which
-- already bypasses RLS); definer just keeps behavior deterministic. It only ever reads the rows
-- for the p_user_id passed by the route (the authenticated user), so no cross-user exposure.

create or replace function public.lensed_product_stats_totals(
  p_user_id   uuid,
  p_store_id  uuid,   -- NULL = all of the user's stores
  p_date_from date,   -- NULL = no lower bound
  p_date_to   date    -- NULL = no upper bound
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with scoped as (
    select
      coalesce(gmv, 0)::numeric          as gmv,
      coalesce(shipping, 0)::numeric     as shipping,
      coalesce(affiliate, 0)::numeric    as affiliate,
      coalesce(platform_fee, 0)::numeric as platform_fee,
      coalesce(units, 0)::numeric        as units,
      order_date,
      upper(coalesce(status, ''))        as ustatus
    from public.synced_order_ids
    where user_id = p_user_id
      and (p_store_id  is null or store_id   = p_store_id)
      and (p_date_from is null or order_date >= p_date_from)
      and (p_date_to   is null or order_date <= p_date_to)
  ),
  classified as (
    select *, (ustatus ~ 'CANCEL|REVERSE|REFUND|RETURN') as is_return
    from scoped
  ),
  agg as (
    select
      coalesce(sum(gmv)          filter (where not is_return), 0) as total_gmv,
      coalesce(sum(shipping)     filter (where not is_return), 0) as total_shipping,
      coalesce(sum(affiliate)    filter (where not is_return), 0) as total_affiliate,
      coalesce(sum(platform_fee) filter (where not is_return), 0) as total_platform_fee,
      coalesce(sum(units)        filter (where not is_return), 0) as total_units,
      count(*)                   filter (where not is_return)     as total_orders,
      count(*)                   filter (where is_return)         as returns_count,
      coalesce(sum(gmv)          filter (where is_return), 0)     as returns_amount,
      count(*) filter (
        where not is_return and gmv = 0
          and ustatus in ('COMPLETED', 'DELIVERED', 'IN_TRANSIT', '')
      ) as samples_count
    from classified
  ),
  bydate as (
    select
      order_date::text as d,
      jsonb_build_object(
        'gmv',         coalesce(sum(gmv), 0),
        'shipping',    coalesce(sum(shipping), 0),
        'affiliate',   coalesce(sum(affiliate), 0),
        'platformFee', coalesce(sum(platform_fee), 0)
      ) as v
    from classified
    where not is_return and order_date is not null
    group by order_date
  )
  select jsonb_build_object(
    'totalGMV',         a.total_gmv,
    'totalShipping',    a.total_shipping,
    'totalAffiliate',   a.total_affiliate,
    'totalPlatformFee', a.total_platform_fee,
    'totalUnits',       a.total_units,
    'totalOrders',      a.total_orders,
    'returnsCount',     a.returns_count,
    'returnsAmount',    a.returns_amount,
    'samplesCount',     a.samples_count,
    'byDate',           coalesce((select jsonb_object_agg(d, v) from bydate), '{}'::jsonb)
  )
  from agg a;
$$;

grant execute on function public.lensed_product_stats_totals(uuid, uuid, date, date)
  to service_role, authenticated;

-- Postgres AUTO-GRANTS EXECUTE to PUBLIC on function creation, so the grant above is NOT
-- sufficient to scope access — PUBLIC (and thus the anon role) would otherwise be able to call
-- this SECURITY DEFINER function with any p_user_id and read that user's aggregates. Revoke it
-- so only service_role + authenticated can execute. (Applied to prod alongside the create.)
revoke execute on function public.lensed_product_stats_totals(uuid, uuid, date, date)
  from public, anon;
