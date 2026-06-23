-- 027: lensed_log_auction — handle the failed→paid (not_sold→sold) transition.
--
-- auction_result/get is a CUMULATIVE snapshot: every poll re-sends each order's
-- CURRENT status. A buyer has ~5 min to fix a failed payment, so an order often
-- appears first as not_sold (is_payment_successful=false) and later as sold.
-- The previous RPC (025) deduped on (session, client_idempotency_key) and
-- no-op'd on ANY repeat, leaving failed→paid orders stuck as not_sold — never
-- decremented, never counted.
--
-- This version makes the conflict path STATUS-AWARE. The per-session advisory
-- xact lock serializes all calls for a session, and the not_sold→sold flip is an
-- atomic guarded UPDATE (... WHERE status = 'not_sold'). Together they guarantee
-- the CRITICAL INVARIANT: qty_on_hand decrements EXACTLY ONCE per order — only on
-- the transition into sold, never on a repeated 'sold' snapshot.
--
-- Conflict matrix (existing row vs incoming p_result):
--   (none)               → INSERT; if sold, decrement (OUT_OF_STOCK guard).   [unchanged]
--   not_sold + sold      → flip to sold + decrement NOW (OUT_OF_STOCK guard).  [NEW]
--   sold     + sold      → NO-OP. Never decrement again.
--   sold     + not_sold  → NO-OP. Never un-sell a real sale / re-increment.
--   not_sold + not_sold  → NO-OP.
--
-- Abe-approved change to lensed_log_auction. Signature, return shape, and the
-- successful-sale-first (new-insert) path are unchanged.

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
  v_be record;
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED' using errcode = '28000'; end if;
  if p_result not in ('sold', 'not_sold') then
    raise exception 'INVALID_RESULT' using errcode = '22023';
  end if;
  if p_skus is null or jsonb_array_length(p_skus) = 0 then
    raise exception 'NO_SKUS' using errcode = '22023';
  end if;

  -- Serialize every call for this session: race-free sequence allocation,
  -- idempotency, AND the not_sold→sold transition + decrement.
  perform pg_advisory_xact_lock(hashtextextended(p_session_id::text, 0));

  -- ── Conflict path: a row already exists for this (session, idem key) ──────
  if p_idem_key is not null and length(p_idem_key) > 0 then
    select i.id, i.sequence, i.status, i.expected_price_cents
      into v_existing
      from public.live_auction_items i
      where i.session_id = p_session_id
        and i.user_id = v_user
        and i.client_idempotency_key = p_idem_key
      limit 1;

    if found then
      -- Transition not_sold → sold (a previously failed payment that is now paid).
      if v_existing.status = 'not_sold' and p_result = 'sold' then
        -- Atomic flip. The "WHERE status = 'not_sold'" guard means only the
        -- FIRST caller can move the row out of not_sold; any racing caller sees
        -- 0 rows updated and therefore never reaches the decrement below. This
        -- is what makes decrement-exactly-once hold even without the lock.
        -- Alias + qualified WHERE: the function has an OUT column named `status`,
        -- so a bare `status` reference here would be ambiguous (42702).
        update public.live_auction_items as t
          set status = 'sold', closed_at = now()
          where t.id = v_existing.id and t.user_id = v_user and t.status = 'not_sold';

        if not found then
          -- Lost the flip race (already flipped to sold). Never decrement twice.
          item_id := v_existing.id; auction_number := v_existing.sequence; status := 'sold';
          replayed := true; expected_price_cents := v_existing.expected_price_cents;
          total_cost_cents := null;
          return next; return;
        end if;

        -- We won the flip → decrement inventory NOW, exactly once, from the
        -- ORIGINALLY-bound lines recorded when the not_sold row was created
        -- (not from p_skus, which a later snapshot's call may not carry).
        for v_be in
          select s.inventory_sku_id, sum(s.qty)::int as qty
            from public.live_auction_item_skus s
            where s.auction_item_id = v_existing.id and s.user_id = v_user
            group by s.inventory_sku_id
        loop
          update public.inventory_skus
            set qty_on_hand = qty_on_hand - v_be.qty
            where id = v_be.inventory_sku_id and user_id = v_user and qty_on_hand >= v_be.qty;
          if not found then
            -- Insufficient stock at settle time: abort the whole transaction,
            -- which ROLLS BACK the flip too — the row stays not_sold and no
            -- partial decrement persists (invariant preserved).
            raise exception 'OUT_OF_STOCK:%',
              coalesce((select sku_number from public.inventory_skus
                          where id = v_be.inventory_sku_id and user_id = v_user), 0)
              using errcode = 'P0001';
          end if;
        end loop;

        -- Recompute total cost from the frozen snapshots for the return value.
        select coalesce(sum(s.unit_cost_cents_snapshot * s.qty), 0)::int,
               bool_or(s.unit_cost_cents_snapshot is null)
          into v_total, v_missing
          from public.live_auction_item_skus s
          where s.auction_item_id = v_existing.id and s.user_id = v_user;

        item_id := v_existing.id; auction_number := v_existing.sequence; status := 'sold';
        replayed := false; expected_price_cents := v_existing.expected_price_cents;
        total_cost_cents := case when v_missing then null else v_total end;
        return next; return;
      end if;

      -- Every other repeat is a NO-OP: sold→sold (must NOT decrement again),
      -- sold→not_sold (must NOT un-sell / re-increment), not_sold→not_sold.
      item_id := v_existing.id; auction_number := v_existing.sequence; status := v_existing.status;
      replayed := true; expected_price_cents := v_existing.expected_price_cents;
      total_cost_cents := null;
      return next; return;
    end if;
  end if;

  -- ── New order (no existing row): original insert behavior, unchanged ──────
  -- Session must exist, be owned, and be open.
  select s.id, s.status into v_session
    from public.live_sessions s where s.id = p_session_id and s.user_id = v_user;
  if not found then raise exception 'SESSION_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_session.status in ('ended', 'reconciled') then
    raise exception 'SESSION_ENDED' using errcode = 'P0001';
  end if;

  -- Validate SKUs; for sold, atomically guard-and-decrement. Any shortfall raises
  -- and rolls back the whole transaction, so no row is created and no stock moves.
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

grant execute on function public.lensed_log_auction(uuid, text, jsonb, text) to authenticated;
