-- Atomic, transactional RPCs for logging + deleting live-auction rows.
-- SECURITY INVOKER: each function runs as the calling user, so RLS + auth.uid()
-- gate every row. A user can only read/modify their own sessions, items, and
-- inventory. No service-role needed for normal app calls.

-- Log one auction (sold / not_sold) atomically.
create or replace function public.lensed_log_auction(
  p_session_id uuid,
  p_result text,
  p_skus jsonb,          -- collapsed: [{"sku_id":"<uuid>","qty":<int>}, ...] one entry per sku
  p_idem_key text
)
returns table (item_id uuid, auction_number int, status text, replayed boolean,
               expected_price_cents int, total_cost_cents int)
language plpgsql
security invoker
as $$
declare
  v_user uuid := auth.uid();
  v_existing record;
  v_session record;
  v_line jsonb;
  v_sku_id uuid;
  v_qty int;
  v_sku record;
  v_total int := 0;
  v_missing boolean := false;
  v_expected int;
  v_seq int;
  v_item uuid;
  v_is_bundle boolean := (jsonb_array_length(p_skus) > 1);
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED' using errcode = '28000'; end if;
  if p_result not in ('sold', 'not_sold') then
    raise exception 'INVALID_RESULT' using errcode = '22023';
  end if;
  if p_skus is null or jsonb_array_length(p_skus) = 0 then
    raise exception 'NO_SKUS' using errcode = '22023';
  end if;

  -- Fast idempotency replay (best-effort, before the lock).
  if p_idem_key is not null and length(p_idem_key) > 0 then
    select i.id, i.sequence, i.status into v_existing
      from public.live_auction_items i
      where i.session_id = p_session_id and i.user_id = v_user and i.client_idempotency_key = p_idem_key
      limit 1;
    if found then
      item_id := v_existing.id; auction_number := v_existing.sequence; status := v_existing.status;
      replayed := true; expected_price_cents := null; total_cost_cents := null;
      return next; return;
    end if;
  end if;

  -- Serialize concurrent saves for this session: race-free sequence + idempotency.
  perform pg_advisory_xact_lock(hashtextextended(p_session_id::text, 0));

  -- Replay AGAIN after acquiring the lock. If a concurrent same-key request won the
  -- race and committed first, this returns a clean replay instead of a unique violation.
  if p_idem_key is not null and length(p_idem_key) > 0 then
    select i.id, i.sequence, i.status into v_existing
      from public.live_auction_items i
      where i.session_id = p_session_id and i.user_id = v_user and i.client_idempotency_key = p_idem_key
      limit 1;
    if found then
      item_id := v_existing.id; auction_number := v_existing.sequence; status := v_existing.status;
      replayed := true; expected_price_cents := null; total_cost_cents := null;
      return next; return;
    end if;
  end if;

  -- Session must exist, be owned, and be open.
  select s.id, s.status into v_session
    from public.live_sessions s where s.id = p_session_id and s.user_id = v_user;
  if not found then raise exception 'SESSION_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_session.status in ('ended', 'reconciled') then
    raise exception 'SESSION_ENDED' using errcode = 'P0001';
  end if;

  -- Validate SKUs; for sold, atomically guard-and-decrement. Any shortfall raises and
  -- rolls back the whole transaction, so no row is created and no stock is changed.
  for v_line in select * from jsonb_array_elements(p_skus) loop
    v_sku_id := (v_line->>'sku_id')::uuid;
    v_qty := greatest(1, coalesce((v_line->>'qty')::int, 1));
    select id, sku_number, unit_cost_cents into v_sku
      from public.inventory_skus where id = v_sku_id and user_id = v_user;
    if not found then raise exception 'SKU_NOT_FOUND' using errcode = '22023'; end if;
    if v_sku.unit_cost_cents is null then v_missing := true;
    else v_total := v_total + v_sku.unit_cost_cents * v_qty; end if;
    if p_result = 'sold' then
      update public.inventory_skus set qty_on_hand = qty_on_hand - v_qty
        where id = v_sku_id and user_id = v_user and qty_on_hand >= v_qty;
      if not found then
        raise exception 'OUT_OF_STOCK:%', v_sku.sku_number using errcode = 'P0001';
      end if;
    end if;
  end loop;

  v_expected := case when v_missing then null else v_total * 3 end;

  -- Allocate sequence (advisory lock makes max+1 race-free) and insert the item.
  select coalesce(max(sequence), 0) + 1 into v_seq
    from public.live_auction_items where session_id = p_session_id and user_id = v_user;

  insert into public.live_auction_items
    (user_id, session_id, sequence, status, is_bundle, expected_price_cents,
     client_idempotency_key, activated_at, closed_at)
  values (v_user, p_session_id, v_seq, p_result, v_is_bundle, v_expected,
     nullif(p_idem_key, ''), now(), now())
  returning id into v_item;

  insert into public.live_auction_item_skus
    (user_id, auction_item_id, inventory_sku_id, qty, unit_cost_cents_snapshot,
     sku_number_snapshot, title_snapshot)
  select v_user, v_item, (l->>'sku_id')::uuid, greatest(1, coalesce((l->>'qty')::int, 1)),
         s.unit_cost_cents, s.sku_number, s.title
  from jsonb_array_elements(p_skus) l
  join public.inventory_skus s on s.id = (l->>'sku_id')::uuid and s.user_id = v_user;

  item_id := v_item; auction_number := v_seq; status := p_result; replayed := false;
  expected_price_cents := v_expected; total_cost_cents := case when v_missing then null else v_total end;
  return next;
end;
$$;

-- Delete an auction row, restoring inventory for sold rows, atomically.
create or replace function public.lensed_delete_auction_item(p_session_id uuid, p_item_id uuid)
returns boolean
language plpgsql
security invoker
as $$
declare
  v_user uuid := auth.uid();
  v_session record;
  v_item record;
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED' using errcode = '28000'; end if;

  select id, status into v_session from public.live_sessions where id = p_session_id and user_id = v_user;
  if not found then raise exception 'SESSION_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_session.status in ('ended', 'reconciled') then
    raise exception 'SESSION_ENDED' using errcode = 'P0001';
  end if;

  select id, status into v_item from public.live_auction_items
    where id = p_item_id and session_id = p_session_id and user_id = v_user;
  if not found then raise exception 'ITEM_NOT_FOUND' using errcode = 'P0002'; end if;

  if v_item.status = 'sold' then
    update public.inventory_skus s set qty_on_hand = s.qty_on_hand + x.qty
      from (select inventory_sku_id, sum(qty) as qty from public.live_auction_item_skus
            where auction_item_id = p_item_id and user_id = v_user group by inventory_sku_id) x
      where s.id = x.inventory_sku_id and s.user_id = v_user;
  end if;

  delete from public.live_auction_items where id = p_item_id and user_id = v_user; -- cascades item_skus
  return v_item.status = 'sold';
end;
$$;

grant execute on function public.lensed_log_auction(uuid, text, jsonb, text) to authenticated;
grant execute on function public.lensed_delete_auction_item(uuid, uuid) to authenticated;
