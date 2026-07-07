-- Rollback for 043_live_order_idempotency.sql — CODE/SCHEMA only.
--
-- Restores the pre-043 idempotency guard (per-session) and the 041 function body
-- VERBATIM (store_id stamping preserved — 041 is the real pre-043 prod definition).
-- This does NOT touch the repaired data: the dedup repair deleted duplicate
-- rows and restored inventory, which is forward-only. Every change it made is recorded
-- in public.live_auction_dedup_repairs and can be reconstructed from there if needed.
--
-- Apply as a single transaction: psql -1 -v ON_ERROR_STOP=1 -f 043_rollback.sql
-- NOT placed under supabase/migrations/ so the migration runner never applies it.

-- 1. Swap the index back to per-session.
drop index if exists public.idx_live_auction_items_user_idem;
create unique index if not exists idx_live_auction_items_idem
  on public.live_auction_items (session_id, client_idempotency_key)
  where client_idempotency_key is not null;

-- 2. Restore the 041 function body verbatim (per-session lookup + store_id stamping).
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

  perform pg_advisory_xact_lock(hashtextextended(p_session_id::text, 0));

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

  select s.id, s.status, s.store_id into v_session from public.live_sessions s where s.id = p_session_id and s.user_id = v_user;
  if not found then raise exception 'SESSION_NOT_FOUND' using errcode='P0002'; end if;
  if v_session.status in ('ended','reconciled') and not p_manual then raise exception 'SESSION_ENDED' using errcode='P0001'; end if;

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
$$;
grant execute on function public.lensed_log_auction(uuid, text, jsonb, text, boolean, boolean) to authenticated;
