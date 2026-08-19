-- 108_close_session_host_segment_as.sql
--
-- Service-role twin of close_session_host_segment, for the auto-ender.  NOT APPLIED.
-- Depends on 106. No capture-path change, so NO write-silence gate.
--
-- WHY A TWIN: close_session_host_segment is SECURITY DEFINER and re-imposes ownership via
-- auth.uid(). src/lib/sessions/autoEnd.ts runs from a CRON_SECRET-gated route using
-- createAdminClient() (service role), where auth.uid() is NULL — so the user-facing RPC can
-- only ever raise SESSION_NOT_FOUND_OR_NOT_OWNED there. This twin takes the owner explicitly,
-- exactly as lensed_log_auction_as does for the same reason.
--
-- ═══════════════════════════ PRIVILEGE — READ BEFORE EDITING ═══════════════════════════
-- This function BYPASSES auth.uid(): the caller asserts the owner. Granting it to
-- `authenticated` would let any signed-in user close segments on any other owner's sessions
-- by passing a different p_owner_user_id — a privilege escalation, not a convenience.
--
--   revoke from public, anon, authenticated   →   grant to service_role ONLY
--
-- Registered in SERVICE_ROLE_ONLY in scripts/check-rpc-grants.mjs so CI asserts it stays
-- ungranted, in BOTH directions. Do not add a user-facing grant. (The ownership check is not
-- dropped, only relocated: the function still verifies the session belongs to the owner it was
-- handed, so a wrong owner id fails closed rather than closing someone else's segment.)
-- ═══════════════════════════════════════════════════════════════════════════════════════

begin;

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
  if p_source is null or p_source not in (
    'extension_switch','session_create','session_reuse',
    'room_change_close','session_end','backfill_legacy','manual_correction'
  ) then
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

  -- CLAMP. The auto-ender passes its computed proposed_ended_at (NOT now()) — passing now()
  -- would credit the host for the idle gap the ender is trimming off. Clamped to
  -- [started_at, now()] all the same, since the caller is still an input.
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
    return null;  -- nothing open: idempotent no-op, never an error
  end if;

  v_close_at := greatest(v_at, v_open.started_at);
  update public.live_session_host_segments
     set ended_at = v_close_at, ended_source = p_source
   where id = v_open.id;

  return v_open.id;
end;
$$;

-- SERVICE ROLE ONLY. See the header. CREATE FUNCTION grants EXECUTE to PUBLIC by default,
-- so the revoke is mandatory, not cosmetic.
revoke execute on function public.close_session_host_segment_as(uuid, uuid, timestamptz, text) from public, anon, authenticated;
grant  execute on function public.close_session_host_segment_as(uuid, uuid, timestamptz, text) to service_role;

commit;
