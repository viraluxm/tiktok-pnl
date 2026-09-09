-- 145_practice_host_token.sql
--
-- Prefix 145: re-scanned across every branch and remote immediately before writing (2026-09-09).
-- 140/141 are on main, 142/143/144 are this chain's. This chain has already been renumbered THREE
-- times by other branches landing the same prefixes — re-scan again before applying.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- APPLIED TO LIVE on 2026-09-09 11:03 UTC, at the user's explicit instruction.
-- DO NOT REPLAY.
--
-- Prefixes were re-scanned immediately beforehand (140/141 on main, 142/143/144 this
-- chain's). Applied in one transaction with lock_timeout 3s.
--
-- Verified in that session:
--   * host_token is `text nullable=YES`; the partial unique index exists.
--   * all 8 pre-existing sessions were untouched and kept host_token NULL, so they
--     continue to work through the admin host route exactly as before.
--   * the PARTIAL index behaves: two rows with a NULL host_token insert fine, while
--     a duplicate non-null token is rejected (23505). That is what makes the token a
--     usable lookup key without every null colliding.
--   * captures were NOT flowing during this window (last capture_events write was
--     167 min earlier — the show had ended), so unlike 142-144 this was not an
--     applied-mid-show change. live_sessions.last_seen_at was 1 min old, i.e. the
--     heartbeat is still running with no captures, which is the normal between-shows
--     state and is exactly why CLAUDE.md says that flag must never be used as the
--     interlock.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS IS FOR
--
-- An opaque per-session token so a practice HOST can join without a Lensed login.
--
-- THE PROBLEM. The host screen lives under (app)/admin, which redirects unless
-- app_metadata.role === 'admin'. That was tolerable while hosts were staff on a
-- company phone. It is not tolerable for auditions: ~100 candidates a day would each
-- need an admin account, and an admin account on this app reaches P&L, orders,
-- inventory and payroll. Nobody should hand that to a job applicant to read a
-- practice script.
--
-- THE SHAPE. Same as the existing /s/[token] employee routes, and for the same
-- reason (see CLAUDE.md): the token resolves an identity SERVER-SIDE via the
-- service-role client, every downstream query is filtered explicitly by the
-- resolved session id, and the public route NEVER establishes a Supabase auth
-- session. RLS is bypassed by service-role, so RLS is not the boundary here — the
-- token plus the explicit filter is.
--
-- WHY THIS IS NOT A CAPTURE-EXTENSION HAZARD. CLAUDE.md forbids a second Supabase
-- auth session on a host machine because the extension relays whatever session it
-- sees and captures would then write under the wrong user_id. A tokenized route
-- establishes NO session at all, which is precisely why it is the safe answer here
-- rather than a lesser one: it removes a login from the flow instead of adding one.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- DESIGN NOTES
--
-- (a) 43-char base64url from 32 random bytes, generated in app code — identical to
--     generateAccessToken() for employee tokens. Not a uuid: the session id is
--     already a uuid and is not secret (it appears in the admin URL, the Realtime
--     channel name and the LiveKit room name), so it must not double as the
--     credential. A separate high-entropy token is what makes the link safe to send
--     to someone outside the company.
--
-- (b) NULLABLE, and null means "no tokenized access". Existing sessions keep
--     working through the admin route untouched, and a session can be created
--     without ever minting a link.
--
-- (c) UNIQUE, partial. The uniqueness is what makes the token a usable lookup key;
--     partial because null is the common state and every null would otherwise
--     collide.
--
-- (d) NO EXPIRY COLUMN. Deliberate: a practice session already carries its own
--     lifecycle (ended_at) and the resolver refuses an ended session, so the link
--     stops working when the session finishes. A separate expiry would be a second
--     source of truth for the same question. Revoking early = end the session.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- LOCK FOOTPRINT
--
-- This is an ALTER of an existing table, unlike 142-144 which only CREATEd. It is
-- still trivial: ADD COLUMN of a nullable text with no default is a catalogue-only
-- change in Postgres 11+ (no table rewrite), and CREATE INDEX on a table holding a
-- handful of rows is instant. practice_sessions is read only by the admin launcher
-- and has no live-show reader, so nothing on the capture or order-sync path can
-- contend. lock_timeout 3s means it fails fast rather than queueing if it ever did.

begin;

set local lock_timeout = '3s';

alter table public.practice_sessions
  add column host_token text;

comment on column public.practice_sessions.host_token is
  'Opaque 43-char base64url token letting a practice host join WITHOUT a Lensed login, via the '
  'public /p/[token] route. Resolved server-side with the service-role client; the route never '
  'establishes a Supabase auth session (see CLAUDE.md). Null = no tokenized access. The resolver '
  'refuses an ended session, so ending a session revokes its link — there is deliberately no '
  'separate expiry.';

-- Partial UNIQUE: the token is a lookup key, and null (the common state) must not collide.
create unique index practice_sessions_host_token_key
  on public.practice_sessions (host_token)
  where host_token is not null;

commit;
