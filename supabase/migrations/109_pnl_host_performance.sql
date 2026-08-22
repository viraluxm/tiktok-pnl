-- 109_pnl_host_performance.sql
-- ┌─────────────────────────────────────────────────────────────────────────────┐
-- │ APPLIED TO PRODUCTION: 2026-08-20                                          │
-- │ Verified present in the live schema. DO NOT RE-APPLY.                       │
-- │ This DB has no migration ledger — this file IS the record that it ran.      │
-- └─────────────────────────────────────────────────────────────────────────────┘
--
-- Per-host ASP-hit / below-break-even rollup for the Team roster badges.  (see the APPLIED banner above)
-- No capture-path change, no write-silence gate. Independent of 106/107/108.
--
-- WHY: /api/live/host-performance filters live_auction_items on closed_at, which
-- lensed_log_auction rewrites to now() on BOTH the retroactive-bind INSERT and the paid-flip
-- UPDATE. Measured: 6.1% of sold auctions drift >1h, 4.1% >24h, worst case 18.3 days. The
-- drift is not noise — retro-bound rows hit the 4x ASP goal at 1.6-2.4x a host's true rate, so
-- the current numbers are systematically FLATTERING. Tiegan reads 46.8% vs a true 36.8%; Lily
-- 29.3% vs 18.4%; Bailey's 7-day sample is 67 auctions that are really 0.
--
-- The route cannot be fixed in place: it filters auctions via PostgREST, then joins prices from
-- a SEPARATE capture_events fetch in JS, so the window predicate cannot live on the capture
-- side. This RPC inverts the drive direction.
--
-- SHAPE: the `sale` and `item_cost` CTEs are deliberately the SAME two the pnl_show_* family
-- uses (040, and 106's pnl_show_host_segments). Kept structurally identical so a later refactor
-- can hoist them into one shared base rather than having three near-copies to reconcile.
--
-- SECURITY INVOKER (the default) — RLS on capture_events / live_auction_items / live_sessions
-- scopes every row to the caller. No `_as` twin: the only caller is a user-session route.
-- Add one when the P&L owner-scoping cutover needs it, not speculatively.

begin;

-- p_asp_goal_multiplier is a PARAMETER, not a literal, so src/lib/asp.ts ASP_GOAL_MULTIPLIER
-- stays the single source of truth. Hardcoding 4 here would silently fork that constant — the
-- exact failure asp.ts's own header warns about ("there are no hardcoded multipliers left").
create or replace function public.pnl_host_performance(
  p_asp_window_days     integer,
  p_be_window_days      integer,
  p_asp_goal_multiplier numeric,
  p_now                 timestamptz default now()   -- injectable for tests; never passed by the route
)
returns table(
  host_id     uuid,
  asp_n       bigint,
  asp_hits    bigint,
  be_n        bigint,
  be_below    bigint
)
language sql
stable
as $function$
  with sale as (
    -- DRIVEN FROM capture_events. The window predicate sits on the SALE clock —
    -- coalesce(ordered_at, created_at) — never on live_auction_items.closed_at.
    select lai.id                                  as item_id,
           ls.host_id                              as host_id,
           ce.selling_price_cents                  as price_cents,
           coalesce(ce.ordered_at, ce.created_at)   as sale_at
      from public.capture_events ce
      join public.live_auction_items lai
        on lai.client_idempotency_key = ce.order_id
       and lai.user_id                = ce.user_id
      join public.live_sessions ls
        on ls.id = lai.session_id
       and ls.host_id is not null                   -- attribution gate: unattributed excluded
     where lai.status = 'sold'
       and ce.selling_price_cents is not null
       and coalesce(ce.ordered_at, ce.created_at) >= p_now - make_interval(days => p_be_window_days)
  ),
  item_cost as (
    -- CANONICAL COALESCE CHAIN, identical to pnl_show_hourly (040). Raw
    -- unit_cost_cents_snapshot is NOT safe: 147 of 72,285 sold SKU lines are NULL, of which
    -- 143 are recoverable from inventory_skus.unit_cost_cents. Summing the raw column
    -- under-reports cost, which deflates break-even and INFLATES the ASP-hit rate — the same
    -- direction of error this migration exists to remove.
    select las.auction_item_id as item_id,
           sum(las.qty * coalesce(las.unit_cost_cents_snapshot, isk.unit_cost_cents, 0)) as break_even_cents
      from public.live_auction_item_skus las
      left join public.inventory_skus isk on isk.id = las.inventory_sku_id
     group by las.auction_item_id
  ),
  -- One row per auction. The sale join is 1:1 — verified on production: 69,098 sale rows =
  -- 69,098 distinct item_id = 69,098 distinct (user_id, order_id), zero duplicates, held by the
  -- unique indexes idx_capture_events_user_order and idx_live_auction_items_user_idem. If that
  -- ever stops being true this aggregate double-counts revenue, so the invariant is load-bearing.
  scored as (
    select s.host_id,
           s.sale_at,
           s.price_cents,
           coalesce(ic.break_even_cents, 0)                             as break_even_cents,
           coalesce(ic.break_even_cents, 0) * p_asp_goal_multiplier      as asp_goal_cents
      from sale s
      left join item_cost ic on ic.item_id = s.item_id
  )
  select
    sc.host_id,
    count(*) filter (where sc.sale_at >= p_now - make_interval(days => p_asp_window_days))         as asp_n,
    count(*) filter (where sc.sale_at >= p_now - make_interval(days => p_asp_window_days)
                       and sc.price_cents >= sc.asp_goal_cents)                                    as asp_hits,
    count(*)                                                                                       as be_n,
    count(*) filter (where sc.price_cents < sc.break_even_cents)                                    as be_below
  from scored sc
  group by sc.host_id;
$function$;

comment on function public.pnl_host_performance(integer, integer, numeric, timestamptz) is
  'Per-host ASP-hit / below-break-even tallies over two rolling windows, anchored on '
  'coalesce(capture_events.ordered_at, created_at) — NOT live_auction_items.closed_at, which '
  'the retroactive-bind and paid-flip paths rewrite to now(). Goal multiplier is a parameter '
  'so src/lib/asp.ts stays canonical. Windows are rolling, so there is no session end to '
  'resolve and lensed_session_activity_end does not apply here.';

revoke execute on function public.pnl_host_performance(integer, integer, numeric, timestamptz) from public, anon;
grant  execute on function public.pnl_host_performance(integer, integer, numeric, timestamptz) to authenticated;

commit;
