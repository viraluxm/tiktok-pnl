-- 039_pnl_aggregation_functions.sql
-- P&L drill-down aggregations for the P&L tab (By SKU / By Show / By Period).
--
-- FUNCTIONS ONLY. This migration must NOT alter any table or modify any data.
--
-- Why Postgres and not JS: a busy month easily exceeds the 1000-row PostgREST
-- cap (699 auction items / 816 SKU lines / 838 capture events today). All
-- aggregation happens here so the client only ever fetches small result sets.
--
-- Real won-price P&L join (verified against production dvucodtdojumvplmgjeu):
--   live_auction_items.client_idempotency_key = capture_events.order_id
--   -> capture_events.selling_price_cents  (the ACTUAL sold price, not the ASP goal)
-- All 636 sold items join 1:1 to a capture_event with a non-null price.
--
-- Sale-moment timestamp: capture_events.ordered_at (the TikTok order-placement
--   time = the buyer's actual purchase moment), falling back to created_at (our
--   capture time, a few seconds later). closed_at is the host's close click, not
--   the buyer's moment. All three cluster within seconds; ordered_at is the
--   semantically correct one for hourly bucketing.
--
-- COGS: per-sale FROZEN cost live_auction_item_skus.unit_cost_cents_snapshot
--   (100% populated), falling back to the SKU's current unit_cost_cents. All
--   costs are in CENTS; callers format to dollars on display.
--
-- Platform fee: 6% of revenue (TikTok Shop), matching the dashboard model.
--   Change the 0.06 literal in each function if the rate changes.
--
-- Bundles (99 sold items have >1 SKU line): for By SKU, the item's sold price is
--   allocated across its lines by COGS share (falling back to qty share when the
--   bundle's total cost is 0). This conserves revenue exactly (verified: the sum
--   of allocated revenue equals the sum of item prices). By Show / By Period /
--   hourly aggregate price at the ITEM level, so no allocation is needed there.
--
-- SECURITY INVOKER: runs with the caller's RLS context (auth.uid()), same as the
--   025 auction RPCs. Each seller sees only their own data.
--
-- p_tz: the seller's IANA timezone (e.g. 'America/Los_Angeles'). Buckets and
--   period boundaries are evaluated in LOCAL time, matching how the app's Period
--   selector computes dates (shop tz) and how the Shows tab renders times.

-- ── Lens 1: By SKU ──────────────────────────────────────────────────────
-- One row per inventory SKU (even with zero sales in the period) so the catalog
-- always shows. period_days is returned so the client can derive velocity /
-- days-of-cover without a second query.
create or replace function public.pnl_by_sku(
  p_from date default null,
  p_to date default null,
  p_tz text default 'America/Los_Angeles'
)
returns table (
  sku_id uuid,
  sku_number integer,
  title text,
  is_active boolean,
  units_sold bigint,
  revenue_cents numeric,
  cogs_cents numeric,
  net_profit_cents numeric,
  qty_on_hand integer,
  lead_time_days integer,
  reorder_point integer,
  period_days integer
)
language sql
stable
security invoker
as $$
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
  line as (
    select
      s.item_id,
      s.price_cents,
      las.inventory_sku_id as sku_id,
      las.qty,
      las.qty * coalesce(las.unit_cost_cents_snapshot, isk.unit_cost_cents, 0) as line_cost
    from sale s
    join public.live_auction_item_skus las on las.auction_item_id = s.item_id
    left join public.inventory_skus isk on isk.id = las.inventory_sku_id
  ),
  item_tot as (
    select item_id, sum(line_cost) as tot_cost, sum(qty) as tot_qty
    from line group by item_id
  ),
  alloc as (
    select
      l.sku_id,
      l.qty,
      l.line_cost,
      -- allocate the item's sold price across its lines (bundle split)
      case
        when it.tot_cost > 0 then l.price_cents * (l.line_cost::numeric / it.tot_cost)
        when it.tot_qty  > 0 then l.price_cents * (l.qty::numeric / it.tot_qty)
        else 0
      end as alloc_rev
    from line l
    join item_tot it on it.item_id = l.item_id
  ),
  agg as (
    select sku_id, sum(qty) as units, sum(alloc_rev) as revenue, sum(line_cost) as cogs
    from alloc group by sku_id
  ),
  params as (
    select case
      when p_from is not null and p_to is not null then (p_to - p_from + 1)
      -- "all time": span from the earliest sale in scope through today
      else greatest(1, (current_date - coalesce((select min(sale_date) from sale), current_date) + 1))
    end as period_days
  )
  select
    isk.id,
    isk.sku_number,
    isk.title,
    isk.is_active,
    coalesce(a.units, 0)::bigint,
    coalesce(a.revenue, 0)::numeric,
    coalesce(a.cogs, 0)::numeric,
    (coalesce(a.revenue, 0) * (1 - 0.06) - coalesce(a.cogs, 0))::numeric,  -- 6% platform fee
    isk.qty_on_hand,
    isk.lead_time_days,
    isk.reorder_point,
    (select period_days from params)::integer
  from public.inventory_skus isk
  left join agg a on a.sku_id = isk.id;
$$;

-- ── Lens 2: By Show ─────────────────────────────────────────────────────
-- One row per live session with sold sales in the period. Price is summed at the
-- item level (no bundle split needed). units/COGS come from the SKU lines.
create or replace function public.pnl_by_show(
  p_from date default null,
  p_to date default null,
  p_tz text default 'America/Los_Angeles'
)
returns table (
  session_id uuid,
  title text,
  started_at timestamptz,
  ended_at timestamptz,
  auctions bigint,
  units bigint,
  gmv_cents numeric,
  cogs_cents numeric,
  net_profit_cents numeric
)
language sql
stable
security invoker
as $$
  with sale as (
    select lai.id as item_id, lai.session_id, ce.selling_price_cents as price_cents
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
    s.session_id,
    ls.title,
    ls.started_at,
    ls.ended_at,
    count(*)::bigint,
    coalesce(sum(ic.units), 0)::bigint,
    sum(s.price_cents)::numeric,
    coalesce(sum(ic.cogs), 0)::numeric,
    (sum(s.price_cents) * (1 - 0.06) - coalesce(sum(ic.cogs), 0))::numeric  -- 6% platform fee
  from sale s
  join public.live_sessions ls on ls.id = s.session_id
  left join item_cost ic on ic.item_id = s.item_id
  group by s.session_id, ls.title, ls.started_at, ls.ended_at
  order by ls.started_at desc nulls last;
$$;

-- ── Lens 2 drill-down: per-hour breakdown for one show ───────────────────
-- Buckets the session's sold sales into LOCAL clock-hour buckets by sale moment.
-- Same period filter as pnl_by_show, so hourly rows SUM EXACTLY to the show row.
create or replace function public.pnl_show_hourly(
  p_session_id uuid,
  p_from date default null,
  p_to date default null,
  p_tz text default 'America/Los_Angeles'
)
returns table (
  hour_start timestamp,     -- local wall-clock hour bucket
  hour_of_day integer,      -- 0..23 local
  auctions bigint,
  units bigint,
  revenue_cents numeric,
  cogs_cents numeric,
  net_profit_cents numeric
)
language sql
stable
security invoker
as $$
  with sale as (
    select
      lai.id as item_id,
      ce.selling_price_cents as price_cents,
      (coalesce(ce.ordered_at, ce.created_at) at time zone p_tz) as sale_local
    from public.live_auction_items lai
    join public.capture_events ce
      on ce.order_id = lai.client_idempotency_key and ce.user_id = lai.user_id
    where lai.status = 'sold'
      and lai.session_id = p_session_id
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
    date_trunc('hour', s.sale_local)::timestamp,
    extract(hour from s.sale_local)::integer,
    count(*)::bigint,
    coalesce(sum(ic.units), 0)::bigint,
    sum(s.price_cents)::numeric,
    coalesce(sum(ic.cogs), 0)::numeric,
    (sum(s.price_cents) * (1 - 0.06) - coalesce(sum(ic.cogs), 0))::numeric  -- 6% platform fee
  from sale s
  left join item_cost ic on ic.item_id = s.item_id
  group by 1, 2
  order by 1;
$$;

-- ── Lens 3: By Period ───────────────────────────────────────────────────
-- Daily time series (local days) of units / revenue / net profit over the period.
create or replace function public.pnl_by_period(
  p_from date default null,
  p_to date default null,
  p_tz text default 'America/Los_Angeles'
)
returns table (
  day date,
  units bigint,
  revenue_cents numeric,
  cogs_cents numeric,
  net_profit_cents numeric
)
language sql
stable
security invoker
as $$
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
    (sum(s.price_cents) * (1 - 0.06) - coalesce(sum(ic.cogs), 0))::numeric  -- 6% platform fee
  from sale s
  left join item_cost ic on ic.item_id = s.item_id
  group by s.sale_date
  order by s.sale_date;
$$;

grant execute on function public.pnl_by_sku(date, date, text) to authenticated;
grant execute on function public.pnl_by_show(date, date, text) to authenticated;
grant execute on function public.pnl_show_hourly(uuid, date, date, text) to authenticated;
grant execute on function public.pnl_by_period(date, date, text) to authenticated;
