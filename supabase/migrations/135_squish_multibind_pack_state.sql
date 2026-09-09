-- 135_squish_multibind_pack_state.sql
--
-- Adds PACK STATE to the squish over-bind audit queue, and a filter for it.
--
-- WHY THIS EXISTS — the correction is only CORRECT on a box that has not been packed yet.
-- Over-binding an order puts N units on it, and the pick ticket renders qty (`×2`) and sums units,
-- so the picker is told to gather 2. Once that box is packed and shipped, BOTH units have
-- physically left the building. "Keep one" restocks a unit that is already with a customer — it
-- fixes the COGS error by creating an inventory error. On an unpacked box it is right in both
-- books. The team must therefore be able to see, and work, only the unpacked ones.
--
-- THE STATUS FIELD ALONE CANNOT ANSWER THIS. Measured on live 2026-09-08 over the 14-day queue:
--
--     AWAITING_COLLECTION, NOT pack-verified   182   ← label BOUGHT, box NOT packed yet
--     AWAITING_SHIPMENT,   NOT pack-verified   112   ← no label yet, definitely on the shelf
--     AWAITING_COLLECTION, pack-verified        77
--     IN_TRANSIT,          pack-verified       189
--     DELIVERED,           pack-verified       140
--     IN_TRANSIT/DELIVERED/COMPLETED, NOT verified  17   ← shipped with no verification row
--
-- AWAITING_COLLECTION means the label is bought and the box is in the PACK-READY QUEUE
-- (src/lib/shipping/packReady.ts) — packed only once a shipment_verifications row exists. So
-- treating AWAITING_COLLECTION as "packed" wrongly excludes 182 still-correctable orders, and
-- treating it as "unpacked" wrongly includes 77 already-packed ones.
--
-- NOR CAN THE VERIFICATION ROW ALONE. Those 17 IN_TRANSIT/DELIVERED rows carry NO verification row
-- yet have demonstrably shipped — the known gap where set-aside scans write no verification row.
-- Absence of a row is therefore WEAKER evidence than presence of one.
--
-- SO THE PREDICATE IS BOTH, ANDed:  unpacked  =  no shipment_verifications row
--                                            AND status IN (AWAITING_SHIPMENT, AWAITING_COLLECTION)
-- Presence of a verification row means packed. Absence means unpacked ONLY while the platform also
-- still says the parcel has not moved. That yields 294 safe-to-correct of the 718.
--
-- DROP + CREATE, not CREATE OR REPLACE: the return type gains a column (pack_verified) and the
-- signature gains a parameter (p_unpacked_only), and Postgres will not replace a function whose
-- OUT columns change. Nothing but /api/member/audit calls this function, so the drop is safe; the
-- grants are re-applied below because DROP takes them with it.
--
-- CLASS A: one function of my own, replaced in a transaction. No existing table is altered, no
-- live-path function (lensed_log_auction / lensed_unbind and their _as siblings) is touched.

begin;

set local lock_timeout = '3s';

drop function if exists public.squish_multibind_audit_as(uuid[], uuid[], boolean, timestamptz, int, int);

create or replace function public.squish_multibind_audit_as(
  p_owner_user_ids uuid[],
  p_store_ids      uuid[],
  p_all_stores     boolean,
  p_since          timestamptz,
  p_limit          int default 50,
  p_offset         int default 0,
  p_unpacked_only  boolean default false
)
returns table(
  order_id         text,
  item_id          uuid,
  session_id       uuid,
  owner_user_id    uuid,
  store_id         uuid,
  bound_at         timestamptz,
  units            int,
  line_count       int,
  tiktok_title     text,
  buyer_handle     text,
  won_price_cents  int,
  lot_hint         text,
  ordered_at       timestamptz,
  tiktok_status    text,
  tracking_number  text,
  pack_verified    boolean,
  unpacked         boolean,
  lines            jsonb,
  total_count      bigint
)
language sql
stable
as $function$
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
  -- UNNESTED ONCE, then hash-joined. shipment_verifications is one row per BOX with an order_ids[]
  -- array and NO GIN index on it, so a per-row `order_id = any(order_ids)` EXISTS would seq-scan
  -- all 35k rows for every flagged order. Flattening the array a single time is one pass.
  verified as (
    select distinct sv.user_id, oid as order_id
    from public.shipment_verifications sv,
         unnest(sv.order_ids) as oid
    where sv.user_id = any(p_owner_user_ids)
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
      (v.order_id is not null)                                         as pack_verified,
      -- see the header: BOTH conditions, because neither signal is sufficient alone
      (v.order_id is null
       and coalesce(soi.status, '') in ('AWAITING_SHIPMENT', 'AWAITING_COLLECTION'))  as unpacked
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
  order by j.bound_at desc, j.order_id desc
  limit greatest(1, least(200, coalesce(p_limit, 50)))
  offset greatest(0, coalesce(p_offset, 0));
$function$;

-- Re-applied because DROP FUNCTION took the old grants with it. service_role ONLY: the function
-- trusts p_owner_user_ids, so a grant to `authenticated` would be a cross-tenant read.
revoke execute on function public.squish_multibind_audit_as(uuid[], uuid[], boolean, timestamptz, int, int, boolean) from public, anon, authenticated;
grant  execute on function public.squish_multibind_audit_as(uuid[], uuid[], boolean, timestamptz, int, int, boolean) to service_role;

comment on function public.squish_multibind_audit_as(uuid[], uuid[], boolean, timestamptz, int, int, boolean) is
  'Squish over-bind audit queue. pack_verified = a shipment_verifications row exists for the order; '
  'unpacked = no such row AND the platform still says AWAITING_SHIPMENT/AWAITING_COLLECTION, which '
  'is the only state where the keep-one correction is right in BOTH books. p_unpacked_only filters '
  'to those. Read-only, service_role only.';

commit;
