-- 139_practice_events.sql
--
-- Prefix 139: RE-SCANNED across tracked files, untracked working-tree files and every branch and
-- remote immediately before writing (2026-09-09). 136 is claimed THREE ways
-- (practice_sessions -> renamed to 138, squish_multibind_audit_timeout_fix on main, shift_trades on
-- origin/feat/employee-portal-redesign) and 137 TWICE (shift_approved_minutes,
-- squish_multibind_onhold_and_order). 138 is this chain's practice_sessions. So 139 is first free.
-- This DB has no migration ledger — re-scan again if any time passes before applying.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- APPLIED TO LIVE on 2026-09-09 05:56 UTC, at the user's explicit instruction.
-- DO NOT REPLAY — every object below already exists on live.
--
-- Prefixes were RE-SCANNED across every branch and remote immediately before
-- applying (origin/main had not moved; 138/139 were claimed only by this chain).
-- That re-scan is not ceremony: 136 was free when practice_sessions was written
-- and collided three ways within hours.
--
-- Applied mid-show under the Class A recipe: one transaction, lock_timeout 3s.
-- Verified in that session:
--   * captures kept landing straight through: capture_events 164,437 -> 164,439,
--     2 rows inside the window; live_sessions.last_seen_at 1s old afterwards.
--   * structure: 6 columns, RLS enabled with 0 policies, 2 indexes (pkey + the
--     session/offset index), 1 foreign key, 0 rows.
--   * the constraints actually bite, each proven against the live table:
--       - an unknown `kind` is rejected (23514)
--       - a negative session_offset_ms is rejected (23514)
--       - an unregistered session_id is rejected by the FK (23503)
--       - deleting a NEVER-STARTED session cascades its events away (0 left)
--       - a session that RAN keeps its events, because the delete is refused by
--         the route's `started_at is null` predicate, so cascade never fires (1 kept)
-- Nothing existing was altered, replaced or dropped: this file only CREATEs.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS IS FOR
--
-- The event timeline for a practice session: what actually happened on the host's screen, when.
--
-- WHY IT EXISTS AT ALL — THIS IS THE HALF OF "RECORDING" THAT VIDEO CANNOT GIVE US.
-- The practice overlay (comments, bids, the auction card, viewer count, the sold state) is React
-- DOM painted ON TOP of the <video> element — it is NOT in the video track. So any egress that
-- records the camera records a host talking to an invisible audience. Two ways out: burn the
-- overlay in with a headless-Chrome web egress (expensive, and on self-hosted LiveKit that means a
-- Chrome per concurrent session), or record the raw A/V and RE-RENDER the overlay at playback from
-- a timeline. This table is that timeline, and it is what lets the recording path stay
-- ffmpeg-only.
--
-- It also pays for itself before any video exists: because the timeline is queryable, it answers
-- how long a host took to respond to each comment, how much dead air there was, how many auctions
-- they ran and how they handled bids. For auditions that is worth more than the footage.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- DESIGN NOTES
--
-- (a) OUTCOMES, NOT COMMANDS. It would be tempting to log the existing TrainerEvent messages
--     (the controller's comment/placeBid/startAuction commands). That would NOT reconstruct the
--     screen. The host is the authority: it applies a bid to reach a TOTAL, it picks the winner, and
--     it SUPPRESSES comments from a blocked user entirely. A command log would replay a comment
--     the host never showed and a bid whose total it cannot know. So the host writes this log, and
--     each row records what the screen actually did.
--
-- (b) session_offset_ms IS MONOTONIC AND HOST-LOCAL, measured with performance.now() from the
--     moment the session started. NOT a wall-clock timestamp. A practice host is a phone, and a
--     phone's clock can be minutes off; a wall-clock offset would desync the whole replay, and the
--     failure is invisible until someone watches it and says "that is not what happened".
--     performance.now() is immune to clock changes, NTP steps and timezones.
--
-- (c) NO recording_offset_ms HERE. Aligning the timeline to a video needs the delta between
--     session start and recording start, which does not exist until egress does. It belongs with
--     the recording work, not here — this table is complete and useful on its own.
--
-- (d) kind IS CONSTRAINED. The replay reducer switches on it, so a typo'd kind would silently
--     vanish from the reconstruction rather than fail. The CHECK mirrors the PracticeLogEvent
--     union in src/lib/training/practiceLog.ts; if they drift, an insert errors loudly.
--
-- (e) payload IS jsonb AND NOT NULL (default '{}'). Per-kind shapes differ (a bid carries a total
--     and a winner; an auction_reset carries nothing) and are validated in the API route, where a
--     bad shape can be rejected with a message. Enforcing per-kind shapes in SQL would need a
--     trigger or one CHECK per kind — cost without benefit for an append-only internal log.
--
-- (f) ON DELETE CASCADE is deliberate and now SAFE: since the practice_sessions DELETE route
--     refuses any session with started_at set, the only deletable session is one that never ran —
--     which by definition has no events. Cascade therefore cleans up a discarded empty link and
--     can never shed a real timeline.
--
-- (g) bigserial, not uuid. This is append-only, high-volume-ish (a 30-minute session writes a few
--     hundred rows) and always read as an ordered range for ONE session. A monotonic integer keeps
--     the index tight and the insert cheap; there is no need for an unguessable id on a row that is
--     only ever reachable through its owner-scoped parent.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- LOCK FOOTPRINT — CLASS A
--
-- One CREATE TABLE with a NEW name, one index, RLS enablement on that same new table. The only
-- reference to an existing object is a FOREIGN KEY to public.practice_sessions — which was itself
-- created hours ago by 138, is not on the capture or order-sync path, and has no live-show reader.
-- Adding an FK takes a brief ShareRowExclusiveLock on the REFERENCED table; practice_sessions is
-- read only by the admin launcher, so there is nothing to contend with. No ALTER of any pre-existing
-- table, no create-or-replace of any function. lock_timeout means that if it ever DID contend, it
-- fails fast rather than queueing ahead of a capture write.

begin;

set local lock_timeout = '3s';

create table public.practice_events (
  id                bigserial   primary key,

  -- The session this happened in. CASCADE is safe: only a never-started session can be deleted,
  -- and it has no events (see design note f).
  session_id        uuid        not null
                                references public.practice_sessions (id) on delete cascade,

  -- Milliseconds since the session started, from the host's monotonic clock. Non-negative by
  -- construction; the CHECK is the backstop against a bad client computing a negative offset,
  -- which would sort ahead of session_start and corrupt the replay's opening state.
  session_offset_ms integer     not null check (session_offset_ms >= 0),

  -- What happened. Mirrors the PracticeLogEvent union (design note d).
  kind              text        not null
                                check (kind in (
                                  'session_start',    -- anchor at offset 0; proves the log is
                                                      -- complete from the beginning
                                  'comment',          -- a comment the host actually DISPLAYED
                                  'bid',              -- a bid the host APPLIED (carries the total)
                                  'auction_start',
                                  'auction_end',      -- carries the sold price and the winner
                                  'auction_reset',
                                  'block',            -- a commenter the host silenced
                                  'viewers',          -- a sampled viewer count
                                  'session_complete'  -- the 30-minute clock ran out
                                )),

  -- Per-kind detail; shape validated in the API route (design note e).
  payload           jsonb       not null default '{}'::jsonb,

  -- Server insert time. Kept for forensics only (how far behind the buffer's flush was) — the
  -- replay NEVER uses this, because batching makes it lag the real moment. session_offset_ms is
  -- the only timing the replay trusts.
  created_at        timestamptz not null default now()
);

comment on table public.practice_events is
  'Append-only timeline of what a practice session''s screen actually did — OUTCOMES written by the '
  'host (applied bid totals, displayed comments, suppressed users), not the controller''s commands. '
  'session_offset_ms is monotonic host-local time from performance.now() at session start, never '
  'wall-clock, so a phone with a skewed clock cannot desync the replay. Written only by '
  'admin-gated service-role routes.';

-- The one and only read pattern: one session's events in order. Replay walks this range from 0 on
-- every seek, which is trivial for the few hundred rows a 30-minute session produces.
create index practice_events_session_offset_idx
  on public.practice_events (session_id, session_offset_ms, id);

-- Same posture as practice_sessions (138): service-role access only, scoped by joining through the
-- owner-scoped parent. RLS on with no policies means an accidental anon/authenticated read returns
-- zero rows rather than every row. Fail closed.
alter table public.practice_events enable row level security;

commit;
