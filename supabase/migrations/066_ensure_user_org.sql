-- 066_ensure_user_org.sql
--
-- ⚠️ STAGED — NOT YET APPLIED. Apply gated after review.
--
-- Phase C — every user gets an org so they are never orgless. Storeless is fine
-- (org-scoped tables just return empty until they connect a shop); orgless is
-- NOT (getOrgId() → null strands the shared-table writes/reads).
--
-- Why a SECURITY DEFINER function: organizations has NO user INSERT policy and
-- organization_members INSERT requires is_org_owner(org_id) — a chicken-and-egg
-- for the first member. Running as postgres (definer) bypasses both, exactly as
-- the 035b backfill did for the existing owner.

begin;

-- Idempotent: returns the user's earliest org (matches getOrgId ordering), or
-- creates a personal org + owner membership if they have none.
create or replace function public.ensure_user_org(p_user uuid, p_name text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  select org_id into v_org
  from public.organization_members
  where user_id = p_user
  order by created_at asc
  limit 1;

  if v_org is not null then
    return v_org;
  end if;

  insert into public.organizations (name, owner_user_id)
  values (coalesce(nullif(p_name, ''), 'My Organization'), p_user)
  returning id into v_org;

  insert into public.organization_members (org_id, user_id, role)
  values (v_org, p_user, 'owner');

  return v_org;
end $$;

-- Callable by the OAuth callback via the service-role admin client (RPC). Not
-- granted to anon/authenticated — creation stays server-side only.
revoke all on function public.ensure_user_org(uuid, text) from public;
revoke all on function public.ensure_user_org(uuid, text) from anon, authenticated;
grant execute on function public.ensure_user_org(uuid, text) to service_role;

-- Extend the existing new-user trigger to also provision the org. Profile insert
-- is preserved verbatim from 001_initial_schema.sql.
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, display_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data->>'avatar_url'
  );

  -- Give every new signup their own org (storeless until they connect a shop).
  -- FUTURE: when an invite flow exists, invited teammates should JOIN the
  -- inviter's org instead of getting a personal one — branch here on an invite
  -- marker in raw_user_meta_data rather than always creating.
  perform public.ensure_user_org(new.id, split_part(new.email, '@', 1));

  return new;
end;
$$ language plpgsql security definer;

commit;
