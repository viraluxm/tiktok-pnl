-- 039_fulfillment_workers.sql — Identity/Auth phase, CHUNK 1: the fulfillment worker roster.
-- Pure addition: one new table + one small helper function. No changes to any existing table,
-- no data changes, no policy changes elsewhere. Transaction-wrapped + idempotent.
-- Reverse: drop table public.fulfillment_workers; drop function public.is_store_owner_in_org(uuid);

begin;

-- Helper: "is the current user an OWNER of some store in this org?" = a shop owner
-- (Alvaro for lots-of-steals, Abe for Snore). Used for roster WRITE access.
--
-- Why not the existing helpers:
--   is_org_owner(org)  = ONLY organizations.owner_user_id (Alvaro) → would EXCLUDE Abe.
--   is_org_member(org) = too broad → would include the future shared FULFILLMENT device
--                        account (chunk 6) and any operator/viewer.
-- store_members.role='owner' is the precise "shop owner" signal and excludes devices.
create or replace function public.is_store_owner_in_org(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from public.store_members sm
      join public.stores s on s.id = sm.store_id
     where s.org_id = p_org
       and sm.user_id = auth.uid()
       and sm.role = 'owner'
  );
$$;
grant execute on function public.is_store_owner_in_org(uuid) to authenticated;

-- Roster of warehouse workers (org-shared — one pool across both stores).
create table if not exists public.fulfillment_workers (
  id        uuid primary key default uuid_generate_v4(),
  org_id    uuid not null references public.organizations(id) on delete cascade,
  name      text not null,
  role      text not null default 'both' check (role in ('picker','packer','both')),  -- eligibility (Model 1)
  user_id   uuid null references auth.users(id) on delete set null,                   -- links an owner/person; usually null
  pin_hash  text null,                                                                 -- FUTURE PIN (nullable now)
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_fw_org        on public.fulfillment_workers(org_id);
create index if not exists idx_fw_org_active on public.fulfillment_workers(org_id, is_active);

drop trigger if exists fulfillment_workers_set_updated_at on public.fulfillment_workers;
create trigger fulfillment_workers_set_updated_at before update on public.fulfillment_workers
  for each row execute function public.set_updated_at();

alter table public.fulfillment_workers enable row level security;
drop policy if exists "fw org read"     on public.fulfillment_workers;
drop policy if exists "fw owner insert" on public.fulfillment_workers;
drop policy if exists "fw owner update" on public.fulfillment_workers;
drop policy if exists "fw owner delete" on public.fulfillment_workers;
-- READ: any org member (owners + the shared fulfillment device account list the roster).
create policy "fw org read"     on public.fulfillment_workers for select using (public.is_org_member(org_id));
-- WRITE: shop owners only (Alvaro & Abe; not devices/operators).
create policy "fw owner insert" on public.fulfillment_workers for insert with check (public.is_store_owner_in_org(org_id));
create policy "fw owner update" on public.fulfillment_workers for update using (public.is_store_owner_in_org(org_id)) with check (public.is_store_owner_in_org(org_id));
create policy "fw owner delete" on public.fulfillment_workers for delete using (public.is_store_owner_in_org(org_id));

commit;
