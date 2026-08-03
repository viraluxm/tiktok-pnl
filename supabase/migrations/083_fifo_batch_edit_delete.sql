-- 072: user-facing FIFO cost-layer EDIT + DELETE (current inventory correction).
--
-- WHY: sku_batches rows have been UI-locked (read-only in the Inventory "Cost
-- layers" panel). This adds an authenticated, org-scoped, security-invoker path to
-- correct a layer's REMAINING quantity and/or unit cost, and to physically remove a
-- layer that was never sold from. It preserves every existing invariant:
--
--   • inventory_skus.qty_on_hand stays in lockstep with Σ sku_batches.qty_remaining
--     (034 invariant): a qty edit moves qty_on_hand by the SAME delta; a delete
--     subtracts the removed layer's qty_remaining; a cost-only edit moves neither.
--   • Option A / "never rewrite history": these RPCs NEVER touch
--     live_auction_item_skus.unit_cost_cents_snapshot. A batch cost edit re-prices
--     only FUTURE draws; every already-sold unit keeps its frozen COGS.
--   • Concurrency: every mutation takes the SAME per-SKU transaction advisory lock
--     as a live sale — pg_advisory_xact_lock(hashtextextended('sku:'||sku_id, 0)) —
--     so an edit/delete can never interleave with lensed_log_auction's FIFO draw.
--
-- EDIT is a CURRENT-inventory correction: it sets qty_remaining directly. It does
-- NOT edit or reconstruct a batch's ORIGINAL quantity (qty_added) — that is not
-- reliably known for legacy layers and is deliberately left alone.
--
-- qty_added POLICY (deliberate): we do NOT backfill qty_added across legacy rows.
-- Setting qty_added = qty_remaining on rows that have already been partly sold would
-- misclassify a consumed layer as "untouched" and make it wrongly deletable. Instead
-- only NEW layers get a trustworthy qty_added: lensed_add_batch (below) now stamps it,
-- the create-SKU seed batch stamps it (API route), and the ViewTrack path already does
-- (045/046). Legacy rows keep qty_added IS NULL and are therefore NOT deletable — the
-- honest classification — but their remaining qty can still be edited to zero.
--
-- Out of scope (documented separately, NOT fixed here): lensed_delete_auction_item
-- (025) restocks inventory_skus.qty_on_hand for a deleted SOLD item but never restores
-- the drawn sku_batches layer, so that one path can drift the 034 invariant. This
-- migration does not touch auction reversal.

-- ── 1. lensed_add_batch: 035b body VERBATIM + stamp qty_added on the new layer ──
-- Signature unchanged. A manually added layer starts untouched, so qty_added = the
-- inserted qty; this makes a later delete of a still-untouched manual layer safe.
create or replace function public.lensed_add_batch(p_sku_id uuid, p_qty int, p_unit_cost_cents int)
returns uuid language plpgsql security invoker as $$
declare
  v_user uuid := auth.uid();
  v_org uuid := public.current_user_org();
  v_seq int; v_id uuid;
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED' using errcode='28000'; end if;
  if v_org is null then raise exception 'NO_ORG' using errcode='P0001'; end if;
  if p_qty is null or p_qty < 0 then raise exception 'INVALID_QTY' using errcode='22023'; end if;
  if not exists (select 1 from public.inventory_skus where id = p_sku_id and org_id = v_org) then
    raise exception 'SKU_NOT_FOUND' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sku:'||p_sku_id::text, 0));
  select coalesce(max(sequence),0)+1 into v_seq from public.sku_batches where sku_id = p_sku_id and org_id = v_org;
  insert into public.sku_batches (user_id, org_id, sku_id, qty_remaining, qty_added, unit_cost_cents, sequence)
  values (v_user, v_org, p_sku_id, p_qty, p_qty, p_unit_cost_cents, v_seq) returning id into v_id;
  update public.inventory_skus set qty_on_hand = qty_on_hand + p_qty where id = p_sku_id and org_id = v_org;
  return v_id;
end;
$$;
grant execute on function public.lensed_add_batch(uuid, int, int) to authenticated;

-- ── 2. lensed_edit_batch: correct a layer's remaining qty and/or unit cost ──────
-- Remaining qty is a CURRENT-inventory correction. If the layer was provably
-- UNTOUCHED before the edit (qty_added IS NOT NULL AND qty_remaining = qty_added),
-- a quantity correction RE-BASES qty_added to the new value so the layer stays
-- provably untouched (and therefore still deletable) — e.g. 100 → 90 leaves
-- qty_added = 90. A partly/over-consumed layer NEVER has qty_added rewritten, and a
-- legacy qty_added NULL stays NULL (opaque). qty_on_hand always moves by the exact
-- remaining-qty delta (cost-only edit ⇒ delta 0 ⇒ qty_on_hand unchanged).
--
-- Cost is written ONLY when p_set_cost is true. The route sets p_set_cost from
-- whether the request actually INCLUDED unit_cost_cents: an OMITTED field
-- (p_set_cost false) leaves the existing cost untouched — a qty-only edit can never
-- blank a cost — while an EXPLICIT null/blank (p_set_cost true, p_unit_cost_cents
-- null) sets it to unknown. NEVER touches live_auction_item_skus.unit_cost_cents_
-- snapshot, so historical COGS is unchanged. OUT names avoid table-column collisions.
create or replace function public.lensed_edit_batch(
  p_sku_id uuid,
  p_batch_id uuid,
  p_qty_remaining int,
  p_unit_cost_cents int,
  p_set_cost boolean default true
)
returns table (batch_id uuid, new_qty_remaining int, new_qty_added int, new_unit_cost_cents int, new_qty_on_hand int)
language plpgsql security invoker as $$
declare
  v_org uuid := public.current_user_org();
  v_sku uuid; v_old int; v_added int; v_new_added int; v_was_untouched boolean;
  v_delta int; v_qoh int; v_final_cost int;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED' using errcode='28000'; end if;
  if v_org is null then raise exception 'NO_ORG' using errcode='P0001'; end if;
  -- Remaining qty: integer >= 0. (Original qty is never edited by hand here.)
  if p_qty_remaining is null or p_qty_remaining < 0 then raise exception 'INVALID_QTY' using errcode='22023'; end if;
  -- Cost (only when actually being set): null (unknown) or a nonnegative integer —
  -- matches lensed_add_batch conventions.
  if p_set_cost and p_unit_cost_cents is not null and p_unit_cost_cents < 0 then
    raise exception 'INVALID_COST' using errcode='22023';
  end if;

  -- Batch must belong to BOTH the requested SKU and the caller's org (defense in
  -- depth beyond RLS; also rejects a wrong sku/batch pairing and cross-org ids).
  select b.sku_id into v_sku
    from public.sku_batches b
    where b.id = p_batch_id and b.org_id = v_org and b.sku_id = p_sku_id;
  if not found then raise exception 'BATCH_NOT_FOUND' using errcode='22023'; end if;

  -- Serialize against live sales / add / settle on this SKU, THEN read fresh state.
  perform pg_advisory_xact_lock(hashtextextended('sku:'||v_sku::text, 0));
  select b.qty_remaining, b.qty_added into v_old, v_added
    from public.sku_batches b where b.id = p_batch_id and b.org_id = v_org;

  -- Untouched BEFORE the edit ⇒ re-base qty_added with the correction so it stays
  -- untouched. Otherwise keep qty_added EXACTLY (legacy NULL stays NULL; a consumed
  -- original is never rewritten).
  v_was_untouched := (v_added is not null and v_old = v_added);
  v_new_added := case when v_was_untouched then p_qty_remaining else v_added end;
  v_delta := p_qty_remaining - v_old;

  update public.sku_batches b
     set qty_remaining = p_qty_remaining,
         qty_added = v_new_added,
         unit_cost_cents = case when p_set_cost then p_unit_cost_cents else b.unit_cost_cents end
     where b.id = p_batch_id and b.org_id = v_org
     returning b.unit_cost_cents into v_final_cost;

  update public.inventory_skus s set qty_on_hand = s.qty_on_hand + v_delta
     where s.id = v_sku and s.org_id = v_org
     returning s.qty_on_hand into v_qoh;

  batch_id := p_batch_id; new_qty_remaining := p_qty_remaining; new_qty_added := v_new_added;
  new_unit_cost_cents := v_final_cost; new_qty_on_hand := v_qoh;
  return next;
end;
$$;
grant execute on function public.lensed_edit_batch(uuid, uuid, int, int, boolean) to authenticated;

-- ── 3. lensed_delete_batch: physically remove ONE untouched layer ───────────────
-- Allowed ONLY when the layer is provably untouched by any sale AND is not the SKU's
-- only layer:
--   • qty_added IS NOT NULL  (we know its original qty — legacy NULL rows are opaque)
--   • qty_remaining = qty_added  (nothing has been drawn from it)
--   • it is not the SKU's last remaining batch (never leave a SKU with 0 layers)
-- Deletes the row and subtracts its qty_remaining from qty_on_hand in the same,
-- SKU-locked transaction. Refuses legacy/partly-consumed layers (BATCH_NOT_DELETABLE)
-- and the last layer (CANNOT_DELETE_LAST_BATCH). Never touches sale records/snapshots.
create or replace function public.lensed_delete_batch(
  p_sku_id uuid,
  p_batch_id uuid
)
returns table (deleted_batch_id uuid, deleted_qty int, new_qty_on_hand int)
language plpgsql security invoker as $$
declare
  v_org uuid := public.current_user_org();
  v_sku uuid; v_rem int; v_added int; v_count int; v_qoh int;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED' using errcode='28000'; end if;
  if v_org is null then raise exception 'NO_ORG' using errcode='P0001'; end if;

  select b.sku_id into v_sku
    from public.sku_batches b
    where b.id = p_batch_id and b.org_id = v_org and b.sku_id = p_sku_id;
  if not found then raise exception 'BATCH_NOT_FOUND' using errcode='22023'; end if;

  -- Serialize against live sales / add / settle on this SKU, THEN read fresh state.
  perform pg_advisory_xact_lock(hashtextextended('sku:'||v_sku::text, 0));
  select b.qty_remaining, b.qty_added into v_rem, v_added
    from public.sku_batches b where b.id = p_batch_id and b.org_id = v_org;

  -- Untouched iff we KNOW its original qty and none has been drawn. Legacy NULL rows
  -- and any partly/over-consumed layer are refused with a single clear conflict.
  if v_added is null or v_rem <> v_added then
    raise exception 'BATCH_NOT_DELETABLE' using errcode='P0001';
  end if;

  -- Never leave a SKU with zero cost layers (the sale path needs at least one).
  select count(*) into v_count from public.sku_batches b where b.sku_id = v_sku and b.org_id = v_org;
  if v_count <= 1 then raise exception 'CANNOT_DELETE_LAST_BATCH' using errcode='P0001'; end if;

  delete from public.sku_batches where id = p_batch_id and org_id = v_org;

  update public.inventory_skus s set qty_on_hand = s.qty_on_hand - v_rem
     where s.id = v_sku and s.org_id = v_org
     returning s.qty_on_hand into v_qoh;

  deleted_batch_id := p_batch_id; deleted_qty := v_rem; new_qty_on_hand := v_qoh;
  return next;
end;
$$;
grant execute on function public.lensed_delete_batch(uuid, uuid) to authenticated;
