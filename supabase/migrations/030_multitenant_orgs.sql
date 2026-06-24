-- 030: multi-tenant orgs — move from single-user (user_id) to org-owned access.
--
-- MODEL: one org owns all data; members have full access. user_id is KEPT on
-- every row as authorship/audit (who created it); org_id becomes the access key.
-- RLS changes from "auth.uid() = user_id" to "caller is a member of row.org_id".
--
-- ⚠️ REVIEW NOTES (read before applying):
--  1. WRITES need org_id. The new INSERT policy requires org_id to belong to the
--     caller's org. A BEFORE-INSERT trigger auto-fills org_id from the caller's
--     membership when auth.uid() is set (user-context requests). SERVICE-ROLE
--     paths (e.g. the order sync admin client) have auth.uid()=NULL, so the
--     trigger can't infer the org — those code paths must pass org_id explicitly,
--     or rows will land with org_id NULL and be invisible. App code change is a
--     SEPARATE task.
--  2. SECOND USER: user 30c4f280-d12c-4120-99a5-67d857647e34 has rows here. This
--     backfill ONLY assigns org_id to f5885f7d-...'s rows. 30c4f280's rows keep
--     org_id NULL (invisible under the new RLS) until you decide their org.
--  3. OUT OF SCOPE: live_events (no user_id; scoped via show_id→live_shows) and
--     profiles (per-user identity, keyed by id) are NOT modified here — flagged
--     for separate handling.
--
-- Owner backfill target:
--   me  = f5885f7d-5841-457c-b66f-a5aa2916db46  (org owner)

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Org tables
-- ─────────────────────────────────────────────────────────────────────────────
do $$ begin
  if not exists (select 1 from pg_type where typname = 'org_role') then
    create type public.org_role as enum ('owner', 'member');
  end if;
end $$;

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_user_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table if not exists public.organization_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.org_role not null default 'member',
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);
create index if not exists idx_org_members_user on public.organization_members(user_id);
create index if not exists idx_org_members_org on public.organization_members(org_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Membership helpers (SECURITY DEFINER → bypass RLS, avoid policy recursion)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.is_org_member(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.organization_members m
    where m.org_id = p_org and m.user_id = auth.uid()
  );
$$;

create or replace function public.is_org_owner(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.organizations o
    where o.id = p_org and o.owner_user_id = auth.uid()
  );
$$;

grant execute on function public.is_org_member(uuid) to authenticated;
grant execute on function public.is_org_owner(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Add nullable org_id + index to every user_id-scoped table
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  t text;
  tables text[] := array[
    'ad_spend','capture_events','entries','hosts','inventory_skus',
    'live_auction_item_skus','live_auction_items','live_sessions','live_shows',
    'product_costs','products','shipment_verifications','shop_videos','sync_logs',
    'synced_order_ids','tiktok_business_connections','tiktok_connections'
  ];
begin
  foreach t in array tables loop
    execute format('alter table public.%I add column if not exists org_id uuid references public.organizations(id) on delete cascade', t);
    execute format('create index if not exists %I on public.%I(org_id)', 'idx_'||t||'_org', t);
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Backfill: create the org, add me as owner, stamp org_id on MY rows only
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_owner uuid := 'f5885f7d-5841-457c-b66f-a5aa2916db46';
  v_org uuid;
  t text;
  tables text[] := array[
    'ad_spend','capture_events','entries','hosts','inventory_skus',
    'live_auction_item_skus','live_auction_items','live_sessions','live_shows',
    'product_costs','products','shipment_verifications','shop_videos','sync_logs',
    'synced_order_ids','tiktok_business_connections','tiktok_connections'
  ];
begin
  insert into public.organizations (name, owner_user_id) values ('Lensed', v_owner)
    returning id into v_org;
  insert into public.organization_members (org_id, user_id, role) values (v_org, v_owner, 'owner');

  foreach t in array tables loop
    execute format('update public.%I set org_id = %L where user_id = %L and org_id is null', t, v_org, v_owner);
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Auto-fill org_id on insert from the caller's membership (user-context only;
--    see REVIEW NOTE #1 about service-role paths).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.set_org_id_on_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is null and auth.uid() is not null then
    select m.org_id into new.org_id
      from public.organization_members m
      where m.user_id = auth.uid()
      order by m.created_at
      limit 1;
  end if;
  return new;
end;
$$;

do $$
declare
  t text;
  tables text[] := array[
    'ad_spend','capture_events','entries','hosts','inventory_skus',
    'live_auction_item_skus','live_auction_items','live_sessions','live_shows',
    'product_costs','products','shipment_verifications','shop_videos','sync_logs',
    'synced_order_ids','tiktok_business_connections','tiktok_connections'
  ];
begin
  foreach t in array tables loop
    execute format('drop trigger if exists zz_set_org_id on public.%I', t);
    execute format('create trigger zz_set_org_id before insert on public.%I for each row execute function public.set_org_id_on_insert()', t);
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. RLS: drop old "user owns row" policies, create org-membership policies
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  t text;
  p record;
  tables text[] := array[
    'ad_spend','capture_events','entries','hosts','inventory_skus',
    'live_auction_item_skus','live_auction_items','live_sessions','live_shows',
    'product_costs','products','shipment_verifications','shop_videos','sync_logs',
    'synced_order_ids','tiktok_business_connections','tiktok_connections'
  ];
begin
  foreach t in array tables loop
    -- drop every existing policy on the table (names vary across tables)
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;

    execute format('alter table public.%I enable row level security', t);

    execute format('create policy %I on public.%I for select using (public.is_org_member(org_id))', t||'_org_sel', t);
    execute format('create policy %I on public.%I for insert with check (public.is_org_member(org_id))', t||'_org_ins', t);
    execute format('create policy %I on public.%I for update using (public.is_org_member(org_id)) with check (public.is_org_member(org_id))', t||'_org_upd', t);
    execute format('create policy %I on public.%I for delete using (public.is_org_member(org_id))', t||'_org_del', t);
  end loop;
end $$;

-- RLS for the org tables themselves
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;

create policy organizations_member_sel on public.organizations
  for select using (public.is_org_member(id));
create policy organizations_owner_upd on public.organizations
  for update using (public.is_org_owner(id)) with check (public.is_org_owner(id));
-- (insert/delete of organizations is intentionally service-role / SQL only)

create policy org_members_member_sel on public.organization_members
  for select using (public.is_org_member(org_id));
create policy org_members_owner_ins on public.organization_members
  for insert with check (public.is_org_owner(org_id));
create policy org_members_owner_upd on public.organization_members
  for update using (public.is_org_owner(org_id)) with check (public.is_org_owner(org_id));
create policy org_members_owner_del on public.organization_members
  for delete using (public.is_org_owner(org_id));

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. (separate step) Add Abe as a member once you have his user_id:
--   insert into public.organization_members (org_id, user_id, role)
--   select id, '<ABE_USER_ID>', 'member' from public.organizations where owner_user_id = 'f5885f7d-5841-457c-b66f-a5aa2916db46';
-- ─────────────────────────────────────────────────────────────────────────────


-- =============================================================================
-- ROLLBACK (run manually to undo; restores the standard per-user RLS pattern)
-- =============================================================================
-- do $$
-- declare
--   t text;
--   p record;
--   tables text[] := array[
--     'ad_spend','capture_events','entries','hosts','inventory_skus',
--     'live_auction_item_skus','live_auction_items','live_sessions','live_shows',
--     'product_costs','products','shipment_verifications','shop_videos','sync_logs',
--     'synced_order_ids','tiktok_business_connections','tiktok_connections'
--   ];
-- begin
--   foreach t in array tables loop
--     execute format('drop trigger if exists zz_set_org_id on public.%I', t);
--     for p in select policyname from pg_policies where schemaname='public' and tablename=t loop
--       execute format('drop policy %I on public.%I', p.policyname, t);
--     end loop;
--     -- restore original single-user policies
--     execute format('create policy %I on public.%I for select using (auth.uid() = user_id)', t||'_own_sel', t);
--     execute format('create policy %I on public.%I for insert with check (auth.uid() = user_id)', t||'_own_ins', t);
--     execute format('create policy %I on public.%I for update using (auth.uid() = user_id)', t||'_own_upd', t);
--     execute format('create policy %I on public.%I for delete using (auth.uid() = user_id)', t||'_own_del', t);
--     execute format('drop index if exists public.%I', 'idx_'||t||'_org');
--     execute format('alter table public.%I drop column if exists org_id', t);
--   end loop;
-- end $$;
-- drop function if exists public.set_org_id_on_insert();
-- drop policy if exists organizations_member_sel on public.organizations;
-- drop policy if exists organizations_owner_upd on public.organizations;
-- drop policy if exists org_members_member_sel on public.organization_members;
-- drop policy if exists org_members_owner_ins on public.organization_members;
-- drop policy if exists org_members_owner_upd on public.organization_members;
-- drop policy if exists org_members_owner_del on public.organization_members;
-- drop function if exists public.is_org_member(uuid);
-- drop function if exists public.is_org_owner(uuid);
-- drop table if exists public.organization_members;
-- drop table if exists public.organizations;
-- drop type if exists public.org_role;
