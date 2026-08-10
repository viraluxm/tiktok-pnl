-- 087_member_inventory_reorder_read.sql
--
-- Owner-scoped, REVENUE-FREE reorder/velocity read for the member `inventory` scope.
-- NOT YET WIRED to a route. Nothing else in this migration.
--
-- Prefix note: 085 and 086 are already claimed by the unmerged scheduling-v1 branch
-- (085_scheduling_v1_schema, 086_collapse_shift_templates), so this is numbered 087 —
-- above the highest CLAIMED prefix across branches, not merely above main's 084.
--
-- Why a NEW function instead of calling pnl_by_sku: the live pnl_by_sku (dumped from prod
-- via pg_get_functiondef) is SECURITY INVOKER and scopes rows PURELY via RLS — it names no
-- auth.uid()/current_user_org(). A confined member owns no data, so calling it via the
-- session client returns nothing; calling it via service_role bypasses RLS and returns EVERY
-- owner's P&L. It also returns revenue_cents/cogs_cents/net_profit_cents, which the member
-- `inventory` scope must never see. This adds a sibling that (a) takes the owners explicitly
-- and (b) is STRUCTURALLY INCAPABLE of emitting price or cost — it selects only the
-- operational (stock/reorder/velocity) columns and never references a price/cost column.
--
-- PROVENANCE: the `today`, `line_all`, and `reorder` CTEs below are copied VERBATIM from the
-- LIVE pnl_by_sku body as of 2026-08-09, so the trailing-window velocity math is reproduced,
-- not reinvented. Changes vs that live body, and ONLY these:
--   * line_all gains  `and ce.user_id = any(p_owner_user_ids)`  (owner scope on the sales half)
--   * driving select gains  `where isk.user_id = any(p_owner_user_ids)`  (owner scope on the SKU set)
--   * pnl_by_sku's revenue CTEs are dropped entirely: sale_period, line, item_tot, alloc, perf
--   * the revenue return columns are dropped: units_sold, revenue_cents, cogs_cents, net_profit_cents
--     (and with them the `left join perf p` in the driving select)
-- Everything else — the tz "today" anchor, the FIXED trailing-30-local-day window, the
-- window_days clamp to the SKU's own history — is identical to pnl_by_sku.
--
-- HARD CONSTRAINT (verified by grep of the finished body): the body references NONE of
-- selling_price_cents, unit_cost_cents, unit_cost_cents_snapshot. The only capture_events
-- columns it touches are order_id, user_id, ordered_at, created_at — a units-only read.
--
-- SECURITY INVOKER, language sql, STABLE — matching pnl_by_sku. Under the service_role caller
-- (the member route) RLS is bypassed, so the two any(p_owner_user_ids) predicates are the sole
-- row scope. Scoped on inventory_skus.user_id directly (0 nulls in prod), NOT via org_id.

create or replace function public.pnl_reorder_by_sku_as(
  p_owner_user_ids uuid[],
  p_tz text default 'America/Los_Angeles'
)
 returns table(
   sku_id uuid,
   sku_number integer,
   title text,
   is_active boolean,
   qty_on_hand integer,
   lead_time_days integer,
   reorder_point integer,
   reorder_units bigint,
   reorder_window_days integer
 )
 language sql
 stable
 security invoker
as $function$
  with
  -- "Today" in the seller's local tz — the reorder window anchors here, NOT to
  -- the selected Period.
  today as (select (now() at time zone p_tz)::date as d),

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
  left join reorder r on r.sku_id = isk.id
  where isk.user_id = any(p_owner_user_ids);
$function$;

-- Lock it to the service role. The member route resolves owners server-side and calls this via
-- the service_role client; no end user (anon/authenticated) may execute it directly.
revoke execute on function public.pnl_reorder_by_sku_as(uuid[], text) from public, anon, authenticated;
grant  execute on function public.pnl_reorder_by_sku_as(uuid[], text) to service_role;
