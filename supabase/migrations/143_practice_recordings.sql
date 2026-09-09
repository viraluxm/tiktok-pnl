-- 143_practice_recordings.sql
--
-- Prefix 143: 141/142 are this chain's (renumbered twice already), and
-- 140_squish_multibind_stable_plan.sql is claimed on a branch. RE-SCAN every ref immediately
-- before applying — origin/main has moved twice during this chain's short life and taken a prefix
-- pair each time.
--
-- NOT YET APPLIED.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS IS FOR
--
-- One row per recorded practice session: where the footage lives, how long it is, and — crucially
-- — whether it FAILED.
--
-- WHY IT IS WRITTEN BEFORE THE CAPTURE CODE. The capture source is still undecided: server-side
-- LiveKit egress needs a Redis link and an egress container on a self-hosted box that has not been
-- confirmed, while browser-side MediaRecorder needs no infrastructure at all. Both produce exactly
-- the same thing — an object in storage plus a duration — so this table is deliberately designed
-- to serve EITHER, and the choice can be made (or changed, or both used) without a schema change.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- DESIGN NOTES
--
-- (a) `source` NAMES THE CAPTURE PATH, and is the reason this table survives the decision.
--     'egress'  — livekit-egress wrote the file server-side; external_id is its egress id.
--     'browser' — the host's own MediaRecorder uploaded it; external_id is null.
--     Constrained, because a replay may eventually need to treat them differently (a browser
--     recording can be missing its final seconds; an egress recording cannot).
--
-- (b) STATUS MUST BE ABLE TO SAY "FAILED", AND THAT IS THE POINT. Every existing LiveKit path in
--     this codebase swallows its errors on purpose — useVideoPublish and TrainerVideoView both
--     catch-and-continue, which is right for a live preview and WRONG for a recording. A reviewer
--     opening a replay that does not exist must be told why, so `failed` carries an `error`.
--
-- (c) NULLABLE storage_path. The row is created when recording STARTS, so the path is not known
--     until it completes (an egress id is not a path, and a browser upload finalises at the end).
--     A row with status='recording' and a null path is the normal in-flight state.
--
-- (d) MANY RECORDINGS PER SESSION, not one. restartPractice() reuses the same session id for a
--     second run, so a session can legitimately produce several recordings. The replay UI lists
--     them; it does not assume one.
--
-- (e) external_id IS UNIQUE WHERE PRESENT. An egress webhook can fire more than once for the same
--     job (retries are normal), and the partial unique index below is what makes handling that
--     webhook idempotent instead of duplicating rows. Partial, because 'browser' rows have no
--     external id and would otherwise all collide on null.
--
-- (f) NO CHUNK/PART TABLE. A browser recording uploads in pieces, but the pieces live under one
--     storage prefix and can simply be listed. Tracking them in Postgres would add a write per
--     ~10 seconds per host — 20 hosts would make that the busiest table in the schema — to
--     duplicate what object storage already knows.
--
-- (g) ON DELETE CASCADE, safe for the same reason as practice_events: the only deletable session
--     is one that never ran, which has no recording. NOTE for whoever adds a retention job — the
--     cascade removes the ROW, not the storage OBJECT. Deleting footage must go through storage
--     explicitly; a cascade alone would orphan files.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- LOCK FOOTPRINT — CLASS A
--
-- One CREATE TABLE with a new name, two indexes, RLS enablement on that same table. Its only
-- reference to an existing object is a foreign key to public.practice_sessions, which has no
-- live-show reader and is not on the capture or order-sync path. No ALTER of any pre-existing
-- table, no create-or-replace of any function.

begin;

set local lock_timeout = '3s';

create table public.practice_recordings (
  id            uuid        primary key default gen_random_uuid(),

  session_id    uuid        not null
                            references public.practice_sessions (id) on delete cascade,

  -- Which capture path produced this (design note a).
  source        text        not null check (source in ('browser', 'egress')),

  -- The egress job id for source='egress'; null for 'browser' (design note e).
  external_id   text,

  -- Object path inside the private practice-recordings bucket. Null while in flight (note c).
  storage_path  text,

  status        text        not null default 'recording'
                            check (status in ('recording', 'complete', 'failed')),

  -- Why it failed, shown to whoever opens the replay (design note b).
  error         text,

  duration_ms   integer     check (duration_ms is null or duration_ms >= 0),
  size_bytes    bigint      check (size_bytes is null or size_bytes >= 0),

  started_at    timestamptz not null default now(),
  ended_at      timestamptz
);

comment on table public.practice_recordings is
  'One row per recorded practice session. `source` names the capture path (browser MediaRecorder or '
  'server-side livekit-egress) so either can be used without a schema change. status=''failed'' with '
  'an `error` is deliberate: unlike the live-preview paths, a recording must never fail silently. '
  'CASCADE removes the row, NOT the storage object — retention must delete footage explicitly.';

-- The replay UI's read: this session's recordings, newest first.
create index practice_recordings_session_idx
  on public.practice_recordings (session_id, started_at desc);

-- Makes egress webhook handling idempotent (design note e). Partial, so 'browser' rows with a null
-- external_id do not all collide.
create unique index practice_recordings_external_id_key
  on public.practice_recordings (external_id)
  where external_id is not null;

-- Same posture as 141/142: service-role only, scoped by joining through the owner-scoped parent.
-- RLS on with no policies means an accidental anon/authenticated read returns zero rows.
alter table public.practice_recordings enable row level security;

commit;
