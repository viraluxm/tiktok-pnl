-- 114_product_stats_totals_as.sql
--
-- Server-side aggregation for /api/tiktok/product-stats. NOT YET WIRED.
--
-- WHY: the route assembled these totals in TypeScript by paging synced_order_ids and then
-- chunking three `.in()` joins at 300 ids each -- ~310 sequential PostgREST round-trips for a
-- 7-day window and ~1,540 for the 'all' filter (RealDashboard's default), at 0.2-0.36s apiece.
-- Any one of those failing truncated the cost reads, and a truncated COGS read is
-- indistinguishable from a real $0: net profit rendered ~2.5x too high. One query removes the
-- fanout entirely. Measured on prod: 447ms for a 3-day window, 2.5s for all-time (139,981
-- orders) -- against ~90s and ~460s of round-trips respectively.
--
-- Prefix: 105 is the highest in the working tree; 106-113 are claimed by the unapplied
-- host-segment chain on feature branches (106 host segments, 107 host_id_snapshot, 108
-- close_session_host_segment_as, 109/111 host performance, 110 segment vocabulary, 112 boundary
-- adjacency, 113 head-of-show). 114 is the first free prefix. Do not renumber into the gaps.
--
-- SECURITY INVOKER + explicit owner predicates, following the 087/089 pnl_*_as precedent: the
-- route calls this with the service-role client, which bypasses RLS, so the owner scope must be
-- written into the query rather than inherited. NOTE this differs from the pre-existing 4-arg
-- public.lensed_product_stats_totals (SECURITY DEFINER), which this function supersedes. That
-- function is left in place, orphaned and unreferenced -- it was applied by hand and has no
-- migration file. Drop it separately once nothing calls it.
--
-- p_tz is accepted for signature symmetry with the pnl_*_as family and is DELIBERATELY UNUSED:
-- synced_order_ids.order_date is a plain `date`, so there is no timestamp to convert, and the
-- TypeScript this replaces never applied a timezone either. Wiring it up would change bucketing.
--
-- BEHAVIOUR-IDENTICAL PORT, verified field-by-field against the route's own TypeScript for
-- 2026-08-18..20 (all 15 scalars + the byDate series matched exactly). Two quirks of that
-- TypeScript are reproduced ON PURPOSE, not fixed here -- this is a transport change, not a
-- recalibration:
--   * snapshotCogs and cogsCoveredOrders include auction orders whose status is a
--     CANCEL/REVERSE/REFUND/RETURN. The TS built its order-id set before applying the returns
--     filter, so cancelled auction orders still contribute COGS. catalogCogs does exclude them.
--   * a sku row with qty = 0 or NULL is costed as qty 1 (`Number(s.qty) || 1`), not skipped.
-- Fixing either is a separate, gated change with its own before/after fingerprint.
--
-- PLAN SHAPE (learned from the live pnl_by_period_as body, which had to solve this same problem):
--   * p_owner_user_ids, p_store_ids and the date bounds are written INSIDE `scoped`, so the
--     predicates never depend on pushdown through a materialized boundary.
--   * `scoped` is explicitly MATERIALIZED and referenced by `snap`, `cap` and `enriched`: it is
--     already filtered, so one scan reused three times beats three scans. This is the opposite
--     of reading pnl_order_grain, whose multiply-referenced CTEs materialize with the predicates
--     stranded OUTSIDE them.
--   * `cost` aggregates live_auction_item_skus UNRESTRICTED (seq scan + hash aggregate, ~88ms).
--     Restricting it by an id list produces a nested loop an order of magnitude slower.
--   * `snap` and `cap` are driven FROM `scoped` (hash join) rather than pre-aggregating the
--     owner's entire history: that alone took the 3-day case from 1,506ms to 447ms and removed a
--     3.6MB hash-aggregate spill to temp.
--
-- Store scope is applied to synced_order_ids ONLY. The order set drives every downstream join, so
-- scoping it there is sufficient -- and live_auction_items.store_id is NULL on thousands of rows
-- (never retro-filled when a session resolves late), so filtering the auction side by store would
-- silently drop real costs. NULL or empty p_store_ids means all stores; the guard is
-- (p_store_ids is null or cardinality = 0 or store_id = any(p_store_ids)) rather than a bare
-- equality, because a bare `= p_store_id` against NULL silently returns zero rows.

create or replace function public.lensed_product_stats_totals_as(
  p_owner_user_ids uuid[],
  p_store_ids      uuid[],
  p_from           date,
  p_to             date,
  p_tz             text
) returns jsonb
language sql
stable
as $function$
  with scoped as materialized (
    select s.order_id,
           s.order_date,
           btrim(coalesce(s.sku_name, ''))      as sku_name,
           coalesce(s.gmv, 0)::numeric          as gmv,
           coalesce(s.shipping, 0)::numeric     as shipping,
           coalesce(s.affiliate, 0)::numeric    as affiliate,
           coalesce(s.platform_fee, 0)::numeric as platform_fee,
           coalesce(s.units, 0)::int            as units,
           upper(coalesce(s.status, ''))        as ustatus
    from public.synced_order_ids s
    where s.user_id = any(p_owner_user_ids)
      and (p_store_ids is null or cardinality(p_store_ids) = 0 or s.store_id = any(p_store_ids))
      and (p_from is null or s.order_date >= p_from)
      and (p_to   is null or s.order_date <= p_to)
  ),
  -- Unrestricted on purpose: see PLAN SHAPE above.
  cost as (
    select las.auction_item_id,
           sum(coalesce(las.unit_cost_cents_snapshot, 0)
               * (case when coalesce(las.qty, 0) = 0 then 1 else las.qty end))::numeric as cost_cents,
           count(*) as sku_rows
    from public.live_auction_item_skus las
    group by las.auction_item_id
  ),
  -- No las.user_id predicate: every sku row's user_id matches its parent item's (verified 0
  -- exceptions), and the parent is already owner-scoped here, so it would be redundant.
  snap as (
    select sc.order_id,
           sum(c.cost_cents) as cost_cents,
           sum(c.sku_rows)   as sku_rows
    from scoped sc
    join public.live_auction_items lai
         on lai.client_idempotency_key = sc.order_id
        and lai.user_id = any(p_owner_user_ids)
        and lai.status  = 'sold'
    join cost c on c.auction_item_id = lai.id
    group by sc.order_id
  ),
  -- Any capture_events row means the order touched an auction, bound or not -> not catalog.
  cap as (
    select distinct ce.order_id
    from public.capture_events ce
    join scoped sc on sc.order_id = ce.order_id
    where ce.user_id = any(p_owner_user_ids)
  ),
  enriched as materialized (
    select sc.order_date, sc.gmv, sc.shipping, sc.affiliate, sc.platform_fee, sc.units, sc.ustatus,
           (sc.ustatus ~ 'CANCEL|REVERSE|REFUND|RETURN') as is_return,
           coalesce(sn.cost_cents, 0)                    as snap_cost_cents,
           coalesce(sn.sku_rows, 0) > 0                  as is_covered,
           (cp.order_id is not null)                     as has_capture,
           -- Port of resolveCatalogBoxes() -- $0.80 x (boxes + 1) tape cost curve.
           -- -1 is the 'numeric' sentinel: a pure-numeric sku_name is an AUCTION LOT number
           -- (class-c, never captured), not catalog, and must never be given a tape cost.
           -- NULL means no pack indicator ("Default") -> left uncosted and counted, never guessed.
           -- Postgres regex needs \y, not \b, for the word boundary after pcs.
           case
             when sc.sku_name = ''                then null::int
             when sc.sku_name ~ '^[0-9]+$'        then -1
             when sc.sku_name ~* 'year'           then 12
             when substring(sc.sku_name from '(?i)([0-9]+)\s*pcs?\y') is not null
               then greatest(1, round((substring(sc.sku_name from '(?i)([0-9]+)\s*pcs?\y'))::numeric / 30))::int
             when substring(sc.sku_name from '[0-9]+') is not null
               then (substring(sc.sku_name from '[0-9]+'))::int
             else null::int
           end as boxes
    from scoped sc
    left join snap sn on sn.order_id = sc.order_id
    left join cap  cp on cp.order_id = sc.order_id
  ),
  tagged as (
    select e.*,
           (not e.is_return and not e.has_capture and not e.is_covered) as is_catalog
    from enriched e
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
      count(*) filter (where not is_return and gmv = 0
                         and ustatus in ('COMPLETED', 'DELIVERED', 'IN_TRANSIT', '')) as samples_count,
      -- Includes returned/cancelled auction orders, matching the TS. See BEHAVIOUR note above.
      coalesce(sum(snap_cost_cents), 0)                           as snapshot_cost_cents,
      count(*) filter (where is_covered)                          as cogs_covered_orders,
      coalesce(sum(0.8 * (boxes + 1) * (case when units = 0 then 1 else units end))
               filter (where is_catalog and boxes is not null and boxes <> -1), 0) as catalog_cogs,
      count(*) filter (where is_catalog and boxes is not null and boxes <> -1) as catalog_costed_orders,
      count(*) filter (where is_catalog and boxes is null)                     as catalog_unparseable,
      count(*) filter (where is_catalog and boxes = -1)                        as catalog_excluded_numeric
    from tagged
  ),
  bydate as (
    select order_date::text as d,
           jsonb_build_object(
             'gmv',         coalesce(sum(gmv), 0),
             'shipping',    coalesce(sum(shipping), 0),
             'affiliate',   coalesce(sum(affiliate), 0),
             'platformFee', coalesce(sum(platform_fee), 0)
           ) as v
    from tagged
    where not is_return and order_date is not null
    group by order_date
  )
  select jsonb_build_object(
    'totalGMV',                   a.total_gmv,
    'totalShipping',              a.total_shipping,
    'totalAffiliate',             a.total_affiliate,
    'totalPlatformFee',           a.total_platform_fee,
    'totalUnits',                 a.total_units,
    'totalOrders',                a.total_orders,
    'returnsCount',               a.returns_count,
    'returnsAmount',              a.returns_amount,
    'samplesCount',               a.samples_count,
    'snapshotCogs',               round(a.snapshot_cost_cents / 100.0, 2),
    'cogsCoveredOrders',          a.cogs_covered_orders,
    'catalogCogs',                round(a.catalog_cogs, 2),
    'catalogCostedOrders',        a.catalog_costed_orders,
    'catalogUncostedUnparseable', a.catalog_unparseable,
    'catalogExcludedNumeric',     a.catalog_excluded_numeric,
    'byDate',                     coalesce((select jsonb_object_agg(d, v) from bydate), '{}'::jsonb)
  )
  from agg a;
$function$;

comment on function public.lensed_product_stats_totals_as(uuid[], uuid[], date, date, text) is
  'Server-side totals for /api/tiktok/product-stats: GMV/shipping/affiliate/platform-fee/units/orders, returns, samples, snapshot + catalog COGS, and the byDate series. Replaces ~310-1540 sequential PostgREST round-trips with one query. p_tz accepted for signature symmetry and unused (order_date is a date). NULL/empty p_store_ids = all stores. Behaviour-identical port of the TS it replaces, including its treatment of cancelled auction orders and qty=0 sku rows.';

-- create or replace DROPS custom grants, so re-grant every time this function is redefined.
grant execute on function public.lensed_product_stats_totals_as(uuid[], uuid[], date, date, text) to authenticated;
