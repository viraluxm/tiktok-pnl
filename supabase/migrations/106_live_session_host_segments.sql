-- 106_live_session_host_segments.sql
--
-- PER-HOST TIME SEGMENTATION WITHIN A LIVE SESSION.  NOT APPLIED — authored only.
--
-- NO CAPTURE-PATH LOCK. This migration touches live_sessions only through the RPCs at call
-- time; it creates one new table and six functions and reads capture_events. It is therefore
-- NOT gated on write-activity silence and may be applied whenever. (The capture-path change —
-- live_auction_items.host_id_snapshot — was split out into 107, which IS gated.)
--
-- WHY: live_sessions.host_id is a mutable scalar and the only host fact in the schema.
-- set_session_host (050/056) does a bare UPDATE with no audit trail, so a mid-show host switch
-- retroactively reassigns the WHOLE session's KPIs and destroys the outgoing host's identity.
--
-- WHAT: an append-only interval log. Segments become the CANONICAL host fact;
-- live_sessions.host_id is demoted to a denormalized "current host" cache the RPCs keep in
-- sync (nine consumers still read it — see the compatibility note in the review report).
--
-- APPEND-ONLY CONTRACT (enforced by trigger, not convention):
--   * host_id, started_at, session_id, user_id, source, created_at IMMUTABLE after insert.
--   * ended_at WRITE-ONCE: NULL -> value only.
--   * superseded_by WRITE-ONCE: NULL -> value only.
--   * DELETE is BLOCKED outright (no RLS delete policy AND a trigger guard, so even the
--     service role cannot quietly erase a segment).
--   * A correction NEVER edits a row: it inserts a replacement and stamps superseded_by.
--
-- TIME BASIS: attribution anchors on coalesce(capture_events.ordered_at,
-- capture_events.created_at) — the anchor pnl_show_hourly (040) already uses, same NAMED zone.
-- live_auction_items.closed_at is NOT used: lensed_log_auction stamps closed_at = now() on
-- both the retroactive-bind INSERT and the paid-flip UPDATE, so it drifts up to 18.3 days.

begin;

-- ══════════════════════════════════════════════════════════════════════════════
-- A0. SESSION ACTIVITY END — the single definition of "when did this show stop selling"
-- ══════════════════════════════════════════════════════════════════════════════
-- This expression drives total_minutes AND auction attribution AND therefore gates bonus pay.
-- It exists exactly ONCE, here, and is called by both the backfill (section D) and the read
-- path (section E). Do not inline a variant anywhere.
--
-- THE RULE, in one line: the show ran from started_at to the last sale in its first contiguous
-- run of sales. live_sessions.ended_at is NOT consulted at all.
--
-- WHY ended_at IS NOT CONSULTED. end_source is unreliable in both directions, measured:
--   TOO LATE  — 2 sessions overshoot by a combined 21.7h. 9f3509e7 records ended_at
--               2026-08-18 19:18Z with its last sale at 08:04Z. 2a3ea085 records 11.0h with
--               its last sale 2.5 MINUTES after the session started.
--   TOO EARLY — 8 sessions keep selling past the recorded end, the next sale landing
--               0.3-2.3 min after it.
-- A rule that ever lets the claim win has to decide which failure it is; a rule that always
-- measures the sales does not. So: extend when the claim was early, pull back when it was
-- late, trim when it was within. One branch, no thresholds comparing claim against evidence.
--
-- WHY last_seen_at IS A CEILING ONLY. The heartbeat means "the tab is open", not "a person is
-- in the seat" — background.js:203-206 pings it deliberately regardless of whether auctions
-- close. As an EXTENDER it is worth exactly zero and actively harmful: an earlier draft let it
-- carry activity past the last sale and credited 46.9 phantom hours across three sessions
-- whose tabs were simply left open overnight. It may only pull an end EARLIER (the show cannot
-- have outlived the tab), never push one later.
--
-- CLOCK. Sales are measured on coalesce(ordered_at, created_at) — the SALE clock, the same
-- anchor the attribution CTEs use, so the window and the sales inside it share one clock.
-- capture_events.created_at is the WRITE clock: over 30 days 931 captures land >5 min after
-- their order, 461 >60 min, worst case 50.3 hours.

-- The contiguity guard as a FUNCTION, not a repeated literal: lensed_session_activity_end
-- cuts the sales run on it, and pnl_show_host_segments measures the heartbeat-overhang flag
-- against it. Two call sites, one literal, so they cannot drift apart.
create or replace function public.lensed_session_contiguity_gap()
returns interval
language sql
immutable
as $$ select interval '45 minutes' $$;

comment on function public.lensed_session_contiguity_gap() is
  'Sales-gap threshold that ends a contiguous run. IMPORTED from '
  'src/lib/sessions/autoEnd.ts IDLE_THRESHOLD_MIN (45); pinned by '
  'src/lib/sessions/sessionEnd.drift.test.mjs. NOTE: fires on 0 of 201 real sessions as of '
  '2026-08-19 — it is untested insurance, not load-bearing on observed data.';

create or replace function public.lensed_session_activity_end(p_session_id uuid)
returns timestamptz
language sql
stable
as $$
  with const as (
    select
      -- CONTIGUITY GAP — a sales gap larger than this ends the run. IMPORTED, not invented:
      -- this is IDLE_THRESHOLD_MIN from src/lib/sessions/autoEnd.ts:12, the threshold the
      -- auto-ender has been using in production to decide a live is over. Keeping our own
      -- number here would mean two subsystems disagreeing about when a show ended.
      -- Held in sync by the drift test at src/lib/sessions/sessionEnd.drift.test.mjs — if you
      -- change one, that test fails until you change the other.
      public.lensed_session_contiguity_gap() as contiguity_gap,
      -- WIND-DOWN GRACE — deliberately ZERO, named rather than absent so the decision is
      -- visible. We do NOT invent a tail after the last sale. Direction of the bias, stated
      -- openly: grace=0 shortens measured show time, which RAISES revenue-per-hour (favours
      -- the host) and UNDERSTATES session-fallback labour. Both are conservative in the
      -- direction we can defend; a non-zero grace would manufacture selling time nobody
      -- observed.
      interval '0 minutes'  as wind_down_grace
  ),
  ses as (
    select ls.id, ls.user_id, ls.tiktok_live_id, ls.started_at, ls.last_seen_at
      from public.live_sessions ls
     where ls.id = p_session_id
  ),
  -- Upper bound: the next session in the SAME room. One show can never absorb the next even
  -- if the sales run straight through.
  nxt as (
    select min(ls2.started_at) as next_start
      from public.live_sessions ls2, ses
     where ls2.tiktok_live_id is not distinct from ses.tiktok_live_id
       and ls2.user_id = ses.user_id
       and ls2.started_at > ses.started_at
  ),
  ev as (
    select coalesce(ce.ordered_at, ce.created_at) as at
      from public.capture_events ce, ses, nxt
     where ce.room_id = ses.tiktok_live_id
       and ce.user_id = ses.user_id
       and coalesce(ce.ordered_at, ce.created_at) >= ses.started_at
       and (nxt.next_start is null or coalesce(ce.ordered_at, ce.created_at) < nxt.next_start)
  ),
  gaps as (
    select at, at - lag(at) over (order by at) as gap from ev
  ),
  -- The first sale that opens a gap wider than the guard. The contiguous run ends before it;
  -- everything from there on belongs to a different stretch of activity, not this show.
  cut as (
    select min(g.at) as cut_at from gaps g, const where g.gap > const.contiguity_gap
  ),
  run as (
    select max(g.at) as run_end
      from gaps g, cut
     where cut.cut_at is null or g.at < cut.cut_at
  )
  select case
    -- No sales in the window at all. The heartbeat is NOT allowed to stand in for evidence
    -- (that is the whole point of it being a ceiling), so the honest answer is a zero-length
    -- span: no observed sales, no measured show time.
    when (select run_end from run) is null then ses.started_at
    else greatest(
      ses.started_at,
      least(
        (select run_end from run) + (select wind_down_grace from const),
        ses.last_seen_at   -- CEILING ONLY. NULL last_seen_at drops out: LEAST ignores NULLs.
      )
    )
  end
  from ses
$$;

comment on function public.lensed_session_activity_end(uuid) is
  'THE definition of when a live session stopped selling: last sale of the first contiguous '
  'run (45-min gap guard, imported from autoEnd.ts IDLE_THRESHOLD_MIN), zero wind-down grace, '
  'ceilinged by last_seen_at. live_sessions.ended_at is never consulted. Shared by the 106 '
  'backfill and the segment read functions — never reimplement it.';

-- ══════════════════════════════════════════════════════════════════════════════
-- A. TABLE
-- ══════════════════════════════════════════════════════════════════════════════

create table if not exists public.live_session_host_segments (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  -- ON DELETE RESTRICT, not CASCADE: a repo-wide grep found NO code path that deletes a
  -- live_sessions row (no .delete() in src/, none in the extension, no DELETE FROM in
  -- supabase/). Segments are the only record that a mid-show switch happened, so a session
  -- delete must FAIL LOUDLY rather than silently take the audit trail with it. If a genuine
  -- delete need ever appears, archive the segments first and drop them explicitly.
  session_id    uuid not null references public.live_sessions(id) on delete restrict,
  -- Nullable: a segment may deliberately record "nobody selected".
  host_id       uuid references public.employees(id) on delete set null,
  started_at    timestamptz not null,
  ended_at      timestamptz,                -- NULL = still open. Write-once.
  source        text not null,              -- why the segment was OPENED
  ended_source  text,                       -- why it was CLOSED
  superseded_by uuid references public.live_session_host_segments(id) on delete restrict,
  created_at    timestamptz not null default now(),

  constraint live_session_host_segments_source_check check (
    source in ('extension_switch','session_create','session_reuse',
               'room_change_close','session_end','backfill_legacy','manual_correction')
  ),
  constraint live_session_host_segments_ended_source_check check (
    ended_source is null or ended_source in (
      'extension_switch','session_create','session_reuse',
      'room_change_close','session_end','backfill_legacy','manual_correction')
  ),
  constraint live_session_host_segments_span_check check (
    ended_at is null or ended_at >= started_at
  ),
  constraint live_session_host_segments_no_self_supersede check (
    superseded_by is null or superseded_by <> id
  )
);

comment on table public.live_session_host_segments is
  'Append-only per-host interval log within a live session. CANONICAL host attribution; '
  'live_sessions.host_id is a denormalized current-host cache kept in sync by '
  'open_session_host_segment. Corrections insert + stamp superseded_by, never UPDATE. '
  'DELETE is blocked by trigger.';

comment on column public.live_session_host_segments.source is
  'Why the segment was opened. backfill_legacy IS the legacy marker — threshold queries '
  'exclude sessions whose only segments are backfill_legacy. No separate flag column.';

create unique index if not exists uq_lshs_one_open_per_session
  on public.live_session_host_segments (session_id)
  where ended_at is null and superseded_by is null;

create index if not exists idx_lshs_session_started
  on public.live_session_host_segments (session_id, started_at);
create index if not exists idx_lshs_host_started
  on public.live_session_host_segments (host_id, started_at)
  where host_id is not null;
create index if not exists idx_lshs_user
  on public.live_session_host_segments (user_id);

-- ── RLS ───────────────────────────────────────────────────────────────────────
-- Mirrors live_sessions (verified live: relrowsecurity=true, relforcerowsecurity=false, four
-- own-row policies on role {public}) — WITH ONE DELIBERATE OMISSION: there is NO DELETE
-- policy. RLS-enabled + no policy = deletes denied for ordinary callers; the trigger below
-- closes the same door on the service role.
alter table public.live_session_host_segments enable row level security;

create policy "Users can view own live_session_host_segments"
  on public.live_session_host_segments for select using (auth.uid() = user_id);
create policy "Users can insert own live_session_host_segments"
  on public.live_session_host_segments for insert with check (auth.uid() = user_id);
create policy "Users can update own live_session_host_segments"
  on public.live_session_host_segments for update using (auth.uid() = user_id);
-- (no delete policy — intentional)

-- ── Append-only enforcement trigger ───────────────────────────────────────────
-- TG_TABLE_NAME GUARD: this function dereferences host_id/started_at/ended_at/superseded_by,
-- which plpgsql resolves at RUNTIME against the actual row type. Attaching it to another table
-- would fail with an obscure "record has no field" mid-write; the guard makes that a loud,
-- diagnosable refusal on the first row instead. (set_updated_at() is safely shared across ~12
-- tables only because it touches one universally-present column — not a property this has.)
create or replace function public.lensed_guard_host_segment_append_only()
returns trigger
language plpgsql
as $$
begin
  if TG_TABLE_NAME <> 'live_session_host_segments' then
    raise exception
      'lensed_guard_host_segment_append_only attached to unsupported table %.% — it dereferences '
      'host_id/started_at/ended_at/superseded_by and must not be reused',
      TG_TABLE_SCHEMA, TG_TABLE_NAME;
  end if;

  -- DELETE is blocked for EVERY role, service role included. RLS already denies it for
  -- ordinary callers (no delete policy); this is what stops an admin client.
  if TG_OP = 'DELETE' then
    raise exception 'HOST_SEGMENT_APPEND_ONLY: segment % cannot be deleted. Segments are the '
                    'only record of a mid-show host switch. Supersede it instead '
                    '(insert a replacement + stamp superseded_by).', OLD.id;
  end if;

  -- Immutable identity + provenance.
  if NEW.host_id    is distinct from OLD.host_id then
    raise exception 'HOST_SEGMENT_IMMUTABLE: host_id cannot be updated (segment %). '
                    'Insert a replacement and stamp superseded_by instead.', OLD.id;
  end if;
  if NEW.started_at is distinct from OLD.started_at then
    raise exception 'HOST_SEGMENT_IMMUTABLE: started_at cannot be updated (segment %).', OLD.id;
  end if;
  if NEW.session_id is distinct from OLD.session_id then
    raise exception 'HOST_SEGMENT_IMMUTABLE: session_id cannot be updated (segment %).', OLD.id;
  end if;
  if NEW.user_id    is distinct from OLD.user_id then
    raise exception 'HOST_SEGMENT_IMMUTABLE: user_id cannot be updated (segment %).', OLD.id;
  end if;
  if NEW.source     is distinct from OLD.source then
    raise exception 'HOST_SEGMENT_IMMUTABLE: source cannot be updated (segment %).', OLD.id;
  end if;
  if NEW.created_at is distinct from OLD.created_at then
    raise exception 'HOST_SEGMENT_IMMUTABLE: created_at cannot be updated (segment %).', OLD.id;
  end if;

  -- ended_at: write-once, NULL -> value only.
  if OLD.ended_at is not null and NEW.ended_at is distinct from OLD.ended_at then
    raise exception 'HOST_SEGMENT_WRITE_ONCE: ended_at is already set on segment % (%); it '
                    'cannot be changed or cleared.', OLD.id, OLD.ended_at;
  end if;
  if NEW.ended_at is not null and NEW.ended_at < NEW.started_at then
    raise exception 'HOST_SEGMENT_INVALID_SPAN: ended_at % precedes started_at % (segment %).',
                    NEW.ended_at, NEW.started_at, OLD.id;
  end if;

  -- superseded_by: write-once, NULL -> value only.
  if OLD.superseded_by is not null and NEW.superseded_by is distinct from OLD.superseded_by then
    raise exception 'HOST_SEGMENT_WRITE_ONCE: superseded_by is already set on segment %.', OLD.id;
  end if;

  -- ended_source may only be set in the same statement that sets ended_at.
  if NEW.ended_source is distinct from OLD.ended_source and NEW.ended_at is null then
    raise exception 'HOST_SEGMENT_INVALID: ended_source cannot be set while ended_at is NULL '
                    '(segment %).', OLD.id;
  end if;

  return NEW;
end;
$$;

create trigger trg_lshs_append_only
  before update or delete on public.live_session_host_segments
  for each row execute function public.lensed_guard_host_segment_append_only();

-- ══════════════════════════════════════════════════════════════════════════════
-- B. WRITE RPCs  (ownership model copied verbatim from set_session_host)
-- ══════════════════════════════════════════════════════════════════════════════

create or replace function public.open_session_host_segment(
  p_session_id uuid,
  p_host_id    uuid,
  p_at         timestamptz default null,
  p_source     text        default 'extension_switch'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session  record;
  v_open     record;
  v_at       timestamptz;
  v_close_at timestamptz;
  v_new_id   uuid;
begin
  if p_source is null or p_source not in (
    'extension_switch','session_create','session_reuse',
    'room_change_close','session_end','backfill_legacy','manual_correction'
  ) then
    raise exception 'INVALID_SOURCE: %', p_source;
  end if;

  -- FOR UPDATE serializes concurrent opens on the same session, so two racing extension events
  -- can never both pass the one-open-segment check. The partial unique index is the backstop;
  -- this keeps callers from seeing a raw 23505.
  select ls.id, ls.user_id, ls.started_at
    into v_session
    from public.live_sessions ls
   where ls.id = p_session_id and ls.user_id = auth.uid()
   for update;
  if not found then
    raise exception 'SESSION_NOT_FOUND_OR_NOT_OWNED';
  end if;

  if p_host_id is not null and not exists (
    select 1 from public.employees e where e.id = p_host_id and e.user_id = auth.uid()
  ) then
    raise exception 'HOST_NOT_FOUND_OR_NOT_OWNED';
  end if;

  -- CLAMP: p_at arrives from a browser clock and cannot be trusted.
  v_at := coalesce(p_at, now());
  if v_session.started_at is not null and v_at < v_session.started_at then
    v_at := v_session.started_at;
  end if;
  if v_at > now() then
    v_at := now();
  end if;

  select s.id, s.host_id, s.started_at
    into v_open
    from public.live_session_host_segments s
   where s.session_id = p_session_id and s.ended_at is null and s.superseded_by is null
   limit 1;

  -- IDEMPOTENCY (session reuse re-asserting the same host): an open segment already carrying
  -- this exact host is left ALONE. Closing and reopening would spray zero-length segments
  -- across every session-reuse event on the hot path and make segment_count meaningless.
  if found and v_open.host_id is not distinct from p_host_id then
    update public.live_sessions
       set host_id = p_host_id, updated_at = now()
     where id = p_session_id and user_id = auth.uid()
       and host_id is distinct from p_host_id;
    return v_open.id;
  end if;

  if found then
    v_close_at := greatest(v_at, v_open.started_at);   -- never close before its own start
    update public.live_session_host_segments
       set ended_at = v_close_at, ended_source = p_source
     where id = v_open.id;
  end if;

  insert into public.live_session_host_segments
    (user_id, session_id, host_id, started_at, source)
  values (auth.uid(), p_session_id, p_host_id, v_at, p_source)
  returning id into v_new_id;

  -- Keep the denormalized scalar in sync — nine consumers still read it.
  update public.live_sessions
     set host_id = p_host_id, updated_at = now()
   where id = p_session_id and user_id = auth.uid();

  return v_new_id;
end;
$$;

-- Close the open segment without opening a replacement (room change, session end).
-- Returns the closed segment's id, or NULL when nothing was open — a no-op close is NOT an
-- error, because room-change fires unconditionally and must stay safe to call.
create or replace function public.close_session_host_segment(
  p_session_id uuid,
  p_at         timestamptz default null,
  p_source     text        default 'session_end'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session  record;
  v_open     record;
  v_at       timestamptz;
  v_close_at timestamptz;
begin
  if p_source is null or p_source not in (
    'extension_switch','session_create','session_reuse',
    'room_change_close','session_end','backfill_legacy','manual_correction'
  ) then
    raise exception 'INVALID_SOURCE: %', p_source;
  end if;

  select ls.id, ls.user_id, ls.started_at
    into v_session
    from public.live_sessions ls
   where ls.id = p_session_id and ls.user_id = auth.uid()
   for update;
  if not found then
    raise exception 'SESSION_NOT_FOUND_OR_NOT_OWNED';
  end if;

  v_at := coalesce(p_at, now());
  if v_session.started_at is not null and v_at < v_session.started_at then
    v_at := v_session.started_at;
  end if;
  if v_at > now() then
    v_at := now();
  end if;

  select s.id, s.started_at
    into v_open
    from public.live_session_host_segments s
   where s.session_id = p_session_id and s.ended_at is null and s.superseded_by is null
   limit 1;
  if not found then
    return null;
  end if;

  v_close_at := greatest(v_at, v_open.started_at);
  update public.live_session_host_segments
     set ended_at = v_close_at, ended_source = p_source
   where id = v_open.id;

  return v_open.id;
end;
$$;

-- ── Grants (supabase/migrations/CONVENTIONS.md) ───────────────────────────────
-- CREATE FUNCTION grants EXECUTE to PUBLIC by default, which reaches `anon`. These are
-- SECURITY DEFINER WRITE RPCs — unauthenticated execute is exactly the drift that
-- 202608161754_revoke_anon_write_rpcs.sql exists to clean up. Lock down, then grant.
revoke execute on function public.open_session_host_segment(uuid, uuid, timestamptz, text) from public, anon;
revoke execute on function public.close_session_host_segment(uuid, timestamptz, text) from public, anon;
grant  execute on function public.open_session_host_segment(uuid, uuid, timestamptz, text) to authenticated;
grant  execute on function public.close_session_host_segment(uuid, timestamptz, text) to authenticated;

-- ══════════════════════════════════════════════════════════════════════════════
-- D. BACKFILL — one legacy segment per already-hosted session
-- ══════════════════════════════════════════════════════════════════════════════
-- 194 rows expected (239 sessions; 194 with a non-NULL host_id; 0 with a NULL started_at).
--
-- Calls lensed_session_activity_end — THE shared definition — so the backfill and read path
-- can never disagree about where a show ended.
--
-- Sessions with no recorded end are backfilled as OPEN segments (ended_at NULL) rather than
-- closed at their last capture: 6 such sessions exist and some are live right now. An open
-- segment lets the extension close it naturally, and the read path bounds it via
-- lensed_session_activity_end. Guarded so a re-run is a no-op.
insert into public.live_session_host_segments
  (user_id, session_id, host_id, started_at, ended_at, source, ended_source)
select
  ls.user_id,
  ls.id,
  ls.host_id,
  ls.started_at,
  case
    when ls.ended_at is null then null   -- leave open; the read path bounds it
    else public.lensed_session_activity_end(ls.id)
  end,
  'backfill_legacy',
  case when ls.ended_at is null then null else 'backfill_legacy' end
from public.live_sessions ls
where ls.host_id is not null
  and ls.started_at is not null
  and not exists (
    select 1 from public.live_session_host_segments s where s.session_id = ls.id
  );

-- ══════════════════════════════════════════════════════════════════════════════
-- E. READ FUNCTIONS
-- ══════════════════════════════════════════════════════════════════════════════
-- Structure, timezone handling and fee model copied from pnl_show_hourly (040): LANGUAGE sql
-- STABLE, SECURITY INVOKER (so RLS applies to the caller), named-zone `at time zone p_tz`,
-- platform_fee_cents() for the 6% platform fee.
--
-- ATTRIBUTION: an auction belongs to the segment whose HALF-OPEN interval
-- [eff_start, eff_end) contains coalesce(ce.ordered_at, ce.created_at), so an instant landing
-- exactly on a switch boundary belongs to exactly one host.
--
-- EFFECTIVE END uses lensed_session_activity_end — session.ended_at is never consulted. The same
-- interval drives total_minutes AND auction attribution, so minutes and revenue can never
-- disagree about a segment's bounds.
--
-- Superseded segments are excluded everywhere. Sold auctions matching NO segment come back as
-- their own row (host_id NULL, host_name 'Unattributed') — never dropped, never folded into a
-- neighbouring host.

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
  -- heartbeat_beyond_activity is a FLAG, not an adjustment. It fires when the tab kept
  -- heartbeating for longer than the contiguity guard past the last sale.
  --
  -- WHY IT MATTERS: a capture outage and a genuinely dead show are INDISTINGUISHABLE in this
  -- data. Both look like "sales stopped, tab stayed open". With wind_down_grace = 0 the
  -- outage case silently zeroes the host for that stretch — they were working, the extension
  -- was not recording. Rather than guess (any grace we invented would be wrong in the other
  -- case), we surface the ambiguity and let a human judge.
  --
  -- Derived, never stored: it is a property of live_sessions.last_seen_at, which keeps moving,
  -- and storing it on an append-only segment would freeze a stale answer.
  --
  -- Fires on 25 of 201 hosted sessions (12.4%) as of 2026-08-19, 0 of them still open.
  with ses as (
    select ls.id, ls.started_at, ls.last_seen_at,
           public.lensed_session_activity_end(ls.id) as eff_session_end
      from public.live_sessions ls where ls.id = p_session_id
  ),
  flag as (
    select coalesce(
             ses.last_seen_at is not null
             and ses.last_seen_at > ses.eff_session_end + public.lensed_session_contiguity_gap(),
             false) as heartbeat_beyond_activity
      from ses
  ),
  seg as (
    select s.id, s.host_id,
           greatest(s.started_at, ses.started_at) as eff_start,
           least(coalesce(s.ended_at, 'infinity'::timestamptz), ses.eff_session_end) as eff_end
      from public.live_session_host_segments s
      join ses on ses.id = s.session_id
     where s.superseded_by is null
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
      left join seg on sale.sale_at >= seg.eff_start and sale.sale_at < seg.eff_end
  ),
  -- UNION of two independent contributions, then one GROUP BY. Time comes from the segments
  -- (so a segment with zero sales still reports its minutes); sales come from the auctions (so
  -- an unattributed sale still reports its revenue). Neither side can drop the other's rows.
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
    select ls.id, ls.started_at, public.lensed_session_activity_end(ls.id) as eff_session_end
      from public.live_sessions ls where ls.id = p_session_id
  ),
  seg as (
    select s.id, s.host_id,
           greatest(s.started_at, ses.started_at) as eff_start,
           least(coalesce(s.ended_at, 'infinity'::timestamptz), ses.eff_session_end) as eff_end
      from public.live_session_host_segments s
      join ses on ses.id = s.session_id
     where s.superseded_by is null
  ),
  sale as (
    select lai.id as item_id, ce.selling_price_cents as price_cents,
           coalesce(ce.ordered_at, ce.created_at) as sale_at,
           -- Identical bucketing to pnl_show_hourly (040): named zone, never a fixed offset.
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
      left join seg on sale.sale_at >= seg.eff_start and sale.sale_at < seg.eff_end
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

-- Read + helper functions are SECURITY INVOKER, so RLS already scopes them to the caller.
-- anon is revoked anyway — an unauthenticated caller has no business reaching them.
revoke execute on function public.lensed_session_contiguity_gap() from public, anon;
revoke execute on function public.lensed_session_activity_end(uuid) from public, anon;
revoke execute on function public.pnl_show_host_segments(uuid, text) from public, anon;
revoke execute on function public.pnl_show_hourly_by_host(uuid, text) from public, anon;
grant  execute on function public.lensed_session_contiguity_gap() to authenticated;
grant  execute on function public.lensed_session_activity_end(uuid) to authenticated;
grant  execute on function public.pnl_show_host_segments(uuid, text) to authenticated;
grant  execute on function public.pnl_show_hourly_by_host(uuid, text) to authenticated;

commit;
