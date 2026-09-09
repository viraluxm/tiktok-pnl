-- 138_practice_sessions.sql
--
-- RENAMED FROM 136_practice_sessions.sql. Prefix 136 was free across every ref when this was
-- written and applied (2026-09-08/09), but origin/main advanced 11 commits during that window and
-- PR #231 landed 136_squish_multibind_audit_timeout_fix.sql — which, being merged to main, has
-- precedence (the same resolution 134 documents for its own rename off 129). A third claim,
-- 136_shift_trades.sql, also exists on origin/feat/employee-portal-redesign, and 137 is claimed
-- TWICE (137_shift_approved_minutes.sql, 137_squish_multibind_onhold_and_order.sql). So the first
-- genuinely free prefix was 138.
--
-- THE RENAME IS PURELY A REPO-RECORD CHANGE. The filename is stored nowhere; the objects below were
-- already applied to live under the old name and are UNAFFECTED. Content is byte-identical to what
-- ran — only the prefix moved.
--
-- This is exactly the skip/double-apply hazard CLAUDE.md warns about: this DB has no migration
-- ledger, so re-scan tracked files, untracked working-tree files AND every branch/remote
-- immediately before applying anything — a scan that is even hours old can be wrong.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- APPLIED TO LIVE on 2026-09-09 03:48 UTC, at the user's explicit instruction.
-- DO NOT REPLAY — every object below already exists on live.
--
-- Applied mid-show under the Class A lock-footprint recipe (the write-activity
-- silence gate is unsatisfiable on a 24/7 operation): one transaction,
-- lock_timeout 3s, new object names only.
--
-- Verified in that session:
--   * captures kept landing straight through: capture_events 163,175 -> 163,180,
--     with 5 rows landing inside the apply window; live_sessions.last_seen_at was
--     5 seconds old immediately afterwards. Nothing blocked.
--   * the table materialised exactly as designed: 9 columns, purpose CHECK =
--     ('training','audition'), 3 indexes (pkey + the two below).
--   * RLS enabled with 0 policies, as intended (service-role access only).
--   * 0 rows — no accidental writes.
-- Nothing existing was altered, replaced or dropped: this file only CREATEs.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS IS FOR
--
-- The server-side registry for Practice Mode sessions (host training + host auditions).
--
-- THE PROBLEM IT SOLVES. Until now the ONLY record that a practice session exists has been a
-- localStorage array in whichever browser created it (`training:launcher:recent-sessions`). The
-- session id itself is a client-side crypto.randomUUID() that flows into the URL, the Supabase
-- Realtime channel name and the LiveKit room name. Consequences, all of which bite at ~20
-- concurrent auditions:
--   * a second manager on a different laptop cannot see, join or QR any session;
--   * clearing site data strands every running session (a published camera with no way back in);
--   * nothing records WHO is being auditioned, so a recording can never be attributed;
--   * there is no way to ask "which sessions are live right now?".
--
-- PR #208 already removed the launcher's 8-session cap and made its list helpers
-- non-destructive, and left a comment saying plainly that the localStorage list is the only
-- record. This table is what lets that comment stop being true.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- DESIGN NOTES
--
-- (a) `id` IS THE EXISTING SESSION ID, not a new surrogate key. The uuid already appears in
--     ?session= on both the host and controller URLs and derives `trainer:<uuid>` (Realtime) and
--     `training:<uuid>` (LiveKit) via src/lib/training/session.ts. Reusing it means the registry
--     row and the live session are the same identity with no mapping table, and an already-running
--     session can be imported by inserting its existing id.
--
-- (b) THERE IS NO `status` COLUMN — ON PURPOSE. A stored status drifts: a phone that dies mid-
--     session would leave status='live' forever and need a reconciling cron to clean up. Instead
--     only lifecycle FACTS are stored (created_at / started_at / ended_at / last_seen_at) and
--     liveness is DERIVED at read time from last_seen_at freshness. The host heartbeats every
--     ~15s and the read treats <45s (three missed beats) as live, so a dead tab decays to "stale"
--     by itself. No cron, no drift, nothing to repair.
--
-- (c) `started_at` IS SET BY THE FIRST HEARTBEAT, not at creation. Creating a session in the
--     launcher only mints a link; the session has not begun until a host actually grants camera
--     access and starts. So created_at != started_at, and a session that was never opened is
--     distinguishable from one that ran — which matters for auditions that no-showed.
--
-- (d) RLS IS ENABLED WITH ZERO POLICIES. Every read and write goes through an admin-gated API
--     route using the service-role client, scoped explicitly by owner_id in the query (the same
--     shape as src/app/api/admin/badges/route.ts, and the same RLS posture as
--     capture_health_alerts from migration 088). RLS-on/no-policies means that if a row ever
--     became reachable from an anon or authenticated session by accident, it reads as empty
--     rather than as everything. Fail closed.
--
-- (e) NO FOREIGN KEY TO auth.users. owner_id/created_by reference Supabase auth users, which live
--     in another schema; the rest of this codebase carries them as bare uuids (see
--     employee_badges.user_id) and scopes in the query. Consistency beats a cross-schema FK here.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- LOCK FOOTPRINT — CLASS A
--
-- One CREATE TABLE with a NEW name, its own indexes, and RLS enablement on that same new table.
-- No ALTER of any existing table. No create-or-replace of any function. Nothing on the capture or
-- order-sync write path takes a lock from this file, and no live-show reader touches
-- practice_sessions (Practice Mode shares no tables with production capture). lock_timeout means
-- that if this somehow DID contend it fails fast instead of queueing ahead of a capture write.

begin;

set local lock_timeout = '3s';

create table public.practice_sessions (
  -- The practice session id: the SAME uuid already carried in ?session= and used to derive the
  -- Realtime channel and LiveKit room. Supplied by the caller (the create route mints it
  -- server-side; an import supplies an already-running session's existing id).
  id            uuid        primary key,

  -- Scoping key for every query. All operational data in this DB belongs to one store owner
  -- today, but every read is written owner-scoped anyway so this stays correct when partners
  -- are promoted to admin.
  owner_id      uuid        not null,

  -- Which admin account minted the link. Distinct from owner_id so that when more than one
  -- manager runs auditions, "whose session is this" is answerable.
  created_by    uuid        not null,

  -- Who is being trained or auditioned. Free text, optional: a session can be created before
  -- the candidate's name is known, and the launcher lets it be filled in later.
  trainee_name  text,

  -- Why this session exists. Constrained rather than free text because the replay list will
  -- filter on it, and a typo'd value would silently vanish from that filter.
  purpose       text        not null default 'training'
                            check (purpose in ('training', 'audition')),

  -- Lifecycle facts. See design note (b): liveness is derived from these, never stored.
  created_at    timestamptz not null default now(),  -- link minted
  started_at    timestamptz,                         -- first heartbeat: a host actually began
  ended_at      timestamptz,                         -- clean finish (session complete / removed)
  last_seen_at  timestamptz                          -- most recent host heartbeat
);

comment on table public.practice_sessions is
  'Server-side registry for Practice Mode training/audition sessions. id is the same uuid used in '
  '?session=, the trainer:<uuid> Realtime channel and the training:<uuid> LiveKit room. Liveness is '
  'DERIVED from last_seen_at freshness (~15s heartbeat, <45s = live); there is deliberately no '
  'status column to drift. Read/written only by admin-gated service-role routes.';

-- The launcher's only list query: an owner's sessions, newest first.
create index practice_sessions_owner_created_idx
  on public.practice_sessions (owner_id, created_at desc);

-- Supports "which of this owner's sessions are live right now?" without scanning ended rows.
-- Partial, because an ended session can never be live again.
create index practice_sessions_live_idx
  on public.practice_sessions (owner_id, last_seen_at desc)
  where ended_at is null;

-- See design note (d): service-role access only. Enabled with no policies so an accidental
-- anon/authenticated read returns zero rows rather than every row.
alter table public.practice_sessions enable row level security;

commit;
