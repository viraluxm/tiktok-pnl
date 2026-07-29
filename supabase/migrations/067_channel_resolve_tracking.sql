-- Bookkeeping for the room→owner channel resolver (see src/lib/live/resolveChannels.ts).
-- Additive + nullable/defaulted → safe on a live table. Lets the sweep back off from
-- permanently-unavailable rooms (TikTok status 4003110) instead of retrying them forever,
-- and records the outcome for observability.

alter table public.live_sessions
  add column if not exists channel_resolve_attempts smallint not null default 0,
  add column if not exists channel_resolve_status   text,
  add column if not exists channel_resolved_at      timestamptz;

comment on column public.live_sessions.channel_resolve_attempts is
  'room→owner resolver: consecutive failed lookups; capped so dead rooms are not retried forever';
comment on column public.live_sessions.channel_resolve_status is
  'room→owner resolver: last outcome — ''ok'' or ''err:<status_code|net>''';
comment on column public.live_sessions.channel_resolved_at is
  'room→owner resolver: when channel_handle/sec_uid were last authoritatively set from the room owner';

-- Partial index for the sweep''s candidate scan (rooms still missing the rename-proof id
-- or the handle, not yet exhausted).
create index if not exists live_sessions_channel_resolve_idx
  on public.live_sessions (started_at desc)
  where tiktok_live_id is not null
    and channel_resolve_attempts < 6
    and (channel_sec_uid is null or channel_handle is null);
