-- Schedule Phase 2 harness — the minimal base world the REAL migrations expect.
-- Stubs only. run.sh applies the actual repo migrations 044/047/085/086/090 on top of this and
-- then the actual 129 file, so every constraint, index and RPC body under test is the shipped one.
--
-- No RLS setup: the tests run as the table owner and migration 129's RPC is SECURITY DEFINER with
-- explicit user_id predicates, which is what does the tenancy scoping. Same convention as
-- ../timeclock/bootstrap.sql and ../idempotency/bootstrap.sql.

create extension if not exists "uuid-ossp";

-- Supabase ships these roles. All three must exist or 129's REVOKE/GRANT block would be a no-op
-- and the grant assertions would silently pass without testing anything.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon')          then create role anon;          end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role')  then create role service_role;  end if;
end $$;

-- updated_at trigger fn (migration 021 in prod).
create or replace function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- auth stub: auth.users + auth.uid() from a GUC.
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.user_id', true), '')::uuid
$$;
