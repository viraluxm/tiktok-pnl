-- ─────────────────────────────────────────────────────────────────────────────
-- 128 — chat_pnl_totals_as: server-side P&L aggregate for the admin assistant.
--
-- WHY THIS EXISTS (measured, 2026-09-05 against prod):
--   The assistant's get_pnl tool originally paged `pnl_order_grain` over HTTP and summed the rows
--   in TypeScript. `pnl_order_grain` is an expensive multi-CTE view, and PostgREST's 1000-row cap
--   means one page per 1000 orders — so the whole view is re-evaluated on EVERY page:
--       1 day  (5,358 orders)   19.4s
--       7 days (34,460 orders) 104.1s   ← /api/chat maxDuration is 60s: hard timeout
--      31 days (104,614 orders) 383.1s
--   The identical aggregate computed IN SQL: 3.4s for that same day. PostgREST server-side
--   aggregates are disabled on this project (PGRST123 "Use of aggregate functions is not allowed"),
--   so there is no route around it — the grouping has to happen in the database.
--
-- SCOPING: owner ids AND store ids are passed explicitly and both are enforced here, so a
-- store-restricted caller cannot widen its own scope. Same shape as the other `_as` reads.
--
-- SECURITY: security invoker + SERVICE_ROLE_ONLY. Do NOT grant this to `authenticated` — it takes
-- the owner set as a parameter, so a grant would let any signed-in user read another owner's
-- revenue and margin. It is called only via createAdminClient() from /api/chat, which resolves the
-- owner set server-side. Registered in scripts/check-rpc-grants.mjs SERVICE_ROLE_ONLY.
--
-- Read-only: creates a function, reads a view. No table is written and no lock is taken on any
-- capture or order-sync table, so this is safe to apply while a show is live.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.chat_pnl_totals_as(
  p_owner_user_ids uuid[],
  p_store_ids      uuid[],
  p_from           date,
  p_to             date,
  p_group_by       text default 'total'
)
returns table (
  bucket               text,
  orders               bigint,
  units                bigint,
  revenue_cents        numeric,
  platform_fee_cents   numeric,
  cogs_cents           numeric,
  uncaptured_gmv_cents numeric,
  missing_cost_lines   bigint,
  orders_missing_cost  bigint
)
language sql
stable
security invoker
as $function$
  select
    case p_group_by
      when 'day'   then g.business_date::text
      when 'store' then coalesce(g.store_id::text, 'unassigned')
      else 'total'
    end                                                             as bucket,
    count(*)::bigint                                                as orders,
    coalesce(sum(g.units), 0)::bigint                               as units,
    coalesce(sum(g.revenue_cents), 0)::numeric                      as revenue_cents,
    coalesce(sum(g.platform_fee_cents), 0)::numeric                 as platform_fee_cents,
    coalesce(sum(g.cogs_cents), 0)::numeric                         as cogs_cents,
    coalesce(sum(g.uncaptured_gmv_cents), 0)::numeric               as uncaptured_gmv_cents,
    coalesce(sum(g.cogs_missing_lines), 0)::bigint                  as missing_cost_lines,
    -- An order counts as missing cost when any line lacks a unit cost, or no cost row resolved at
    -- all. COGS is PARTIAL BY DESIGN (only auction orders carry a snapshot) and a partial COGS
    -- INFLATES margin rather than erroring, so coverage travels with every figure.
    count(*) filter (
      where coalesce(g.cogs_missing_lines, 0) > 0 or g.cogs_cents is null
    )::bigint                                                       as orders_missing_cost
  from public.pnl_order_grain g
  where g.user_id = any(p_owner_user_ids)
    and (p_store_ids is null or g.store_id = any(p_store_ids))
    and (p_from is null or g.business_date >= p_from)
    and (p_to   is null or g.business_date <= p_to)
  group by 1
  order by 1;
$function$;

-- Deliberately NO grant to authenticated/anon. See the SECURITY note above.
revoke all on function public.chat_pnl_totals_as(uuid[], uuid[], date, date, text) from public;
revoke all on function public.chat_pnl_totals_as(uuid[], uuid[], date, date, text) from anon;
revoke all on function public.chat_pnl_totals_as(uuid[], uuid[], date, date, text) from authenticated;
