-- 103_platform_fee_centralization.sql
-- Centralize the 6% platform fee behind ONE immutable function. NUMERIC (not bigint): the pnl
-- functions carry fractional cents (pnl_by_sku allocates revenue), so a rounded fee would move
-- 87/314 fingerprint rows. numeric x*0.06 makes  revenue - platform_fee_cents(revenue)  identical
-- to today's  revenue * (1 - 0.06)  by exact-decimal distributivity — proven exact against
-- pnl_fingerprint_2026-08-14.json before applying. Behavior-identical: centralization, not recalibration.
-- fee_model marker: 'flat_0.06_v1'.

create or replace function public.platform_fee_cents(gross_cents numeric)
returns numeric language sql immutable as $$ select gross_cents * 0.06 $$;
comment on function public.platform_fee_cents(numeric) is 'Platform fee (flat 6%). fee_model=flat_0.06_v1. Centralizes the 0.06 literal; behavior-identical to revenue*(1-0.06).';


-- pnl_by_period: fee term  sum(s.price_cents) * (1 - 0.06)  ->  sum(s.price_cents) - platform_fee_cents(sum(s.price_cents))
CREATE OR REPLACE FUNCTION public.pnl_by_period(p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_tz text DEFAULT 'America/Los_Angeles'::text)
 RETURNS TABLE(day date, units bigint, revenue_cents numeric, cogs_cents numeric, net_profit_cents numeric)
 LANGUAGE sql
 STABLE
AS $function$
  with sale as (
    select
      lai.id as item_id,
      ce.selling_price_cents as price_cents,
      (coalesce(ce.ordered_at, ce.created_at) at time zone p_tz)::date as sale_date
    from public.live_auction_items lai
    join public.capture_events ce
      on ce.order_id = lai.client_idempotency_key and ce.user_id = lai.user_id
    where lai.status = 'sold'
      and (p_from is null or (coalesce(ce.ordered_at, ce.created_at) at time zone p_tz)::date >= p_from)
      and (p_to   is null or (coalesce(ce.ordered_at, ce.created_at) at time zone p_tz)::date <= p_to)
  ),
  item_cost as (
    select
      las.auction_item_id as item_id,
      sum(las.qty) as units,
      sum(las.qty * coalesce(las.unit_cost_cents_snapshot, isk.unit_cost_cents, 0)) as cogs
    from public.live_auction_item_skus las
    left join public.inventory_skus isk on isk.id = las.inventory_sku_id
    group by las.auction_item_id
  )
  select
    s.sale_date,
    coalesce(sum(ic.units), 0)::bigint,
    sum(s.price_cents)::numeric,
    coalesce(sum(ic.cogs), 0)::numeric,
    (sum(s.price_cents) - public.platform_fee_cents(sum(s.price_cents)) - coalesce(sum(ic.cogs), 0))::numeric  -- 6% platform fee
  from sale s
  left join item_cost ic on ic.item_id = s.item_id
  group by s.sale_date
  order by s.sale_date;
$function$
;

-- pnl_by_period_as: fee term  sum(s.price_cents) * (1 - 0.06)  ->  sum(s.price_cents) - platform_fee_cents(sum(s.price_cents))
CREATE OR REPLACE FUNCTION public.pnl_by_period_as(p_owner_user_ids uuid[], p_from date, p_to date, p_tz text)
 RETURNS TABLE(day date, units bigint, revenue_cents numeric, cogs_cents numeric, net_profit_cents numeric)
 LANGUAGE sql
 STABLE
AS $function$
  with sale as (
    select
      lai.id as item_id,
      ce.selling_price_cents as price_cents,
      (coalesce(ce.ordered_at, ce.created_at) at time zone p_tz)::date as sale_date
    from public.live_auction_items lai
    join public.capture_events ce
      on ce.order_id = lai.client_idempotency_key and ce.user_id = lai.user_id
    where lai.status = 'sold'
      and ce.user_id = any(p_owner_user_ids)
      and (p_from is null or (coalesce(ce.ordered_at, ce.created_at) at time zone p_tz)::date >= p_from)
      and (p_to   is null or (coalesce(ce.ordered_at, ce.created_at) at time zone p_tz)::date <= p_to)
  ),
  item_cost as (
    select
      las.auction_item_id as item_id,
      sum(las.qty) as units,
      sum(las.qty * coalesce(las.unit_cost_cents_snapshot, isk.unit_cost_cents, 0)) as cogs
    from public.live_auction_item_skus las
    left join public.inventory_skus isk on isk.id = las.inventory_sku_id
    group by las.auction_item_id
  )
  select
    s.sale_date,
    coalesce(sum(ic.units), 0)::bigint,
    sum(s.price_cents)::numeric,
    coalesce(sum(ic.cogs), 0)::numeric,
    (sum(s.price_cents) - public.platform_fee_cents(sum(s.price_cents)) - coalesce(sum(ic.cogs), 0))::numeric  -- 6% platform fee
  from sale s
  left join item_cost ic on ic.item_id = s.item_id
  group by s.sale_date
  order by s.sale_date;
$function$
;

-- pnl_by_show: fee term  coalesce(sum(s.price_cents), 0) * (1 - 0.06)  ->  coalesce(sum(s.price_cents), 0) - platform_fee_cents(coalesce(sum(s.price_cents), 0))
CREATE OR REPLACE FUNCTION public.pnl_by_show(p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_tz text DEFAULT 'America/Los_Angeles'::text)
 RETURNS TABLE(session_id uuid, title text, started_at timestamp with time zone, ended_at timestamp with time zone, auctions bigint, units bigint, gmv_cents numeric, cogs_cents numeric, net_profit_cents numeric)
 LANGUAGE sql
 STABLE
AS $function$
  with picked as (
    -- Shows whose SESSION START falls in the selected range (local tz).
    select ls.id, ls.title, ls.started_at, ls.ended_at
    from public.live_sessions ls
    where (p_from is null or (ls.started_at at time zone p_tz)::date >= p_from)
      and (p_to   is null or (ls.started_at at time zone p_tz)::date <= p_to)
  ),
  sale as (
    -- FULL show: every sold+joined sale of the picked sessions (no per-sale clip).
    select lai.id as item_id, lai.session_id, ce.selling_price_cents as price_cents
    from public.live_auction_items lai
    join public.capture_events ce
      on ce.order_id = lai.client_idempotency_key and ce.user_id = lai.user_id
    where lai.status = 'sold' and lai.session_id in (select id from picked)
  ),
  item_cost as (
    select las.auction_item_id as item_id, sum(las.qty) as units,
      sum(las.qty * coalesce(las.unit_cost_cents_snapshot, isk.unit_cost_cents, 0)) as cogs
    from public.live_auction_item_skus las
    left join public.inventory_skus isk on isk.id = las.inventory_sku_id
    group by las.auction_item_id
  )
  select
    p.id,
    p.title,
    p.started_at,
    p.ended_at,
    count(s.item_id)::bigint,
    coalesce(sum(ic.units), 0)::bigint,
    coalesce(sum(s.price_cents), 0)::numeric,
    coalesce(sum(ic.cogs), 0)::numeric,
    (coalesce(sum(s.price_cents), 0) - public.platform_fee_cents(coalesce(sum(s.price_cents), 0)) - coalesce(sum(ic.cogs), 0))::numeric  -- 6% platform fee
  from picked p
  join sale s on s.session_id = p.id                 -- inner: only shows with sales
  left join item_cost ic on ic.item_id = s.item_id
  group by p.id, p.title, p.started_at, p.ended_at
  order by p.started_at desc nulls last;
$function$
;

-- pnl_by_show_as: fee term  coalesce(sum(s.price_cents), 0) * (1 - 0.06)  ->  coalesce(sum(s.price_cents), 0) - platform_fee_cents(coalesce(sum(s.price_cents), 0))
CREATE OR REPLACE FUNCTION public.pnl_by_show_as(p_owner_user_ids uuid[], p_from date, p_to date, p_tz text)
 RETURNS TABLE(session_id uuid, title text, started_at timestamp with time zone, ended_at timestamp with time zone, auctions bigint, units bigint, gmv_cents numeric, cogs_cents numeric, net_profit_cents numeric)
 LANGUAGE sql
 STABLE
AS $function$
  with picked as (
    -- Shows whose SESSION START falls in the selected range (local tz).
    select ls.id, ls.title, ls.started_at, ls.ended_at
    from public.live_sessions ls
    where (p_from is null or (ls.started_at at time zone p_tz)::date >= p_from)
      and (p_to   is null or (ls.started_at at time zone p_tz)::date <= p_to)
      and ls.user_id = any(p_owner_user_ids)
  ),
  sale as (
    -- FULL show: every sold+joined sale of the picked sessions (no per-sale clip).
    select lai.id as item_id, lai.session_id, ce.selling_price_cents as price_cents
    from public.live_auction_items lai
    join public.capture_events ce
      on ce.order_id = lai.client_idempotency_key and ce.user_id = lai.user_id
    where lai.status = 'sold' and lai.session_id in (select id from picked)
      and ce.user_id = any(p_owner_user_ids)
  ),
  item_cost as (
    select las.auction_item_id as item_id, sum(las.qty) as units,
      sum(las.qty * coalesce(las.unit_cost_cents_snapshot, isk.unit_cost_cents, 0)) as cogs
    from public.live_auction_item_skus las
    left join public.inventory_skus isk on isk.id = las.inventory_sku_id
    where las.user_id = any(p_owner_user_ids)
    group by las.auction_item_id
  )
  select
    p.id,
    p.title,
    p.started_at,
    p.ended_at,
    count(s.item_id)::bigint,
    coalesce(sum(ic.units), 0)::bigint,
    coalesce(sum(s.price_cents), 0)::numeric,
    coalesce(sum(ic.cogs), 0)::numeric,
    (coalesce(sum(s.price_cents), 0) - public.platform_fee_cents(coalesce(sum(s.price_cents), 0)) - coalesce(sum(ic.cogs), 0))::numeric  -- 6% platform fee
  from picked p
  join sale s on s.session_id = p.id                 -- inner: only shows with sales
  left join item_cost ic on ic.item_id = s.item_id
  group by p.id, p.title, p.started_at, p.ended_at
  order by p.started_at desc nulls last;
$function$
;

-- pnl_by_sku: fee term  coalesce(p.revenue, 0) * (1 - 0.06)  ->  coalesce(p.revenue, 0) - platform_fee_cents(coalesce(p.revenue, 0))
CREATE OR REPLACE FUNCTION public.pnl_by_sku(p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_tz text DEFAULT 'America/Los_Angeles'::text)
 RETURNS TABLE(sku_id uuid, sku_number integer, title text, is_active boolean, units_sold bigint, revenue_cents numeric, cogs_cents numeric, net_profit_cents numeric, qty_on_hand integer, lead_time_days integer, reorder_point integer, reorder_units bigint, reorder_window_days integer)
 LANGUAGE sql
 STABLE
AS $function$
  with
  -- "Today" in the seller's local tz — the reorder window anchors here, NOT to
  -- the selected Period.
  today as (select (now() at time zone p_tz)::date as d),

  -- Sales within the SELECTED period -> performance columns.
  sale_period as (
    select lai.id as item_id, ce.selling_price_cents as price_cents
    from public.live_auction_items lai
    join public.capture_events ce
      on ce.order_id = lai.client_idempotency_key and ce.user_id = lai.user_id
    where lai.status = 'sold'
      and (p_from is null or (coalesce(ce.ordered_at, ce.created_at) at time zone p_tz)::date >= p_from)
      and (p_to   is null or (coalesce(ce.ordered_at, ce.created_at) at time zone p_tz)::date <= p_to)
  ),
  line as (
    select s.item_id, s.price_cents, las.inventory_sku_id as sku_id, las.qty,
      las.qty * coalesce(las.unit_cost_cents_snapshot, isk.unit_cost_cents, 0) as line_cost
    from sale_period s
    join public.live_auction_item_skus las on las.auction_item_id = s.item_id
    left join public.inventory_skus isk on isk.id = las.inventory_sku_id
  ),
  item_tot as (select item_id, sum(line_cost) as tc, sum(qty) as tq from line group by item_id),
  alloc as (
    select l.sku_id, l.qty, l.line_cost,
      case
        when it.tc > 0 then l.price_cents * (l.line_cost::numeric / it.tc)
        when it.tq > 0 then l.price_cents * (l.qty::numeric / it.tq)
        else 0
      end as alloc_rev
    from line l join item_tot it on it.item_id = l.item_id
  ),
  perf as (
    select sku_id, sum(qty) as units, sum(alloc_rev) as revenue, sum(line_cost) as cogs
    from alloc group by sku_id
  ),

  -- Reorder velocity basis: FIXED, period-independent. All sold lines lifetime,
  -- with the local sale date, per SKU.
  line_all as (
    select las.inventory_sku_id as sku_id, las.qty,
      (coalesce(ce.ordered_at, ce.created_at) at time zone p_tz)::date as sale_date
    from public.live_auction_items lai
    join public.capture_events ce
      on ce.order_id = lai.client_idempotency_key and ce.user_id = lai.user_id
    join public.live_auction_item_skus las on las.auction_item_id = lai.id
    where lai.status = 'sold'
  ),
  reorder as (
    select
      la.sku_id,
      min(la.sale_date) as first_sale,
      -- units sold in the trailing 30 local days (anchored to local "today")
      coalesce(sum(la.qty) filter (where la.sale_date > (select d from today) - 30), 0) as units_window
    from line_all la
    group by la.sku_id
  )

  select
    isk.id,
    isk.sku_number,
    isk.title,
    isk.is_active,
    coalesce(p.units, 0)::bigint,
    coalesce(p.revenue, 0)::numeric,
    coalesce(p.cogs, 0)::numeric,
    (coalesce(p.revenue, 0) - public.platform_fee_cents(coalesce(p.revenue, 0)) - coalesce(p.cogs, 0))::numeric,  -- 6% platform fee
    isk.qty_on_hand,
    isk.lead_time_days,
    isk.reorder_point,
    coalesce(r.units_window, 0)::bigint,
    case
      -- No sales ever: nominal 30d window (units_window = 0 -> client shows "—").
      when r.first_sale is null then 30
      -- Clamp to the SKU's own history so new SKUs aren't understated.
      else greatest(1, least(30, ((select d from today) - r.first_sale)))
    end::integer
  from public.inventory_skus isk
  left join perf p on p.sku_id = isk.id
  left join reorder r on r.sku_id = isk.id;
$function$
;

-- pnl_by_sku_as: fee term  coalesce(p.revenue, 0) * (1 - 0.06)  ->  coalesce(p.revenue, 0) - platform_fee_cents(coalesce(p.revenue, 0))
CREATE OR REPLACE FUNCTION public.pnl_by_sku_as(p_owner_user_ids uuid[], p_from date, p_to date, p_tz text)
 RETURNS TABLE(sku_id uuid, sku_number integer, title text, is_active boolean, units_sold bigint, revenue_cents numeric, cogs_cents numeric, net_profit_cents numeric, qty_on_hand integer, lead_time_days integer, reorder_point integer, reorder_units bigint, reorder_window_days integer)
 LANGUAGE sql
 STABLE
AS $function$
  with
  -- "Today" in the seller's local tz — the reorder window anchors here, NOT to
  -- the selected Period.
  today as (select (now() at time zone p_tz)::date as d),

  -- Sales within the SELECTED period -> performance columns.
  sale_period as (
    select lai.id as item_id, ce.selling_price_cents as price_cents
    from public.live_auction_items lai
    join public.capture_events ce
      on ce.order_id = lai.client_idempotency_key and ce.user_id = lai.user_id
    where lai.status = 'sold'
      and ce.user_id = any(p_owner_user_ids)
      and (p_from is null or (coalesce(ce.ordered_at, ce.created_at) at time zone p_tz)::date >= p_from)
      and (p_to   is null or (coalesce(ce.ordered_at, ce.created_at) at time zone p_tz)::date <= p_to)
  ),
  line as (
    select s.item_id, s.price_cents, las.inventory_sku_id as sku_id, las.qty,
      las.qty * coalesce(las.unit_cost_cents_snapshot, isk.unit_cost_cents, 0) as line_cost
    from sale_period s
    join public.live_auction_item_skus las on las.auction_item_id = s.item_id
    left join public.inventory_skus isk on isk.id = las.inventory_sku_id
  ),
  item_tot as (select item_id, sum(line_cost) as tc, sum(qty) as tq from line group by item_id),
  alloc as (
    select l.sku_id, l.qty, l.line_cost,
      case
        when it.tc > 0 then l.price_cents * (l.line_cost::numeric / it.tc)
        when it.tq > 0 then l.price_cents * (l.qty::numeric / it.tq)
        else 0
      end as alloc_rev
    from line l join item_tot it on it.item_id = l.item_id
  ),
  perf as (
    select sku_id, sum(qty) as units, sum(alloc_rev) as revenue, sum(line_cost) as cogs
    from alloc group by sku_id
  ),

  -- Reorder velocity basis: FIXED, period-independent. All sold lines lifetime,
  -- with the local sale date, per SKU.
  line_all as (
    select las.inventory_sku_id as sku_id, las.qty,
      (coalesce(ce.ordered_at, ce.created_at) at time zone p_tz)::date as sale_date
    from public.live_auction_items lai
    join public.capture_events ce
      on ce.order_id = lai.client_idempotency_key and ce.user_id = lai.user_id
    join public.live_auction_item_skus las on las.auction_item_id = lai.id
    where lai.status = 'sold'
      and ce.user_id = any(p_owner_user_ids)
  ),
  reorder as (
    select
      la.sku_id,
      min(la.sale_date) as first_sale,
      -- units sold in the trailing 30 local days (anchored to local "today")
      coalesce(sum(la.qty) filter (where la.sale_date > (select d from today) - 30), 0) as units_window
    from line_all la
    group by la.sku_id
  )

  select
    isk.id,
    isk.sku_number,
    isk.title,
    isk.is_active,
    coalesce(p.units, 0)::bigint,
    coalesce(p.revenue, 0)::numeric,
    coalesce(p.cogs, 0)::numeric,
    (coalesce(p.revenue, 0) - public.platform_fee_cents(coalesce(p.revenue, 0)) - coalesce(p.cogs, 0))::numeric,  -- 6% platform fee
    isk.qty_on_hand,
    isk.lead_time_days,
    isk.reorder_point,
    coalesce(r.units_window, 0)::bigint,
    case
      -- No sales ever: nominal 30d window (units_window = 0 -> client shows "—").
      when r.first_sale is null then 30
      -- Clamp to the SKU's own history so new SKUs aren't understated.
      else greatest(1, least(30, ((select d from today) - r.first_sale)))
    end::integer
  from public.inventory_skus isk
  left join perf p on p.sku_id = isk.id
  left join reorder r on r.sku_id = isk.id
  where isk.user_id = any(p_owner_user_ids);
$function$
;

-- pnl_show_hourly: fee term  sum(s.price_cents) * (1 - 0.06)  ->  sum(s.price_cents) - platform_fee_cents(sum(s.price_cents))
CREATE OR REPLACE FUNCTION public.pnl_show_hourly(p_session_id uuid, p_tz text DEFAULT 'America/Los_Angeles'::text)
 RETURNS TABLE(hour_start timestamp without time zone, hour_of_day integer, auctions bigint, units bigint, revenue_cents numeric, cogs_cents numeric, net_profit_cents numeric)
 LANGUAGE sql
 STABLE
AS $function$
  with sale as (
    select
      lai.id as item_id,
      ce.selling_price_cents as price_cents,
      (coalesce(ce.ordered_at, ce.created_at) at time zone p_tz) as sale_local
    from public.live_auction_items lai
    join public.capture_events ce
      on ce.order_id = lai.client_idempotency_key and ce.user_id = lai.user_id
    where lai.status = 'sold' and lai.session_id = p_session_id
  ),
  item_cost as (
    select las.auction_item_id as item_id, sum(las.qty) as units,
      sum(las.qty * coalesce(las.unit_cost_cents_snapshot, isk.unit_cost_cents, 0)) as cogs
    from public.live_auction_item_skus las
    left join public.inventory_skus isk on isk.id = las.inventory_sku_id
    group by las.auction_item_id
  )
  select
    date_trunc('hour', s.sale_local)::timestamp,
    extract(hour from s.sale_local)::integer,
    count(*)::bigint,
    coalesce(sum(ic.units), 0)::bigint,
    sum(s.price_cents)::numeric,
    coalesce(sum(ic.cogs), 0)::numeric,
    (sum(s.price_cents) - public.platform_fee_cents(sum(s.price_cents)) - coalesce(sum(ic.cogs), 0))::numeric  -- 6% platform fee
  from sale s
  left join item_cost ic on ic.item_id = s.item_id
  group by 1, 2
  order by 1;
$function$
;

-- pnl_show_hourly_as: fee term  sum(s.price_cents) * (1 - 0.06)  ->  sum(s.price_cents) - platform_fee_cents(sum(s.price_cents))
CREATE OR REPLACE FUNCTION public.pnl_show_hourly_as(p_owner_user_ids uuid[], p_session_id uuid, p_tz text)
 RETURNS TABLE(hour_start timestamp without time zone, hour_of_day integer, auctions bigint, units bigint, revenue_cents numeric, cogs_cents numeric, net_profit_cents numeric)
 LANGUAGE sql
 STABLE
AS $function$
  with sale as (
    select
      lai.id as item_id,
      ce.selling_price_cents as price_cents,
      (coalesce(ce.ordered_at, ce.created_at) at time zone p_tz) as sale_local
    from public.live_auction_items lai
    join public.capture_events ce
      on ce.order_id = lai.client_idempotency_key and ce.user_id = lai.user_id
    where lai.status = 'sold' and lai.session_id = p_session_id
      and lai.user_id = any(p_owner_user_ids)
  ),
  item_cost as (
    select las.auction_item_id as item_id, sum(las.qty) as units,
      sum(las.qty * coalesce(las.unit_cost_cents_snapshot, isk.unit_cost_cents, 0)) as cogs
    from public.live_auction_item_skus las
    left join public.inventory_skus isk on isk.id = las.inventory_sku_id
    group by las.auction_item_id
  )
  select
    date_trunc('hour', s.sale_local)::timestamp,
    extract(hour from s.sale_local)::integer,
    count(*)::bigint,
    coalesce(sum(ic.units), 0)::bigint,
    sum(s.price_cents)::numeric,
    coalesce(sum(ic.cogs), 0)::numeric,
    (sum(s.price_cents) - public.platform_fee_cents(sum(s.price_cents)) - coalesce(sum(ic.cogs), 0))::numeric  -- 6% platform fee
  from sale s
  left join item_cost ic on ic.item_id = s.item_id
  group by 1, 2
  order by 1;
$function$
;
