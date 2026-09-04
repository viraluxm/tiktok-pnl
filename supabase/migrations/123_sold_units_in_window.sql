-- 123_sold_units_in_window.sql
--
-- Units SOLD in a window — the denominator the Shows tab allocates fulfillment labor over.
--
-- WHY THIS REPLACES THE PICKED COUNT AS THE DENOMINATOR
-- 122 counts units PICKED (completed shipment_verifications rows). That was the wrong divisor
-- for a cost allocation, for one decisive reason: it does not conserve. Measured over the 7
-- fulfillment days to 2026-09-02 — labor $12,017.65, units sold 26,760, recorded picks 18,355:
--
--   picked-based rate x units sold  =  26,760 x $0.6547  =  $17,520
--   actual fulfillment payroll                           =  $12,018   <- 46% over-allocated
--
-- Sum the picking charge across every show in that week and it exceeded what was actually paid
-- by $5,500. Dividing by units SOLD reconciles by construction ($0.449 x 26,760 = $12,015), and
-- an allocation whose parts do not add up to the whole is simply wrong, however carefully each
-- part is computed.
--
-- The picked count is ALSO under-recorded, which inflated the rate independently: recorded picks
-- were 65% of units sold over 7 days, 82% over 14, 77% over 30, 54% over 60. It never converges,
-- so this is not fulfillment lag — real picking writes no verification row (4,185 orders sitting
-- in COMPLETED / DELIVERED / IN_TRANSIT over 30 days have none, and they demonstrably shipped).
-- Units sold is not subject to that blind spot. 122 is KEPT, and the route still reads it, purely
-- so that coverage ratio stays visible instead of silently distorting a cost again.
--
-- WHY 'CANCELLED' IS THE ONLY EXCLUSION
-- All six statuses present in a 30-day window were checked: DELIVERED, AWAITING_COLLECTION,
-- COMPLETED, IN_TRANSIT, CANCELLED, AWAITING_SHIPMENT. Every one except CANCELLED either has
-- been picked or still needs to be, so every one belongs in the denominator. CANCELLED (5,824
-- of 100,677 over 30 days) never needs picking, and leaving it in would understate the rate by
-- charging labor against orders no one ever touched.
--
-- WHY coalesce(order_created_at, created_at)
-- order_created_at is the real TikTok order time; created_at is when Lensed's sync inserted the
-- row, which is an artifact of when the job ran. Over the 30-day window the two agree to within
-- 0.07% (94,853 vs 94,917), so this is about correctness under drift, not about today's number.
-- The coalesce matters because order_created_at is NULL on 25,588 of 185,038 rows (all
-- historical): a bare `order_created_at >= p_start` would silently DROP such rows from the
-- denominator, shrinking it and inflating the cost per unit — the same class of silent-wrong
-- that the picked count already produced. Falling back to created_at keeps them counted.
--
-- SECURITY: INVOKER, SCOPED TO auth.uid() — same posture as 122. No owner parameter exists, so
-- one account cannot read another's volume. synced_order_ids has RLS DISABLED (verified on the
-- live database: no policies at all), so the explicit `user_id = auth.uid()` predicate IS the
-- boundary here, not a belt-and-braces second check. Per CLAUDE.md, the filter is written into
-- the query rather than left to RLS.
--
-- Units are weighted by synced_order_ids.units, floored at 1, matching skuCount() in
-- pickCostEconomics.ts — so both sides of every rate count a unit the same way. In practice
-- units is 1 for nearly every order (94,961 units across 94,853 orders).

create or replace function public.lensed_sold_units_in_window(
  p_start timestamptz,
  p_end   timestamptz
)
returns table (orders bigint, units bigint, cancelled_orders bigint)
language sql
stable
security invoker
set search_path = public
as $$
  with sold as (
    select so.status, greatest(1, coalesce(so.units, 1)) as units
    from synced_order_ids so
    where so.user_id = auth.uid()
      -- Half-open [p_start, p_end), same convention as 122 and the fulfillment routes.
      and coalesce(so.order_created_at, so.created_at) >= p_start
      and coalesce(so.order_created_at, so.created_at) <  p_end
  )
  select
    count(*) filter (where status is distinct from 'CANCELLED')::bigint          as orders,
    coalesce(sum(units) filter (where status is distinct from 'CANCELLED'), 0)::bigint as units,
    count(*) filter (where status = 'CANCELLED')::bigint                          as cancelled_orders
  from sold;
$$;

-- Called from a USER SESSION (createClient(...).rpc) → the grant is required, see
-- supabase/migrations/CONVENTIONS.md. The revoke is NOT redundant: Postgres grants EXECUTE to
-- PUBLIC by default on a new function and both `anon` and `authenticated` inherit from PUBLIC,
-- so without it an unauthenticated role holds EXECUTE on an app RPC (observed on 122).
revoke execute on function public.lensed_sold_units_in_window(timestamptz, timestamptz)
  from public, anon;
grant execute on function public.lensed_sold_units_in_window(timestamptz, timestamptz) to authenticated;

-- AFTER APPLYING: `notify pgrst, 'reload schema';` — PostgREST resolves RPC names from a cached
-- schema and will 500 with PGRST202 on a function it has not re-read yet, even though the
-- function exists and is correctly granted. This bit 122 for several minutes after a clean
-- apply. See the note at the end of 122 for the verification probe.

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- CORRECTION (appended after this migration was applied; the SQL above is unchanged and is the
-- record of what ran).
--
-- The header above justifies this function partly by claiming the picked count is structurally
-- under-recorded ("recorded picks were 65% of units sold over 7 days ... it never converges").
-- BOTH THAT CLAIM AND THE BACKLOG READING BUILT ON IT ARE WRONG.
--
-- Recording is fine. Those percentages were aggregates spanning the pack-station rollout.
-- Measured per COHORT — orders sold in week W, checked for a pick row with no window on the pick
-- side — coverage runs 84% (08-03), 86% (08-10), 94% (08-17); of orders that actually shipped it
-- is ~97% from mid-August. The 4,185 shipped-without-a-pick-row orders cited above are almost
-- entirely pre-rollout.
--
-- And there is no demonstrated backlog. "Sold in window minus picked in window" compares two
-- different clocks — order date against verified_at — so orders sold late in a window are picked
-- after it. At ~3,400 units/day with a couple of days of lag that edge effect accounts for
-- essentially the whole apparent gap, and it scales with volume, which is why it looked worse as
-- the operation grew.
--
-- WHAT THIS MEANS FOR THIS FUNCTION: each sold unit is picked exactly once, so units sold and
-- units picked are the same population and the two possible denominators converge over matched
-- cohorts. The choice is practical, not economic. Units sold is used because it comes from order
-- sync — complete and authoritative — so the rate depends on no pack-station behaviour at all,
-- and because it makes a period's allocation sum to that period's payroll. 122 is still read for
-- raw picked/box volume, which belongs to the Team view's own KPIs; the ratio between the two
-- windowed counts is NOT interpretable and must not be surfaced as one.
