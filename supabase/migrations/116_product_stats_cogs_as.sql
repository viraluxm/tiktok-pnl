-- 116_product_stats_cogs_as.sql
--
-- Fix: the dashboard's NET card has been showing net profit with NO COGS subtracted.
--
-- ROOT CAUSE. /api/tiktok/product-stats read pnl_order_grain by paging it 1000 rows at a time
-- (`.range(vOffset, vOffset + PAGE - 1)`), summing cogs_cents in JS. Measured on prod:
--   * ONE 1000-row page costs 32,594 ms (EXPLAIN ANALYZE). The LIMIT/OFFSET forces an
--     *incremental sort* on top of the view's internal dedup, and it is redone every page --
--     12 pages for a 3-day window, ~141 for the 'all' filter.
--   * PostgREST enforces statement_timeout = 8s (from the `authenticator` role). Running that
--     exact page query under `set statement_timeout='8s'` reproduces
--     `57014: canceling statement due to statement timeout`.
-- So page 1 errored, the loop broke with snapshotCogs still 0, and the route returned
-- snapshotCogs: 0. Confirmed against production: the API returned snapshotCogs 0 /
-- cogsCoveredOrders 0 / nonAuctionMerch 0 for 2026-08-18..20 while the correct COGS is $30,181.66.
-- Client-side math was never at fault -- RealDashboard reads orderTotals.snapshotCogs and does
-- subtract it; it was subtracting a real zero.
--
-- THE FIX. Ask Postgres for the aggregate instead of shipping 11,576 rows to Node. Removing the
-- LIMIT removes the incremental-sort pathology entirely: the same aggregate runs in ~2s warm and
-- ~6.6s cold, comfortably inside the 8s budget where 12x32.6s never was. An RPC is required
-- because PostgREST aggregate functions are DISABLED on this project
-- (`PGRST123: Use of aggregate functions is not allowed`) and db-max-rows is 1000, so the route
-- can neither ask for a sum() nor fetch the rows in one request.
--
-- WHY NOT pnl_daily_fact (which would be ~0.4-0.8s). It cannot supply this today:
--   * It was materialized EXACTLY ONCE -- first_run == last_run == 2026-08-16 20:45:28Z. There is
--     no cron for pnl_materialize_daily and no application code references it at all.
--   * It covers 31 of 544 days (2026-07-17..2026-08-16). It has ZERO rows for 2026-08-18..20.
--   * Where it does have rows it is stale: 42 of 113 day x store groups disagree with the view,
--     COGS understated by $12,433.82, because COGS keeps arriving retroactively (late binds, cost
--     snapshots landing after the fact) -- drift is +$7,616.34 on the most recent materialized day
--     and decays backwards, still non-zero 12+ days back.
--   * It structurally cannot supply cogsCoveredOrders: there is no order-count column, and
--     capture_coverage_pct / cost_coverage_pct are a different metric (the latter revenue-weighted).
-- Switching to the fact table needs a backfill AND a recurring re-materialisation of a trailing
-- window first. That is deliberately NOT part of this change.
--
-- NO CHEAP WIN ON THE VIEW's DISK SORT, checked as asked. The `external merge Disk: 10016kB` sort
-- is `allo` = DISTINCT over (cap UNION syn) -- ~195k rows deduped in full no matter what you
-- filter, because cap/syn are multiply-referenced (hence materialised) and business_date is a
-- COALESCE of a computed expression that can never push down. No index can remove it: the sort is
-- over a materialised CTE result, not a table. `work_mem = 64MB` DOES convert it to
-- `quicksort Memory: 18591kB`, but wall-clock is unchanged (2.0-2.4s at default, 64MB and 256MB
-- alike), so it is not worth setting. The view is not redesigned here.
--
-- Returns CENTS (integers, no float drift); the caller divides by 100 once, as it did before.
-- p_tz is deliberately NOT a parameter: business_date is already a date in the view, so there is
-- nothing to convert, and an unused parameter would just invite someone to wire it up later.
-- No store parameter: this route has never filtered by store.
--
-- SECURITY INVOKER + explicit owner predicate, following the 087/089 pnl_*_as precedent -- the
-- route calls this with the service-role client, which bypasses RLS, so the owner scope must be
-- written into the query rather than inherited.
--
-- GRANTS: service-role only, and this one matters. pnl_order_grain reads synced_order_ids, which
-- has RLS DISABLED (relrowsecurity = false, 0 policies) while `authenticated` holds SELECT on it.
-- Granting EXECUTE to authenticated would therefore make this a cross-tenant read primitive: any
-- logged-in user could pass an arbitrary p_owner_user_ids and read that owner's COGS. That is the
-- exact mistake 115 had to clean up. The route uses createAdminClient(), so the grant buys
-- nothing. Per supabase/migrations/CONVENTIONS.md this is revoked and registered in
-- SERVICE_ROLE_ONLY in scripts/check-rpc-grants.mjs (same commit).

create or replace function public.lensed_product_stats_cogs_as(
  p_owner_user_ids uuid[],
  p_from           date,
  p_to             date
) returns jsonb
language sql
stable
as $function$
  select jsonb_build_object(
    -- Auction cost snapshot. No is_sold filter, matching the JS this replaces exactly: cogs_cents
    -- is already NULL in the view unless sold.order_id is present, so the filter is redundant --
    -- verified 0 rows / $0.00 difference on 2026-08-18..20.
    'snapshotCogsCents',    coalesce(sum(og.cogs_cents), 0)::bigint,
    -- Orders carrying a cost snapshot. count(expr) skips NULLs, which is the same set the JS
    -- accumulated into cogsCoveredSet. The view is order-grain (one row per order), so counting
    -- rows equals counting distinct orders.
    'cogsCoveredOrders',    count(og.cogs_cents),
    -- Non-auction merchandise, dropped from headline GMV by the dashboard. The source filter is
    -- kept for exactness even though uncaptured_gmv_cents is non-zero on zero rows where
    -- source <> 'non_auction' (verified across all 544 days).
    'nonAuctionMerchCents', coalesce(sum(og.uncaptured_gmv_cents) filter (where og.source = 'non_auction'), 0)::bigint
  )
  from public.pnl_order_grain og
  where og.user_id = any(p_owner_user_ids)
    and (p_from is null or og.business_date >= p_from)
    and (p_to   is null or og.business_date <= p_to);
$function$;

comment on function public.lensed_product_stats_cogs_as(uuid[], date, date) is
  'COGS totals for /api/tiktok/product-stats: snapshot COGS, covered-order count, and non-auction merchandise (all cents), aggregated server-side from pnl_order_grain. Replaces a 12-page row-by-row read whose per-page cost (32.6s) exceeded PostgREST''s 8s statement_timeout, silently zeroing COGS. Service-role only: synced_order_ids has RLS disabled, so an authenticated grant would be a cross-tenant read.';

-- create or replace DROPS custom grants, so re-apply the revoke every time this is redefined.
revoke execute on function public.lensed_product_stats_cogs_as(uuid[], date, date) from public, anon, authenticated;
