-- 140_squish_multibind_stable_plan.sql
--
-- THIRD and final timeout fix for squish_multibind_audit_as. The first two treated symptoms; this
-- one removes the shape the planner kept getting wrong.
--
-- ── WHAT KEPT HAPPENING ──────────────────────────────────────────────────────────────────────
--
-- PostgREST runs as `authenticator` (statement_timeout = 8s) and SET ROLEs to service_role, which
-- sets no timeout of its own, so 8s stands. This function has now blown that limit twice, each
-- time for a DIFFERENT plan reason, and each time after an edit that looked cosmetic:
--
--   135  `verified` unnested shipment_verifications.order_ids into a CTE. unnest() has no
--        statistics → estimated 3 rows against an actual 105,215 → Nested Loop Anti Join
--        re-scanning a 105k Materialize once per candidate.                          14.2s
--   136  Replaced it with a correlated `sv.order_ids @> array[f.order_id]` EXISTS behind a new
--        GIN index. Fast — while the probe stayed in the joined SELECT list.          1.3s
--   137  Rewrote `unpacked` from an allow-list to a deny-list (a CORRECTNESS fix, unrelated to
--        performance). That let the planner push the probe DOWN into a per-row filter on the
--        flagged set, where it chose a Seq Scan on shipment_verifications — 779 loops
--        x ~15ms.                                                                    13-21s
--
-- The lesson is not "136 was wrong". It is that a CORRELATED probe leaves the planner free to
-- re-place it on any later edit, and two of the three placements are catastrophic. The shape had
-- to stop being correlated.
--
-- ── WHAT WAS TRIED AND REJECTED ──────────────────────────────────────────────────────────────
--
--   MATERIALIZED on the 135 CTE          17.6s — SLOWER. Forcing one evaluation does not help
--                                        when the join shape is the problem.
--   ANALYZE shipment_verifications       21s — WORSE. The table had never been analyzed since the
--                                        GIN index was built, so this looked like the obvious
--                                        cause. It was not: the issue is plan instability, not
--                                        stale statistics. Recorded here so nobody re-runs it
--                                        expecting a fix.
--
-- ── THE FIX ──────────────────────────────────────────────────────────────────────────────────
--
-- Pre-filter the verification set to THIS page's candidates, then plain-join it:
--
--     verified as (
--       select distinct sv.user_id, oid
--       from shipment_verifications sv, unnest(sv.order_ids) as oid
--       where sv.user_id = any(p_owner_user_ids)
--         and sv.order_ids && (select array_agg(order_id) from flagged)   <- ONE GIN index scan
--         and oid in (select order_id from flagged)                       <- keeps the unnest tiny
--     )
--
-- `&&` (array overlap) is GIN-indexable, so a single index scan replaces one probe per candidate,
-- and the unnest then runs over the handful of boxes that actually touch this page instead of all
-- 37,535 rows. There is no correlated subquery left for the planner to relocate.
--
-- Confirmed in the plan: ONE `Bitmap Index Scan on idx_shipment_verifications_order_ids` with
-- loops=1 (it was 779), no SubPlan, no Seq Scan on shipment_verifications.
--
--     before   13,003ms / 21,386ms (varying by load)
--     after       791ms /    820ms /    795ms — three consecutive runs
--
-- The GIN index from 136 is still required; this changes only HOW it is reached.
--
-- ── EQUIVALENCE, PROVEN BEFORE APPLYING ──────────────────────────────────────────────────────
--
-- The candidate was diffed against the live function row-for-row on the same arguments: 25 rows
-- each, total_count 313 both, ZERO rows in one and not the other, and ZERO field mismatches across
-- pack_verified / unpacked / units. This is a pure plan change and nothing else.
--
-- Class A: create-or-replace of a function only /api/member/audit calls; nothing on the capture or
-- order-sync path touches it. APPLIED to prod 2026-09-09 — that is what unbroke the page, since
-- the fix is server-side and needed no deploy. Verified after: 313 fixable, 777 total, zero
-- packed-or-shipped rows leaking through the filter, oldest row first, grants unchanged
-- (authenticated false, service_role true).
--
-- Numbered 140: 138 and 139 were taken on main (shift_trades, shift_approved_minutes) while this
-- work was in flight.
CREATE OR REPLACE FUNCTION public.squish_multibind_audit_as(p_owner_user_ids uuid[], p_store_ids uuid[], p_all_stores boolean, p_since timestamp with time zone, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_unpacked_only boolean DEFAULT false)
 RETURNS TABLE(order_id text, item_id uuid, session_id uuid, owner_user_id uuid, store_id uuid, bound_at timestamp with time zone, units integer, line_count integer, tiktok_title text, buyer_handle text, won_price_cents integer, lot_hint text, ordered_at timestamp with time zone, tiktok_status text, tracking_number text, pack_verified boolean, unpacked boolean, lines jsonb, total_count bigint)
 LANGUAGE sql
 STABLE
AS $function$
  with flagged as (
    select
      lai.client_idempotency_key                as order_id,
      lai.id                                    as item_id,
      lai.session_id                            as session_id,
      lai.user_id                               as owner_user_id,
      lai.store_id                              as item_store_id,
      lai.created_at                            as bound_at,
      sum(las.qty)::int                         as units,
      count(*)::int                             as line_count,
      jsonb_agg(jsonb_build_object(
        'sku_id',          las.inventory_sku_id,
        'sku_number',      las.sku_number_snapshot,
        'title',           las.title_snapshot,
        'qty',             las.qty,
        'unit_cost_cents', las.unit_cost_cents_snapshot,
        'category',        isk.category,
        'thumbnail_path',  isk.thumbnail_path
      ) order by las.sku_number_snapshot nulls last) as lines
    from public.live_auction_items lai
    join public.live_auction_item_skus las
      on las.auction_item_id = lai.id and las.user_id = lai.user_id
    left join public.inventory_skus isk
      on isk.id = las.inventory_sku_id
    where lai.user_id = any(p_owner_user_ids)
      and lai.status = 'sold'
      and coalesce(lai.client_idempotency_key, '') not in ('', '0')
      and lai.created_at >= p_since
    group by lai.client_idempotency_key, lai.id, lai.session_id, lai.user_id, lai.store_id, lai.created_at
    having sum(las.qty) > 1
       and bool_and(coalesce(isk.category, '') = 'squish')
  ),
  -- PRE-FILTERED to this page's candidates. `&&` (array overlap) against the flagged order list
  -- is GIN-indexable, so ONE index scan replaces a correlated probe per candidate, and the unnest
  -- then runs over a handful of boxes instead of all 37k rows. See the header for why the two
  -- previous shapes both failed.
  verified as (
    select distinct sv.user_id, oid as order_id
    from public.shipment_verifications sv,
         unnest(sv.order_ids) as oid
    where sv.user_id = any(p_owner_user_ids)
      and sv.order_ids && (select array_agg(f2.order_id) from flagged f2)
      and oid in (select f3.order_id from flagged f3)
  ),
  joined as (
    select
      f.*,
      coalesce(soi.store_id, f.item_store_id)                          as store_id,
      ce.product_name                                                  as tiktok_title,
      ce.buyer_username                                                 as buyer_handle,
      ce.selling_price_cents                                           as won_price_cents,
      ce.platform_sku_ref                                              as lot_hint,
      ce.ordered_at                                                    as ordered_at,
      soi.status                                                       as tiktok_status,
      soi.tracking_number                                              as tracking_number,
      -- Containment probe against idx_shipment_verifications_order_ids (GIN). The previous shape
      -- unnested order_ids into a CTE; unnest() has no statistics, so the planner estimated it at
      -- 3 rows against an actual 105,215 and chose a Nested Loop Anti Join that re-scanned a 105k
      -- Materialize once per candidate — 14.2s, over PostgREST's 8s statement_timeout. The probe is
      -- index-backed and takes the same query to 1.3s. MATERIALIZED does not fix it (it was slower).
      (v.order_id is not null)                                         as pack_verified,
      -- see the header: BOTH conditions, because neither signal is sufficient alone
      (v.order_id is null
       and coalesce(soi.status, '') not in ('IN_TRANSIT', 'DELIVERED', 'COMPLETED'))  as unpacked
    from flagged f
    left join public.capture_events ce
      on ce.order_id = f.order_id and ce.user_id = f.owner_user_id
    left join public.synced_order_ids soi
      on soi.order_id = f.order_id and soi.user_id = f.owner_user_id
    left join verified v
      on v.order_id = f.order_id and v.user_id = f.owner_user_id
    where (p_all_stores or coalesce(soi.store_id, f.item_store_id) = any(p_store_ids))
      and coalesce(soi.status, '') <> 'CANCELLED'
      and not exists (
        select 1 from public.bind_review_decisions d
        where d.order_id = f.order_id and d.item_id = f.item_id
      )
  )
  select
    j.order_id, j.item_id, j.session_id, j.owner_user_id, j.store_id, j.bound_at,
    j.units, j.line_count, j.tiktok_title, j.buyer_handle, j.won_price_cents, j.lot_hint,
    j.ordered_at, j.tiktok_status, j.tracking_number, j.pack_verified, j.unpacked, j.lines,
    count(*) over ()  as total_count
  from joined j
  where (not p_unpacked_only or j.unpacked)
  order by j.bound_at asc, j.order_id asc
  limit greatest(1, least(200, coalesce(p_limit, 50)))
  offset greatest(0, coalesce(p_offset, 0));
$function$;

-- Grants preserved by create-or-replace; re-checked authenticated=false, service_role=true.
