-- 122_pick_units_in_window.sql
--
-- Aggregate box/unit counts for a completed-pick window, in ONE round trip.
--
-- WHY THIS FUNCTION EXISTS
-- The Shows tab needs a TRAILING crew "$ per unit picked" so a show's net-net figure is not
-- built on a single volatile day (measured 2026-08-27..09-02: $0.376 to $0.841 per unit,
-- day over day — a 2.2x swing that would make the same show read profitable or not depending
-- on which day it happened to fall on). Trailing 7 days is stable at $0.556.
--
-- Reading 7 days of shipment_verifications through PostgREST is not viable: a single response
-- is capped at 1000 rows SILENTLY, and this window holds 5,908 boxes / 18,355 orders — ~19
-- paged requests plus a chunked, paged synced_order_ids read for the unit counts, per page
-- view. This function does the same arithmetic server-side and returns two integers.
--
-- SECURITY: INVOKER, AND THE CALLER IS auth.uid()
-- This function takes NO owner parameter and is `security invoker`, so it can only ever count
-- the CALLING user's own rows — there is no argument through which one account could read
-- another's volume, which is why it is granted to `authenticated` and called from the ordinary
-- user session rather than being service-role-only.
--
--   • shipment_verifications has RLS enabled with own-row SELECT (auth.uid() = user_id), so
--     that read is scoped twice over: by the policy, and by the explicit predicate below.
--   • synced_order_ids has RLS DISABLED (verified on the live database — no policies at all),
--     so for that table the explicit `user_id = auth.uid()` predicate IS the boundary. This is
--     why the filter is written into the query rather than left to RLS, per CLAUDE.md.
--
-- WHAT IT DELIBERATELY DOES NOT DO
-- No payroll logic. Not the 04:00 fulfillment-day boundary, not isPayableShift, not an hourly
-- rate, not a cost. The window bounds are passed IN as instants, computed by
-- zonedDayRangeUtcMs in src/lib/shipping/pickerPerformance.ts, and the money side stays in
-- pickCostEconomics.ts behind the real payroll gate. Duplicating either of those in SQL is
-- exactly the drift this codebase has been careful to avoid, so the split is: SQL counts rows,
-- TypeScript owns every definition.
--
-- UNIT COUNTING mirrors skuCount() in pickCostEconomics.ts verbatim in behaviour:
--   box   = one shipment_verifications row (de-duped by group_key)
--   unit  = one DISTINCT order_id inside that box, weighted by synced_order_ids.units
-- units defaults to 1 for an order with no synced row and is floored at 1, because a NULL or 0
-- would silently shrink the denominator and make picking look cheaper than it is. Verified
-- against the existing route's own figures for 2026-09-02: 982 boxes / 3,408 units, identical.
--
-- Both joins hit a unique index — shipment_verifications (user_id, group_key) and
-- synced_order_ids (user_id, order_id) — so neither can fan out and double-count.

create or replace function public.lensed_pick_units_in_window(
  p_start timestamptz,
  p_end   timestamptz
)
returns table (boxes bigint, units bigint)
language sql
stable
security invoker
set search_path = public
as $$
  with box as (
    -- distinct on is defensive: (user_id, group_key) is already unique. Half-open window
    -- [p_start, p_end) matches the .gte/.lt the fulfillment-performance route uses, so a box
    -- verified exactly at a day boundary lands in one day and never both.
    select distinct on (sv.group_key) sv.group_key, sv.order_ids
    from shipment_verifications sv
    where sv.user_id = auth.uid()
      and sv.verified_at >= p_start
      and sv.verified_at <  p_end
    order by sv.group_key, sv.verified_at
  ),
  box_order as (
    select distinct b.group_key, o.order_id
    from box b
    cross join lateral unnest(coalesce(b.order_ids, '{}'::text[])) as o(order_id)
  )
  select
    (select count(*) from box)::bigint as boxes,
    coalesce((
      select sum(greatest(1, coalesce(s.units, 1)))
      from box_order bo
      left join synced_order_ids s
        on s.order_id = bo.order_id
       and s.user_id  = auth.uid()
    ), 0)::bigint as units;
$$;

-- Called from a USER SESSION (createClient(...).rpc), so the grant is required — see
-- supabase/migrations/CONVENTIONS.md. Safe to grant precisely because the function has no owner
-- parameter: `authenticated` can only ever count its own rows.
--
-- The revoke is NOT redundant. Postgres grants EXECUTE to PUBLIC by default on a new function,
-- and both `anon` and `authenticated` inherit from PUBLIC — verified on this database, where a
-- freshly created copy of this function came back with has_function_privilege('anon', …) TRUE
-- before any grant was written. An anon caller would get auth.uid() = NULL and read zero rows,
-- so the exposure is empty rather than dangerous, but an unauthenticated EXECUTE grant on an
-- app RPC is exactly the out-of-repo drift check-rpc-grants.mjs exists to catch. Revoke first,
-- then grant only what the app needs.
revoke execute on function public.lensed_pick_units_in_window(timestamptz, timestamptz)
  from public, anon;
grant execute on function public.lensed_pick_units_in_window(timestamptz, timestamptz) to authenticated;

-- AFTER APPLYING: reload the PostgREST schema cache, or the app gets a silent 500 on first use.
--
-- This bit: applying the function is not enough. PostgREST resolves RPC names from a cached
-- schema and will not see a newly created function until told to re-read it, so the route kept
-- failing with PGRST202 ("Could not find the function … in the schema cache", helpfully
-- suggesting `lensed_unbind`) for several minutes AFTER a clean, verified apply. The function
-- was present and correctly granted the whole time — exactly the "existed but couldn't be
-- called" failure mode CONVENTIONS.md opens with, just one layer further out.
--
--   notify pgrst, 'reload schema';
--
-- Then confirm the name actually resolves before calling it done. A service-role probe is the
-- quickest check and returns {"boxes":0,"units":0} on success — 0 because a service-role JWT
-- carries no `sub`, so auth.uid() is NULL and the function correctly counts nothing. Absence of
-- PGRST202 is the signal here, NOT the numbers:
--
--   curl -s -X POST "$SUPABASE_URL/rest/v1/rpc/lensed_pick_units_in_window" \
--     -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
--     -H 'Content-Type: application/json' \
--     -d '{"p_start":"2026-08-27T11:00:00Z","p_end":"2026-09-03T11:00:00Z"}'
--
-- Real (non-zero) figures only appear for a caller with a user JWT, which is how the app calls
-- it — /api/team/fulfillment-cost-rate uses the request-scoped user session, never service role.
