-- 137_squish_multibind_onhold_and_order.sql
--
-- Two fixes to the audit queue, both found by the team looking at the real screen.
--
-- ── 1. ON_HOLD orders were wrongly marked "already gone" ─────────────────────────────────────
--
-- 135 defined the fixable set with an ALLOW-LIST of two statuses:
--
--     coalesce(soi.status,'') in ('AWAITING_SHIPMENT','AWAITING_COLLECTION')
--
-- so EVERY other status fell through to "not fixable" and the page told the team the box had
-- already shipped. Found live: 10 ON_HOLD rows, NOT pack-verified, NO tracking number, all bound
-- the same day. Nothing had been picked; no label had even been bought. They were the freshest,
-- most fixable rows in the queue and the UI was telling people to give up on them.
--
-- INVERTED TO A DENY-LIST of the states that genuinely mean the units are gone:
--
--     coalesce(soi.status,'') not in ('IN_TRANSIT','DELIVERED','COMPLETED')
--
-- CANCELLED is already excluded further up, so it is not repeated here. Every status present in
-- prod was enumerated before choosing: COMPLETED, DELIVERED, AWAITING_COLLECTION, CANCELLED,
-- AWAITING_SHIPMENT, IN_TRANSIT, ON_HOLD (608 orders, ZERO with a tracking number), UNPAID (3).
-- ON_HOLD and UNPAID are pre-shipment, so both are now correctly fixable.
--
-- THE TRADE-OFF, STATED. A deny-list means an unknown FUTURE status defaults to fixable, where the
-- allow-list defaulted to not-fixable. The allow-list's default is safer in the abstract, but it
-- silently broke a real, current status and would break the next one too. The pack_verified half
-- of the condition is the real guard — anything actually picked has a shipment_verifications row —
-- and the three shipped states are named explicitly so the 17 known shipped-without-a-row cases
-- (the set-aside gap) stay excluded.
--
-- ── 2. Oldest first, not newest first ────────────────────────────────────────────────────────
--
-- Was `order by j.bound_at desc`. The team works this as a queue to drain, and with the fixable
-- filter on, the OLDEST unpacked box is the one closest to being packed and shipped — i.e. the one
-- about to become impossible to fix. Newest-first put the least urgent rows on top and buried the
-- deadline. Now `asc`, so 7d / 14d / 30d each read oldest → now and the team catches up.
--
-- Class A: create-or-replace of a function only /api/member/audit calls. APPLIED to prod
-- 2026-09-09. Verified after: fixable 287 -> 301 (the 9 ON_HOLD rows return), zero packed-or-
-- shipped rows leaking through the filter, first row is the oldest in the window.
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
       and coalesce(soi.status, '') not in ('IN_TRANSIT', 'DELIVERED', 'COMPLETED'))  as unpacked
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
  order by j.bound_at asc, j.order_id asc
  limit greatest(1, least(200, coalesce(p_limit, 50)))
  offset greatest(0, coalesce(p_offset, 0));
$function$;

-- Grants preserved by create-or-replace; re-checked authenticated=false, service_role=true.
