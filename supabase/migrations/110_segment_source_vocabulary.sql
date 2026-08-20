-- 110_segment_source_vocabulary.sql
-- ┌─────────────────────────────────────────────────────────────────────────────┐
-- │ APPLIED TO PRODUCTION: 2026-08-20                                          │
-- │ Verified present in the live schema. DO NOT RE-APPLY.                       │
-- │ This DB has no migration ledger — this file IS the record that it ran.      │
-- └─────────────────────────────────────────────────────────────────────────────┘
--
-- Extend the segment source vocabulary, and collapse it to ONE definition.  (see the APPLIED banner above)
-- Additive. No capture-path table touched, so NO write-silence gate.
-- Depends on 106 (applied) and 108 (applied).
--
-- ═══════════════════════════ WHY (blocker R1) ═══════════════════════════
-- Phase 2 needs to close a segment when the signed-in user changes
-- (background.js:1951) and when the live tab closes. Neither value exists in the vocabulary,
-- and the enforcement is STRICT in five separate places:
--
--   1. live_session_host_segments_source_check
--   2. live_session_host_segments_ended_source_check
--   3. open_session_host_segment      -> raise 'INVALID_SOURCE'
--   4. close_session_host_segment     -> raise 'INVALID_SOURCE'
--   5. close_session_host_segment_as  -> raise 'INVALID_SOURCE'
--
-- Because Phase 2's closes are best-effort and non-fatal by design, an INVALID_SOURCE would be
-- CAUGHT AND SWALLOWED and the segment would silently stay open — the failure mode the close
-- paths exist to prevent. Adding a value to four of five places would reproduce the same class
-- of bug later, so this migration removes the duplication instead of widening it.
--
-- 106 chose strictness where migration 094 had deliberately chosen NO check ("unknown
-- reason/code values from a future extension build must be RECORDABLE, not rejected"). This
-- keeps 106's strictness — a typo'd source should still fail — but makes the vocabulary a
-- single object, so extending it is one edit and cannot go half-applied.
--
-- ═══════════════════════ THE ONE RULE FOR THIS FUNCTION ═══════════════════════
-- lensed_is_valid_segment_source MAY ONLY EVER BE WIDENED. Never remove a value.
--
-- It is referenced by two CHECK constraints, and Postgres does NOT re-validate existing rows
-- when a function a CHECK depends on changes. Widening is therefore always safe (no existing
-- row can stop satisfying a superset). NARROWING would silently leave rows in violation of
-- their own constraint — invisible until a dump/restore or an ALTER ... VALIDATE fails.
-- If a value must ever be retired, do it as an explicit data migration with a re-VALIDATE, not
-- by editing this function.
-- ══════════════════════════════════════════════════════════════════════════════

begin;

-- ── The single vocabulary ─────────────────────────────────────────────────────
create or replace function public.lensed_is_valid_segment_source(p_source text)
returns boolean
language sql
immutable
as $$
  select p_source in (
    -- OPEN reasons
    'session_create',      -- extension created a session and attached the selected host
    'session_reuse',       -- extension re-attached to an existing room-scoped session
    'extension_switch',    -- operator changed the host dropdown mid-show
    -- CLOSE reasons
    'room_change_close',   -- a new live (new room) began; prior host does not carry over
    'user_change_close',   -- ADDED 110: signed-in Supabase user changed (background.js:1951)
    'tab_closed',          -- ADDED 110: the live tab closed; mirrors live_sessions.end_source
    'session_end',         -- the live ended (Seller Center end POST, or the auto-ender)
    -- ADMIN / BACKFILL
    'backfill_legacy',     -- migration 106's one-shot legacy segment; also the legacy marker
    'manual_correction'    -- a correction: new row + superseded_by on the row it replaces
  )
$$;

comment on function public.lensed_is_valid_segment_source(text) is
  'THE segment source vocabulary. Referenced by both CHECK constraints and all three segment '
  'RPCs, so extending it is one edit. MAY ONLY BE WIDENED — Postgres does not re-validate '
  'existing rows when a CHECK''s function changes, so narrowing would silently leave rows in '
  'violation. See migration 110.';

-- ── Repoint both CHECK constraints at it ──────────────────────────────────────
-- Dropping and re-adding takes a brief ACCESS EXCLUSIVE lock on live_session_host_segments and
-- re-validates all rows. At authoring time that is 202 rows, all source='backfill_legacy', so
-- validation is instant. This table is NOT on the capture path and nothing reads it during a
-- live show, so the lock is inconsequential.
alter table public.live_session_host_segments
  drop constraint if exists live_session_host_segments_source_check;
alter table public.live_session_host_segments
  add constraint live_session_host_segments_source_check
  check (public.lensed_is_valid_segment_source(source));

alter table public.live_session_host_segments
  drop constraint if exists live_session_host_segments_ended_source_check;
alter table public.live_session_host_segments
  add constraint live_session_host_segments_ended_source_check
  check (ended_source is null or public.lensed_is_valid_segment_source(ended_source));

-- ── Recreate the three RPCs against the shared vocabulary ─────────────────────
-- Bodies are otherwise UNCHANGED from 106/108. Only the validation line differs: the inline
-- nine-value IN list becomes a call to lensed_is_valid_segment_source.

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

  v_close_at := greatest(v_at, v_open.started_at);
  update public.live_session_host_segments
     set ended_at = v_close_at, ended_source = p_source
   where id = v_open.id;

  return v_open.id;
end;
$$;

-- ── Grants ────────────────────────────────────────────────────────────────────
-- CREATE OR REPLACE preserves an existing function's ACL, so the 106/108 grants survive. These
-- are restated so this file is self-sufficient if the functions are ever created fresh from it.
revoke execute on function public.lensed_is_valid_segment_source(text) from public, anon;
grant  execute on function public.lensed_is_valid_segment_source(text) to authenticated;

revoke execute on function public.open_session_host_segment(uuid, uuid, timestamptz, text) from public, anon;
revoke execute on function public.close_session_host_segment(uuid, timestamptz, text) from public, anon;
grant  execute on function public.open_session_host_segment(uuid, uuid, timestamptz, text) to authenticated;
grant  execute on function public.close_session_host_segment(uuid, timestamptz, text) to authenticated;

-- Service-role only — it bypasses auth.uid() and takes the owner explicitly.
revoke execute on function public.close_session_host_segment_as(uuid, uuid, timestamptz, text) from public, anon, authenticated;
grant  execute on function public.close_session_host_segment_as(uuid, uuid, timestamptz, text) to service_role;

commit;
