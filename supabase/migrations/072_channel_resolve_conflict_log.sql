-- 072_channel_resolve_conflict_log.sql
-- Pure instrumentation for the ROOM → OWNER resolver (src/lib/live/resolveChannels.ts).
--
-- The resolver is AUTHORITATIVE and always overwrites live_sessions.channel_handle (100%
-- store attribution is the evidence this is correct). But when the authoritative owner
-- handle DISAGREES with a non-null stored handle — typically the extension's DOM scrape
-- having written the wrong channel — we record the disagreement here BEFORE overwriting,
-- so a bad scrape is traceable after the fact. This table never gates the overwrite: the
-- resolver still writes the resolved handle exactly as before. Recording only, no policy.
--
-- The insert is best-effort/non-fatal in the resolver (a failed log can never abort or
-- skip a resolution), so there are deliberately NO foreign keys here — instrumentation
-- must not be able to fail the thing it instruments (e.g. on an edge/missing session row).
--
-- New standalone table — no lock on live_sessions, no coupling to the auction/capture path.

create table if not exists public.channel_resolve_conflict_log (
  id               uuid primary key default gen_random_uuid(),
  session_id       uuid not null,          -- live_sessions.id (no FK: log must never fail on a missing row)
  stored_handle    text,                   -- channel_handle BEFORE overwrite (the disagreeing value)
  resolved_handle  text not null,          -- authoritative owner handle the resolver wrote
  resolved_sec_uid text,                   -- rename-proof owner id captured at resolution
  created_at       timestamptz not null default now()
);

create index if not exists idx_channel_resolve_conflict_log_session on public.channel_resolve_conflict_log (session_id, created_at desc);
create index if not exists idx_channel_resolve_conflict_log_time on public.channel_resolve_conflict_log (created_at desc);

-- Service-role writes only (the cron/resolver uses the admin client, which bypasses RLS);
-- no public policies — mirrors tracking_correction_log (066).
alter table public.channel_resolve_conflict_log enable row level security;
