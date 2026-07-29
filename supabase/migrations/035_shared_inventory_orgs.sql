-- 035b: SHARED INVENTORY, PRIVATE OPERATIONS.
--
-- Supersedes the set-aside 035/036/037 (which org-scoped all 19 tables — wrong
-- for this model; DO NOT apply those). Confirmed NOT applied in prod: 030/035/036
-- (organizations/organization_members → 404) and 037 never existed.
--
-- ORG-OWNED (shared across members) — 4 tables only:
--     inventory_skus, sku_batches, products, product_costs
--   ONE shared physical stock: every member's sale depletes the same
--   sku_batches.qty_remaining. Any member may select/insert/update/delete org
--   inventory (UPDATE is required so a member can decrement batches they don't
--   personally own).
--
-- USER-OWNED (UNCHANGED — no org_id, existing user_id RLS stays): live_sessions,
--   live_auction_items, live_auction_item_skus, capture_events, synced_order_ids,
--   order_payouts, tiktok_connections, tiktok_business_connections, ad_spend,
--   entries, shop_videos, sync_logs, hosts, live_shows, shipment_verifications.
--   Each member runs their own shows on their own TikTok with private P&L; they
--   do NOT see each other's shows/orders/payouts.
--
-- ⚠️ FOLLOW-UP NOT IN THIS MIGRATION: lensed_delete_auction_item (025) restocks
--   inventory_skus by user_id and predates FIFO (it never touches sku_batches).
--   Under shared inventory it must restock the ORG sku + its batch. Left for a
--   separate fix; deleting a sold auction item is not part of this cutover.
--
-- Owner backfill target: f5885f7d-5841-457c-b66f-a5aa2916db46

-- ── 1. Org tables + helpers (only if absent) ────────────────────────────────
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

create or replace function public.is_org_member(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.organization_members m where m.org_id = p_org and m.user_id = auth.uid());
$$;
create or replace function public.is_org_owner(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.organizations o where o.id = p_org and o.owner_user_id = auth.uid());
$$;
create or replace function public.current_user_org()
returns uuid language sql stable security definer set search_path = public as $$
  select m.org_id from public.organization_members m where m.user_id = auth.uid() order by m.created_at limit 1;
$$;
grant execute on function public.is_org_member(uuid) to authenticated;
grant execute on function public.is_org_owner(uuid) to authenticated;
grant execute on function public.current_user_org() to authenticated;

create or replace function public.set_org_id_on_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is null and auth.uid() is not null then
    select m.org_id into new.org_id from public.organization_members m
      where m.user_id = auth.uid() order by m.created_at limit 1;
  end if;
  return new;
end;
$$;

-- ── 2. The 4 SHARED tables: org_id + index + trigger + org RLS ───────────────
do $$
declare
  t text;
  p record;
  tables text[] := array['inventory_skus','sku_batches','products','product_costs'];
begin
  foreach t in array tables loop
    execute format('alter table public.%I add column if not exists org_id uuid references public.organizations(id) on delete cascade', t);
    execute format('create index if not exists %I on public.%I(org_id)', 'idx_'||t||'_org', t);
    execute format('drop trigger if exists zz_set_org_id on public.%I', t);
    execute format('create trigger zz_set_org_id before insert on public.%I for each row execute function public.set_org_id_on_insert()', t);
    for p in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select using (public.is_org_member(org_id))', t||'_org_sel', t);
    execute format('create policy %I on public.%I for insert with check (public.is_org_member(org_id))', t||'_org_ins', t);
    execute format('create policy %I on public.%I for update using (public.is_org_member(org_id)) with check (public.is_org_member(org_id))', t||'_org_upd', t);
    execute format('create policy %I on public.%I for delete using (public.is_org_member(org_id))', t||'_org_del', t);
  end loop;
end $$;

-- ── 3. Backfill: create the org, owner member, stamp org_id on owner's rows ──
do $$
declare
  v_owner uuid := 'f5885f7d-5841-457c-b66f-a5aa2916db46';
  v_org uuid;
  t text;
  tables text[] := array['inventory_skus','sku_batches','products','product_costs'];
begin
  insert into public.organizations (name, owner_user_id) values ('Lensed', v_owner) returning id into v_org;
  insert into public.organization_members (org_id, user_id, role) values (v_org, v_owner, 'owner');
  foreach t in array tables loop
    execute format('update public.%I set org_id = %L where user_id = %L and org_id is null', t, v_org, v_owner);
  end loop;
end $$;

-- Org-table RLS
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
create policy organizations_member_sel on public.organizations for select using (public.is_org_member(id));
create policy org_members_member_sel on public.organization_members for select using (public.is_org_member(org_id));
create policy org_members_owner_ins on public.organization_members for insert with check (public.is_org_owner(org_id));
create policy org_members_owner_del on public.organization_members for delete using (public.is_org_owner(org_id));

-- ── 4. RPCs: PRIVATE operations draw from SHARED org inventory ───────────────
-- Sessions + auction items stay USER-owned (user_id, unchanged). Inventory +
-- batches are resolved by ORG, so a member's sale decrements the shared pool.
-- CONCURRENCY: each touched SKU is serialized with a TRANSACTION advisory lock
-- keyed on the SKU (not the session/user), so two members selling the same SKU
-- can't both read the same qty — the FIFO/oversell DECISION is made on fresh
-- committed state. Locks are taken in sorted SKU order (deadlock-free).

create or replace function public.lensed_add_batch(p_sku_id uuid, p_qty int, p_unit_cost_cents int)
returns uuid language plpgsql security invoker as $$
declare
  v_user uuid := auth.uid();
  v_org uuid := public.current_user_org();
  v_seq int; v_id uuid;
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED' using errcode='28000'; end if;
  if v_org is null then raise exception 'NO_ORG' using errcode='P0001'; end if;
  if p_qty is null or p_qty < 0 then raise exception 'INVALID_QTY' using errcode='22023'; end if;
  if not exists (select 1 from public.inventory_skus where id = p_sku_id and org_id = v_org) then
    raise exception 'SKU_NOT_FOUND' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sku:'||p_sku_id::text, 0));
  select coalesce(max(sequence),0)+1 into v_seq from public.sku_batches where sku_id = p_sku_id and org_id = v_org;
  insert into public.sku_batches (user_id, org_id, sku_id, qty_remaining, unit_cost_cents, sequence)
  values (v_user, v_org, p_sku_id, p_qty, p_unit_cost_cents, v_seq) returning id into v_id;
  update public.inventory_skus set qty_on_hand = qty_on_hand + p_qty where id = p_sku_id and org_id = v_org;
  return v_id;
end;
$$;
grant execute on function public.lensed_add_batch(uuid, int, int) to authenticated;

create or replace function public.lensed_settle_batch(p_batch_id uuid)
returns int language plpgsql security invoker as $$
declare
  v_org uuid := public.current_user_org();
  v_sku uuid; v_q int; v_deficit int;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED' using errcode='28000'; end if;
  select sku_id into v_sku from public.sku_batches where id = p_batch_id and org_id = v_org;
  if not found then raise exception 'BATCH_NOT_FOUND' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('sku:'||v_sku::text, 0));
  select qty_remaining into v_q from public.sku_batches where id = p_batch_id and org_id = v_org;
  if v_q >= 0 then return 0; end if;
  v_deficit := -v_q;
  update public.sku_batches set qty_remaining = 0 where id = p_batch_id and org_id = v_org;
  update public.inventory_skus set qty_on_hand = qty_on_hand + v_deficit where id = v_sku and org_id = v_org;
  return v_deficit;
end;
$$;
grant execute on function public.lensed_settle_batch(uuid) to authenticated;

drop function if exists public.lensed_log_auction(uuid, text, jsonb, text, boolean, boolean);
create or replace function public.lensed_log_auction(
  p_session_id uuid, p_result text, p_skus jsonb, p_idem_key text,
  p_manual boolean default false, p_allow_negative boolean default false
)
returns table (item_id uuid, auction_number int, status text, replayed boolean,
               expected_price_cents int, total_cost_cents int)
language plpgsql security invoker as $$
declare
  v_user uuid := auth.uid();
  v_org uuid := public.current_user_org();
  v_existing record; v_session record; v_line jsonb;
  v_sku_id uuid; v_qty int; v_sku record; v_batch record; v_unit_cost int;
  v_total int := 0; v_missing boolean := false; v_expected int; v_seq int; v_item uuid;
  v_is_bundle boolean := (jsonb_array_length(p_skus) > 1);
  v_be record; v_costed jsonb := '[]'::jsonb;
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED' using errcode='28000'; end if;
  if v_org is null then raise exception 'NO_ORG' using errcode='P0001'; end if;
  if p_result not in ('sold','not_sold') then raise exception 'INVALID_RESULT' using errcode='22023'; end if;
  if p_skus is null or jsonb_array_length(p_skus)=0 then raise exception 'NO_SKUS' using errcode='22023'; end if;

  -- idempotency lock: serialize ops within this (private) session
  perform pg_advisory_xact_lock(hashtextextended(p_session_id::text, 0));

  -- ── existing row (USER-owned session/items) ──
  if p_idem_key is not null and length(p_idem_key) > 0 then
    select i.id, i.sequence, i.status, i.expected_price_cents into v_existing
      from public.live_auction_items i
      where i.session_id = p_session_id and i.user_id = v_user and i.client_idempotency_key = p_idem_key
      limit 1;
    if found then
      if v_existing.status = 'not_sold' and p_result = 'sold' then
        update public.live_auction_items as t set status='sold', closed_at=now()
          where t.id = v_existing.id and t.user_id = v_user and t.status = 'not_sold';
        if not found then
          item_id:=v_existing.id; auction_number:=v_existing.sequence; status:='sold';
          replayed:=true; expected_price_cents:=v_existing.expected_price_cents; total_cost_cents:=null;
          return next; return;
        end if;
        -- SHARED-stock serialization: lock the item's SKUs (sorted) before drawing
        perform pg_advisory_xact_lock(hashtextextended('sku:'||sid::text, 0))
          from (select distinct inventory_sku_id as sid from public.live_auction_item_skus
                where auction_item_id = v_existing.id and user_id = v_user order by 1) z;
        for v_be in
          select s.inventory_sku_id, sum(s.qty)::int as qty from public.live_auction_item_skus s
            where s.auction_item_id = v_existing.id and s.user_id = v_user group by s.inventory_sku_id
        loop
          select b.id, b.unit_cost_cents into v_batch from public.sku_batches b
            where b.sku_id = v_be.inventory_sku_id and b.org_id = v_org and b.qty_remaining >= v_be.qty
            order by b.sequence asc limit 1;
          if not found then
            if not p_allow_negative then
              raise exception 'OUT_OF_STOCK:%', coalesce((select sku_number from public.inventory_skus where id=v_be.inventory_sku_id and org_id=v_org),0) using errcode='P0001';
            end if;
            select b.id, b.unit_cost_cents into v_batch from public.sku_batches b
              where b.sku_id = v_be.inventory_sku_id and b.org_id = v_org order by b.sequence desc limit 1;
            if not found then raise exception 'NO_BATCH:%', coalesce((select sku_number from public.inventory_skus where id=v_be.inventory_sku_id and org_id=v_org),0) using errcode='P0001'; end if;
          end if;
          update public.sku_batches set qty_remaining = qty_remaining - v_be.qty where id = v_batch.id;
          update public.inventory_skus set qty_on_hand = qty_on_hand - v_be.qty where id = v_be.inventory_sku_id and org_id = v_org;
          update public.live_auction_item_skus set unit_cost_cents_snapshot = v_batch.unit_cost_cents
            where auction_item_id = v_existing.id and inventory_sku_id = v_be.inventory_sku_id and user_id = v_user;
        end loop;
        select coalesce(sum(s.unit_cost_cents_snapshot*s.qty),0)::int, bool_or(s.unit_cost_cents_snapshot is null)
          into v_total, v_missing from public.live_auction_item_skus s where s.auction_item_id = v_existing.id and s.user_id = v_user;
        item_id:=v_existing.id; auction_number:=v_existing.sequence; status:='sold';
        replayed:=false; expected_price_cents:=v_existing.expected_price_cents;
        total_cost_cents:=case when v_missing then null else v_total end;
        return next; return;
      end if;
      item_id:=v_existing.id; auction_number:=v_existing.sequence; status:=v_existing.status;
      replayed:=true; expected_price_cents:=v_existing.expected_price_cents; total_cost_cents:=null;
      return next; return;
    end if;
  end if;

  -- ── new insert (USER-owned session) ──
  select s.id, s.status into v_session from public.live_sessions s where s.id = p_session_id and s.user_id = v_user;
  if not found then raise exception 'SESSION_NOT_FOUND' using errcode='P0002'; end if;
  if v_session.status in ('ended','reconciled') and not p_manual then raise exception 'SESSION_ENDED' using errcode='P0001'; end if;

  -- SHARED-stock serialization: lock all SKUs this sale touches (sorted) up front
  perform pg_advisory_xact_lock(hashtextextended('sku:'||s, 0))
    from (select distinct (e->>'sku_id') as s from jsonb_array_elements(p_skus) e order by 1) z;

  for v_line in select * from jsonb_array_elements(p_skus) loop
    v_sku_id := (v_line->>'sku_id')::uuid;
    v_qty := greatest(1, coalesce((v_line->>'qty')::int, 1));
    select id, sku_number, title, unit_cost_cents into v_sku from public.inventory_skus where id = v_sku_id and org_id = v_org;
    if not found then raise exception 'SKU_NOT_FOUND' using errcode='22023'; end if;
    if p_result = 'sold' then
      select b.id, b.unit_cost_cents into v_batch from public.sku_batches b
        where b.sku_id = v_sku_id and b.org_id = v_org and b.qty_remaining >= v_qty order by b.sequence asc limit 1;
      if not found then
        if not p_allow_negative then raise exception 'OUT_OF_STOCK:%', v_sku.sku_number using errcode='P0001'; end if;
        select b.id, b.unit_cost_cents into v_batch from public.sku_batches b
          where b.sku_id = v_sku_id and b.org_id = v_org order by b.sequence desc limit 1;
        if not found then raise exception 'NO_BATCH:%', v_sku.sku_number using errcode='P0001'; end if;
      end if;
      update public.sku_batches set qty_remaining = qty_remaining - v_qty where id = v_batch.id;
      update public.inventory_skus set qty_on_hand = qty_on_hand - v_qty where id = v_sku_id and org_id = v_org;
      v_unit_cost := v_batch.unit_cost_cents;
    else
      v_unit_cost := v_sku.unit_cost_cents;
    end if;
    if v_unit_cost is null then v_missing := true; else v_total := v_total + v_unit_cost * v_qty; end if;
    v_costed := v_costed || jsonb_build_object('sku_id', v_sku_id, 'qty', v_qty, 'cost', v_unit_cost, 'sku_number', v_sku.sku_number, 'title', v_sku.title);
  end loop;

  v_expected := case when v_missing then null else v_total * 3 end;
  select coalesce(max(sequence),0)+1 into v_seq from public.live_auction_items where session_id = p_session_id and user_id = v_user;

  -- auction item + lines stay USER-owned (no org_id on these tables)
  insert into public.live_auction_items
    (user_id, session_id, sequence, status, is_bundle, expected_price_cents, client_idempotency_key, activated_at, closed_at)
  values (v_user, p_session_id, v_seq, p_result, v_is_bundle, v_expected, nullif(p_idem_key,''), now(), now())
  returning id into v_item;
  insert into public.live_auction_item_skus
    (user_id, auction_item_id, inventory_sku_id, qty, unit_cost_cents_snapshot, sku_number_snapshot, title_snapshot)
  select v_user, v_item, (l->>'sku_id')::uuid, (l->>'qty')::int, (l->>'cost')::int, (l->>'sku_number')::int, (l->>'title')
  from jsonb_array_elements(v_costed) l;

  item_id:=v_item; auction_number:=v_seq; status:=p_result; replayed:=false;
  expected_price_cents:=v_expected; total_cost_cents:=case when v_missing then null else v_total end;
  return next;
end;
$$;
grant execute on function public.lensed_log_auction(uuid, text, jsonb, text, boolean, boolean) to authenticated;
