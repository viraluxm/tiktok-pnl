-- 064_lensed_unbind.sql
-- The correction path for a retroactive bind. Reverses a bind for (user_id, order_id): restocks
-- the qty and deletes the live_auction_items / live_auction_item_skus rows.
--
-- Why a FRESH layer: live_auction_item_skus stores unit_cost_cents_snapshot but NOT the
-- sku_batches.id it drew from, so the literal original FIFO layer cannot be restored. We restock
-- the qty as a NEW batch at the snapshot cost — correct for both unit count (qty_on_hand back) and
-- total cost value (a layer at the exact cost consumed); only the FIFO sequence POSITION differs
-- (the restocked layer sits at the tail, consumed last). qty_on_hand and total inventory cost net
-- to zero across the bind+unbind pair.
--
-- Idempotent (a second unbind finds no item and no-ops → never double-restocks). Advisory-locked
-- exactly like lensed_log_auction. SECURITY INVOKER (auth.uid() + current_user_org), same as bind.
-- Does NOT modify lensed_log_auction.

create or replace function public.lensed_unbind(p_order_id text)
returns table(unbound boolean, item_id uuid, restocked_lines integer, restocked_units integer)
language plpgsql
as $function$
declare
  v_user uuid := auth.uid();
  v_org  uuid := public.current_user_org();
  v_item record; v_line record; v_seq int; v_n int := 0; v_u int := 0;
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED' using errcode='28000'; end if;
  if v_org  is null then raise exception 'NO_ORG' using errcode='P0001'; end if;
  if p_order_id is null or length(p_order_id) = 0 then raise exception 'NO_ORDER' using errcode='22023'; end if;

  -- serialize ops on this order key (idempotency + concurrency)
  perform pg_advisory_xact_lock(hashtextextended('unbind:'||p_order_id, 0));

  select i.id into v_item
    from public.live_auction_items i
    where i.user_id = v_user and i.client_idempotency_key = p_order_id
    limit 1;
  if not found then
    -- already unbound / never bound → idempotent no-op, no restock
    unbound := false; item_id := null; restocked_lines := 0; restocked_units := 0; return next; return;
  end if;

  -- lock this item's SKUs (sorted) before touching shared stock — same discipline as the bind
  perform pg_advisory_xact_lock(hashtextextended('sku:'||sid::text, 0))
    from (select distinct inventory_sku_id sid from public.live_auction_item_skus
          where auction_item_id = v_item.id and user_id = v_user order by 1) z;

  for v_line in
    select inventory_sku_id, sum(qty)::int as qty, max(unit_cost_cents_snapshot) as cost
      from public.live_auction_item_skus
      where auction_item_id = v_item.id and user_id = v_user
      group by inventory_sku_id
  loop
    -- restore the on-hand count (always, even if the original cost is unknown)
    update public.inventory_skus set qty_on_hand = qty_on_hand + v_line.qty
      where id = v_line.inventory_sku_id and org_id = v_org;
    -- add a fresh FIFO layer at the snapshot cost (tail of the sequence) when the cost is known
    if v_line.cost is not null then
      select coalesce(max(sequence), 0) + 1 into v_seq
        from public.sku_batches where sku_id = v_line.inventory_sku_id and org_id = v_org;
      insert into public.sku_batches
        (user_id, org_id, sku_id, qty_remaining, qty_added, unit_cost_cents, sequence, source, external_ref)
      values
        (v_user, v_org, v_line.inventory_sku_id, v_line.qty, v_line.qty, v_line.cost, v_seq, 'unbind_restock', p_order_id);
    end if;
    v_n := v_n + 1; v_u := v_u + v_line.qty;
  end loop;

  delete from public.live_auction_item_skus where auction_item_id = v_item.id and user_id = v_user;
  delete from public.live_auction_items     where id = v_item.id and user_id = v_user;

  raise notice 'lensed_unbind: user=% order=% item=% lines=% units=%', v_user, p_order_id, v_item.id, v_n, v_u;
  unbound := true; item_id := v_item.id; restocked_lines := v_n; restocked_units := v_u; return next;
end;
$function$;

grant execute on function public.lensed_unbind(text) to authenticated;
