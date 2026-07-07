-- 046: ViewTrack integration — void (undo) a mistakenly-sent batch.
--
-- WHY: 045 has no reversal. If ViewTrack sends a wrong batch, there is no clean
-- per-batch undo (whole-SKU delete is destructive and blocked once the SKU has
-- any sale). This adds a TARGETED void that removes ONE batch layer and restores
-- qty_on_hand in lockstep — but ONLY while that layer is untouched by a sale.
--
-- "Untouched" needs the originally-added qty, which the schema never stored
-- (qty_remaining is the only qty column). So we add sku_batches.qty_added,
-- populate it on the admin add path, and void refuses unless
-- qty_remaining = qty_added (i.e. nothing has been drawn from this layer).
--
-- Deleting the layer also removes its (org_id, source, external_ref) unique row,
-- so the same ViewTrack order can be re-sent as a genuinely fresh batch.

-- ── 1. Record the originally-added qty on the cost layer ────────────────────
alter table public.sku_batches
  add column if not exists qty_added integer;   -- units inserted when the layer was created

-- ── 2. add_batch_admin: identical to 045 EXCEPT it now stamps qty_added ──────
create or replace function public.lensed_add_batch_admin(
  p_org_id uuid,
  p_sku_id uuid,
  p_qty int,
  p_unit_cost_cents int,
  p_external_ref text,
  p_system_user_id uuid
)
returns table (batch_id uuid, qty_on_hand int, replayed boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid;
  v_seq int;
  v_id uuid;
  v_existing uuid;
  v_qoh int;
begin
  if p_org_id is null then raise exception 'MISSING_ORG' using errcode='22023'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'INVALID_QTY' using errcode='22023'; end if;
  if p_unit_cost_cents is null or p_unit_cost_cents < 0 or p_unit_cost_cents > 100000 then
    raise exception 'INVALID_COST' using errcode='22023';
  end if;
  if p_external_ref is null or length(p_external_ref) = 0 then
    raise exception 'MISSING_REF' using errcode='22023';
  end if;

  if not exists (select 1 from public.inventory_skus where id = p_sku_id and org_id = p_org_id) then
    raise exception 'SKU_NOT_FOUND' using errcode='22023';
  end if;

  v_user := coalesce(
    p_system_user_id,
    (select owner_user_id from public.organizations where id = p_org_id)
  );
  if v_user is null then raise exception 'NO_ATTRIBUTION_USER' using errcode='22023'; end if;

  perform pg_advisory_xact_lock(hashtextextended('sku:'||p_sku_id::text, 0));

  select id into v_existing from public.sku_batches
    where org_id = p_org_id and source = 'viewtrack' and external_ref = p_external_ref;
  if found then
    select s.qty_on_hand into v_qoh from public.inventory_skus s where s.id = p_sku_id and s.org_id = p_org_id;
    batch_id := v_existing; qty_on_hand := v_qoh; replayed := true;
    return next; return;
  end if;

  select coalesce(max(sequence),0)+1 into v_seq
    from public.sku_batches where sku_id = p_sku_id and org_id = p_org_id;

  insert into public.sku_batches
    (user_id, org_id, sku_id, qty_remaining, qty_added, unit_cost_cents, sequence, source, external_ref)
  values
    (v_user, p_org_id, p_sku_id, p_qty, p_qty, p_unit_cost_cents, v_seq, 'viewtrack', p_external_ref)
  returning id into v_id;

  update public.inventory_skus s set qty_on_hand = s.qty_on_hand + p_qty
    where s.id = p_sku_id and s.org_id = p_org_id
    returning s.qty_on_hand into v_qoh;

  batch_id := v_id; qty_on_hand := v_qoh; replayed := false;
  return next;
end;
$$;

revoke all on function public.lensed_add_batch_admin(uuid, uuid, int, int, text, uuid) from public;
revoke all on function public.lensed_add_batch_admin(uuid, uuid, int, int, text, uuid) from authenticated;

-- ── 3. void_batch: remove ONE untouched viewtrack layer, restore stock ──────
-- Refuses (ALREADY_DRAWN) if any of the layer has been consumed by a sale.
-- Deletes the row (which clears its idempotency record) and subtracts qty_added
-- from qty_on_hand in the SAME transaction. SKU + all other batches untouched.
create or replace function public.lensed_void_batch(
  p_org_id uuid,
  p_batch_id uuid
)
returns table (batch_id uuid, sku_id uuid, qty_on_hand int, voided_qty int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sku uuid;
  v_src text;
  v_rem int;
  v_added int;
  v_qoh int;
begin
  if p_org_id is null then raise exception 'MISSING_ORG' using errcode='22023'; end if;

  -- Locate the layer (org-scoped). Only integration-created layers are voidable
  -- through this path, so a stray id can't nuke a hand-entered cost layer.
  select b.sku_id, b.source into v_sku, v_src
    from public.sku_batches b
    where b.id = p_batch_id and b.org_id = p_org_id;
  if not found then raise exception 'BATCH_NOT_FOUND' using errcode='22023'; end if;
  if v_src is distinct from 'viewtrack' then raise exception 'BATCH_NOT_FOUND' using errcode='22023'; end if;

  -- Serialize against concurrent sales on this SKU, then decide on fresh state.
  perform pg_advisory_xact_lock(hashtextextended('sku:'||v_sku::text, 0));

  select b.qty_remaining, b.qty_added into v_rem, v_added
    from public.sku_batches b
    where b.id = p_batch_id and b.org_id = p_org_id;

  -- Untouched iff nothing has been drawn: qty_remaining still equals qty_added.
  if v_added is null or v_rem <> v_added then
    raise exception 'ALREADY_DRAWN' using errcode='P0001';
  end if;

  -- Remove the layer (this also removes its source/external_ref idempotency row).
  delete from public.sku_batches where id = p_batch_id and org_id = p_org_id;

  -- Restore stock in lockstep (same transaction).
  update public.inventory_skus s set qty_on_hand = s.qty_on_hand - v_added
    where s.id = v_sku and s.org_id = p_org_id
    returning s.qty_on_hand into v_qoh;

  batch_id := p_batch_id; sku_id := v_sku; qty_on_hand := v_qoh; voided_qty := v_added;
  return next;
end;
$$;

revoke all on function public.lensed_void_batch(uuid, uuid) from public;
revoke all on function public.lensed_void_batch(uuid, uuid) from authenticated;
