-- 112_segment_boundary_adjacency.sql
-- ┌─────────────────────────────────────────────────────────────────────────────┐
-- │ APPLIED TO PRODUCTION: 2026-08-20                                          │
-- │ Verified present in the live schema. DO NOT RE-APPLY.                       │
-- │ This DB has no migration ledger — this file IS the record that it ran.      │
-- └─────────────────────────────────────────────────────────────────────────────┘
--
-- Fix two boundary defects in the segment RPCs.  (see the APPLIED banner above)
-- Function bodies only — no table, no data, no capture-path lock, no write-silence gate.
-- Depends on 106/108/110 (all applied).
--
-- ═══════════════════════════ THE TWO DEFECTS ═══════════════════════════
-- Found by exercising the APPLIED RPC directly (impersonating the owner via
-- request.jwt.claims inside a rolled-back transaction), not by reading the code.
--
-- Sequence: open for Madison at T+10m, switch to Bella at T+70m, then switch to Ivy at
-- T+20m — a client whose clock runs behind, reporting an instant BEFORE the segment it is
-- leaving even started. Result on the applied code:
--
--   Madison  11:50:41 -> 12:50:41     overlaps_next = TRUE
--   Ivy      12:00:41 -> (open)
--   Bella    12:50:41 -> 12:50:41     zero_length   = TRUE
--
--   1. ZERO-LENGTH OUTGOING SEGMENT. ended_at = greatest(v_at, v_open.started_at) equals
--      v_open.started_at when the reported instant is earlier, so Bella's segment closed at
--      the same instant it opened. A host who genuinely sold for 40 minutes records nothing.
--
--   2. OVERLAP. The incoming segment was inserted at v_at (12:00:41) while the outgoing one
--      closed at 12:50:41, so Ivy's segment overlapped Madison's. The read functions LEFT JOIN
--      segments, so a sale inside the overlap matches TWO segments and its revenue and units
--      are counted TWICE. This is the more serious of the two: it inflates rather than loses.
--
-- ═══════════════════════════ THE FIXES ═══════════════════════════
--   A. CLOCK-SKEW GUARD. If the reported instant is at or before the open segment's own
--      start, the client's clock is demonstrably unusable — fall back to now(). Applied in all
--      three RPCs (a close suffers defect 1 on its own).
--   B. ADJACENCY MADE STRUCTURAL. The incoming segment starts exactly where the outgoing one
--      ended (v_at := v_close_at), so adjacency cannot depend on the two values agreeing.
--      No gap (sales lost to 'Unattributed'), no overlap (sales double-counted).
--
-- Everything else in all three bodies is byte-identical to 110.
--
-- NOTE ON EXISTING DATA: no repair needed. Only the 202 backfill_legacy segments exist, one
-- per session, none produced by a switch — verified before authoring. The defect was reachable
-- only once the extension began switching hosts, which has not shipped.

begin;

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
  if p_source is null or not public.lensed_is_valid_segment_source(p_source) then
    raise exception 'INVALID_SOURCE: %', p_source;
  end if;

  -- FOR UPDATE serializes concurrent opens on the same session, so two racing extension events
  -- can never both pass the one-open-segment check.
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

  -- CLOCK-SKEW GUARD (R2). A client reporting a switch at or before the instant the segment it
  -- is leaving even began has a demonstrably unusable clock, so fall back to the SERVER's.
  -- Without this, greatest(v_at, v_open.started_at) collapsed the outgoing segment to
  -- zero length AND started the incoming one before it, overlapping the segment before that —
  -- a sale in the overlap then matched two segments and was counted twice.
  if found and v_at <= v_open.started_at then
    v_at := now();
  end if;

  -- IDEMPOTENCY: an open segment already carrying this exact host is left ALONE.
  if found and v_open.host_id is not distinct from p_host_id then
    update public.live_sessions
       set host_id = p_host_id, updated_at = now()
     where id = p_session_id and user_id = auth.uid()
       and host_id is distinct from p_host_id;
    return v_open.id;
  end if;

  if found then
    v_close_at := greatest(v_at, v_open.started_at);
    update public.live_session_host_segments
       set ended_at = v_close_at, ended_source = p_source
     where id = v_open.id;
    -- ADJACENCY IS STRUCTURAL, not incidental: the incoming segment begins exactly where the
    -- outgoing one ended. Inserting at v_at instead left a gap (sales fall into 'Unattributed')
    -- or an overlap (sales counted twice) whenever the two differed.
    v_at := v_close_at;
  end if;

  insert into public.live_session_host_segments
    (user_id, session_id, host_id, started_at, source)
  values (auth.uid(), p_session_id, p_host_id, v_at, p_source)
  returning id into v_new_id;

  update public.live_sessions
     set host_id = p_host_id, updated_at = now()
   where id = p_session_id and user_id = auth.uid();

  return v_new_id;
end;
$$;

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
  if p_source is null or not public.lensed_is_valid_segment_source(p_source) then
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
    return null;  -- nothing open: idempotent no-op
  end if;

  -- CLOCK-SKEW GUARD (R2): same rule as open — an instant at or before the segment's own start
  -- would close it to zero length, so distrust the client's clock and use the server's.
  if v_at <= v_open.started_at then
    v_at := now();
  end if;
  v_close_at := greatest(v_at, v_open.started_at);
  update public.live_session_host_segments
     set ended_at = v_close_at, ended_source = p_source
   where id = v_open.id;

  return v_open.id;
end;
$$;

create or replace function public.close_session_host_segment_as(
  p_owner_user_id uuid,
  p_session_id    uuid,
  p_at            timestamptz default null,
  p_source        text        default 'session_end'
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
  if p_owner_user_id is null then
    raise exception 'OWNER_REQUIRED';
  end if;
  if p_source is null or not public.lensed_is_valid_segment_source(p_source) then
    raise exception 'INVALID_SOURCE: %', p_source;
  end if;

  -- Ownership is RELOCATED, not removed: the session must belong to the asserted owner.
  select ls.id, ls.user_id, ls.started_at
    into v_session
    from public.live_sessions ls
   where ls.id = p_session_id and ls.user_id = p_owner_user_id
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

  -- CLOCK-SKEW GUARD (R2): as above.
  if v_at <= v_open.started_at then
    v_at := now();
  end if;
  v_close_at := greatest(v_at, v_open.started_at);
  update public.live_session_host_segments
     set ended_at = v_close_at, ended_source = p_source
   where id = v_open.id;

  return v_open.id;
end;
$$;


-- ── Grants ────────────────────────────────────────────────────────────────────
-- CREATE OR REPLACE preserves the existing ACL; restated so this file stands alone.
revoke execute on function public.open_session_host_segment(uuid, uuid, timestamptz, text) from public, anon;
revoke execute on function public.close_session_host_segment(uuid, timestamptz, text) from public, anon;
grant  execute on function public.open_session_host_segment(uuid, uuid, timestamptz, text) to authenticated;
grant  execute on function public.close_session_host_segment(uuid, timestamptz, text) to authenticated;
revoke execute on function public.close_session_host_segment_as(uuid, uuid, timestamptz, text) from public, anon, authenticated;
grant  execute on function public.close_session_host_segment_as(uuid, uuid, timestamptz, text) to service_role;

commit;
