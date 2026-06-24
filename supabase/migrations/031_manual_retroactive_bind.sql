-- 031: allow DELIBERATE manual retroactive binds into ENDED sessions.
--
-- Retroactive binding ("needs a SKU" banner) is inherently post-show: the host
-- ends the live, then assigns SKUs to unbound orders. So lensed_log_auction's
-- new-insert path must be permitted on an ended/reconciled session WHEN, and
-- ONLY when, explicitly invoked with p_manual := true.
--
-- Live capture (the extension's auto-bind) calls the function WITHOUT p_manual
-- (defaults false) → it stays BLOCKED on ended sessions, exactly as before.
--
-- Nothing else changes from migration 027: exactly-once decrement, OUT_OF_STOCK
-- guard, idempotency on (session, client_idempotency_key), and the not_sold→sold
-- transition are all identical. The ONLY behavioral delta is the session-ended
-- guard now reads `and not p_manual`.

-- Drop the 4-arg version and recreate with a 5th defaulted param. Existing 4-arg
-- callers (quick-close route, extension background) resolve to this function with
-- p_manual defaulting to false — unchanged behavior.
drop function if exists public.lensed_log_auction(uuid, text, jsonb, text);

create or replace function public.lensed_log_auction(
  p_session_id uuid,
  p_result text,
  p_skus jsonb,          -- collapsed: [{"sku_id":"<uuid>","qty":<int>}, ...] one entry per sku
  p_idem_key text,
  p_manual boolean default false   -- true ONLY for deliberate manual retroactive binds
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
        update public.live_auction_items as t
          set status = 'sold', closed_at = now()
          where t.id = v_existing.id and t.user_id = v_user and t.status = 'not_sold';

        if not found then
          item_id := v_existing.id; auction_number := v_existing.sequence; status := 'sold';
          replayed := true; expected_price_cents := v_existing.expected_price_cents;
          total_cost_cents := null;
          return next; return;
        end if;

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
            raise exception 'OUT_OF_STOCK:%',
              coalesce((select sku_number from public.inventory_skus
                          where id = v_be.inventory_sku_id and user_id = v_user), 0)
              using errcode = 'P0001';
          end if;
        end loop;

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

      -- Every other repeat is a NO-OP (the double-bind guard for manual binds too):
      -- sold→sold, sold→not_sold, not_sold→not_sold.
      item_id := v_existing.id; auction_number := v_existing.sequence; status := v_existing.status;
      replayed := true; expected_price_cents := v_existing.expected_price_cents;
      total_cost_cents := null;
      return next; return;
    end if;
  end if;

  -- ── New order (no existing row): insert path ──────────────────────────────
  -- Session must exist and be owned. Open-session requirement is enforced for
  -- LIVE capture (p_manual = false); deliberate manual retroactive binds
  -- (p_manual = true) are allowed regardless of session status.
  select s.id, s.status into v_session
    from public.live_sessions s where s.id = p_session_id and s.user_id = v_user;
  if not found then raise exception 'SESSION_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_session.status in ('ended', 'reconciled') and not p_manual then
    raise exception 'SESSION_ENDED' using errcode = 'P0001';
  end if;

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

grant execute on function public.lensed_log_auction(uuid, text, jsonb, text, boolean) to authenticated;
