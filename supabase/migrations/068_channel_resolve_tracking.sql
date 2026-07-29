-- Bookkeeping for the room→owner channel resolver (see src/lib/live/resolveChannels.ts).
-- Additive + nullable/defaulted → safe on a live table. Records outcomes for observability
-- and paces RETRIES across sweeps with backoff (channel_resolve_next_at) — a status 4003110
-- is often transient, so failures are retried, spaced out, rather than given up on.

alter table public.live_sessions
  add column if not exists channel_resolve_attempts smallint not null default 0,
  add column if not exists channel_resolve_status   text,
  add column if not exists channel_resolved_at      timestamptz,
  add column if not exists channel_resolve_next_at  timestamptz;

comment on column public.live_sessions.channel_resolve_attempts is
  'room→owner resolver: consecutive failed lookups (backstop cap)';
comment on column public.live_sessions.channel_resolve_status is
  'room→owner resolver: last outcome — ''ok'' or ''err:<status_code|net>''';
comment on column public.live_sessions.channel_resolved_at is
  'room→owner resolver: when channel_handle/sec_uid were last authoritatively set from the room owner';
comment on column public.live_sessions.channel_resolve_next_at is
  'room→owner resolver: earliest time to retry after a failure (backoff); null = due now';

-- Partial index for the sweep''s candidate scan (rooms still missing the rename-proof id
-- or the handle). now() is not immutable, so the due-time gate stays in the query, not here.
create index if not exists live_sessions_channel_resolve_idx
  on public.live_sessions (started_at desc)
  where tiktok_live_id is not null
    and (channel_sec_uid is null or channel_handle is null);

-- ORDER GROUND TRUTH store resolver: the store for a room's captured orders, via
-- synced_order_ids (reliable store_id). Returns a store ONLY when the room's orders resolve
-- to a SINGLE store (unambiguous); null on 0 or >1. Lets the sweep attribute the store even
-- when room/info can't resolve the owner (removed room) → 100% store coverage.
create or replace function public.session_store_from_orders(p_room text)
returns uuid
language sql
stable
as $function$
  with s as (
    select so.store_id, count(*) as n
    from public.capture_events ce
    join public.synced_order_ids so
      on so.order_id = ce.order_id and so.store_id is not null
    where ce.room_id = p_room
    group by so.store_id
  )
  select case when (select count(*) from s) = 1 then (select store_id from s) end;
$function$;
