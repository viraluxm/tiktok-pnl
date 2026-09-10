-- 146_crew_board_tokens.sql
--
-- ⚠️ RENAMED FROM 137_crew_board_tokens.sql. It was written and APPLIED TO PRODUCTION on
--    2026-09-09 under the name `137_`, before `137_squish_multibind_onhold_and_order.sql` was
--    seen — that file landed on main first (PR #243) and keeps the 137 prefix. Both had already
--    run in prod (crew_board_tokens exists; squish_multibind_audit_as exists), so nothing was
--    skipped or double-applied — but two files sharing a prefix is exactly the hazard this repo
--    has been bitten by, so the LATER one is renumbered to a free prefix.
--    ➜ THIS FILE IS ALREADY APPLIED. Do not run it again looking for a gap at 146. It is
--      idempotent (create ... if not exists) so a re-run is harmless, but it is not needed.
-- Manager crew board — the tokenized link that shows ONE crew's picker output for one
-- fulfillment day. Read-only surface; this migration adds ONE new table and nothing else.
--
-- ⚠️ MIGRATION LEDGER: this database has NO migration ledger. Migrations are applied BY HAND
--    and the repo file is the ONLY record of what has run. Prefix 137 was chosen by scanning
--    tracked files, the working tree, AND every branch (max found: 136, practice_sessions).
--    ➜ BEFORE HAND-APPLYING: confirm public.crew_board_tokens does NOT already exist.
--
-- LOCK FOOTPRINT: CREATE TABLE only — no ALTER, no index build on an existing table, no lock
-- taken on anything already in use. Nothing in the capture or order-sync path is touched, so
-- this does not need a write-activity silence window; it is safe to apply mid-show.
--
-- WHY A NEW TABLE rather than reusing employee_access_tokens: that table's employee_id is NOT
-- NULL and means "this employee's own schedule". A crew board token is not scoped to a person —
-- it is scoped to a CREW (am/pm) and grants a manager a read of everyone on that shift. Same
-- reasoning kiosk_tokens (091) was split out rather than overloading employee_access_tokens.

create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------------
-- crew_board_tokens — one row per manager link. The token IS the crew: a morning manager's
-- link cannot show the night shift and vice versa, so there is no crew switcher to get wrong.
-- Mirrors the kiosk_tokens (091) shape: opaque token, active flag, revoked_at, no updated_at.
-- ---------------------------------------------------------------------------
create table if not exists public.crew_board_tokens (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  store_id uuid,                             -- guarded FK below (out-of-band `stores`, 070 idiom)
  token text not null unique,                -- 32 random bytes, base64url; generated in app code
  crew text not null,                        -- 'am' = 04:00-14:59 PT, 'pm' = 15:00-03:59 PT
  label text not null default 'Crew',        -- page heading, e.g. 'Morning crew'
  -- Per-shift box minimum shown on the board. NULLABLE ON PURPOSE: a NULL target renders the
  -- board with counts and hourly bars only and NO target column, so the number can be set,
  -- changed or removed from the admin API without a deploy. Per-crew because each crew has its
  -- own token row — morning and night can carry different minimums.
  target_boxes integer,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint crew_board_tokens_crew_check check (crew in ('am', 'pm')),
  constraint crew_board_tokens_target_positive check (target_boxes is null or target_boxes > 0)
);

create index if not exists idx_crew_board_tokens_user on public.crew_board_tokens(user_id);
-- Hot path: resolve an ACTIVE token. UNIQUE(token) already guarantees active uniqueness (tokens
-- are random and never reused); this partial index is the covering lookup for
-- `where token = ? and active`, matching the 091 idiom.
create unique index if not exists idx_crew_board_tokens_active_token
  on public.crew_board_tokens (token) where active;

-- store_id FK guarded exactly like 044/047/070/091 — `stores` is created out-of-band and is
-- never RLS-load-bearing here.
do $$ begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'stores') then
    if not exists (select 1 from pg_constraint where conname = 'crew_board_tokens_store_id_fkey') then
      alter table public.crew_board_tokens
        add constraint crew_board_tokens_store_id_fkey foreign key (store_id) references public.stores(id);
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- RLS — own-row (auth.uid() = user_id), the 070/044/091 idiom. These policies govern OWNER
-- management of the links from the dashboard (a real user session). The public
-- /s/[token]/pickers route uses the SERVICE-ROLE client, which bypasses RLS entirely — its
-- confinement is the explicit `.eq('user_id', <owner resolved from the token>)` written into
-- every downstream query, never these policies. See the auth-sessions section of CLAUDE.md.
-- ---------------------------------------------------------------------------
alter table public.crew_board_tokens enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='crew_board_tokens' and policyname='Users can view own crew_board_tokens') then
    create policy "Users can view own crew_board_tokens" on public.crew_board_tokens
      for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='crew_board_tokens' and policyname='Users can insert own crew_board_tokens') then
    create policy "Users can insert own crew_board_tokens" on public.crew_board_tokens
      for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='crew_board_tokens' and policyname='Users can update own crew_board_tokens') then
    create policy "Users can update own crew_board_tokens" on public.crew_board_tokens
      for update using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='crew_board_tokens' and policyname='Users can delete own crew_board_tokens') then
    create policy "Users can delete own crew_board_tokens" on public.crew_board_tokens
      for delete using (auth.uid() = user_id);
  end if;
end $$;
