-- 136_squish_multibind_audit_timeout_fix.sql
--
-- FIX: /team/audit died with "canceling statement due to statement timeout" for the team.
--
-- WHAT BROKE. 135's pack-state filter unnested shipment_verifications.order_ids into a CTE:
--
--     verified as (select distinct sv.user_id, oid from shipment_verifications sv,
--                  unnest(sv.order_ids) as oid where sv.user_id = any(p_owner_user_ids))
--
-- unnest() has NO statistics, so the planner estimated that CTE at 3 rows against an actual
-- 105,215. On that estimate it chose a Nested Loop Anti Join and re-scanned a 105k-row Materialize
-- once per candidate — 420 loops. 14.2s for a page that has 8s.
--
-- WHY I DID NOT CATCH IT. I timed 135 through the Supabase Management API, which runs as `postgres`
-- with NO statement_timeout, so a 14-second query looked like a working one. The app does not get
-- that: PostgREST connects as `authenticator` (statement_timeout=8s) and SET ROLEs to service_role,
-- which sets no timeout of its own, so the 8s stands. Any future "is this query fast enough" check
-- has to be measured against 8s, not against whether the Management API returns.
--
-- WHY NOT `MATERIALIZED`. Tried it: 17.6s, SLOWER than the 11-14s inline version. Forcing one
-- evaluation does not help when the join itself is the problem.
--
-- THE FIX. Drop the unnest entirely and probe the array through a GIN index:
--
--     exists (select 1 from shipment_verifications sv
--             where sv.user_id = f.owner_user_id and sv.order_ids @> array[f.order_id])
--
-- Index-backed bitmap probes, no 105k intermediate, and the planner has real selectivity to work
-- with. Same query: 14.2s -> 1.27s. Semantics are identical — verified after applying: 770 rows
-- unfiltered, 287 with the filter on, and ZERO packed-or-shipped rows leaking through it.
--
-- CLASS A. A new index built CONCURRENTLY (no write lock on a table the pickers write to during a
-- shift) and a create-or-replace of a function that only /api/member/audit calls — nothing on the
-- capture or order-sync path touches it. Both APPLIED to prod 2026-09-08.

-- ── a) the index. CONCURRENTLY, so it cannot block a picker's verification write. ──
-- NOTE: create index concurrently CANNOT run inside a transaction block, which is why this file
-- has no begin/commit. Each statement is its own transaction. If the index build fails it leaves
-- an INVALID index behind — drop it and re-run rather than assuming it worked.
create index concurrently if not exists idx_shipment_verifications_order_ids
  on public.shipment_verifications using gin (order_ids);

comment on index public.idx_shipment_verifications_order_ids is
  'Supports order_ids @> array[<order_id>] containment probes from squish_multibind_audit_as. '
  'Without it that lookup unnested 105k array elements per call and blew PostgREST''s 8s timeout.';
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
      exists (select 1 from public.shipment_verifications sv
              where sv.user_id = f.owner_user_id and sv.order_ids @> array[f.order_id]) as pack_verified,
      -- see the header: BOTH conditions, because neither signal is sufficient alone
      (not exists (select 1 from public.shipment_verifications sv
                   where sv.user_id = f.owner_user_id and sv.order_ids @> array[f.order_id])
       and coalesce(soi.status, '') in ('AWAITING_SHIPMENT', 'AWAITING_COLLECTION'))  as unpacked
    from flagged f
    left join public.capture_events ce
      on ce.order_id = f.order_id and ce.user_id = f.owner_user_id
    left join public.synced_order_ids soi
      on soi.order_id = f.order_id and soi.user_id = f.owner_user_id
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
  order by j.bound_at desc, j.order_id desc
  limit greatest(1, least(200, coalesce(p_limit, 50)))
  offset greatest(0, coalesce(p_offset, 0));
$function$;

-- Grants are NOT re-applied: create-or-replace preserves them (unlike 135's drop+create). Verified
-- after applying — authenticated: false, service_role: true.
