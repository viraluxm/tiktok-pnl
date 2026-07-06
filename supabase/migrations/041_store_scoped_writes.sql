-- 041_store_scoped_writes.sql
-- Phase B of the store-scoping fix. Replaces the dangerous limit-1
-- set_store_id_from_user() guess with explicit/derived store_id — but ONLY on
-- the paths that are safe to guard today (see the Stage-2 trace).
--
-- ⚠️ PRECONDITION (production): the fail-loud guard on synced_order_ids RAISES on
-- any insert with a null store_id. The `team@viralux` connection
-- (df7d28b7-a86f-4205-933c-065b222b19a7) has store_id = NULL, so its next sync
-- would error. DELETE team@viralux (or its tiktok_connection) BEFORE this guard
-- goes live. Do not apply to prod until that's done.
--
-- Trigger layout AFTER this migration (all 9 store-tagged tables keep a trigger):
--   FAIL-LOUD guard (enforce_store_id):   synced_order_ids, shop_videos,
--                                         order_payouts, shipment_verifications
--   OLD backstop (set_store_id_from_user): live_sessions, live_auction_items,
--                                         live_auction_item_skus, entries
--   DERIVATION (derive_store_id):          capture_events
--   live_auction_items ALSO gets an AFTER trigger (backfill_capture_store_id).
--
-- set_store_id_from_user() itself is NOT dropped — the 4 deferred tables still use it.

begin;

-- ── 1. Fail-loud guard: require an explicit store_id on INSERT; never re-null on UPDATE ──
create or replace function public.enforce_store_id()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'INSERT' then
    if NEW.store_id is null then
      raise exception 'store_id is required on %.% — set it explicitly (no user-derived guessing)',
        TG_TABLE_SCHEMA, TG_TABLE_NAME using errcode = '23502';
    end if;
  elsif TG_OP = 'UPDATE' then
    -- Preserve the original store; an update must never blank or re-derive it.
    if NEW.store_id is null then
      NEW.store_id := OLD.store_id;
    end if;
  end if;
  return NEW;
end $$;

-- Swap the trigger on the 4 GUARDED tables: drop the limit-1 backstop, install the guard.
drop trigger if exists set_store_id on public.synced_order_ids;
create trigger enforce_store_id before insert or update on public.synced_order_ids
  for each row execute function public.enforce_store_id();

drop trigger if exists set_store_id on public.shop_videos;
create trigger enforce_store_id before insert or update on public.shop_videos
  for each row execute function public.enforce_store_id();

drop trigger if exists set_store_id on public.order_payouts;
create trigger enforce_store_id before insert or update on public.order_payouts
  for each row execute function public.enforce_store_id();

drop trigger if exists set_store_id on public.shipment_verifications;
create trigger enforce_store_id before insert or update on public.shipment_verifications
  for each row execute function public.enforce_store_id();

-- ── 2. capture_events: option-(a) derivation from the linked auction (NOT the guard) ──
-- capture_events has no session_id; it links to an auction via
-- order_id = live_auction_items.client_idempotency_key. Derive store from that
-- auction. No match yet → leave NULL (honest; the backfill below fills it once the
-- auction arrives). Never falls back to the limit-1 guess.
create or replace function public.derive_capture_store_id()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if NEW.store_id is null then
    NEW.store_id := (
      select lai.store_id
      from public.live_auction_items lai
      where lai.user_id = NEW.user_id
        and lai.client_idempotency_key = NEW.order_id
        and lai.store_id is not null
      limit 1
    );
  end if;
  return NEW;
end $$;

drop trigger if exists set_store_id on public.capture_events;
create trigger derive_store_id before insert or update on public.capture_events
  for each row execute function public.derive_capture_store_id();

-- Backfill: when an auction row gains a store_id, stamp any already-captured
-- events for the same order that are still NULL (handles capture-before-auction).
create or replace function public.backfill_capture_store_id()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if NEW.store_id is not null and NEW.client_idempotency_key is not null then
    update public.capture_events ce
      set store_id = NEW.store_id
      where ce.user_id = NEW.user_id
        and ce.order_id = NEW.client_idempotency_key
        and ce.store_id is null;
  end if;
  return NEW;
end $$;

-- AFTER trigger on live_auction_items; its BEFORE set_store_id backstop stays in place.
drop trigger if exists backfill_capture_store_id on public.live_auction_items;
create trigger backfill_capture_store_id after insert or update on public.live_auction_items
  for each row execute function public.backfill_capture_store_id();

-- ── 3. lensed_log_auction: stamp store_id explicitly from the session ──────────
-- Only the "new insert" branch inserts rows; it now reads live_sessions.store_id
-- and stamps both child inserts. Forward-compatible: correct the moment the
-- session's store_id is correct. When the session's store is still null (pre-Abe
-- backstop edge), the child rows' set_store_id backstop fills it (those tables are
-- deferred, not guarded). Body is otherwise verbatim from the live definition.
create or replace function public.lensed_log_auction(p_session_id uuid, p_result text, p_skus jsonb, p_idem_key text, p_manual boolean DEFAULT false, p_allow_negative boolean DEFAULT false)
 returns table(item_id uuid, auction_number integer, status text, replayed boolean, expected_price_cents integer, total_cost_cents integer)
 language plpgsql
as $function$
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
  -- store_id added to the select so the child inserts can stamp it explicitly.
  select s.id, s.status, s.store_id into v_session from public.live_sessions s where s.id = p_session_id and s.user_id = v_user;
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

  -- auction item + lines stay USER-owned; store_id stamped explicitly from the session
  insert into public.live_auction_items
    (user_id, store_id, session_id, sequence, status, is_bundle, expected_price_cents, client_idempotency_key, activated_at, closed_at)
  values (v_user, v_session.store_id, p_session_id, v_seq, p_result, v_is_bundle, v_expected, nullif(p_idem_key,''), now(), now())
  returning id into v_item;
  insert into public.live_auction_item_skus
    (user_id, store_id, auction_item_id, inventory_sku_id, qty, unit_cost_cents_snapshot, sku_number_snapshot, title_snapshot)
  select v_user, v_session.store_id, v_item, (l->>'sku_id')::uuid, (l->>'qty')::int, (l->>'cost')::int, (l->>'sku_number')::int, (l->>'title')
  from jsonb_array_elements(v_costed) l;

  item_id:=v_item; auction_number:=v_seq; status:=p_result; replayed:=false;
  expected_price_cents:=v_expected; total_cost_cents:=case when v_missing then null else v_total end;
  return next;
end;
$function$;

commit;
