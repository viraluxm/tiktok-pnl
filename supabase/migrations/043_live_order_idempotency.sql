-- 043: Idempotent live-order capture — dedup on the STABLE order key per account.
--
-- BUG: lensed_log_auction (current prod def = 041, which added store_id stamping) keys idempotency on
-- (session_id, user_id, client_idempotency_key). client_idempotency_key is the
-- TikTok order_id. But the extension's getOrCreateSession() mints a NEW session on
-- reload / service-worker eviction / a second open instance, so the SAME order_id
-- misses the session-scoped lookup, inserts a fresh row, RE-ALLOCATES sequence from
-- 1, and decrements inventory AGAIN → the duplicate "#1 order" rows + double
-- inventory draw seen after a live.
--
-- FIX (minimal, behavior-preserving): make idempotency key on the stable order key
-- per account — (user_id, client_idempotency_key) — at the DB level:
--   • a UNIQUE index enforces one tracked auction row per (user_id, order_id);
--   • lensed_log_auction is the 041 body VERBATIM (store_id stamping from the session
--     PRESERVED) with exactly two edits:
--       (1) widen the existing-row lookup from (session,user,key) to (user,key);
--       (2) wrap the new-insert path in a unique_violation handler that returns a
--           clean replay of the canonical row (covers a concurrent cross-session race).
-- Everything else — FIFO batch draw, org scoping, store_id stamping (041),
-- p_manual/p_allow_negative, the not_sold→sold flip, sequence allocation, return
-- shape, advisory locks — is unchanged. capture_events is untouched.
--
-- Before the unique index can exist, pre-existing duplicates from the bad live are
-- repaired CONSERVATIVELY (keep earliest, restore inventory only when the batch is
-- unambiguous, audit every removed row). Any ambiguity aborts the whole migration
-- (DEDUP_NEEDS_MANUAL_REVIEW) rather than guess. Apply as a SINGLE TRANSACTION
-- (psql -1 / the Supabase per-file transaction) so a failure rolls back everything.

create extension if not exists "uuid-ossp";

-- ── 1. Audit table for the one-time dedup repair (durable record of every change) ──
create table if not exists public.live_auction_dedup_repairs (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null,
  order_id text not null,
  canonical_item_id uuid not null,
  removed_item_id uuid not null,
  removed_session_id uuid,
  removed_sequence int,
  removed_status text,
  removed_expected_price_cents int,
  canonical_expected_price_cents int,
  price_conflict boolean not null default false,
  sku_conflict boolean not null default false,
  removed_skus jsonb,
  inventory_restored jsonb,
  repaired_at timestamptz not null default now()
);

-- ── 2. Conservative repair of pre-existing duplicates ────────────────────────
-- For each (user_id, client_idempotency_key) group with >1 row: keep the earliest
-- (created_at, sequence, id) as canonical; for every other (removed) row, log it,
-- restore the inventory it decremented IFF the batch is unambiguous, then delete it.
do $$
declare
  v_grp record; v_canon record; v_dup record; v_be record;
  v_batch_id uuid; v_batch_count int; v_match_count int;
  v_restored jsonb; v_canon_skus jsonb; v_dup_skus jsonb;
  v_price_conflict boolean; v_sku_conflict boolean;
  v_groups int := 0; v_rows int := 0;
begin
  for v_grp in
    select user_id, client_idempotency_key as order_id
    from public.live_auction_items
    where client_idempotency_key is not null
    group by user_id, client_idempotency_key
    having count(*) > 1
  loop
    v_groups := v_groups + 1;

    select * into v_canon
      from public.live_auction_items
      where user_id = v_grp.user_id and client_idempotency_key = v_grp.order_id
      order by created_at asc, sequence asc, id asc
      limit 1;

    select coalesce(jsonb_agg(jsonb_build_object('sku_id', inventory_sku_id, 'qty', qty)
                              order by inventory_sku_id), '[]'::jsonb)
      into v_canon_skus
      from public.live_auction_item_skus where auction_item_id = v_canon.id;

    for v_dup in
      select * from public.live_auction_items
      where user_id = v_grp.user_id and client_idempotency_key = v_grp.order_id and id <> v_canon.id
      order by created_at asc, sequence asc, id asc
    loop
      v_rows := v_rows + 1;
      v_restored := '[]'::jsonb;

      select coalesce(jsonb_agg(jsonb_build_object('sku_id', inventory_sku_id, 'qty', qty)
                                order by inventory_sku_id), '[]'::jsonb)
        into v_dup_skus
        from public.live_auction_item_skus where auction_item_id = v_dup.id;

      v_sku_conflict   := (v_dup_skus is distinct from v_canon_skus);
      v_price_conflict := (v_dup.expected_price_cents is distinct from v_canon.expected_price_cents);

      -- Restore inventory ONLY for a removed SOLD row (only those decremented stock).
      if v_dup.status = 'sold' then
        for v_be in
          select s.inventory_sku_id,
                 sum(s.qty)::int as qty,
                 (array_agg(s.unit_cost_cents_snapshot))[1] as snap_cost
          from public.live_auction_item_skus s
          where s.auction_item_id = v_dup.id
          group by s.inventory_sku_id
        loop
          select count(*) into v_batch_count
            from public.sku_batches b where b.sku_id = v_be.inventory_sku_id;

          if v_batch_count = 0 then
            raise notice 'DEDUP ambiguity: sku % has no batch to restore (removed item %, order %)',
              v_be.inventory_sku_id, v_dup.id, v_grp.order_id;
            raise exception 'DEDUP_NEEDS_MANUAL_REVIEW' using errcode = 'P0001';
          elsif v_batch_count = 1 then
            select b.id into v_batch_id
              from public.sku_batches b where b.sku_id = v_be.inventory_sku_id limit 1;
          else
            -- >1 batch: unambiguous only if EXACTLY ONE batch matches the drawn cost.
            select count(*) into v_match_count
              from public.sku_batches b
              where b.sku_id = v_be.inventory_sku_id
                and b.unit_cost_cents is not distinct from v_be.snap_cost;
            if v_match_count = 1 then
              select b.id into v_batch_id
                from public.sku_batches b
                where b.sku_id = v_be.inventory_sku_id
                  and b.unit_cost_cents is not distinct from v_be.snap_cost
                limit 1;
            else
              raise notice 'DEDUP ambiguity: sku % has % batches, % match drawn cost % (removed item %, order %) — cannot restore safely',
                v_be.inventory_sku_id, v_batch_count, v_match_count, v_be.snap_cost, v_dup.id, v_grp.order_id;
              raise exception 'DEDUP_NEEDS_MANUAL_REVIEW' using errcode = 'P0001';
            end if;
          end if;

          -- Restore batch qty + qty_on_hand in lockstep (034 invariant).
          update public.sku_batches   set qty_remaining = qty_remaining + v_be.qty where id = v_batch_id;
          update public.inventory_skus set qty_on_hand   = qty_on_hand   + v_be.qty where id = v_be.inventory_sku_id;
          v_restored := v_restored || jsonb_build_object(
            'sku_id', v_be.inventory_sku_id, 'qty', v_be.qty, 'batch_id', v_batch_id);
        end loop;
      end if;

      insert into public.live_auction_dedup_repairs
        (user_id, order_id, canonical_item_id, removed_item_id, removed_session_id,
         removed_sequence, removed_status, removed_expected_price_cents,
         canonical_expected_price_cents, price_conflict, sku_conflict, removed_skus, inventory_restored)
      values
        (v_grp.user_id, v_grp.order_id, v_canon.id, v_dup.id, v_dup.session_id,
         v_dup.sequence, v_dup.status, v_dup.expected_price_cents,
         v_canon.expected_price_cents, v_price_conflict, v_sku_conflict, v_dup_skus, v_restored);

      -- Delete the duplicate (cascades its live_auction_item_skus).
      delete from public.live_auction_items where id = v_dup.id;
    end loop;
  end loop;

  raise notice 'lensed dedup repair: % duplicate group(s), % duplicate row(s) collapsed', v_groups, v_rows;
end $$;

-- ── 3. Swap the idempotency guard: per-session → per stable order key ─────────
-- The per-session unique index is now redundant (the per-user one is strictly
-- stronger) and would confuse ON CONFLICT / unique_violation attribution.
drop index if exists public.idx_live_auction_items_idem;
create unique index if not exists idx_live_auction_items_user_idem
  on public.live_auction_items (user_id, client_idempotency_key)
  where client_idempotency_key is not null;

-- ── 4. lensed_log_auction — 041 body VERBATIM (store_id preserved) + two edits ──
-- EDIT 1: existing-row lookup widened from (session_id,user_id,key) to (user_id,key).
-- EDIT 2: new-insert path wrapped in `begin … exception when unique_violation` that
--         replays the canonical row (covers a concurrent cross-session race).
-- (Plus additive RAISE NOTICE telemetry — no behavior/return change.)
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

  -- ── existing row (USER-owned; idempotent on the stable order key across ANY session) ──
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

  -- ── new insert (USER-owned session) ──
  -- EDIT 2: wrapped in a subtransaction. If a concurrent call for the SAME
  -- (user_id, order_id) in another session commits first, idx_live_auction_items_user_idem
  -- raises unique_violation here; the handler rolls back this block's FIFO draws and
  -- returns a clean replay of the canonical row — never a duplicate row or second draw.
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

    -- auction item + lines stay USER-owned; store_id stamped explicitly from the
    -- session — PRESERVED from migration 041 so this fix does not revert store scoping.
    insert into public.live_auction_items
      (user_id, store_id, session_id, sequence, status, is_bundle, expected_price_cents, client_idempotency_key, activated_at, closed_at)
    values (v_user, v_session.store_id, p_session_id, v_seq, p_result, v_is_bundle, v_expected, nullif(p_idem_key,''), now(), now())
    returning id into v_item;
    insert into public.live_auction_item_skus
      (user_id, store_id, auction_item_id, inventory_sku_id, qty, unit_cost_cents_snapshot, sku_number_snapshot, title_snapshot)
    select v_user, v_session.store_id, v_item, (l->>'sku_id')::uuid, (l->>'qty')::int, (l->>'cost')::int, (l->>'sku_number')::int, (l->>'title')
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
      if not found then raise; end if;  -- not the order-dup case → surface it
      raise notice 'lensed_log_auction: REPLAY (race, duplicate skipped) user=% order=%', v_user, p_idem_key;
      item_id:=v_existing.id; auction_number:=v_existing.sequence; status:=v_existing.status;
      replayed:=true; expected_price_cents:=v_existing.expected_price_cents; total_cost_cents:=null;
      return next;
  end;
end;
$$;
grant execute on function public.lensed_log_auction(uuid, text, jsonb, text, boolean, boolean) to authenticated;
