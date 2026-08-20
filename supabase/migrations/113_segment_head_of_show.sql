-- 113_segment_head_of_show.sql
--
-- Reclaim the sales that land BEFORE a session's started_at.  NOT APPLIED.
-- Function bodies only. No table, no data, no capture-path lock, no write-silence gate.
-- Depends on 106/110/112 (all applied).
--
-- ═══════════════════════════ THE PROBLEM ═══════════════════════════
-- getOrCreateSession creates the live_sessions row ON THE FIRST CAPTURED SALE, so
-- capture_events.ordered_at — the instant TikTok recorded the order — can precede
-- live_sessions.started_at. The read functions floor a segment's effective start at
-- ses.started_at, so those opening sales match no segment and surface as 'Unattributed'.
--
-- Measured across 251 sessions: 164 of them (65%) have at least one sale before their own
-- started_at, stranding 328 sales. Small in aggregate (0.55% of ~59k) but SYSTEMATIC, and it
-- always hits the host who opened the show.
--
-- ═══════════════════════════ WHY A NAIVE FIX IS UNSAFE ═══════════════════════════
-- Simply reaching back to the earliest sale in the room would be wrong. The reach-back
-- distribution has a long tail:
--
--   <= 10s   136 sessions   136 sales      <- the real mechanism: row created a beat late
--   <= 1m      8 sessions    13 sales
--   <= 10m    18 sessions    60 sales
--   <= 1h      1 session     81 sales      <- 57.9 minutes
--   >  1h      1 session     38 sales      <- 14.9 HOURS
--
-- Those last two are not head-of-show artifacts; they are sessions created long after their
-- show was already selling. An unbounded reach-back would hand roughly 16 hours of
-- pay-adjacent time to whoever opened those two shows.
--
-- Worse, the same room can hold OVERLAPPING sessions — c1101b87 and ca92ccf3 share a
-- started_at — so "the previous session" is not simply the one before it in time.
--
-- ═══════════════════════════ THE RULE ═══════════════════════════
-- The reach-back is bounded twice, and both bounds are load-bearing:
--
--   1. MAGNITUDE — never further back than ONE contiguity gap
--      (lensed_session_contiguity_gap(), 45 min, imported from autoEnd.ts IDLE_THRESHOLD_MIN).
--      No new constant is invented: the existing semantic is "a gap larger than this means a
--      different stretch of activity", which is exactly the judgement being made here.
--   2. PRIOR SESSION — never past the activity end of ANY earlier session in the same room,
--      so a reach-back can never absorb a previous show's sales. Taken as a MAX over all
--      earlier sessions in the room, not just the immediately preceding one, because they
--      can overlap.
--
-- And it applies to the FIRST segment ONLY, and only when that segment actually begins at or
-- before the session's start. A host picked two hours into a show must NOT be credited with the
-- opening — those two hours genuinely have no host. Later segments keep exact adjacency to
-- their predecessor, untouched.

begin;

-- ── Where a session's activity really began ───────────────────────────────────
-- Mirror of lensed_session_activity_end. Returns session.started_at when there is nothing
-- earlier to reclaim, so callers can use it unconditionally.
create or replace function public.lensed_session_activity_start(p_session_id uuid)
returns timestamptz
language sql
stable
as $$
  with ses as (
    select ls.id, ls.user_id, ls.tiktok_live_id, ls.started_at
      from public.live_sessions ls
     where ls.id = p_session_id
  ),
  -- BOUND 2: the latest activity end among ALL earlier sessions in this room. MAX rather than
  -- "the previous one" because sessions in a room can overlap (same started_at observed).
  prior as (
    select max(public.lensed_session_activity_end(ls2.id)) as prior_end
      from public.live_sessions ls2, ses
     where ls2.tiktok_live_id is not distinct from ses.tiktok_live_id
       and ls2.user_id = ses.user_id
       and ls2.id <> ses.id
       and ls2.started_at < ses.started_at
  ),
  floor_at as (
    -- GREATEST ignores NULLs, so a room with no earlier session falls through to the
    -- magnitude bound alone.
    select greatest(ses.started_at - public.lensed_session_contiguity_gap(), prior.prior_end) as f
      from ses, prior
  ),
  earliest as (
    select min(coalesce(ce.ordered_at, ce.created_at)) as first_sale
      from public.capture_events ce, ses, floor_at
     where ce.room_id = ses.tiktok_live_id
       and ce.user_id = ses.user_id
       and coalesce(ce.ordered_at, ce.created_at) <  ses.started_at
       and coalesce(ce.ordered_at, ce.created_at) >  floor_at.f
  )
  select least(ses.started_at, coalesce(earliest.first_sale, ses.started_at))
    from ses, earliest
$$;

comment on function public.lensed_session_activity_start(uuid) is
  'Where a session''s selling actually began: its started_at, or the earliest sale before it '
  'when one exists within one contiguity gap AND after every earlier same-room session''s '
  'activity end. Mirror of lensed_session_activity_end. See migration 113.';

-- ══════════════════════════════════════════════════════════════════════════════
-- Read functions: first segment reaches back; later segments unchanged.
-- Bodies are otherwise byte-identical to 106 (as amended by 112's callers).
-- ══════════════════════════════════════════════════════════════════════════════

create or replace function public.pnl_show_host_segments(
  p_session_id uuid,
  p_tz text default 'America/Los_Angeles'
)
returns table(
  host_id uuid, host_name text, segment_count bigint, total_minutes numeric,
  auctions bigint, units bigint, revenue_cents numeric, cogs_cents numeric, net_profit_cents numeric,
  heartbeat_beyond_activity boolean
)
language sql
stable
as $function$
  with ses as (
    select ls.id, ls.started_at, ls.last_seen_at,
           public.lensed_session_activity_end(ls.id)   as eff_session_end,
           public.lensed_session_activity_start(ls.id) as eff_session_start
      from public.live_sessions ls where ls.id = p_session_id
  ),
  flag as (
    select coalesce(
             ses.last_seen_at is not null
             and ses.last_seen_at > ses.eff_session_end + public.lensed_session_contiguity_gap(),
             false) as heartbeat_beyond_activity
      from ses
  ),
  ranked as (
    select s.*, row_number() over (order by s.started_at, s.created_at) as rn
      from public.live_session_host_segments s
      join ses on ses.id = s.session_id
     where s.superseded_by is null
  ),
  seg as (
    select r.id, r.host_id,
           -- FIRST segment, and only when it actually begins at or before the session start,
           -- reaches back to where selling began. A host picked mid-show keeps its own start.
           case when r.rn = 1 and r.started_at <= ses.started_at
                then least(ses.started_at, ses.eff_session_start)
                else greatest(r.started_at, ses.started_at) end as eff_start,
           least(coalesce(r.ended_at, 'infinity'::timestamptz), ses.eff_session_end) as eff_end,
           (least(coalesce(r.ended_at, 'infinity'::timestamptz), ses.eff_session_end)
              >= ses.eff_session_end) as ends_at_session_ceiling
      from ranked r, ses
  ),
  sale as (
    select lai.id as item_id, ce.selling_price_cents as price_cents,
           coalesce(ce.ordered_at, ce.created_at) as sale_at
      from public.live_auction_items lai
      join public.capture_events ce
        on ce.order_id = lai.client_idempotency_key and ce.user_id = lai.user_id
     where lai.status = 'sold' and lai.session_id = p_session_id
  ),
  item_cost as (
    select las.auction_item_id as item_id, sum(las.qty) as units,
           sum(las.qty * coalesce(las.unit_cost_cents_snapshot, isk.unit_cost_cents, 0)) as cogs
      from public.live_auction_item_skus las
      left join public.inventory_skus isk on isk.id = las.inventory_sku_id
     group by las.auction_item_id
  ),
  assigned as (
    select sale.item_id, sale.price_cents, seg.host_id, (seg.id is not null) as matched
      from sale
      left join seg
        on sale.sale_at >= seg.eff_start
       and (sale.sale_at < seg.eff_end
            or (seg.ends_at_session_ceiling and sale.sale_at <= seg.eff_end))
  ),
  parts as (
    select seg.host_id, false as unattributed, 1::bigint as segment_count,
           (greatest(extract(epoch from (seg.eff_end - seg.eff_start)), 0) / 60.0)::numeric as minutes,
           0::bigint as auctions, 0::bigint as units, 0::numeric as revenue_cents, 0::numeric as cogs_cents
      from seg
    union all
    select a.host_id, not a.matched, 0::bigint, 0::numeric, 1::bigint,
           coalesce(ic.units, 0)::bigint, coalesce(a.price_cents, 0)::numeric, coalesce(ic.cogs, 0)::numeric
      from assigned a
      left join item_cost ic on ic.item_id = a.item_id
  )
  select p.host_id,
    case when p.unattributed then 'Unattributed' else coalesce(e.name, 'Unassigned host') end,
    sum(p.segment_count)::bigint, sum(p.minutes)::numeric,
    sum(p.auctions)::bigint, sum(p.units)::bigint,
    sum(p.revenue_cents)::numeric, sum(p.cogs_cents)::numeric,
    (sum(p.revenue_cents) - public.platform_fee_cents(sum(p.revenue_cents)) - sum(p.cogs_cents))::numeric,
    (select heartbeat_beyond_activity from flag)
  from parts p
  left join public.employees e on e.id = p.host_id
  group by p.host_id, p.unattributed, e.name
  order by 4 desc nulls last, 2;
$function$;

create or replace function public.pnl_show_hourly_by_host(
  p_session_id uuid,
  p_tz text default 'America/Los_Angeles'
)
returns table(
  hour_start timestamp without time zone, hour_of_day integer,
  host_id uuid, host_name text,
  auctions bigint, units bigint, revenue_cents numeric, cogs_cents numeric, net_profit_cents numeric
)
language sql
stable
as $function$
  with ses as (
    select ls.id, ls.started_at,
           public.lensed_session_activity_end(ls.id)   as eff_session_end,
           public.lensed_session_activity_start(ls.id) as eff_session_start
      from public.live_sessions ls where ls.id = p_session_id
  ),
  ranked as (
    select s.*, row_number() over (order by s.started_at, s.created_at) as rn
      from public.live_session_host_segments s
      join ses on ses.id = s.session_id
     where s.superseded_by is null
  ),
  seg as (
    select r.id, r.host_id,
           case when r.rn = 1 and r.started_at <= ses.started_at
                then least(ses.started_at, ses.eff_session_start)
                else greatest(r.started_at, ses.started_at) end as eff_start,
           least(coalesce(r.ended_at, 'infinity'::timestamptz), ses.eff_session_end) as eff_end,
           (least(coalesce(r.ended_at, 'infinity'::timestamptz), ses.eff_session_end)
              >= ses.eff_session_end) as ends_at_session_ceiling
      from ranked r, ses
  ),
  sale as (
    select lai.id as item_id, ce.selling_price_cents as price_cents,
           coalesce(ce.ordered_at, ce.created_at) as sale_at,
           (coalesce(ce.ordered_at, ce.created_at) at time zone p_tz) as sale_local
      from public.live_auction_items lai
      join public.capture_events ce
        on ce.order_id = lai.client_idempotency_key and ce.user_id = lai.user_id
     where lai.status = 'sold' and lai.session_id = p_session_id
  ),
  item_cost as (
    select las.auction_item_id as item_id, sum(las.qty) as units,
           sum(las.qty * coalesce(las.unit_cost_cents_snapshot, isk.unit_cost_cents, 0)) as cogs
      from public.live_auction_item_skus las
      left join public.inventory_skus isk on isk.id = las.inventory_sku_id
     group by las.auction_item_id
  ),
  assigned as (
    select sale.item_id, sale.price_cents, sale.sale_local, seg.host_id, (seg.id is not null) as matched
      from sale
      left join seg
        on sale.sale_at >= seg.eff_start
       and (sale.sale_at < seg.eff_end
            or (seg.ends_at_session_ceiling and sale.sale_at <= seg.eff_end))
  )
  select date_trunc('hour', a.sale_local)::timestamp,
    extract(hour from a.sale_local)::integer,
    a.host_id,
    case when a.matched is false then 'Unattributed' else coalesce(e.name, 'Unassigned host') end,
    count(*)::bigint,
    coalesce(sum(ic.units), 0)::bigint,
    coalesce(sum(a.price_cents), 0)::numeric,
    coalesce(sum(ic.cogs), 0)::numeric,
    (coalesce(sum(a.price_cents),0) - public.platform_fee_cents(coalesce(sum(a.price_cents),0))
       - coalesce(sum(ic.cogs),0))::numeric
  from assigned a
  left join item_cost ic on ic.item_id = a.item_id
  left join public.employees e on e.id = a.host_id
  group by 1, 2, 3, 4
  order by 1, 4;
$function$;

revoke execute on function public.lensed_session_activity_start(uuid) from public, anon;
grant  execute on function public.lensed_session_activity_start(uuid) to authenticated;
revoke execute on function public.pnl_show_host_segments(uuid, text) from public, anon;
revoke execute on function public.pnl_show_hourly_by_host(uuid, text) from public, anon;
grant  execute on function public.pnl_show_host_segments(uuid, text) to authenticated;
grant  execute on function public.pnl_show_hourly_by_host(uuid, text) to authenticated;

commit;
