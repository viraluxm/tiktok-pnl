-- VERBATIM SNAPSHOT of the LIVE public.pnl_order_grain view (pg_get_viewdef, 2026-09-11).
--
-- THIS FILE IS A SNAPSHOT, NOT A MIGRATION. Do not apply it to production — it is already
-- there. It is recorded because the view exists in NO repo migration: `rg "create (or
-- replace )?view"` across the whole repo returns zero hits, yet this view is the canonical
-- order-grain COGS surface behind pnl_by_show_as, chat_pnl_totals_as and the owner
-- dashboard (/api/tiktok/product-stats reads it directly).
--
-- Its cost expression is the one that matters to migrations 152-154:
--     sum(las.qty * COALESCE(las.unit_cost_cents_snapshot, isk.unit_cost_cents))
-- i.e. it reads the snapshot dynamically, which is why repricing snapshots propagates here
-- with no further work. supabase/tests/fifo_source_batch/pnl_surfaces.sql installs this same
-- text in the throwaway test database so that propagation is proven rather than assumed.
create or replace view public.pnl_order_grain as  WITH cap AS (
         SELECT DISTINCT ON (capture_events.user_id, capture_events.order_id) capture_events.user_id,
            capture_events.order_id,
            capture_events.store_id,
            capture_events.selling_price_cents,
            COALESCE(capture_events.ordered_at, capture_events.created_at) AS ordered_at_eff
           FROM capture_events
          WHERE capture_events.order_id IS NOT NULL
          ORDER BY capture_events.user_id, capture_events.order_id, (COALESCE(capture_events.ordered_at, capture_events.created_at))
        ), sold AS (
         SELECT DISTINCT ON (live_auction_items.user_id, live_auction_items.client_idempotency_key) live_auction_items.user_id,
            live_auction_items.client_idempotency_key AS order_id,
            live_auction_items.id AS item_id,
            live_auction_items.session_id,
            live_auction_items.store_id
           FROM live_auction_items
          WHERE live_auction_items.status = 'sold'::text AND live_auction_items.client_idempotency_key IS NOT NULL
          ORDER BY live_auction_items.user_id, live_auction_items.client_idempotency_key
        ), syn AS (
         SELECT DISTINCT ON (synced_order_ids.user_id, synced_order_ids.order_id) synced_order_ids.user_id,
            synced_order_ids.order_id,
            synced_order_ids.store_id,
            synced_order_ids.gmv,
            synced_order_ids.shipping,
            synced_order_ids.order_date,
            synced_order_ids.order_created_at
           FROM synced_order_ids
          WHERE synced_order_ids.order_id IS NOT NULL AND NOT upper(COALESCE(synced_order_ids.status, ''::text)) ~ 'CANCEL|REVERSE|REFUND|RETURN'::text
          ORDER BY synced_order_ids.user_id, synced_order_ids.order_id
        ), cost AS (
         SELECT las.auction_item_id,
            sum(las.qty * COALESCE(las.unit_cost_cents_snapshot, isk.unit_cost_cents)) AS known_cost,
            count(*) FILTER (WHERE COALESCE(las.unit_cost_cents_snapshot, isk.unit_cost_cents) IS NULL) AS missing_lines,
            count(*) AS n_lines,
            sum(las.qty) AS units,
            min(las.inventory_sku_id::text) AS sku
           FROM live_auction_item_skus las
             LEFT JOIN inventory_skus isk ON isk.id = las.inventory_sku_id
          GROUP BY las.auction_item_id
        ), allo AS (
         SELECT DISTINCT u.user_id,
            u.order_id
           FROM ( SELECT cap_1.user_id,
                    cap_1.order_id
                   FROM cap cap_1
                UNION
                 SELECT syn_1.user_id,
                    syn_1.order_id
                   FROM syn syn_1) u
        )
 SELECT o.order_id,
    o.user_id,
    COALESCE((cap.ordered_at_eff AT TIME ZONE 'America/Los_Angeles'::text)::date, syn.order_date) AS business_date,
    COALESCE(sold.store_id, cap.store_id, syn.store_id) AS store_id,
        CASE
            WHEN cap.order_id IS NOT NULL THEN 'auction'::text
            ELSE 'non_auction'::text
        END AS source,
        CASE
            WHEN syn.order_id IS NOT NULL THEN 'synced'::text
            ELSE 'captured'::text
        END AS maturity,
        CASE
            WHEN sold.order_id IS NOT NULL THEN cap.selling_price_cents
            ELSE NULL::integer
        END AS revenue_cents,
        CASE
            WHEN sold.order_id IS NOT NULL THEN platform_fee_cents(cap.selling_price_cents::numeric)
            ELSE NULL::numeric
        END AS platform_fee_cents,
        CASE
            WHEN sold.order_id IS NOT NULL THEN cost.known_cost
            ELSE NULL::bigint
        END AS cogs_cents,
        CASE
            WHEN sold.order_id IS NOT NULL THEN COALESCE(cost.missing_lines, 0::bigint)
            ELSE NULL::bigint
        END AS cogs_missing_lines,
        CASE
            WHEN sold.order_id IS NOT NULL AND cost.known_cost IS NOT NULL THEN cap.selling_price_cents::numeric - platform_fee_cents(cap.selling_price_cents::numeric) - cost.known_cost::numeric
            ELSE NULL::numeric
        END AS gross_margin_cents,
        CASE
            WHEN cap.order_id IS NULL THEN round(GREATEST(COALESCE(syn.gmv, 0::numeric) - COALESCE(syn.shipping, 0::numeric), 0::numeric) * 100::numeric)::bigint
            ELSE 0::bigint
        END AS uncaptured_gmv_cents,
    sold.session_id,
    ls.host_id AS host_employee_id,
    cost.sku,
    COALESCE(cap.ordered_at_eff, syn.order_created_at) AS ordered_at,
    cap.order_id IS NOT NULL AS captured,
    sold.order_id IS NOT NULL AS is_sold,
        CASE
            WHEN sold.order_id IS NOT NULL THEN COALESCE(cost.units, 0::bigint)
            ELSE NULL::bigint
        END AS units
   FROM allo o
     LEFT JOIN cap ON cap.user_id = o.user_id AND cap.order_id = o.order_id
     LEFT JOIN sold ON sold.user_id = o.user_id AND sold.order_id = o.order_id
     LEFT JOIN syn ON syn.user_id = o.user_id AND syn.order_id = o.order_id
     LEFT JOIN cost ON cost.auction_item_id = sold.item_id
     LEFT JOIN live_sessions ls ON ls.id = sold.session_id;
