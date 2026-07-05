-- 040_pnl_period_and_reorder_window.sql
-- Period-handling refinements for the P&L tab. FUNCTIONS ONLY — no table alters,
-- no data writes. Builds on 039.
--
-- Three changes:
--  1. pnl_by_sku: split into TWO time bases.
--       • Performance columns (units/revenue/COGS/net) use the SELECTED period.
--       • Reorder velocity uses a FIXED trailing window, independent of the
--         Period selector, so a short window (e.g. "Today") can't zero out a
--         SKU's velocity and falsely mark it "OK".
--     Trailing window denominator = max(1, min(30, days_since_first_sale)) so
--     newly-added SKUs aren't understated as slow-movers. units come from the
--     last 30 local days. The client derives velocity/days-of-cover from these.
--  2. pnl_by_show: filter by which SESSIONS fall in the range (local start date),
--     and report FULL-show totals (not period-clipped), so the per-hour drill-down
--     still sums to the show row.
--  3. pnl_show_hourly: drop the period params — the drill-down is always the full
--     show.
--
-- Sale-moment / join / COGS / platform-fee / RLS conventions are unchanged from
-- 039 (see that migration's header).

-- ── Lens 1: By SKU (dual time base) ─────────────────────────────────────
-- Return shape changes (period_days -> reorder_units + reorder_window_days), so
-- drop and recreate rather than replace.
drop function if exists public.pnl_by_sku(date, date, text);

create function public.pnl_by_sku(
  p_from date default null,
  p_to date default null,
  p_tz text default 'America/Los_Angeles'
)
returns table (
  sku_id uuid,
  sku_number integer,
  title text,
  is_active boolean,
  units_sold bigint,            -- selected period
  revenue_cents numeric,        -- selected period
  cogs_cents numeric,           -- selected period
  net_profit_cents numeric,     -- selected period
  qty_on_hand integer,
  lead_time_days integer,
  reorder_point integer,
  reorder_units bigint,         -- units sold in the FIXED trailing window
  reorder_window_days integer   -- denominator: max(1, min(30, days_since_first_sale))
)
language sql
stable
security invoker
as $$
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
    (coalesce(p.revenue, 0) * (1 - 0.06) - coalesce(p.cogs, 0))::numeric,  -- 6% platform fee
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
$$;

grant execute on function public.pnl_by_sku(date, date, text) to authenticated;

-- ── Lens 2: By Show (filter by session, full-show totals) ───────────────
-- Same return shape as 039 -> replace in place.
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
    (coalesce(sum(s.price_cents), 0) * (1 - 0.06) - coalesce(sum(ic.cogs), 0))::numeric  -- 6% platform fee
  from picked p
  join sale s on s.session_id = p.id                 -- inner: only shows with sales
  left join item_cost ic on ic.item_id = s.item_id
  group by p.id, p.title, p.started_at, p.ended_at
  order by p.started_at desc nulls last;
$$;

-- ── Lens 2 drill-down: full-show per-hour breakdown ─────────────────────
-- Period params dropped — the expansion is always the whole show.
drop function if exists public.pnl_show_hourly(uuid, date, date, text);

create function public.pnl_show_hourly(
  p_session_id uuid,
  p_tz text default 'America/Los_Angeles'
)
returns table (
  hour_start timestamp,
  hour_of_day integer,
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
    (sum(s.price_cents) * (1 - 0.06) - coalesce(sum(ic.cogs), 0))::numeric  -- 6% platform fee
  from sale s
  left join item_cost ic on ic.item_id = s.item_id
  group by 1, 2
  order by 1;
$$;

grant execute on function public.pnl_show_hourly(uuid, text) to authenticated;
