-- Time-clock test harness — minimal base world the real migrations expect.
-- Stubs only (no RLS: tests run as owner, and the RPCs' explicit `user_id = auth.uid()`
-- filters do the ownership scoping — same convention as the idempotency harness). run.sh
-- applies the REAL migrations 044/047/052/055/068/069 on top of this, so the actual
-- constraints, indexes, and RPC bodies under test are the shipped ones.

create extension if not exists "uuid-ossp";

-- Supabase provides `authenticated`; create it so `grant execute ... to authenticated` works.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
end $$;

-- updated_at trigger fn (defined in migration 021 in prod).
create or replace function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- auth stub: auth.users + auth.uid() sourced from a GUC the tests set per "logged-in" user.
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.user_id', true), '')::uuid
$$;
