-- 119_team_schedule_tokens.sql
-- One opaque, revocable token per owner that grants READ-ONLY access to the team schedule
-- calendar at /s/team/[token]. Intended for managers on their phones — the same shape as
-- employee_access_tokens (085), but owner-scoped rather than employee-scoped.
--
-- ⚠️ MIGRATION LEDGER: this database has NO migration ledger. Migrations are applied BY HAND and
--    the repo file is the ONLY record of what has run. Prefix 119 was chosen because 118 is the
--    highest prefix claimed across ALL branches (112–118 exist; 116/117/118 land with the
--    inventory-mapping work). Gaps below were deliberately NOT backfilled.
--    ➜ BEFORE HAND-APPLYING: confirm public.team_schedule_tokens does not already exist.
--
-- SECURITY MODEL (identical to employee_access_tokens — see CLAUDE.md "Auth sessions"):
--   * The /s/team/[token] route NEVER establishes a Supabase auth session. `/s/` is excluded from
--     the middleware matcher, so updateSession never runs there and the capture extension's JWT
--     can never be clobbered by someone opening this link on a host machine.
--   * The route reads via the SERVICE-ROLE client, which BYPASSES RLS. RLS below is therefore not
--     the boundary for the public route — it is for the admin UI (a manager's own session). The
--     boundary is: resolve owner_id from the token, then filter EVERY downstream query by that
--     owner_id explicitly.
--   * The token grants READ of schedule only. It exposes no pay, no hourly rate, and no punches.
--
-- Fully idempotent (create ... if not exists + guarded do-blocks), matching every migration here.

create extension if not exists "uuid-ossp";

create table if not exists public.team_schedule_tokens (
  id          uuid primary key default uuid_generate_v4(),
  -- The MANAGING account that owns the roster — same meaning as employees.user_id.
  user_id     uuid not null references auth.users(id) on delete cascade,
  token       text not null unique,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);

-- Token lookup is the hot path for every page load of the public route.
create index if not exists team_schedule_tokens_token_active_idx
  on public.team_schedule_tokens (token) where active;

-- Owner lookup for the admin UI ("do I already have a link?").
create index if not exists team_schedule_tokens_user_idx
  on public.team_schedule_tokens (user_id, active);

alter table public.team_schedule_tokens enable row level security;

-- Own-row RLS for the manager session. The service-role client bypasses these entirely.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'team_schedule_tokens'
      and policyname = 'team_schedule_tokens_own_rows'
  ) then
    create policy team_schedule_tokens_own_rows
      on public.team_schedule_tokens
      for all
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end $$;

-- Only ONE active token per owner. Revoking sets active=false, which frees the slot, so a
-- rotate is (revoke, mint) with no window in which two live links exist.
create unique index if not exists team_schedule_tokens_one_active_per_owner
  on public.team_schedule_tokens (user_id) where active;
