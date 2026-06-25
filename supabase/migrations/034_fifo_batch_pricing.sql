-- 034: FIFO batch pricing for inventory SKUs (Option A — never rewrite history).
--
-- WHY: a SKU's cost is no longer a single flat number — it's a stack of cost
-- layers ("batches"), each a quantity bought at a price. A future sale draws its
-- cost from a SINGLE batch (FIFO, oldest first), so Profit/ROI reflect the real
-- layer consumed. The ONLY thing that changes is WHERE a future sale's cost
-- snapshot comes from (a drawn batch vs. a flat inventory_skus.unit_cost_cents);
-- the snapshot mechanism, exactly-once decrement, and double-bind guard are
-- identical to 033.
--
-- OPTION A: this migration never touches recorded history. Existing
-- live_auction_item_skus.unit_cost_cents_snapshot rows are left exactly as-is.
-- Each existing SKU gets ONE initial batch = its current qty_on_hand at its
-- current cost, so Σ qty_remaining per SKU == pre-migration qty_on_hand. FIFO
-- applies to FUTURE sales only.
--
-- INVARIANT: inventory_skus.qty_on_hand stays in lockstep with Σ qty_remaining
-- across that SKU's batches (every draw/settle/add updates both). This keeps the
-- whole existing read surface (inventory list, board cost calc, reconcile,
-- payout, Profit/ROI display) working UNCHANGED — total stock is still
-- qty_on_hand, and it equals Σ qty_remaining by construction.
--
-- ⚠️ MULTI-TENANT TODO: org migration 030 is NOT live yet, so sku_batches uses
-- user_id-only RLS to match the rest of the schema. WHEN 030 IS APPLIED,
-- sku_batches MUST be added to 030's table list (org_id + is_org_member policies).

-- ── 1. Cost-layer table ────────────────────────────────────────────────────
create table if not exists public.sku_batches (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  sku_id uuid not null references public.inventory_skus(id) on delete cascade,
  qty_remaining integer not null,            -- units left in this layer; MAY go negative (oversell)
  unit_cost_cents integer,                   -- cost of this layer (null = unknown cost)
  sequence integer not null,                 -- FIFO order within a SKU, oldest first
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sku_id, sequence)
);

create index if not exists idx_sku_batches_user on public.sku_batches(user_id);
create index if not exists idx_sku_batches_sku on public.sku_batches(sku_id, sequence);

create trigger sku_batches_set_updated_at
  before update on public.sku_batches
  for each row execute function public.set_updated_at();

alter table public.sku_batches enable row level security;

create policy "Users can view own sku_batches"
  on public.sku_batches for select using (auth.uid() = user_id);
create policy "Users can insert own sku_batches"
  on public.sku_batches for insert with check (auth.uid() = user_id);
create policy "Users can update own sku_batches"
  on public.sku_batches for update using (auth.uid() = user_id);
create policy "Users can delete own sku_batches"
  on public.sku_batches for delete using (auth.uid() = user_id);

-- ── 2. Option-A backfill: one initial batch per existing SKU ────────────────
-- qty_remaining = current qty_on_hand, cost = current unit_cost_cents, sequence 1.
-- Idempotent: only seed SKUs that have no batch yet. Recorded sale snapshots in
-- live_auction_item_skus are deliberately NOT touched.
insert into public.sku_batches (user_id, sku_id, qty_remaining, unit_cost_cents, sequence, created_at)
select s.user_id, s.id, s.qty_on_hand, s.unit_cost_cents, 1, s.created_at
from public.inventory_skus s
where not exists (select 1 from public.sku_batches b where b.sku_id = s.id);

-- ── 3. add_batch: append a genuine new purchased layer (qty @ cost) ─────────
-- Newest sequence; bumps qty_on_hand in lockstep. This is NOT settle.
create or replace function public.lensed_add_batch(
  p_sku_id uuid,
  p_qty int,
  p_unit_cost_cents int
)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_user uuid := auth.uid();
  v_seq int;
  v_id uuid;
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED' using errcode = '28000'; end if;
  if p_qty is null or p_qty < 0 then raise exception 'INVALID_QTY' using errcode = '22023'; end if;
  if not exists (select 1 from public.inventory_skus where id = p_sku_id and user_id = v_user) then
    raise exception 'SKU_NOT_FOUND' using errcode = '22023';
  end if;

  select coalesce(max(sequence), 0) + 1 into v_seq
    from public.sku_batches where sku_id = p_sku_id and user_id = v_user;

  insert into public.sku_batches (user_id, sku_id, qty_remaining, unit_cost_cents, sequence)
  values (v_user, p_sku_id, p_qty, p_unit_cost_cents, v_seq)
  returning id into v_id;

  update public.inventory_skus set qty_on_hand = qty_on_hand + p_qty
    where id = p_sku_id and user_id = v_user;

  return v_id;
end;
$$;
grant execute on function public.lensed_add_batch(uuid, int, int) to authenticated;

-- ── 4. settle_batch: quantity-only — bring a NEGATIVE batch up to exactly 0 ──
-- Adds the exact deficit of a negative batch (−3 → 0 by adding 3) and bumps
-- qty_on_hand to match. Does NOT change, recompute, or touch ANY recorded sale
-- cost (those were locked at bind). Distinct from add_batch.
create or replace function public.lensed_settle_batch(p_batch_id uuid)
returns int
language plpgsql
security invoker
as $$
declare
  v_user uuid := auth.uid();
  v_batch record;
  v_deficit int;
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED' using errcode = '28000'; end if;
  select id, sku_id, qty_remaining into v_batch
    from public.sku_batches where id = p_batch_id and user_id = v_user;
  if not found then raise exception 'BATCH_NOT_FOUND' using errcode = '22023'; end if;
  if v_batch.qty_remaining >= 0 then return 0; end if;  -- nothing to settle

  v_deficit := -v_batch.qty_remaining;                  -- units to add to reach 0
  update public.sku_batches set qty_remaining = 0 where id = v_batch.id and user_id = v_user;
  update public.inventory_skus set qty_on_hand = qty_on_hand + v_deficit
    where id = v_batch.sku_id and user_id = v_user;
  return v_deficit;
end;
$$;
grant execute on function public.lensed_settle_batch(uuid) to authenticated;

-- ── 5. lensed_log_auction with FIFO batch draw-down ─────────────────────────
-- Identical to 033 EXCEPT: a SOLD line draws its cost from a single batch
-- (FIFO, oldest covering the whole qty; Option X = skip too-small batches);
-- oversell (no single batch covers it) draws the NEWEST batch into the negative,
-- gated by p_allow_negative exactly as before. The drawn batch's unit_cost_cents
-- is the locked snapshot. not_sold is unchanged (no draw; provisional flat cost).
drop function if exists public.lensed_log_auction(uuid, text, jsonb, text, boolean, boolean);

create or replace function public.lensed_log_auction(
  p_session_id uuid,
  p_result text,
  p_skus jsonb,          -- collapsed: [{"sku_id":"<uuid>","qty":<int>}, ...] one entry per sku
  p_idem_key text,
  p_manual boolean default false,
  p_allow_negative boolean default false
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
  v_batch record;
  v_unit_cost int;
  v_total int := 0;
  v_missing boolean := false;
  v_expected int;
  v_seq int;
  v_item uuid;
  v_is_bundle boolean := (jsonb_array_length(p_skus) > 1);
  v_be record;
  v_costed jsonb := '[]'::jsonb;
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
      -- This is when the sale becomes REAL, so it draws FIFO now and locks the
      -- cost from the drawn batch (the provisional not_sold cost is replaced).
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
          -- FIFO: oldest batch that covers the WHOLE qty.
          select b.id, b.unit_cost_cents into v_batch
            from public.sku_batches b
            where b.sku_id = v_be.inventory_sku_id and b.user_id = v_user
              and b.qty_remaining >= v_be.qty
            order by b.sequence asc limit 1;
          if not found then
            -- Oversell: newest batch goes negative (only if confirmed).
            if not p_allow_negative then
              raise exception 'OUT_OF_STOCK:%',
                coalesce((select sku_number from public.inventory_skus
                            where id = v_be.inventory_sku_id and user_id = v_user), 0)
                using errcode = 'P0001';
            end if;
            select b.id, b.unit_cost_cents into v_batch
              from public.sku_batches b
              where b.sku_id = v_be.inventory_sku_id and b.user_id = v_user
              order by b.sequence desc limit 1;
            if not found then
              raise exception 'NO_BATCH:%',
                coalesce((select sku_number from public.inventory_skus
                            where id = v_be.inventory_sku_id and user_id = v_user), 0)
                using errcode = 'P0001';
            end if;
          end if;
          update public.sku_batches set qty_remaining = qty_remaining - v_be.qty where id = v_batch.id;
          update public.inventory_skus set qty_on_hand = qty_on_hand - v_be.qty
            where id = v_be.inventory_sku_id and user_id = v_user;
          -- Lock the cost from the drawn batch (at flip = attach time of the sale).
          update public.live_auction_item_skus set unit_cost_cents_snapshot = v_batch.unit_cost_cents
            where auction_item_id = v_existing.id and inventory_sku_id = v_be.inventory_sku_id and user_id = v_user;
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

      -- Every other repeat is a NO-OP (the double-bind guard): sold→sold,
      -- sold→not_sold, not_sold→not_sold. No second draw.
      item_id := v_existing.id; auction_number := v_existing.sequence; status := v_existing.status;
      replayed := true; expected_price_cents := v_existing.expected_price_cents;
      total_cost_cents := null;
      return next; return;
    end if;
  end if;

  -- ── New order (no existing row): insert path ──────────────────────────────
  select s.id, s.status into v_session
    from public.live_sessions s where s.id = p_session_id and s.user_id = v_user;
  if not found then raise exception 'SESSION_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_session.status in ('ended', 'reconciled') and not p_manual then
    raise exception 'SESSION_ENDED' using errcode = 'P0001';
  end if;

  for v_line in select * from jsonb_array_elements(p_skus) loop
    v_sku_id := (v_line->>'sku_id')::uuid;
    v_qty := greatest(1, coalesce((v_line->>'qty')::int, 1));
    select id, sku_number, title, unit_cost_cents into v_sku
      from public.inventory_skus where id = v_sku_id and user_id = v_user;
    if not found then raise exception 'SKU_NOT_FOUND' using errcode = '22023'; end if;

    if p_result = 'sold' then
      -- FIFO: oldest batch that covers the WHOLE qty (Option X: skip too-small).
      select b.id, b.unit_cost_cents into v_batch
        from public.sku_batches b
        where b.sku_id = v_sku_id and b.user_id = v_user and b.qty_remaining >= v_qty
        order by b.sequence asc limit 1;
      if not found then
        -- Oversell: no single batch covers N → NEWEST batch goes negative.
        if not p_allow_negative then
          raise exception 'OUT_OF_STOCK:%', v_sku.sku_number using errcode = 'P0001';
        end if;
        select b.id, b.unit_cost_cents into v_batch
          from public.sku_batches b
          where b.sku_id = v_sku_id and b.user_id = v_user
          order by b.sequence desc limit 1;
        if not found then
          raise exception 'NO_BATCH:%', v_sku.sku_number using errcode = 'P0001';
        end if;
      end if;
      update public.sku_batches set qty_remaining = qty_remaining - v_qty where id = v_batch.id;
      update public.inventory_skus set qty_on_hand = qty_on_hand - v_qty
        where id = v_sku_id and user_id = v_user;
      v_unit_cost := v_batch.unit_cost_cents;   -- locked snapshot = drawn batch's cost
    else
      -- not_sold: no sale, no draw. Provisional flat cost (unchanged from 033).
      v_unit_cost := v_sku.unit_cost_cents;
    end if;

    if v_unit_cost is null then v_missing := true; else v_total := v_total + v_unit_cost * v_qty; end if;
    v_costed := v_costed || jsonb_build_object(
      'sku_id', v_sku_id, 'qty', v_qty, 'cost', v_unit_cost,
      'sku_number', v_sku.sku_number, 'title', v_sku.title);
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

  -- Snapshot the per-line cost DRAWN above (not a flat re-read of the SKU).
  insert into public.live_auction_item_skus
    (user_id, auction_item_id, inventory_sku_id, qty, unit_cost_cents_snapshot,
     sku_number_snapshot, title_snapshot)
  select v_user, v_item, (l->>'sku_id')::uuid, (l->>'qty')::int,
         (l->>'cost')::int, (l->>'sku_number')::int, (l->>'title')
  from jsonb_array_elements(v_costed) l;

  item_id := v_item; auction_number := v_seq; status := p_result; replayed := false;
  expected_price_cents := v_expected; total_cost_cents := case when v_missing then null else v_total end;
  return next;
end;
$$;

grant execute on function public.lensed_log_auction(uuid, text, jsonb, text, boolean, boolean) to authenticated;
