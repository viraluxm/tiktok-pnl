-- 158_show_auction_hosts.sql
-- ┌─────────────────────────────────────────────────────────────────────────────┐
-- │ APPLIED TO PRODUCTION: 2026-09-13. DO NOT RE-APPLY.                        │
-- │ This DB has no migration ledger — this file IS the record that it ran.      │
-- │ Function bodies only: no table, no data, no capture-path lock, and so no    │
-- │ write-silence gate (same class as 113). The gate was clear anyway at apply  │
-- │ time — capture idle 79.8 min, heartbeat idle 79.8 min, 0 open sessions.     │
-- │                                                                             │
-- │ Verified after apply: pnl_show_auction_hosts('943edfbf…') returns 144 rows   │
-- │ and splits Samie 97 / Ismael 46 sold — identical to pnl_show_host_segments.  │
-- │ ACL matches 113's posture exactly: authenticated=X, service_role=X, no anon. │
-- └─────────────────────────────────────────────────────────────────────────────┘
--
-- Per-auction host assignment, so the Shows UI can filter one show's sales down to a
-- single host and have every recomputed figure agree with pnl_show_host_segments.
--
-- ═══════════════════════════ WHY THIS EXISTS ═══════════════════════════
-- The obvious client-side implementation — tag each board row by comparing its
-- `logged_at` to the segment windows — is WRONG, measurably.
--
-- The board sets logged_at = live_auction_items.closed_at ?? created_at (see
-- src/app/api/live/sessions/[id]/board/route.ts), but every host read anchors a sale at
-- coalesce(capture_events.ordered_at, created_at). closed_at is the CLOSE/FLIP instant,
-- not the order instant. Measured over 66,808 rows in the 14 days to 2026-09-13:
--
--     median  4.9s          <- harmless
--     p95     26,611s       <- 7.4 HOURS
--     max     1,137,973s    <- 13 days
--     >1min   6,645 rows (10.0%)
--     >5min   4,898 rows ( 7.3%)
--
-- A bathroom-break segment is ~10 minutes. Assigning on closed_at would misfile ~7% of
-- rows across segment boundaries — precisely the error that would corrupt a host bonus.
--
-- The second reason is fidelity. The correct window is not simply [started_at, ended_at):
-- 113's head-of-show reclaim bounds a first-segment reach-back by BOTH a contiguity gap
-- AND the activity end of every earlier session in the room, and 112 pins adjacency.
-- Re-expressing that in TypeScript would fork the rule and let the chips and the list
-- disagree. So the assignment is computed HERE, from the same CTEs, and the row-level
-- answer and the aggregate are the same computation by construction.
--
-- ═══════════════════════════ CONTRACT ═══════════════════════════
-- One row per live_auction_items row in the session (NOT only 'sold' — the board renders
-- every status, so every row needs an answer). unattributed = true means the sale matched
-- no segment; the UI must show it under "Unattributed", never silently fold it into a host.
--
-- The seg/assigned CTEs below are a VERBATIM lift from pnl_show_host_segments in
-- 113_segment_head_of_show.sql. If that function's windowing ever changes, change it here
-- in the same commit — test/showHostSplit asserts the two agree.

begin;

create or replace function public.pnl_show_auction_hosts(
  p_session_id uuid,
  p_tz text default 'America/Los_Angeles'   -- accepted for signature parity with 113; unused
)
returns table(item_id uuid, host_id uuid, unattributed boolean)
language sql
stable
security invoker
as $function$
  with ses as (
    select ls.id, ls.started_at,
           public.lensed_session_activity_end(ls.id)   as eff_session_end,
           public.lensed_session_activity_start(ls.id) as eff_session_start
      from public.live_sessions ls
     where ls.id = p_session_id
  ),
  ranked as (
    select s.*, row_number() over (order by s.started_at, s.created_at) as rn
      from public.live_session_host_segments s
      join ses on ses.id = s.session_id
     where s.superseded_by is null
  ),
  -- VERBATIM from pnl_show_host_segments (113). Do not "simplify".
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
  -- 113 filters to status='sold' because it only aggregates money. The board renders every
  -- status, so this one does not filter — the anchor is identical either way, so the rows
  -- 113 does aggregate get an identical answer here.
  sale as (
    select lai.id as item_id,
           coalesce(ce.ordered_at, ce.created_at) as sale_at
      from public.live_auction_items lai
      join public.capture_events ce
        on ce.order_id = lai.client_idempotency_key and ce.user_id = lai.user_id
     where lai.session_id = p_session_id
  )
  select sale.item_id, seg.host_id, (seg.id is null) as unattributed
    from sale
    left join seg
      on sale.sale_at >= seg.eff_start
     and (sale.sale_at < seg.eff_end
          or (seg.ends_at_session_ceiling and sale.sale_at <= seg.eff_end));
$function$;

comment on function public.pnl_show_auction_hosts(uuid, text) is
  'Per-auction host assignment for one show. Windowing is a verbatim lift from '
  'pnl_show_host_segments (113) so a row-level filter and the per-host aggregate can never '
  'disagree. Anchors on coalesce(capture_events.ordered_at, created_at) — NEVER on '
  'live_auction_items.closed_at, which is the close/flip instant and differs by >5min on '
  '7.3% of rows.';

-- security invoker + RLS on the underlying tables already scopes this to the caller's own
-- rows; no GRANT to anon. Mirrors 113's posture.
revoke all on function public.pnl_show_auction_hosts(uuid, text) from public, anon;
grant execute on function public.pnl_show_auction_hosts(uuid, text) to authenticated;

commit;
