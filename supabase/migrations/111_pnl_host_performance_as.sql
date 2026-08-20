-- 111_pnl_host_performance_as.sql
-- ┌─────────────────────────────────────────────────────────────────────────────┐
-- │ APPLIED TO PRODUCTION: 2026-08-20                                          │
-- │ Verified present in the live schema. DO NOT RE-APPLY.                       │
-- │ This DB has no migration ledger — this file IS the record that it ran.      │
-- └─────────────────────────────────────────────────────────────────────────────┘
--
-- Service-role owner-scoped twin of pnl_host_performance.  (see the APPLIED banner above)
-- Additive, no capture-path lock, no write-silence gate. Depends on 109.
--
-- WHY NOW RATHER THAN LATER: /api/member/team/host-performance still windows on
-- live_auction_items.closed_at, which lensed_log_auction rewrites to now() on both the
-- retroactive-bind INSERT and the paid-flip UPDATE. With 109 landed, the owner Roster shows
-- corrected numbers while the station Team page shows the old flattering ones — the SAME metric,
-- two pages, materially different values (Tiegan 56.1% vs 36.8%). Whoever notices will conclude
-- the corrected number is the broken one. Two disagreeing sources are worse than one wrong
-- source, so this ships with 109 rather than after it.
--
-- WHY A TWIN: pnl_host_performance is SECURITY INVOKER and relies on RLS auth.uid(). The member
-- route runs through requireMemberScope('team') with createAdminClient() (service role) and an
-- explicit ownerIds array — auth.uid() is empty for a confined member, so the INVOKER function
-- would return nothing. Same reason pnl_show_hourly_as and lensed_log_auction_as exist.
--
-- ARRAY, not scalar: the member scope resolves a LIST of owner ids (`.in('user_id', ownerIds)`),
-- so the parameter mirrors pnl_show_hourly_as(p_owner_user_ids uuid[], …) rather than
-- lensed_log_auction_as's single-owner shape.
--
-- ═══════════════════════════ PRIVILEGE — READ BEFORE EDITING ═══════════════════════════
-- This function BYPASSES RLS: the caller asserts which owners it may read. Granting it to
-- `authenticated` would let any signed-in user read any owner's host performance by passing a
-- different array. Service role ONLY, per 108's pattern, and registered in SERVICE_ROLE_ONLY in
-- scripts/check-rpc-grants.mjs so CI asserts it stays ungranted in both directions.
-- ══════════════════════════════════════════════════════════════════════════════════════
--
-- COUNTS ONLY — deliberately. The member route's contract is that no cost figure ever leaves it
-- ("no cost, no breakEven, no aspGoal"). Break-even is computed here to CLASSIFY each auction and
-- is never returned, so the RPC satisfies that contract by construction rather than by the route
-- remembering to strip fields.

begin;

create or replace function public.pnl_host_performance_as(
  p_owner_user_ids      uuid[],
  p_asp_window_days     integer,
  p_be_window_days      integer,
  p_asp_goal_multiplier numeric,
  p_now                 timestamptz default now()
)
returns table(
  host_id  uuid,
  asp_n    bigint,
  asp_hits bigint,
  be_n     bigint,
  be_below bigint
)
language sql
stable
as $function$
  with sale as (
    -- Body identical to pnl_host_performance (109), plus the explicit owner filter that
    -- replaces the RLS scoping an INVOKER function would have got from auth.uid().
    select lai.id                                as item_id,
           ls.host_id                            as host_id,
           ce.selling_price_cents                as price_cents,
           coalesce(ce.ordered_at, ce.created_at) as sale_at
      from public.capture_events ce
      join public.live_auction_items lai
        on lai.client_idempotency_key = ce.order_id
       and lai.user_id                = ce.user_id
      join public.live_sessions ls
        on ls.id = lai.session_id
       and ls.host_id is not null                 -- attribution gate
     where lai.status = 'sold'
       and ce.selling_price_cents is not null
       and lai.user_id = any(p_owner_user_ids)    -- ← the owner scope
       and coalesce(ce.ordered_at, ce.created_at) >= p_now - make_interval(days => p_be_window_days)
  ),
  item_cost as (
    -- Canonical coalesce chain, identical to pnl_show_hourly / pnl_host_performance.
    select las.auction_item_id as item_id,
           sum(las.qty * coalesce(las.unit_cost_cents_snapshot, isk.unit_cost_cents, 0)) as break_even_cents
      from public.live_auction_item_skus las
      left join public.inventory_skus isk on isk.id = las.inventory_sku_id
     group by las.auction_item_id
  ),
  scored as (
    select s.host_id, s.sale_at, s.price_cents,
           coalesce(ic.break_even_cents, 0)                        as break_even_cents,
           coalesce(ic.break_even_cents, 0) * p_asp_goal_multiplier as asp_goal_cents
      from sale s
      left join item_cost ic on ic.item_id = s.item_id
  )
  select
    sc.host_id,
    count(*) filter (where sc.sale_at >= p_now - make_interval(days => p_asp_window_days))      as asp_n,
    count(*) filter (where sc.sale_at >= p_now - make_interval(days => p_asp_window_days)
                       and sc.price_cents >= sc.asp_goal_cents)                                 as asp_hits,
    count(*)                                                                                    as be_n,
    count(*) filter (where sc.price_cents < sc.break_even_cents)                                 as be_below
  from scored sc
  group by sc.host_id;
$function$;

comment on function public.pnl_host_performance_as(uuid[], integer, integer, numeric, timestamptz) is
  'Service-role owner-scoped twin of pnl_host_performance, for the member team scope. Bypasses '
  'RLS — the caller asserts p_owner_user_ids — so it must never be granted to authenticated. '
  'Returns counts only; break-even is used to classify and is never emitted.';

revoke execute on function public.pnl_host_performance_as(uuid[], integer, integer, numeric, timestamptz) from public, anon, authenticated;
grant  execute on function public.pnl_host_performance_as(uuid[], integer, integer, numeric, timestamptz) to service_role;

commit;
