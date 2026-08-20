-- ═══════════════════════════════════════════════════════════════════════════════════════
-- PHASE 2 SMOKE TEST — verification queries, in the order you run them
--
-- Run these one block at a time. Every block is READ-ONLY except where it says otherwise
-- (nothing here writes).
--
-- HOW TO USE: set the session id ONCE in block 0, then run blocks in order. Every later block
-- reads it back from the temp table, so you paste the id exactly once.
--
-- Steps 1-8 have queries. STEP 9 HAS NONE — it is a UI check, see block 9.
-- ═══════════════════════════════════════════════════════════════════════════════════════


-- ═══ BLOCK 0 ═══ Set the session under test. Run this FIRST, once.
-- Find the id: the newest live session for the room you are testing.
select id, tiktok_live_id as room, store_id, started_at, ended_at, host_id
  from public.live_sessions
 order by started_at desc
 limit 5;

-- Then paste it here and run. (Temp table lives for your psql session only.)
drop table if exists _t;
create temp table _t(session_id uuid);
insert into _t values ('PASTE-SESSION-ID-HERE');
select * from _t;
-- PASS: one row, the id you expect.


-- ═══ BLOCK 1 ═══ STEP 1 — ext_version is stamped
select ce.ext_version, count(*) as captures, max(ce.created_at) as newest
  from public.capture_events ce
  join public.live_sessions ls on ls.tiktok_live_id = ce.room_id and ls.user_id = ce.user_id
 where ls.id = (select session_id from _t)
   and ce.created_at >= ls.started_at
 group by ce.ext_version
 order by newest desc;
-- PASS: ext_version = '0.7.0' on the new rows.
-- FAIL: NULL on rows written after the build was loaded → BAD BUILD. Stop the test, capture the
--       diagnostics ring, roll back. (Older rows in the same room may legitimately be NULL if
--       they predate the build — check `newest`.)


-- ═══ BLOCK 2 ═══ STEP 2 — exactly one open segment, correct host, scalar in sync
select s.id as segment_id, e.name as host, s.started_at, s.ended_at,
       s.source, s.ended_source,
       (select e2.name from public.employees e2
         join public.live_sessions l2 on l2.host_id = e2.id
        where l2.id = s.session_id) as live_sessions_host_scalar
  from public.live_session_host_segments s
  left join public.employees e on e.id = s.host_id
 where s.session_id = (select session_id from _t)
   and s.superseded_by is null
 order by s.started_at;
-- PASS: exactly 1 row; ended_at IS NULL; host = the person you picked;
--       source IN ('session_create','session_reuse'); live_sessions_host_scalar = same person.
-- FAIL: 0 rows → the writer never fired. Check the overlay for the HOST NOT SAVED banner and
--       read its tooltip. 2+ open rows should be IMPOSSIBLE (partial unique index).


-- ═══ BLOCK 3 ═══ STEP 3 / STEP 8 — the rollup, and conservation
select host_name,
       round(total_minutes/60.0, 2) as hours,
       segment_count, auctions, units,
       revenue_cents, net_profit_cents,
       heartbeat_beyond_activity as hb_flag
  from public.pnl_show_host_segments((select session_id from _t))
 order by total_minutes desc;

-- conservation: attributed + unattributed MUST equal the session's sold count
select (select coalesce(sum(auctions),0)
          from public.pnl_show_host_segments((select session_id from _t))) as rollup_auctions,
       (select count(*)
          from public.live_auction_items lai
          join public.capture_events ce
            on ce.order_id = lai.client_idempotency_key and ce.user_id = lai.user_id
         where lai.session_id = (select session_id from _t) and lai.status = 'sold') as sold_count,
       (select coalesce(sum(auctions),0)
          from public.pnl_show_host_segments((select session_id from _t))) =
       (select count(*)
          from public.live_auction_items lai
          join public.capture_events ce
            on ce.order_id = lai.client_idempotency_key and ce.user_id = lai.user_id
         where lai.session_id = (select session_id from _t) and lai.status = 'sold') as conserved;
-- PASS: conserved = true, and NO 'Unattributed' row in the rollup above.
-- FAIL, rollup < sold_count  → sales are falling into a GAP between segments.
-- FAIL, rollup > sold_count  → segments OVERLAP and revenue is DOUBLE-COUNTED. Worse of the two.
--       Either way: finish the show, then roll back the extension before the next one.


-- ═══ BLOCK 4 ═══ STEP 4 — the mid-show switch: exactly two adjacent segments
select s.started_at, e.name as host, s.ended_at, s.source, s.ended_source,
       lead(s.started_at) over w                                   as next_starts_at,
       s.ended_at = lead(s.started_at) over w                       as boundary_contiguous,
       lead(s.started_at) over w < s.ended_at                       as OVERLAPS_NEXT,
       (s.ended_at is not null and s.ended_at = s.started_at)       as ZERO_LENGTH,
       round(extract(epoch from (coalesce(s.ended_at, now()) - s.started_at))/60.0, 2) as minutes
  from public.live_session_host_segments s
  left join public.employees e on e.id = s.host_id
 where s.session_id = (select session_id from _t)
   and s.superseded_by is null
window w as (order by s.started_at, s.ended_at nulls last)
 order by s.started_at, s.ended_at nulls last;
-- PASS, all of:
--   * exactly 2 rows for one switch (3 for two switches, etc.)
--   * boundary_contiguous = true on every row except the last
--   * OVERLAPS_NEXT  = false everywhere   ← overlap double-counts revenue
--   * ZERO_LENGTH    = false everywhere   ← a zero-length segment records nothing
--   * row1.ended_source = 'extension_switch'
--   * the last row has ended_at IS NULL while the live is still running
-- FAIL on boundary/overlap/zero-length → a migration 112 regression. Finish the show, do NOT
--       flip SEGMENT_CLOSE_WRITE_ENABLED, treat that show's per-host numbers as unusable.

-- Same thing as a single verdict, if you would rather not read the table:
select count(*) as segments,
       count(*) filter (where nxt is not null and ended_at is distinct from nxt) as non_adjacent,
       count(*) filter (where nxt is not null and nxt < ended_at)                as overlaps,
       count(*) filter (where ended_at is not null and ended_at = started_at)    as zero_length,
       count(*) filter (where ended_at is null)                                  as still_open
  from (select s.started_at, s.ended_at,
               lead(s.started_at) over (order by s.started_at, s.ended_at nulls last) as nxt
          from public.live_session_host_segments s
         where s.session_id = (select session_id from _t) and s.superseded_by is null) q;
-- PASS: non_adjacent = 0, overlaps = 0, zero_length = 0, still_open = 1 (while live) or 0 (ended).
-- NOTE: `segments` is the denominator — if it is 0 or 1 you have not actually tested a switch yet.


-- ═══ BLOCK 5 ═══ STEP 5 — the sales landed on the RIGHT side of the boundary
with seg as (
  select s.id, s.host_id, s.started_at, s.ended_at,
         row_number() over (order by s.started_at) as rn
    from public.live_session_host_segments s
   where s.session_id = (select session_id from _t) and s.superseded_by is null
)
select e.name as host, seg.rn as segment_no,
       to_char(seg.started_at, 'HH24:MI:SS') as seg_from,
       coalesce(to_char(seg.ended_at, 'HH24:MI:SS'), 'open') as seg_to,
       count(ce.order_id) as sales_in_segment,
       to_char(min(coalesce(ce.ordered_at, ce.created_at)), 'HH24:MI:SS') as first_sale,
       to_char(max(coalesce(ce.ordered_at, ce.created_at)), 'HH24:MI:SS') as last_sale
  from seg
  left join public.employees e on e.id = seg.host_id
  left join public.live_auction_items lai
    on lai.session_id = (select session_id from _t) and lai.status = 'sold'
  left join public.capture_events ce
    on ce.order_id = lai.client_idempotency_key and ce.user_id = lai.user_id
   and coalesce(ce.ordered_at, ce.created_at) >= seg.started_at
   and (seg.ended_at is null or coalesce(ce.ordered_at, ce.created_at) < seg.ended_at)
 group by e.name, seg.rn, seg.started_at, seg.ended_at
 order by seg.rn;
-- PASS: every segment's last_sale is before the NEXT segment's seg_from, and each host's sales
--       are the ones that happened during their own stint.
-- EDGE CASE WORTH FORCING: a sale in the same second as the switch must land on the INCOMING
--       host (segments are half-open [start, end), closed only at the session ceiling).


-- ═══ BLOCK 6 ═══ STEP 6 — TWO TABS. The 2a regression check. THE IMPORTANT ONE.
-- Run this with BOTH lives running, having picked a DIFFERENT host in each tab.
-- Do not judge this from the dropdowns — the old bug left the dropdowns looking correct.
select left(ls.id::text, 8) as session,
       ls.tiktok_live_id as room,
       st.name as store,
       e_scalar.name as live_sessions_host_scalar,
       e_seg.name    as open_segment_host,
       (e_scalar.name = e_seg.name) as scalar_matches_segment,
       s.source, s.started_at as segment_started
  from public.live_sessions ls
  left join public.stores st on st.id = ls.store_id
  left join public.employees e_scalar on e_scalar.id = ls.host_id
  left join public.live_session_host_segments s
    on s.session_id = ls.id and s.ended_at is null and s.superseded_by is null
  left join public.employees e_seg on e_seg.id = s.host_id
 where ls.ended_at is null
 order by ls.started_at;
-- PASS, all of:
--   * one row per open live, each with a DIFFERENT room
--   * open_segment_host = the host you picked IN THAT TAB
--   * the two rows have DIFFERENT open_segment_host values
--   * scalar_matches_segment = true on both
-- FAIL: both rows show the SAME open_segment_host → the 2a clobber. THIS IS A ROLLBACK-NOW.
--       It silently misattributes a whole concurrent show and is invisible from the UI.
--       Capture the diagnostics ring in BOTH tabs first, then roll back, then run one live per
--       machine until it is fixed.
-- NOTE: if this returns fewer than 2 rows you have not tested the two-tab case at all.


-- ═══ BLOCK 7 ═══ STEP 7 — the segment closed when the live ended
select s.id as segment_id, e.name as host, s.started_at, s.ended_at, s.ended_source,
       ls.ended_at as session_ended_at, ls.end_source as session_end_source,
       round(extract(epoch from (s.ended_at - s.started_at))/60.0, 2) as segment_minutes
  from public.live_session_host_segments s
  join public.live_sessions ls on ls.id = s.session_id
  left join public.employees e on e.id = s.host_id
 where s.session_id = (select session_id from _t) and s.superseded_by is null
 order by s.started_at;
-- PASS: NO row has ended_at IS NULL; the last row has ended_source = 'session_end'.
-- FAIL (segment still open): NOT URGENT. lensed_session_activity_end bounds an orphan to the
--       last sale — measured, 456.2h of exposure collapses to 5.85h. Finish, then read the ring
--       for host.segment_close_error. Keep SEGMENT_CLOSE_WRITE_ENABLED off.


-- ═══ BLOCK 8 ═══ hourly split across the switch (cross-check on block 4)
select hour_start, host_name, auctions, units, revenue_cents
  from public.pnl_show_hourly_by_host((select session_id from _t))
 order by hour_start, host_name;

select h.hour_start, sum(h.auctions) as by_host_auctions,
       (select p.auctions from public.pnl_show_hourly((select session_id from _t)) p
         where p.hour_start = h.hour_start) as whole_show_auctions
  from public.pnl_show_hourly_by_host((select session_id from _t)) h
 group by h.hour_start
 order by h.hour_start;
-- PASS: the switch hour has TWO rows (one per host) in the first query, and in the second
--       by_host_auctions = whole_show_auctions for EVERY hour. A mismatch means the by-host
--       split is losing or duplicating sales that the whole-show view counts once.


-- ═══ BLOCK 9 ═══ STEP 9 — NO QUERY. THIS ONE IS UI ONLY.
-- Force a failure and LOOK at the overlay. The DB is expected to refuse the write, so there is
-- nothing to verify in the DB — the whole point is whether the OPERATOR can see it.
--
-- 1. Pick a host in the overlay. Confirm the warning area is empty (a clean save).
-- 2. In another tab, set that employee inactive:
--       update public.employees set status = 'former' where id = '<employee id>';
--    (remember to set it back to 'active' afterwards)
-- 3. In the overlay, pick a DIFFERENT host, then pick the now-inactive one again.
--
-- PASS, all of:
--   * persistent "⚠ HOST NOT SAVED — inactive, pick someone else" beside the dropdown
--   * the dropdown itself outlined RED (class lensed-host-unsaved)
--   * hovering the warning shows the underlying DB error (HOST_NOT_FOUND_OR_NOT_OWNED)
--   * it does NOT fade — still there 30+ seconds later
--   * picking a valid host clears both the message and the red outline
--
-- FAIL (a clean-looking selection for a host that was refused): NOT a rollback — the DB
--       correctly refused, no data is wrong. But it is the failure mode that makes every other
--       failure invisible, so it BLOCKS distribution to host machines. Capture the ring, finish
--       the test, fix the indicator, re-run this block.
--
-- Confirm the DB really did refuse, so you know you tested the right thing:
select ls.host_id, e.name as scalar_host,
       (select count(*) from public.live_session_host_segments s
         where s.session_id = ls.id and s.host_id = '<the inactive employee id>') as segments_for_inactive
  from public.live_sessions ls
  left join public.employees e on e.id = ls.host_id
 where ls.id = (select session_id from _t);
-- PASS: segments_for_inactive = 0, and scalar_host is still the PREVIOUS valid host.


-- ═══ BLOCK 10 ═══ One-shot overall verdict, run at the end
select
  (select count(*) from public.live_session_host_segments
    where session_id = (select session_id from _t) and superseded_by is null) as segments,
  (select count(*) from public.live_session_host_segments
    where session_id = (select session_id from _t) and superseded_by is null and ended_at is null) as still_open,
  (select count(*) from public.pnl_show_host_segments((select session_id from _t))
    where host_name = 'Unattributed') as unattributed_rows,
  (select coalesce(sum(auctions),0) from public.pnl_show_host_segments((select session_id from _t))) as rollup_auctions,
  (select count(*) from public.live_auction_items lai
     join public.capture_events ce on ce.order_id = lai.client_idempotency_key and ce.user_id = lai.user_id
    where lai.session_id = (select session_id from _t) and lai.status = 'sold') as sold_count,
  (select count(*) from public.capture_events ce
     join public.live_sessions ls on ls.tiktok_live_id = ce.room_id and ls.user_id = ce.user_id
    where ls.id = (select session_id from _t) and ce.created_at >= ls.started_at
      and ce.ext_version is null) as captures_missing_ext_version;
-- PASS: segments >= 2 (if you tested a switch), still_open = 0 (after the live ended),
--       unattributed_rows = 0, rollup_auctions = sold_count, captures_missing_ext_version = 0.
