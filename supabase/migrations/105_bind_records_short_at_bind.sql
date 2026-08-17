-- 105: set live_auction_item_skus.short_at_bind at BIND time, in both bind RPCs.
--
-- Pairs with 104 (the column). 104 is inert on its own; this is what populates it. Apply 104
-- FIRST — this file cannot apply against a table without the column.
--
-- WHAT CHANGES. Six lines per function, nothing else:
--   • declare      — `v_short boolean;` appended to the existing v_be/v_costed line
--   • site A       — the not_sold->sold transition loop: reset v_short per line, set it true
--                    when the FIFO lookup finds no layer holding the full qty, and persist it on
--                    the UPDATE of live_auction_item_skus THAT ALREADY RUNS
--   • site B       — the new-insert per-line loop: same reset/set, carried through the existing
--                    v_costed jsonb and persisted by the INSERT … SELECT THAT ALREADY RUNS
--
-- WHY IT CANNOT FAIL OR SLOW A BIND. No new statement executes. Both writes ride statements that
-- are already on the bind path — one UPDATE, one INSERT — so there is no new failure mode, no
-- extra round trip, no subtransaction/savepoint. A bind cannot fail because of this change. That
-- was the hard constraint: a missing flag is a missing band, a failed bind is a lost sale.
--
-- WHERE `short` COMES FROM. Not a new calculation. The function already asks "is there a FIFO
-- layer with qty_remaining >= this qty?", and the `if not found` branch is precisely "no stock
-- for this line". It is followed by the p_allow_negative guard, so `v_short := true` is placed
-- AFTER that guard and is reached only when the sale is permitted to go negative — the exact
-- case this feature is about: sold at zero, bound anyway. When p_allow_negative is false the
-- function still raises OUT_OF_STOCK before ever reaching the new line.
--
-- PER LINE. v_short resets at the top of each loop iteration, so a short line in a multi-SKU
-- bundle cannot leak its flag onto the next line. A 'not_sold' result skips the draw branch
-- entirely and records false (nothing was drawn), never null.
--
-- BOTH FUNCTIONS, ONE PATCH. lensed_log_auction is what the CAPTURE EXTENSION calls directly via
-- PostgREST (extension/background.js) — the majority of live binds never touch Next.js.
-- lensed_log_auction_as is the member/retroactive path (/api/member/bind, service role). They are
-- deliberately changed together and received the SAME mechanical patch: drift between them would
-- mean the band fires on some short orders and not others, which is worse to debug than one
-- larger diff.
--
-- HOW THIS FILE WAS BUILT (per CLAUDE.md: never hand-copy a create-or-replace). Both definitions
-- below are pg_get_functiondef() output pulled from LIVE — signature, RETURNS TABLE, LANGUAGE and
-- body wrapper included, not reconstructed from memory or from an older migration. The six edits
-- were applied programmatically, each anchor asserted to match EXACTLY ONCE, and the result
-- diffed against live: the only delta is the boolean. Every advisory lock, the FIFO selection,
-- the unique_violation subtransaction and replay path, and all four raise notice strings are
-- byte-identical.
--
-- GRANTS. CREATE OR REPLACE PRESERVES the existing ACL (ownership and permissions are not
-- changed), so nothing here alters who can execute what. The grant below is the explicit
-- restatement CONVENTIONS.md requires for a function called from a user session; it is a no-op
-- against live, where authenticated already holds EXECUTE. Live ACL at time of writing:
--   lensed_log_auction     PUBLIC=X, anon=X, authenticated=X, service_role=X
--   lensed_log_auction_as  service_role only (authenticated/anon have NO execute)
-- This file deliberately does NOT touch the anon/PUBLIC grant on lensed_log_auction. Revoking it
-- is a real question, but it belongs to sec/revoke-anon-write-rpcs, not to a bind-path change.
--
-- NOT APPLIED. Capture-path functions — write-silence gated. CREATE OR REPLACE takes a brief lock
-- and any in-flight bind will queue behind it.

CREATE OR REPLACE FUNCTION public.lensed_log_auction(p_session_id uuid, p_result text, p_skus jsonb, p_idem_key text, p_manual boolean DEFAULT false, p_allow_negative boolean DEFAULT false)
 RETURNS TABLE(item_id uuid, auction_number integer, status text, replayed boolean, expected_price_cents integer, total_cost_cents integer)
 LANGUAGE plpgsql
AS $function$
declare
  v_user uuid := auth.uid();
  v_org uuid := public.current_user_org();
  v_existing record; v_session record; v_line jsonb;
  v_sku_id uuid; v_qty int; v_sku record; v_batch record; v_unit_cost int;
  v_total int := 0; v_missing boolean := false; v_expected int; v_seq int; v_item uuid;
  v_is_bundle boolean := (jsonb_array_length(p_skus) > 1);
  v_be record; v_costed jsonb := '[]'::jsonb; v_short boolean;
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED' using errcode='28000'; end if;
  if v_org is null then raise exception 'NO_ORG' using errcode='P0001'; end if;
  if p_result not in ('sold','not_sold') then raise exception 'INVALID_RESULT' using errcode='22023'; end if;
  if p_skus is null or jsonb_array_length(p_skus)=0 then raise exception 'NO_SKUS' using errcode='22023'; end if;

  -- idempotency lock: serialize ops within this (private) session
  perform pg_advisory_xact_lock(hashtextextended(p_session_id::text, 0));

  -- ‚îÄ‚îÄ existing row (USER-owned; idempotent on the stable order key across ANY session) ‚îÄ‚îÄ
  -- EDIT 1: was `i.session_id = p_session_id and i.user_id = v_user and ...`. Dropping
  -- the session filter is the whole fix: a reload / 2nd instance / forked session that
  -- re-sends the same order_id now finds the canonical row instead of inserting a dup.
  if p_idem_key is not null and length(p_idem_key) > 0 then
    select i.id, i.sequence, i.status, i.expected_price_cents into v_existing
      from public.live_auction_items i
      where i.user_id = v_user and i.client_idempotency_key = p_idem_key
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
          v_short := false;
          select b.id, b.unit_cost_cents into v_batch from public.sku_batches b
            where b.sku_id = v_be.inventory_sku_id and b.org_id = v_org and b.qty_remaining >= v_be.qty
            order by b.sequence asc limit 1;
          if not found then
            v_short := true;
            if not p_allow_negative then
              raise exception 'OUT_OF_STOCK:%', coalesce((select sku_number from public.inventory_skus where id=v_be.inventory_sku_id and org_id=v_org),0) using errcode='P0001';
            end if;
            select b.id, b.unit_cost_cents into v_batch from public.sku_batches b
              where b.sku_id = v_be.inventory_sku_id and b.org_id = v_org order by b.sequence desc limit 1;
            if not found then raise exception 'NO_BATCH:%', coalesce((select sku_number from public.inventory_skus where id=v_be.inventory_sku_id and org_id=v_org),0) using errcode='P0001'; end if;
          end if;
          update public.sku_batches set qty_remaining = qty_remaining - v_be.qty where id = v_batch.id;
          update public.inventory_skus set qty_on_hand = qty_on_hand - v_be.qty where id = v_be.inventory_sku_id and org_id = v_org;
          update public.live_auction_item_skus set unit_cost_cents_snapshot = v_batch.unit_cost_cents, short_at_bind = v_short
            where auction_item_id = v_existing.id and inventory_sku_id = v_be.inventory_sku_id and user_id = v_user;
        end loop;
        select coalesce(sum(s.unit_cost_cents_snapshot*s.qty),0)::int, bool_or(s.unit_cost_cents_snapshot is null)
          into v_total, v_missing from public.live_auction_item_skus s where s.auction_item_id = v_existing.id and s.user_id = v_user;
        raise notice 'lensed_log_auction: TRANSITION not_sold->sold user=% order=% item=%', v_user, p_idem_key, v_existing.id;
        item_id:=v_existing.id; auction_number:=v_existing.sequence; status:='sold';
        replayed:=false; expected_price_cents:=v_existing.expected_price_cents;
        total_cost_cents:=case when v_missing then null else v_total end;
        return next; return;
      end if;
      raise notice 'lensed_log_auction: REPLAY (duplicate skipped) user=% order=% status=%', v_user, p_idem_key, v_existing.status;
      item_id:=v_existing.id; auction_number:=v_existing.sequence; status:=v_existing.status;
      replayed:=true; expected_price_cents:=v_existing.expected_price_cents; total_cost_cents:=null;
      return next; return;
    end if;
  end if;

  -- ‚îÄ‚îÄ new insert (USER-owned session) ‚îÄ‚îÄ
  -- EDIT 2: wrapped in a subtransaction. If a concurrent call for the SAME
  -- (user_id, order_id) in another session commits first, idx_live_auction_items_user_idem
  -- raises unique_violation here; the handler rolls back this block's FIFO draws and
  -- returns a clean replay of the canonical row ‚Äî never a duplicate row or second draw.
  begin
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
      v_short := false;
      if p_result = 'sold' then
        select b.id, b.unit_cost_cents into v_batch from public.sku_batches b
          where b.sku_id = v_sku_id and b.org_id = v_org and b.qty_remaining >= v_qty order by b.sequence asc limit 1;
        if not found then
          if not p_allow_negative then raise exception 'OUT_OF_STOCK:%', v_sku.sku_number using errcode='P0001'; end if;
          v_short := true;
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
      v_costed := v_costed || jsonb_build_object('sku_id', v_sku_id, 'qty', v_qty, 'cost', v_unit_cost, 'sku_number', v_sku.sku_number, 'title', v_sku.title, 'short', v_short);
    end loop;

    v_expected := case when v_missing then null else v_total * 3 end;
    select coalesce(max(sequence),0)+1 into v_seq from public.live_auction_items where session_id = p_session_id and user_id = v_user;

    -- auction item + lines stay USER-owned; store_id stamped explicitly from the
    -- session ‚Äî PRESERVED from migration 041 so this fix does not revert store scoping.
    insert into public.live_auction_items
      (user_id, store_id, session_id, sequence, status, is_bundle, expected_price_cents, client_idempotency_key, activated_at, closed_at)
    values (v_user, v_session.store_id, p_session_id, v_seq, p_result, v_is_bundle, v_expected, nullif(p_idem_key,''), now(), now())
    returning id into v_item;
    insert into public.live_auction_item_skus
      (user_id, store_id, auction_item_id, inventory_sku_id, qty, unit_cost_cents_snapshot, sku_number_snapshot, title_snapshot, short_at_bind)
    select v_user, v_session.store_id, v_item, (l->>'sku_id')::uuid, (l->>'qty')::int, (l->>'cost')::int, (l->>'sku_number')::int, (l->>'title'), (l->>'short')::boolean
    from jsonb_array_elements(v_costed) l;

    raise notice 'lensed_log_auction: NEW insert user=% order=% seq=%', v_user, p_idem_key, v_seq;
    item_id:=v_item; auction_number:=v_seq; status:=p_result; replayed:=false;
    expected_price_cents:=v_expected; total_cost_cents:=case when v_missing then null else v_total end;
    return next;
  exception
    when unique_violation then
      -- Lost a concurrent race for this (user_id, order_id): another session inserted
      -- the canonical row first. This block's FIFO draws rolled back with the subtxn.
      select i.id, i.sequence, i.status, i.expected_price_cents into v_existing
        from public.live_auction_items i
        where i.user_id = v_user and i.client_idempotency_key = p_idem_key
        limit 1;
      if not found then raise; end if;  -- not the order-dup case ‚Üí surface it
      raise notice 'lensed_log_auction: REPLAY (race, duplicate skipped) user=% order=%', v_user, p_idem_key;
      item_id:=v_existing.id; auction_number:=v_existing.sequence; status:=v_existing.status;
      replayed:=true; expected_price_cents:=v_existing.expected_price_cents; total_cost_cents:=null;
      return next;
  end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.lensed_log_auction_as(p_owner_user_id uuid, p_session_id uuid, p_result text, p_skus jsonb, p_idem_key text, p_manual boolean DEFAULT false, p_allow_negative boolean DEFAULT false)
 RETURNS TABLE(item_id uuid, auction_number integer, status text, replayed boolean, expected_price_cents integer, total_cost_cents integer)
 LANGUAGE plpgsql
AS $function$
declare
  v_user uuid := p_owner_user_id;   -- CHANGED from: auth.uid()
  v_org uuid := (                    -- CHANGED from: public.current_user_org()
    select m.org_id from public.organization_members m
    where m.user_id = p_owner_user_id order by m.created_at limit 1);
  v_existing record; v_session record; v_line jsonb;
  v_sku_id uuid; v_qty int; v_sku record; v_batch record; v_unit_cost int;
  v_total int := 0; v_missing boolean := false; v_expected int; v_seq int; v_item uuid;
  v_is_bundle boolean := (jsonb_array_length(p_skus) > 1);
  v_be record; v_costed jsonb := '[]'::jsonb; v_short boolean;
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED' using errcode='28000'; end if;
  if v_org is null then raise exception 'NO_ORG' using errcode='P0001'; end if;
  if p_result not in ('sold','not_sold') then raise exception 'INVALID_RESULT' using errcode='22023'; end if;
  if p_skus is null or jsonb_array_length(p_skus)=0 then raise exception 'NO_SKUS' using errcode='22023'; end if;

  -- idempotency lock: serialize ops within this (private) session
  perform pg_advisory_xact_lock(hashtextextended(p_session_id::text, 0));

  -- existing row (USER-owned; idempotent on the stable order key across ANY session)
  -- EDIT 1: was `i.session_id = p_session_id and i.user_id = v_user and ...`. Dropping
  -- the session filter is the whole fix: a reload / 2nd instance / forked session that
  -- re-sends the same order_id now finds the canonical row instead of inserting a dup.
  if p_idem_key is not null and length(p_idem_key) > 0 then
    select i.id, i.sequence, i.status, i.expected_price_cents into v_existing
      from public.live_auction_items i
      where i.user_id = v_user and i.client_idempotency_key = p_idem_key
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
          v_short := false;
          select b.id, b.unit_cost_cents into v_batch from public.sku_batches b
            where b.sku_id = v_be.inventory_sku_id and b.org_id = v_org and b.qty_remaining >= v_be.qty
            order by b.sequence asc limit 1;
          if not found then
            v_short := true;
            if not p_allow_negative then
              raise exception 'OUT_OF_STOCK:%', coalesce((select sku_number from public.inventory_skus where id=v_be.inventory_sku_id and org_id=v_org),0) using errcode='P0001';
            end if;
            select b.id, b.unit_cost_cents into v_batch from public.sku_batches b
              where b.sku_id = v_be.inventory_sku_id and b.org_id = v_org order by b.sequence desc limit 1;
            if not found then raise exception 'NO_BATCH:%', coalesce((select sku_number from public.inventory_skus where id=v_be.inventory_sku_id and org_id=v_org),0) using errcode='P0001'; end if;
          end if;
          update public.sku_batches set qty_remaining = qty_remaining - v_be.qty where id = v_batch.id;
          update public.inventory_skus set qty_on_hand = qty_on_hand - v_be.qty where id = v_be.inventory_sku_id and org_id = v_org;
          update public.live_auction_item_skus set unit_cost_cents_snapshot = v_batch.unit_cost_cents, short_at_bind = v_short
            where auction_item_id = v_existing.id and inventory_sku_id = v_be.inventory_sku_id and user_id = v_user;
        end loop;
        select coalesce(sum(s.unit_cost_cents_snapshot*s.qty),0)::int, bool_or(s.unit_cost_cents_snapshot is null)
          into v_total, v_missing from public.live_auction_item_skus s where s.auction_item_id = v_existing.id and s.user_id = v_user;
        raise notice 'lensed_log_auction: TRANSITION not_sold->sold user=% order=% item=%', v_user, p_idem_key, v_existing.id;
        item_id:=v_existing.id; auction_number:=v_existing.sequence; status:='sold';
        replayed:=false; expected_price_cents:=v_existing.expected_price_cents;
        total_cost_cents:=case when v_missing then null else v_total end;
        return next; return;
      end if;
      raise notice 'lensed_log_auction: REPLAY (duplicate skipped) user=% order=% status=%', v_user, p_idem_key, v_existing.status;
      item_id:=v_existing.id; auction_number:=v_existing.sequence; status:=v_existing.status;
      replayed:=true; expected_price_cents:=v_existing.expected_price_cents; total_cost_cents:=null;
      return next; return;
    end if;
  end if;

  -- new insert (USER-owned session)
  -- EDIT 2: wrapped in a subtransaction. If a concurrent call for the SAME
  -- (user_id, order_id) in another session commits first, idx_live_auction_items_user_idem
  -- raises unique_violation here; the handler rolls back this block's FIFO draws and
  -- returns a clean replay of the canonical row - never a duplicate row or second draw.
  begin
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
      v_short := false;
      if p_result = 'sold' then
        select b.id, b.unit_cost_cents into v_batch from public.sku_batches b
          where b.sku_id = v_sku_id and b.org_id = v_org and b.qty_remaining >= v_qty order by b.sequence asc limit 1;
        if not found then
          if not p_allow_negative then raise exception 'OUT_OF_STOCK:%', v_sku.sku_number using errcode='P0001'; end if;
          v_short := true;
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
      v_costed := v_costed || jsonb_build_object('sku_id', v_sku_id, 'qty', v_qty, 'cost', v_unit_cost, 'sku_number', v_sku.sku_number, 'title', v_sku.title, 'short', v_short);
    end loop;

    v_expected := case when v_missing then null else v_total * 3 end;
    select coalesce(max(sequence),0)+1 into v_seq from public.live_auction_items where session_id = p_session_id and user_id = v_user;

    -- auction item + lines stay USER-owned; store_id stamped explicitly from the
    -- session - PRESERVED from migration 041 so this fix does not revert store scoping.
    insert into public.live_auction_items
      (user_id, store_id, session_id, sequence, status, is_bundle, expected_price_cents, client_idempotency_key, activated_at, closed_at)
    values (v_user, v_session.store_id, p_session_id, v_seq, p_result, v_is_bundle, v_expected, nullif(p_idem_key,''), now(), now())
    returning id into v_item;
    insert into public.live_auction_item_skus
      (user_id, store_id, auction_item_id, inventory_sku_id, qty, unit_cost_cents_snapshot, sku_number_snapshot, title_snapshot, short_at_bind)
    select v_user, v_session.store_id, v_item, (l->>'sku_id')::uuid, (l->>'qty')::int, (l->>'cost')::int, (l->>'sku_number')::int, (l->>'title'), (l->>'short')::boolean
    from jsonb_array_elements(v_costed) l;

    raise notice 'lensed_log_auction: NEW insert user=% order=% seq=%', v_user, p_idem_key, v_seq;
    item_id:=v_item; auction_number:=v_seq; status:=p_result; replayed:=false;
    expected_price_cents:=v_expected; total_cost_cents:=case when v_missing then null else v_total end;
    return next;
  exception
    when unique_violation then
      -- Lost a concurrent race for this (user_id, order_id): another session inserted
      -- the canonical row first. This block's FIFO draws rolled back with the subtxn.
      select i.id, i.sequence, i.status, i.expected_price_cents into v_existing
        from public.live_auction_items i
        where i.user_id = v_user and i.client_idempotency_key = p_idem_key
        limit 1;
      if not found then raise; end if;  -- not the order-dup case -> surface it
      raise notice 'lensed_log_auction: REPLAY (race, duplicate skipped) user=% order=%', v_user, p_idem_key;
      item_id:=v_existing.id; auction_number:=v_existing.sequence; status:=v_existing.status;
      replayed:=true; expected_price_cents:=v_existing.expected_price_cents; total_cost_cents:=null;
      return next;
  end;
end;
$function$;

-- Explicit grant restatement (CONVENTIONS.md). No-op against live — CREATE OR REPLACE already
-- preserved it — but present so the rule holds for anyone reading this file in isolation.
grant execute on function public.lensed_log_auction(uuid, text, jsonb, text, boolean, boolean) to authenticated;

-- lensed_log_auction_as is called ONLY via createAdminClient() (service role bypasses grants), so
-- it stays locked down. Idempotent against live, where none of these roles hold EXECUTE.
revoke execute on function public.lensed_log_auction_as(uuid, uuid, text, jsonb, text, boolean, boolean) from public, anon, authenticated;
